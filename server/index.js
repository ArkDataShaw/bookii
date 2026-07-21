import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { q, pool, migrate } from "./db.js";
import { hashPassword, verifyPassword, createSession, requireUser, RESERVED_USERNAMES, SLUG_RE } from "./auth.js";
import { computeSlots, slotIsAvailable, explainDay, computeTeamSlots, hostsFreeAt, pickHost } from "./availability.js";
import { isValidTz } from "./time.js";
import * as G from "./google.js";
import { encrypt, signState, verifyState } from "./crypto.js";
import { sendBookingEmails, sendCancellationEmails, sendRescheduleEmails, sendMagicLink, sendPasswordReset, sendReminder, emailReady } from "./email.js";
import { fireWebhooks, deliver } from "./webhooks.js";
import { randomBytes, createHash } from "crypto";

const sha256 = s => createHash("sha256").update(s).digest("hex");
/* Resolve an api/agent key from Authorization: Bearer bk_... */
async function requireKey(c, scope) {
  const auth = c.req.header("Authorization") || "";
  const raw = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!raw.startsWith("bk_")) return null;
  const r = await q(`SELECT * FROM api_keys WHERE key_hash=$1`, [sha256(raw)]);
  const key = r.rows[0];
  if (!key) return null;
  if (scope && !key.scopes.includes(scope)) return { key, denied: true };
  q(`UPDATE api_keys SET last_used=now() WHERE id=$1`, [key.id]).catch(() => {});
  return { key };
}
async function logAgentAction(key, action, detail) {
  if (key.kind !== "agent") return;
  await q(`INSERT INTO agent_actions (user_id, key_id, action, detail) VALUES ($1,$2,$3,$4)`,
    [key.user_id, key.id, action, JSON.stringify(detail || {})]).catch(() => {});
}

const app = new Hono();

app.use("*", cors({
  origin: (o) => {
    if (!o) return "*";
    if (/^https?:\/\/((localhost|127\.0\.0\.1)(:\d+)?|([a-z0-9-]+\.)?bookii\.to|bookii-696\.netlify\.app)$/.test(o)) return o;
    return "https://bookii.to";
  },
  allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
}));

const err = (c, status, msg) => c.json({ error: msg }, status);
const HOLD_TTL_S = 300;

/* ---------------- health ---------------- */
app.get("/v1/health", async (c) => {
  await q("SELECT 1");
  return c.json({ ok: true, service: "bookii-api", time: new Date().toISOString() });
});

/* ---------------- auth ---------------- */
app.post("/v1/auth/signup", async (c) => {
  const { email, password, name, timezone } = await c.req.json().catch(() => ({}));
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err(c, 400, "Enter a valid email.");
  if (!password || password.length < 8) return err(c, 400, "Password must be at least 8 characters.");
  const tz = isValidTz(timezone) ? timezone : "America/Chicago";
  const hash = await hashPassword(password);
  let user;
  try {
    const r = await q(
      `INSERT INTO users (email, password_hash, name, timezone) VALUES ($1,$2,$3,$4) RETURNING id, email, name, username, timezone, welcome_note`,
      [email.toLowerCase(), hash, name || "", tz]
    );
    user = r.rows[0];
  } catch (e) {
    if (e.code === "23505") return err(c, 409, "An account with that email already exists.");
    throw e;
  }
  // default schedule: Mon-Fri 9-5
  const sch = await q(
    `INSERT INTO schedules (user_id, name, timezone, is_default) VALUES ($1,'Working hours',$2,true) RETURNING id`,
    [user.id, tz]
  );
  for (const wd of [1, 2, 3, 4, 5]) {
    await q(`INSERT INTO schedule_rules (schedule_id, weekday, start_min, end_min) VALUES ($1,$2,540,1020)`, [sch.rows[0].id, wd]);
  }
  const token = await createSession(user.id);
  return c.json({ token, user }, 201);
});

app.post("/v1/auth/login", async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}));
  const r = await q(`SELECT * FROM users WHERE email=$1`, [(email || "").toLowerCase()]);
  const u = r.rows[0];
  if (!u || !(await verifyPassword(password || "", u.password_hash))) return err(c, 401, "Email or password is incorrect.");
  const token = await createSession(u.id);
  const { password_hash, ...user } = u;
  return c.json({ token, user });
});

/* ---------- email-token auth (magic link + password reset) ---------- */
async function issueAuthToken(userId, kind) {
  const token = randomBytes(24).toString("hex");
  await q(`INSERT INTO auth_tokens (token, user_id, kind, expires_at) VALUES ($1,$2,$3, now() + interval '15 minutes')`, [token, userId, kind]);
  return token;
}
const NEUTRAL = "If that email has an account, a link is on its way.";

app.post("/v1/auth/magic-link", async (c) => {
  if (!emailReady()) return err(c, 503, "Email sign-in isn't available yet — use your password.");
  const { email } = await c.req.json().catch(() => ({}));
  const u = (await q(`SELECT id, email FROM users WHERE email=$1`, [(email || "").toLowerCase()])).rows[0];
  if (u) {
    const token = await issueAuthToken(u.id, "magic");
    sendMagicLink(u.email, `https://from.bookii.to/app.html#/auth-token/${token}`).catch(() => {});
  }
  return c.json({ ok: true, message: NEUTRAL });
});

app.post("/v1/auth/forgot", async (c) => {
  if (!emailReady()) return err(c, 503, "Password reset by email isn't available yet — contact support@bookii.to.");
  const { email } = await c.req.json().catch(() => ({}));
  const u = (await q(`SELECT id, email FROM users WHERE email=$1`, [(email || "").toLowerCase()])).rows[0];
  if (u) {
    const token = await issueAuthToken(u.id, "reset");
    sendPasswordReset(u.email, `https://from.bookii.to/app.html#/reset/${token}`).catch(() => {});
  }
  return c.json({ ok: true, message: NEUTRAL });
});

async function consumeAuthToken(token, kind) {
  const r = await q(
    `UPDATE auth_tokens SET used_at=now() WHERE token=$1 AND kind=$2 AND expires_at > now() AND used_at IS NULL RETURNING user_id`,
    [token || "", kind]);
  return r.rows[0]?.user_id || null;
}

app.post("/v1/auth/magic-verify", async (c) => {
  const { token } = await c.req.json().catch(() => ({}));
  const userId = await consumeAuthToken(token, "magic");
  if (!userId) return err(c, 401, "That sign-in link is invalid or expired — request a new one.");
  const session = await createSession(userId);
  const u = (await q(`SELECT id, email, name, username, timezone, welcome_note, notify_prefs FROM users WHERE id=$1`, [userId])).rows[0];
  return c.json({ token: session, user: u });
});

app.post("/v1/auth/reset", async (c) => {
  const { token, password } = await c.req.json().catch(() => ({}));
  if (!password || password.length < 8) return err(c, 400, "Password must be at least 8 characters.");
  const userId = await consumeAuthToken(token, "reset");
  if (!userId) return err(c, 401, "That reset link is invalid or expired — request a new one.");
  await q(`UPDATE users SET password_hash=$1 WHERE id=$2`, [await hashPassword(password), userId]);
  await q(`DELETE FROM sessions WHERE user_id=$1`, [userId]); // sign out everywhere
  const session = await createSession(userId);
  const u = (await q(`SELECT id, email, name, username, timezone, welcome_note, notify_prefs FROM users WHERE id=$1`, [userId])).rows[0];
  return c.json({ token: session, user: u });
});

app.get("/v1/me", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const { password_hash, ...user } = u;
  return c.json({ user });
});

app.patch("/v1/me", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const b = await c.req.json().catch(() => ({}));
  if (b.username !== undefined) {
    const un = String(b.username).toLowerCase();
    if (!SLUG_RE.test(un) || un.length < 3 || un.length > 30) return err(c, 400, "Username: 3-30 chars, lowercase letters, numbers, hyphens.");
    if (RESERVED_USERNAMES.has(un)) return err(c, 409, "That username is reserved.");
    try {
      await q(`UPDATE users SET username=$1 WHERE id=$2`, [un, u.id]);
    } catch (e) {
      if (e.code === "23505") return err(c, 409, "That username is taken.");
      throw e;
    }
  }
  if (b.name !== undefined) await q(`UPDATE users SET name=$1 WHERE id=$2`, [String(b.name).slice(0, 80), u.id]);
  if (b.welcome_note !== undefined) await q(`UPDATE users SET welcome_note=$1 WHERE id=$2`, [String(b.welcome_note).slice(0, 300), u.id]);
  if (b.timezone !== undefined && isValidTz(b.timezone)) await q(`UPDATE users SET timezone=$1 WHERE id=$2`, [b.timezone, u.id]);
  if (b.notify_prefs !== undefined && typeof b.notify_prefs === "object") {
    await q(`UPDATE users SET notify_prefs = notify_prefs || $1 WHERE id=$2`, [JSON.stringify(b.notify_prefs), u.id]);
  }
  const r = await q(`SELECT id, email, name, username, timezone, welcome_note, notify_prefs FROM users WHERE id=$1`, [u.id]);
  return c.json({ user: r.rows[0] });
});

app.delete("/v1/me", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const { confirmEmail } = await c.req.json().catch(() => ({}));
  if ((confirmEmail || "").toLowerCase() !== u.email) return err(c, 400, "Type your account email to confirm deletion.");
  // revoke calendar tokens best-effort before cascade delete
  const conns = (await q(`SELECT * FROM calendar_connections WHERE user_id=$1 AND provider='google'`, [u.id])).rows;
  for (const conn of conns) await G.revoke(conn);
  await q(`DELETE FROM users WHERE id=$1`, [u.id]); // cascades to everything
  return c.json({ ok: true });
});

app.get("/v1/username-check/:name", async (c) => {
  const un = c.req.param("name").toLowerCase();
  if (!SLUG_RE.test(un) || un.length < 3) return c.json({ available: false, reason: "invalid" });
  if (RESERVED_USERNAMES.has(un)) return c.json({ available: false, reason: "reserved" });
  const r = await q(`SELECT 1 FROM users WHERE username=$1`, [un]);
  return c.json({ available: r.rows.length === 0 });
});

/* ---------------- schedules ---------------- */
app.get("/v1/schedules", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const s = await q(`SELECT * FROM schedules WHERE user_id=$1 ORDER BY created_at`, [u.id]);
  const out = [];
  for (const sch of s.rows) {
    const [rules, ov] = await Promise.all([
      q(`SELECT weekday, start_min, end_min FROM schedule_rules WHERE schedule_id=$1 ORDER BY weekday, start_min`, [sch.id]),
      q(`SELECT id, date::text, start_min, end_min FROM date_overrides WHERE schedule_id=$1 AND date >= current_date ORDER BY date`, [sch.id]),
    ]);
    out.push({ ...sch, rules: rules.rows, overrides: ov.rows });
  }
  return c.json({ schedules: out });
});

app.post("/v1/schedules", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const b = await c.req.json().catch(() => ({}));
  const tz = isValidTz(b.timezone) ? b.timezone : u.timezone;
  const r = await q(`INSERT INTO schedules (user_id, name, timezone) VALUES ($1,$2,$3) RETURNING *`,
    [u.id, (b.name || "New schedule").slice(0, 60), tz]);
  return c.json({ schedule: { ...r.rows[0], rules: [], overrides: [] } }, 201);
});

app.put("/v1/schedules/:id", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const id = c.req.param("id");
  const own = await q(`SELECT id FROM schedules WHERE id=$1 AND user_id=$2`, [id, u.id]);
  if (!own.rows.length) return err(c, 404, "Schedule not found.");
  const b = await c.req.json().catch(() => ({}));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (b.name) await client.query(`UPDATE schedules SET name=$1 WHERE id=$2`, [b.name.slice(0, 60), id]);
    if (b.timezone && isValidTz(b.timezone)) await client.query(`UPDATE schedules SET timezone=$1 WHERE id=$2`, [b.timezone, id]);
    if (b.is_default === true) {
      await client.query(`UPDATE schedules SET is_default=false WHERE user_id=$1`, [u.id]);
      await client.query(`UPDATE schedules SET is_default=true WHERE id=$1`, [id]);
    }
    if (Array.isArray(b.rules)) {
      await client.query(`DELETE FROM schedule_rules WHERE schedule_id=$1`, [id]);
      for (const r of b.rules) {
        const wd = +r.weekday, sm = +r.start_min, em = +r.end_min;
        if (wd >= 0 && wd <= 6 && sm >= 0 && em <= 1440 && em > sm) {
          await client.query(`INSERT INTO schedule_rules (schedule_id, weekday, start_min, end_min) VALUES ($1,$2,$3,$4)`, [id, wd, sm, em]);
        }
      }
    }
    if (Array.isArray(b.overrides)) {
      await client.query(`DELETE FROM date_overrides WHERE schedule_id=$1`, [id]);
      for (const o of b.overrides) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date || "")) continue;
        await client.query(`INSERT INTO date_overrides (schedule_id, date, start_min, end_min) VALUES ($1,$2,$3,$4)`,
          [id, o.date, o.start_min ?? null, o.end_min ?? null]);
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return c.json({ ok: true });
});

app.delete("/v1/schedules/:id", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const r = await q(`DELETE FROM schedules WHERE id=$1 AND user_id=$2 AND is_default=false RETURNING id`, [c.req.param("id"), u.id]);
  if (!r.rows.length) return err(c, 400, "Can't delete (not found, or it's your default schedule).");
  return c.json({ ok: true });
});

/* ---------------- event types ---------------- */
const ET_FIELDS = ["title", "slug", "description", "duration_min", "color", "locations",
  "buffer_before_min", "buffer_after_min", "min_notice_min", "window_days",
  "slot_interval_min", "daily_cap", "questions", "hidden", "schedule_id",
  "allow_reschedule", "allow_cancel", "cancel_policy"];

app.get("/v1/event-types", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const r = await q(`SELECT * FROM event_types WHERE user_id=$1 ORDER BY created_at`, [u.id]);
  return c.json({ eventTypes: r.rows });
});

async function validateEt(c, u, b, existingId) {
  if (b.slug !== undefined) {
    b.slug = String(b.slug).toLowerCase();
    if (!SLUG_RE.test(b.slug) || b.slug.length > 60) return "Link: lowercase letters, numbers, hyphens only.";
    const clash = await q(`SELECT id FROM event_types WHERE user_id=$1 AND slug=$2 AND id != COALESCE($3,'00000000-0000-0000-0000-000000000000'::uuid)`, [u.id, b.slug, existingId || null]);
    if (clash.rows.length) return "You already have an event with that link.";
  }
  if (b.schedule_id) {
    const own = await q(`SELECT id FROM schedules WHERE id=$1 AND user_id=$2`, [b.schedule_id, u.id]);
    if (!own.rows.length) return "Schedule not found.";
  }
  if (b.questions !== undefined && (!Array.isArray(b.questions) || b.questions.length > 10)) return "Up to 10 questions.";
  return null;
}

app.post("/v1/event-types", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const b = await c.req.json().catch(() => ({}));
  if (!b.title) return err(c, 400, "Give the event a name.");
  const slugExplicit = !!b.slug;
  b.slug = b.slug || b.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "meeting";
  if (!slugExplicit) {
    // auto-generated slug: suffix until free instead of erroring
    const base = b.slug;
    for (let n = 2; n < 50; n++) {
      const clash = await q(`SELECT 1 FROM event_types WHERE user_id=$1 AND slug=$2`, [u.id, b.slug]);
      if (!clash.rows.length) break;
      b.slug = `${base}-${n}`;
    }
  }
  const v = await validateEt(c, u, b, null);
  if (v) return err(c, 400, v);
  if (!b.schedule_id) {
    const d = await q(`SELECT id FROM schedules WHERE user_id=$1 AND is_default=true LIMIT 1`, [u.id]);
    b.schedule_id = d.rows[0]?.id || null;
  }
  const cols = ["user_id"], vals = [u.id], ph = ["$1"];
  let i = 2;
  for (const f of ET_FIELDS) if (b[f] !== undefined) {
    cols.push(f); ph.push(`$${i++}`);
    vals.push(["locations", "questions"].includes(f) ? JSON.stringify(b[f]) : b[f]);
  }
  const r = await q(`INSERT INTO event_types (${cols.join(",")}) VALUES (${ph.join(",")}) RETURNING *`, vals);
  return c.json({ eventType: r.rows[0] }, 201);
});

app.put("/v1/event-types/:id", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const id = c.req.param("id");
  const own = await q(`SELECT id FROM event_types WHERE id=$1 AND user_id=$2`, [id, u.id]);
  if (!own.rows.length) return err(c, 404, "Event type not found.");
  const b = await c.req.json().catch(() => ({}));
  const v = await validateEt(c, u, b, id);
  if (v) return err(c, 400, v);
  const sets = [], vals = [];
  let i = 1;
  for (const f of ET_FIELDS) if (b[f] !== undefined) {
    sets.push(`${f}=$${i++}`);
    vals.push(["locations", "questions"].includes(f) ? JSON.stringify(b[f]) : b[f]);
  }
  if (!sets.length) return err(c, 400, "Nothing to update.");
  vals.push(id);
  const r = await q(`UPDATE event_types SET ${sets.join(",")} WHERE id=$${i} RETURNING *`, vals);
  return c.json({ eventType: r.rows[0] });
});

app.delete("/v1/event-types/:id", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const r = await q(`DELETE FROM event_types WHERE id=$1 AND user_id=$2 RETURNING id`, [c.req.param("id"), u.id]);
  if (!r.rows.length) return err(c, 404, "Event type not found.");
  return c.json({ ok: true });
});

/* ---------------- teams ---------------- */
async function teamRole(teamId, userId) {
  const r = await q(`SELECT role FROM team_members WHERE team_id=$1 AND user_id=$2`, [teamId, userId]);
  return r.rows[0]?.role || null;
}

app.get("/v1/teams", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const r = await q(
    `SELECT t.*, tm.role FROM teams t JOIN team_members tm ON tm.team_id=t.id WHERE tm.user_id=$1 ORDER BY t.created_at`, [u.id]);
  return c.json({ teams: r.rows });
});

app.post("/v1/teams", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const b = await c.req.json().catch(() => ({}));
  if (!b.name) return err(c, 400, "Give the team a name.");
  const slug = String(b.slug || b.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  if (!SLUG_RE.test(slug) || RESERVED_USERNAMES.has(slug)) return err(c, 400, "That team link isn't available.");
  let team;
  try {
    team = (await q(`INSERT INTO teams (name, slug, bio) VALUES ($1,$2,$3) RETURNING *`,
      [String(b.name).slice(0, 80), slug, String(b.bio || "").slice(0, 300)])).rows[0];
  } catch (e) {
    if (e.code === "23505") return err(c, 409, "That team link is taken.");
    throw e;
  }
  await q(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1,$2,'owner')`, [team.id, u.id]);
  return c.json({ team: { ...team, role: "owner" } }, 201);
});

app.get("/v1/teams/:id", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const role = await teamRole(c.req.param("id"), u.id);
  if (!role) return err(c, 404, "Team not found.");
  const [team, members, ets] = await Promise.all([
    q(`SELECT * FROM teams WHERE id=$1`, [c.req.param("id")]),
    q(`SELECT tm.role, u.id, u.name, u.email, u.username FROM team_members tm JOIN users u ON u.id=tm.user_id WHERE tm.team_id=$1 ORDER BY tm.created_at`, [c.req.param("id")]),
    q(`SELECT et.*, (SELECT array_agg(h.user_id) FROM event_type_hosts h WHERE h.event_type_id=et.id) AS host_ids
       FROM event_types et WHERE et.team_id=$1 ORDER BY et.created_at`, [c.req.param("id")]),
  ]);
  return c.json({ team: { ...team.rows[0], role }, members: members.rows, eventTypes: ets.rows });
});

app.patch("/v1/teams/:id", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const role = await teamRole(c.req.param("id"), u.id);
  if (!["owner", "admin"].includes(role)) return err(c, 403, "Only team admins can edit the team.");
  const b = await c.req.json().catch(() => ({}));
  if (b.name !== undefined) await q(`UPDATE teams SET name=$1 WHERE id=$2`, [String(b.name).slice(0, 80), c.req.param("id")]);
  if (b.bio !== undefined) await q(`UPDATE teams SET bio=$1 WHERE id=$2`, [String(b.bio).slice(0, 300), c.req.param("id")]);
  return c.json({ ok: true });
});

app.post("/v1/teams/:id/transfer", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  if ((await teamRole(c.req.param("id"), u.id)) !== "owner") return err(c, 403, "Only the owner can transfer ownership.");
  const { userId } = await c.req.json().catch(() => ({}));
  if (!(await teamRole(c.req.param("id"), userId))) return err(c, 404, "That person isn't a team member.");
  await q(`UPDATE team_members SET role='admin' WHERE team_id=$1 AND user_id=$2`, [c.req.param("id"), u.id]);
  await q(`UPDATE team_members SET role='owner' WHERE team_id=$1 AND user_id=$2`, [c.req.param("id"), userId]);
  return c.json({ ok: true });
});

app.delete("/v1/teams/:id", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  if ((await teamRole(c.req.param("id"), u.id)) !== "owner") return err(c, 403, "Only the owner can delete the team.");
  await q(`DELETE FROM teams WHERE id=$1`, [c.req.param("id")]);
  return c.json({ ok: true });
});

app.get("/v1/teams/:id/meetings", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  if (!(await teamRole(c.req.param("id"), u.id))) return err(c, 404, "Team not found.");
  const r = await q(
    `SELECT b.id, b.start_at, b.end_at, b.status, b.invitee_name, b.invitee_email, b.origin,
            et.title AS event_title, u.name AS host_name, u.username AS host_username
     FROM bookings b JOIN event_types et ON et.id=b.event_type_id JOIN users u ON u.id=b.user_id
     WHERE et.team_id=$1 AND b.start_at > now() - interval '7 days'
     ORDER BY b.start_at LIMIT 100`, [c.req.param("id")]);
  return c.json({ meetings: r.rows });
});

app.get("/v1/teams/:id/host-stats", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  if (!(await teamRole(c.req.param("id"), u.id))) return err(c, 404, "Team not found.");
  const r = await q(
    `SELECT tm.user_id, u.name, u.email,
       (SELECT count(*) FROM schedule_rules sr JOIN schedules s ON s.id=sr.schedule_id WHERE s.user_id=tm.user_id)::int AS rule_count,
       coalesce((SELECT count(*)::int FROM bookings b JOIN event_types et ON et.id=b.event_type_id
         WHERE b.user_id=tm.user_id AND et.team_id=$1 AND b.created_at > now() - interval '30 days'
           AND b.status IN ('pending','confirmed','attended','no_show')), 0) AS bookings_30d,
       (SELECT max(b.created_at) FROM bookings b JOIN event_types et ON et.id=b.event_type_id
         WHERE b.user_id=tm.user_id AND et.team_id=$1) AS last_assigned,
       coalesce((SELECT count(*)::int FROM bookings b JOIN event_types et ON et.id=b.event_type_id
         WHERE b.user_id=tm.user_id AND et.team_id=$1 AND b.status='attended'), 0) AS attended,
       coalesce((SELECT count(*)::int FROM bookings b JOIN event_types et ON et.id=b.event_type_id
         WHERE b.user_id=tm.user_id AND et.team_id=$1 AND b.status='no_show'), 0) AS no_show
     FROM team_members tm JOIN users u ON u.id=tm.user_id WHERE tm.team_id=$1`, [c.req.param("id")]);
  const cfg = await q(
    `SELECT h.event_type_id, h.user_id, h.priority, h.paused FROM event_type_hosts h
     JOIN event_types et ON et.id=h.event_type_id WHERE et.team_id=$1`, [c.req.param("id")]);
  return c.json({ hosts: r.rows, hostConfig: cfg.rows });
});

app.patch("/v1/teams/:id/event-types/:etId/hosts/:userId", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const role = await teamRole(c.req.param("id"), u.id);
  if (!["owner", "admin"].includes(role)) return err(c, 403, "Only team admins can change hosts.");
  const b = await c.req.json().catch(() => ({}));
  const sets = [], vals = [];
  let i = 1;
  if (b.paused !== undefined) { sets.push(`paused=$${i++}`); vals.push(!!b.paused); }
  if (b.priority !== undefined) { sets.push(`priority=$${i++}`); vals.push(Math.max(0, Math.min(4, +b.priority || 0))); }
  if (!sets.length) return err(c, 400, "Nothing to update.");
  vals.push(c.req.param("etId"), c.req.param("userId"));
  await q(`UPDATE event_type_hosts SET ${sets.join(",")} WHERE event_type_id=$${i++} AND user_id=$${i}`, vals);
  return c.json({ ok: true });
});

app.post("/v1/teams/:id/members", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const role = await teamRole(c.req.param("id"), u.id);
  if (!["owner", "admin"].includes(role)) return err(c, 403, "Only team admins can add members.");
  const b = await c.req.json().catch(() => ({}));
  const member = (await q(`SELECT id, name, email FROM users WHERE email=$1`, [(b.email || "").toLowerCase()])).rows[0];
  if (!member) return err(c, 404, "No Bookii account with that email — have them sign up at from.bookii.to first.");
  await q(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [c.req.param("id"), member.id, ["admin", "member"].includes(b.role) ? b.role : "member"]);
  return c.json({ ok: true, member });
});

app.delete("/v1/teams/:id/members/:userId", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const role = await teamRole(c.req.param("id"), u.id);
  const removingSelf = c.req.param("userId") === u.id;
  if (!removingSelf && !["owner", "admin"].includes(role)) return err(c, 403, "Only team admins can remove members.");
  const target = await teamRole(c.req.param("id"), c.req.param("userId"));
  if (target === "owner") return err(c, 400, "The owner can't be removed.");
  await q(`DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, [c.req.param("id"), c.req.param("userId")]);
  await q(`DELETE FROM event_type_hosts WHERE user_id=$1 AND event_type_id IN (SELECT id FROM event_types WHERE team_id=$2)`,
    [c.req.param("userId"), c.req.param("id")]);
  return c.json({ ok: true });
});

app.post("/v1/teams/:id/event-types", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const role = await teamRole(c.req.param("id"), u.id);
  if (!["owner", "admin"].includes(role)) return err(c, 403, "Only team admins can create team events.");
  const b = await c.req.json().catch(() => ({}));
  if (!b.title) return err(c, 400, "Give the event a name.");
  const st = ["round_robin", "collective"].includes(b.scheduling_type) ? b.scheduling_type : "round_robin";
  const hostIds = Array.isArray(b.host_ids) ? b.host_ids : [];
  const valid = (await q(`SELECT user_id FROM team_members WHERE team_id=$1 AND user_id = ANY($2)`,
    [c.req.param("id"), hostIds])).rows.map(r => r.user_id);
  if (!valid.length) return err(c, 400, "Pick at least one host from the team.");
  let slug = String(b.slug || b.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "meeting";
  for (let n = 2; n < 50; n++) {
    const clash = await q(`SELECT 1 FROM event_types WHERE team_id=$1 AND slug=$2`, [c.req.param("id"), slug]);
    if (!clash.rows.length) break;
    slug = `${slug.replace(/-\d+$/, "")}-${n}`;
  }
  const et = (await q(
    `INSERT INTO event_types (user_id, team_id, scheduling_type, title, slug, duration_min, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [u.id, c.req.param("id"), st, String(b.title).slice(0, 80), slug, +b.duration_min || 30, String(b.description || "").slice(0, 500)])).rows[0];
  for (const uid of valid) await q(`INSERT INTO event_type_hosts (event_type_id, user_id) VALUES ($1,$2)`, [et.id, uid]);
  return c.json({ eventType: { ...et, host_ids: valid } }, 201);
});

app.put("/v1/teams/:id/event-types/:etId/hosts", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const role = await teamRole(c.req.param("id"), u.id);
  if (!["owner", "admin"].includes(role)) return err(c, 403, "Only team admins can change hosts.");
  const b = await c.req.json().catch(() => ({}));
  const valid = (await q(`SELECT user_id FROM team_members WHERE team_id=$1 AND user_id = ANY($2)`,
    [c.req.param("id"), Array.isArray(b.host_ids) ? b.host_ids : []])).rows.map(r => r.user_id);
  if (!valid.length) return err(c, 400, "Pick at least one host.");
  await q(`DELETE FROM event_type_hosts WHERE event_type_id=$1`, [c.req.param("etId")]);
  for (const uid of valid) await q(`INSERT INTO event_type_hosts (event_type_id, user_id) VALUES ($1,$2)`, [c.req.param("etId"), uid]);
  return c.json({ ok: true });
});

/* ---------------- public team pages ---------------- */
app.get("/v1/pages/team/:slug", async (c) => {
  const t = (await q(`SELECT * FROM teams WHERE slug=$1`, [c.req.param("slug").toLowerCase()])).rows[0];
  if (!t) return err(c, 404, "Page not found.");
  const ets = await q(`SELECT title, slug, description, duration_min, color, scheduling_type FROM event_types WHERE team_id=$1 AND hidden=false ORDER BY created_at`, [t.id]);
  return c.json({ team: { name: t.name, slug: t.slug, bio: t.bio }, eventTypes: ets.rows });
});

app.get("/v1/pages/team/:slug/:eventSlug", async (c) => {
  const t = (await q(`SELECT * FROM teams WHERE slug=$1`, [c.req.param("slug").toLowerCase()])).rows[0];
  if (!t) return err(c, 404, "Page not found.");
  const et = (await q(`SELECT * FROM event_types WHERE team_id=$1 AND slug=$2`, [t.id, c.req.param("eventSlug").toLowerCase()])).rows[0];
  if (!et) return err(c, 404, "Page not found.");
  const hostIds = (await q(`SELECT user_id FROM event_type_hosts WHERE event_type_id=$1 AND paused=false`, [et.id])).rows.map(r => r.user_id);
  const from = c.req.query("from");
  const fromMs = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? Date.parse(from + "T12:00:00Z") : Date.now();
  const days = Math.min(+(c.req.query("days") || 31), 62);
  const { tz, days: slotDays } = await computeTeamSlots(et, hostIds, fromMs, days);
  return c.json({
    host: { name: t.name, username: "team/" + t.slug, welcome_note: t.bio },
    eventType: {
      id: et.id, title: et.title, slug: et.slug, description: et.description,
      durationMin: et.duration_min, color: et.color, locations: et.locations, questions: et.questions,
      allowReschedule: et.allow_reschedule !== false, allowCancel: et.allow_cancel !== false,
      cancelPolicy: et.cancel_policy || "", schedulingType: et.scheduling_type,
    },
    hostTz: tz,
    days: slotDays,
  });
});

/* ---------------- API keys & agent tokens ---------------- */
const VALID_SCOPES = ["read-availability", "create-booking", "manage-bookings", "manage-event-types"];

app.get("/v1/api-keys", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const r = await q(`SELECT id, name, prefix, last4, scopes, kind, agent_name, last_used, created_at FROM api_keys WHERE user_id=$1 ORDER BY created_at DESC`, [u.id]);
  return c.json({ keys: r.rows });
});

app.post("/v1/api-keys", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const b = await c.req.json().catch(() => ({}));
  const kind = b.kind === "agent" ? "agent" : "api";
  const scopes = Array.isArray(b.scopes) ? b.scopes.filter(s => VALID_SCOPES.includes(s)) : ["read-availability", "create-booking"];
  if (!scopes.length) return err(c, 400, "Pick at least one scope.");
  const raw = `bk_${kind === "agent" ? "agent" : "live"}_${randomBytes(24).toString("hex")}`;
  const r = await q(
    `INSERT INTO api_keys (user_id, name, key_hash, prefix, last4, scopes, kind, agent_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name, prefix, last4, scopes, kind, agent_name, created_at`,
    [u.id, String(b.name || (kind === "agent" ? "Agent" : "API key")).slice(0, 60), sha256(raw),
      raw.slice(0, 11), raw.slice(-4), scopes, kind, b.agent_name ? String(b.agent_name).slice(0, 60) : null]);
  return c.json({ key: r.rows[0], secret: raw }, 201); // full secret shown once
});

app.delete("/v1/api-keys/:id", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  await q(`DELETE FROM api_keys WHERE id=$1 AND user_id=$2`, [c.req.param("id"), u.id]);
  return c.json({ ok: true });
});

app.get("/v1/agent-actions", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const r = await q(
    `SELECT a.action, a.detail, a.created_at, k.agent_name, k.name AS key_name
     FROM agent_actions a LEFT JOIN api_keys k ON k.id=a.key_id
     WHERE a.user_id=$1 ORDER BY a.created_at DESC LIMIT 100`, [u.id]);
  return c.json({ actions: r.rows });
});

/* ---------------- webhooks ---------------- */
app.get("/v1/webhooks", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const r = await q(`SELECT id, url, events, secret, active, created_at FROM webhooks WHERE user_id=$1 ORDER BY created_at`, [u.id]);
  return c.json({ webhooks: r.rows });
});

const WH_EVENTS = ["booking.created", "booking.cancelled", "booking.rescheduled", "booking.no_show"];

app.post("/v1/webhooks", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const b = await c.req.json().catch(() => ({}));
  if (!/^https:\/\/.+/.test(b.url || "")) return err(c, 400, "Webhook URL must be https.");
  const events = (Array.isArray(b.events) ? b.events : WH_EVENTS).filter(e => WH_EVENTS.includes(e));
  if (!events.length) return err(c, 400, "Pick at least one event.");
  const r = await q(
    `INSERT INTO webhooks (user_id, url, events, secret) VALUES ($1,$2,$3,$4) RETURNING id, url, events, secret, active, created_at`,
    [u.id, b.url.slice(0, 500), events, "whsec_" + randomBytes(24).toString("hex")]);
  return c.json({ webhook: r.rows[0] }, 201);
});

app.patch("/v1/webhooks/:id", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const b = await c.req.json().catch(() => ({}));
  if (b.active !== undefined) await q(`UPDATE webhooks SET active=$1 WHERE id=$2 AND user_id=$3`, [!!b.active, c.req.param("id"), u.id]);
  return c.json({ ok: true });
});

app.delete("/v1/webhooks/:id", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  await q(`DELETE FROM webhooks WHERE id=$1 AND user_id=$2`, [c.req.param("id"), u.id]);
  return c.json({ ok: true });
});

app.post("/v1/webhooks/:id/test", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const h = (await q(`SELECT * FROM webhooks WHERE id=$1 AND user_id=$2`, [c.req.param("id"), u.id])).rows[0];
  if (!h) return err(c, 404, "Webhook not found.");
  const result = await deliver(h, "ping", { message: "Test delivery from Bookii", at: new Date().toISOString() });
  return c.json(result);
});

app.get("/v1/webhooks/:id/deliveries", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const own = await q(`SELECT id FROM webhooks WHERE id=$1 AND user_id=$2`, [c.req.param("id"), u.id]);
  if (!own.rows.length) return err(c, 404, "Webhook not found.");
  const r = await q(`SELECT id, event, status_code, ok, response, created_at FROM webhook_deliveries WHERE webhook_id=$1 ORDER BY created_at DESC LIMIT 30`, [c.req.param("id")]);
  return c.json({ deliveries: r.rows });
});

app.post("/v1/webhooks/:id/deliveries/:did/replay", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const h = (await q(`SELECT * FROM webhooks WHERE id=$1 AND user_id=$2`, [c.req.param("id"), u.id])).rows[0];
  if (!h) return err(c, 404, "Webhook not found.");
  const d = (await q(`SELECT * FROM webhook_deliveries WHERE id=$1 AND webhook_id=$2`, [c.req.param("did"), h.id])).rows[0];
  if (!d) return err(c, 404, "Delivery not found.");
  const result = await deliver(h, d.event, d.payload);
  return c.json(result);
});

/* ---------------- billing ---------------- */
app.get("/v1/billing", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  return c.json({
    plan: "beta",
    planLabel: "Beta — everything free",
    stripeReady: !!process.env.STRIPE_SECRET_KEY,
    note: "Paid plans launch later; beta users keep a discount. Your booking pages will never go dark over billing.",
  });
});

/* ---------------- admin (internal) ---------------- */
app.get("/v1/admin/lookup", async (c) => {
  const key = c.req.header("X-Admin-Key");
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) return err(c, 404, "Not found.");
  const email = (c.req.query("email") || "").toLowerCase();
  const uname = (c.req.query("username") || "").toLowerCase();
  const u = (await q(`SELECT id, email, name, username, timezone, created_at, notify_prefs FROM users WHERE email=$1 OR username=$2 LIMIT 1`, [email, uname])).rows[0];
  if (!u) return c.json({ found: false });
  const [ets, scheds, conns, stats] = await Promise.all([
    q(`SELECT title, slug, hidden, duration_min FROM event_types WHERE user_id=$1`, [u.id]),
    q(`SELECT name, timezone, is_default FROM schedules WHERE user_id=$1`, [u.id]),
    q(`SELECT provider, status, account_email, is_destination FROM calendar_connections WHERE user_id=$1`, [u.id]),
    q(`SELECT status, count(*)::int AS n FROM bookings WHERE user_id=$1 GROUP BY status`, [u.id]),
  ]);
  return c.json({ found: true, user: u, eventTypes: ets.rows, schedules: scheds.rows, connections: conns.rows, bookingStats: stats.rows });
});

/* ---------------- insights ---------------- */
app.get("/v1/insights", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const [byStatus, byEvent, byDow, byOrigin, recent] = await Promise.all([
    q(`SELECT status, count(*)::int AS n FROM bookings WHERE user_id=$1 AND created_at > now() - interval '90 days' GROUP BY status`, [u.id]),
    q(`SELECT et.title, count(*)::int AS n FROM bookings b JOIN event_types et ON et.id=b.event_type_id
       WHERE b.user_id=$1 AND b.created_at > now() - interval '90 days' GROUP BY et.title ORDER BY n DESC LIMIT 8`, [u.id]),
    q(`SELECT extract(dow FROM start_at AT TIME ZONE $2)::int AS dow, count(*)::int AS n FROM bookings
       WHERE user_id=$1 AND status != 'cancelled' AND created_at > now() - interval '90 days' GROUP BY dow ORDER BY dow`, [u.id, u.timezone]),
    q(`SELECT origin, count(*)::int AS n FROM bookings WHERE user_id=$1 AND created_at > now() - interval '90 days' GROUP BY origin`, [u.id]),
    q(`SELECT count(*)::int AS n FROM bookings WHERE user_id=$1 AND created_at > now() - interval '7 days'`, [u.id]),
  ]);
  const s = Object.fromEntries(byStatus.rows.map(r => [r.status, r.n]));
  const attended = s.attended || 0, noShow = s.no_show || 0;
  const showRate = attended + noShow > 0 ? Math.round(100 * attended / (attended + noShow)) : null;
  return c.json({
    windowDays: 90,
    totals: { booked: Object.values(s).reduce((a, b) => a + b, 0), ...s },
    showRate,
    last7Days: recent.rows[0].n,
    byEvent: byEvent.rows,
    byWeekday: byDow.rows,
    byOrigin: byOrigin.rows,
  });
});

/* ---------------- troubleshooter ---------------- */
app.get("/v1/troubleshoot/:eventTypeId/:date", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.req.param("date"))) return err(c, 400, "date must be YYYY-MM-DD");
  const et = (await q(`SELECT * FROM event_types WHERE id=$1 AND user_id=$2`, [c.req.param("eventTypeId"), u.id])).rows[0];
  if (!et) return err(c, 404, "Event type not found.");
  const sched = (await q(`SELECT * FROM schedules WHERE id=$1`, [et.schedule_id])).rows[0];
  if (!sched) return err(c, 409, "This event type has no schedule attached.");
  return c.json(await explainDay(et, sched, c.req.param("date")));
});

/* ---------------- bookings (host view) ---------------- */
app.get("/v1/bookings", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const r = await q(
    `SELECT b.*, et.title AS event_title, et.slug AS event_slug FROM bookings b
     JOIN event_types et ON et.id=b.event_type_id
     WHERE b.user_id=$1 AND b.start_at > now() - interval '90 days'
     ORDER BY b.start_at DESC LIMIT 200`, [u.id]);
  return c.json({ bookings: r.rows });
});

app.patch("/v1/bookings/:id/status", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const { status } = await c.req.json().catch(() => ({}));
  if (!["cancelled", "no_show", "attended", "confirmed"].includes(status)) return err(c, 400, "Bad status.");
  const r = await q(`UPDATE bookings SET status=$1 WHERE id=$2 AND user_id=$3 RETURNING id`, [status, c.req.param("id"), u.id]);
  if (!r.rows.length) return err(c, 404, "Booking not found.");
  if (status === "no_show") fireWebhooks(u.id, "booking.no_show", { bookingId: c.req.param("id") });
  if (status === "cancelled") {
    await removeExternalEvent(c.req.param("id"));
    sendCancellationEmails(c.req.param("id"), "the host").catch(() => {});
    fireWebhooks(u.id, "booking.cancelled", { bookingId: c.req.param("id"), by: "host" });
  }
  return c.json({ ok: true });
});

/* ---------------- calendar connections ---------------- */
const APP_URL = "https://from.bookii.to";

app.get("/v1/calendar-connections", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const r = await q(`SELECT id, provider, status, account_email, is_destination, created_at FROM calendar_connections WHERE user_id=$1 ORDER BY created_at`, [u.id]);
  return c.json({
    connections: r.rows,
    providersReady: { google: G.googleReady(), microsoft: !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET), icloud: false },
  });
});

app.get("/v1/oauth/:provider/start", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const p = c.req.param("provider");
  if (p === "google") {
    if (!G.googleReady()) return err(c, 503, "Google Calendar sync isn't configured yet. The app needs Google OAuth credentials (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).");
    return c.json({ url: G.authUrl(signState(u.id)) });
  }
  if (p === "microsoft") {
    if (!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET)) return err(c, 503, "Microsoft calendar sync isn't configured yet. The app needs Entra OAuth credentials (MS_CLIENT_ID / MS_CLIENT_SECRET).");
    const url = new URL(`https://login.microsoftonline.com/${process.env.MS_TENANT || "common"}/oauth2/v2.0/authorize`);
    url.searchParams.set("client_id", process.env.MS_CLIENT_ID);
    url.searchParams.set("redirect_uri", process.env.MS_REDIRECT_URI || "https://api.bookii.to/v1/oauth/microsoft/callback");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email offline_access https://graph.microsoft.com/Calendars.ReadWrite");
    url.searchParams.set("state", signState(u.id));
    return c.json({ url: url.toString() });
  }
  return err(c, 400, "Unknown provider.");
});

app.get("/v1/oauth/google/callback", async (c) => {
  const fail = (msg) => c.redirect(`${APP_URL}/app.html#/calendars?error=${encodeURIComponent(msg)}`);
  if (c.req.query("error")) return fail(c.req.query("error"));
  const userId = verifyState(c.req.query("state"));
  if (!userId) return fail("Sign-in link expired — try connecting again.");
  const code = c.req.query("code");
  if (!code) return fail("Google didn't return a code.");
  try {
    const t = await G.exchangeCode(code);
    // identify the account from the id_token payload (email claim)
    let email = "";
    if (t.id_token) {
      try { email = JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString()).email || ""; } catch {}
    }
    const isFirst = !(await q(`SELECT 1 FROM calendar_connections WHERE user_id=$1 AND is_destination=true`, [userId])).rows.length;
    await q(
      `INSERT INTO calendar_connections (user_id, provider, status, account_email, enc_access_token, enc_refresh_token, access_expires_at, scopes, is_destination)
       VALUES ($1,'google','connected',$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, provider, account_email) DO UPDATE SET
         status='connected', enc_access_token=EXCLUDED.enc_access_token,
         enc_refresh_token=COALESCE(EXCLUDED.enc_refresh_token, calendar_connections.enc_refresh_token),
         access_expires_at=EXCLUDED.access_expires_at, scopes=EXCLUDED.scopes`,
      [userId, email, encrypt(t.access_token), t.refresh_token ? encrypt(t.refresh_token) : null,
        new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString(), t.scope || "", isFirst]);
    return c.redirect(`${APP_URL}/app.html#/calendars?connected=google`);
  } catch (e) {
    console.error("google callback:", e.message);
    return fail("Couldn't finish connecting Google — try again.");
  }
});

app.get("/v1/oauth/microsoft/callback", (c) =>
  c.text("Microsoft sync activates when Entra credentials are configured.", 501));

app.patch("/v1/calendar-connections/:id", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const b = await c.req.json().catch(() => ({}));
  if (b.is_destination === true) {
    await q(`UPDATE calendar_connections SET is_destination=false WHERE user_id=$1`, [u.id]);
    const r = await q(`UPDATE calendar_connections SET is_destination=true WHERE id=$1 AND user_id=$2 RETURNING id`, [c.req.param("id"), u.id]);
    if (!r.rows.length) return err(c, 404, "Connection not found.");
  }
  return c.json({ ok: true });
});

app.delete("/v1/calendar-connections/:id", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const r = await q(`SELECT * FROM calendar_connections WHERE id=$1 AND user_id=$2`, [c.req.param("id"), u.id]);
  if (r.rows[0]?.provider === "google") await G.revoke(r.rows[0]);
  await q(`DELETE FROM calendar_connections WHERE id=$1 AND user_id=$2`, [c.req.param("id"), u.id]);
  return c.json({ ok: true });
});

/* ---------------- public booking surface ---------------- */
async function loadPage(username, slug) {
  const ur = await q(`SELECT id, name, username, welcome_note, timezone FROM users WHERE username=$1`, [username.toLowerCase()]);
  const host = ur.rows[0];
  if (!host) return {};
  if (!slug) return { host };
  const er = await q(`SELECT * FROM event_types WHERE user_id=$1 AND slug=$2`, [host.id, slug.toLowerCase()]);
  const et = er.rows[0];
  if (!et) return { host };
  const sr = await q(`SELECT * FROM schedules WHERE id=$1`, [et.schedule_id]);
  return { host, et, schedule: sr.rows[0] };
}

app.get("/v1/pages/:username", async (c) => {
  const { host } = await loadPage(c.req.param("username"), null);
  if (!host) return err(c, 404, "Page not found.");
  const ets = await q(`SELECT title, slug, description, duration_min, color, locations FROM event_types WHERE user_id=$1 AND hidden=false ORDER BY created_at`, [host.id]);
  return c.json({ host: { name: host.name, username: host.username, welcome_note: host.welcome_note }, eventTypes: ets.rows });
});

app.get("/v1/pages/:username/:slug", async (c) => {
  const { host, et, schedule } = await loadPage(c.req.param("username"), c.req.param("slug"));
  if (!host || !et || !schedule) return err(c, 404, "Page not found.");
  const from = c.req.query("from");
  const fromMs = from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? Date.parse(from + "T12:00:00Z") : Date.now();
  const days = Math.min(+(c.req.query("days") || 31), 62);
  const { tz, days: slotDays } = await computeSlots(et, schedule, fromMs, days);
  return c.json({
    host: { name: host.name, username: host.username, welcome_note: host.welcome_note },
    eventType: {
      id: et.id, title: et.title, slug: et.slug, description: et.description,
      durationMin: et.duration_min, color: et.color, locations: et.locations, questions: et.questions,
      allowReschedule: et.allow_reschedule !== false, allowCancel: et.allow_cancel !== false,
      cancelPolicy: et.cancel_policy || "",
    },
    hostTz: tz,
    days: slotDays,
  });
});

app.post("/v1/holds", async (c) => {
  const k = await requireKey(c, "create-booking");
  if (k?.denied) return err(c, 403, "This key doesn't have the create-booking scope.");
  const { eventTypeId, start } = await c.req.json().catch(() => ({}));
  const startMs = Date.parse(start || "");
  if (!eventTypeId || !startMs) return err(c, 400, "eventTypeId and start (ISO) required.");
  const er = await q(`SELECT * FROM event_types WHERE id=$1`, [eventTypeId]);
  const et = er.rows[0];
  if (!et) return err(c, 404, "Event type not found.");
  let holdUserId = et.user_id;
  if (et.team_id) {
    // team event: find free hosts at this time, pick one now (hold reserves that host)
    const hostIds = (await q(`SELECT user_id FROM event_type_hosts WHERE event_type_id=$1 AND paused=false`, [et.id])).rows.map(r => r.user_id);
    const free = await hostsFreeAt(et, hostIds, startMs);
    const need = et.scheduling_type === "collective" ? hostIds.length : 1;
    if (free.length < need) return err(c, 409, "That time is no longer available.");
    holdUserId = et.scheduling_type === "collective" ? hostIds[0] : await pickHost(et, free);
  } else {
    const sr = await q(`SELECT * FROM schedules WHERE id=$1`, [et.schedule_id]);
    if (!sr.rows[0]) return err(c, 404, "No schedule.");
    if (!(await slotIsAvailable(et, sr.rows[0], startMs))) return err(c, 409, "That time is no longer available.");
  }
  const endMs = startMs + et.duration_min * 60000;
  const r = await q(
    `INSERT INTO holds (event_type_id, user_id, start_at, end_at, expires_at) VALUES ($1,$2,$3,$4, now() + interval '${HOLD_TTL_S} seconds') RETURNING id, expires_at`,
    [et.id, holdUserId, new Date(startMs).toISOString(), new Date(endMs).toISOString()]);
  if (k?.key) logAgentAction(k.key, "hold.created", { eventType: et.slug, start }).catch(() => {});
  return c.json({ holdId: r.rows[0].id, expiresAt: r.rows[0].expires_at }, 201);
});

app.post("/v1/public-bookings", async (c) => {
  const k = await requireKey(c, "create-booking");
  if (k?.denied) return err(c, 403, "This key doesn't have the create-booking scope.");
  const idem = c.req.header("Idempotency-Key");
  if (idem) {
    const hit = await q(`SELECT response FROM idempotency_keys WHERE key=$1`, [idem]);
    if (hit.rows.length) return c.json(hit.rows[0].response);
  }
  const b = await c.req.json().catch(() => ({}));
  const { holdId, eventTypeId, start, name, email, answers, location, agent, principal } = b;
  if (!name || !email) return err(c, 400, "Name and email are required.");

  let et, startMs, assignedHost = null;
  if (holdId) {
    const hr = await q(`SELECT * FROM holds WHERE id=$1 AND expires_at > now()`, [holdId]);
    if (!hr.rows.length) return err(c, 410, "Hold expired — pick the time again.");
    const h = hr.rows[0];
    const er = await q(`SELECT * FROM event_types WHERE id=$1`, [h.event_type_id]);
    et = er.rows[0];
    startMs = h.start_at.getTime();
    assignedHost = h.user_id; // team holds already carry the picked host
  } else {
    const er = await q(`SELECT * FROM event_types WHERE id=$1`, [eventTypeId]);
    et = er.rows[0];
    startMs = Date.parse(start || "");
    if (!et || !startMs) return err(c, 400, "eventTypeId and start required (or a holdId).");
    if (et.team_id) {
      const hostIds = (await q(`SELECT user_id FROM event_type_hosts WHERE event_type_id=$1 AND paused=false`, [et.id])).rows.map(r => r.user_id);
      const free = await hostsFreeAt(et, hostIds, startMs);
      const need = et.scheduling_type === "collective" ? hostIds.length : 1;
      if (free.length < need) return err(c, 409, "That time is no longer available.");
      assignedHost = et.scheduling_type === "collective" ? hostIds[0] : await pickHost(et, free);
    } else {
      const sr = await q(`SELECT * FROM schedules WHERE id=$1`, [et.schedule_id]);
      if (!(await slotIsAvailable(et, sr.rows[0], startMs))) return err(c, 409, "That time is no longer available.");
    }
  }
  const bookAs = assignedHost || et.user_id;
  const endMs = startMs + et.duration_min * 60000;

  const client = await pool.connect();
  let booking;
  try {
    await client.query("BEGIN");
    if (holdId) await client.query(`DELETE FROM holds WHERE id=$1`, [holdId]);
    const r = await client.query(
      `INSERT INTO bookings (event_type_id, user_id, start_at, end_at, invitee_name, invitee_email, answers, location, origin, agent_name, principal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, start_at, end_at, status, cancel_token`,
      [et.id, bookAs, new Date(startMs).toISOString(), new Date(endMs).toISOString(),
        String(name).slice(0, 100), String(email).slice(0, 200), JSON.stringify(answers || {}),
        String(location || (Array.isArray(et.locations) ? et.locations[0] : "") || "").slice(0, 100),
        (agent || k?.key?.kind === "agent") ? "agent" : "human",
        agent ? String(agent).slice(0, 60) : (k?.key?.kind === "agent" ? (k.key.agent_name || k.key.name) : null),
        principal ? String(principal).slice(0, 200) : null]);
    await client.query("COMMIT");
    booking = r.rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    if (e.code === "23P01") { client.release(); return err(c, 409, "That time was just taken."); }
    client.release();
    throw e;
  }
  client.release();
  // write to the host's destination calendar (best effort — booking stands regardless)
  try {
    const dest = (await q(`SELECT * FROM calendar_connections WHERE user_id=$1 AND provider='google' AND status='connected' AND is_destination=true LIMIT 1`, [bookAs])).rows[0];
    if (dest) {
      const host = (await q(`SELECT username FROM users WHERE id=$1`, [bookAs])).rows[0];
      const evId = await G.createEvent(dest, {
        start_at: booking.start_at, end_at: booking.end_at,
        invitee_name: name, invitee_email: email,
        note: Object.values(answers || {}).join(" · "),
      }, et, host);
      await q(`UPDATE bookings SET external_refs = external_refs || $1 WHERE id=$2`,
        [JSON.stringify({ google: { connectionId: dest.id, eventId: evId } }), booking.id]);
    }
  } catch (e) { console.error("calendar write-back:", e.message); }
  sendBookingEmails({ ...booking, invitee_name: name, invitee_email: email, location: String(location || (Array.isArray(et.locations) ? et.locations[0] : "") || "") }, et, bookAs).catch(() => {});
  fireWebhooks(bookAs, "booking.created", { bookingId: booking.id, eventType: et.slug, start: booking.start_at, end: booking.end_at, invitee: { name, email }, origin: agent || k?.key?.kind === "agent" ? "agent" : "human" });
  if (k?.key) logAgentAction(k.key, "booking.created", { eventType: et.slug, start: booking.start_at, invitee: email }).catch(() => {});
  const resp = { bookingId: booking.id, status: booking.status, start: booking.start_at, end: booking.end_at, cancelToken: booking.cancel_token, eventTitle: et.title };
  if (idem) await q(`INSERT INTO idempotency_keys (key, response) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [idem, JSON.stringify(resp)]);
  return c.json(resp, 201);
});

async function removeExternalEvent(bookingId) {
  try {
    const b = (await q(`SELECT external_refs FROM bookings WHERE id=$1`, [bookingId])).rows[0];
    const ref = b?.external_refs?.google;
    if (!ref) return;
    const conn = (await q(`SELECT * FROM calendar_connections WHERE id=$1`, [ref.connectionId])).rows[0];
    if (conn) await G.deleteEvent(conn, ref.eventId);
  } catch (e) { console.error("calendar event delete:", e.message); }
}

// Invitee reads their booking via cancel token (for reschedule page context)
app.get("/v1/public-bookings/:id", async (c) => {
  const token = c.req.query("token") || "";
  const r = await q(
    `SELECT b.id, b.start_at, b.end_at, b.status, b.invitee_name, b.invitee_email,
            et.title, et.slug, et.duration_min, et.allow_reschedule, et.allow_cancel, et.cancel_policy,
            u.username, u.name AS host_name
     FROM bookings b JOIN event_types et ON et.id=b.event_type_id JOIN users u ON u.id=b.user_id
     WHERE b.id=$1 AND b.cancel_token=$2`, [c.req.param("id"), token]);
  if (!r.rows.length) return err(c, 404, "Booking not found.");
  return c.json({ booking: r.rows[0] });
});

app.post("/v1/public-bookings/:id/reschedule", async (c) => {
  const { cancelToken, start, reason } = await c.req.json().catch(() => ({}));
  const startMs = Date.parse(start || "");
  if (!startMs) return err(c, 400, "start (ISO) required.");
  const br = await q(
    `SELECT b.*, et.duration_min, et.schedule_id FROM bookings b JOIN event_types et ON et.id=b.event_type_id
     WHERE b.id=$1 AND b.cancel_token=$2 AND b.status IN ('pending','confirmed')`,
    [c.req.param("id"), cancelToken || ""]);
  const b = br.rows[0];
  if (!b) return err(c, 404, "Booking not found (or already cancelled).");
  const et = (await q(`SELECT * FROM event_types WHERE id=$1`, [b.event_type_id])).rows[0];
  if (et.allow_reschedule === false) return err(c, 403, "The host has disabled rescheduling for this event — contact them directly.");
  const sched = (await q(`SELECT * FROM schedules WHERE id=$1`, [et.schedule_id])).rows[0];
  if (!sched) return err(c, 409, "This event can't be rescheduled right now.");
  const endMs = startMs + et.duration_min * 60000;
  if (!(await slotIsAvailable(et, sched, startMs)) && startMs !== b.start_at.getTime()) {
    return err(c, 409, "That time is no longer available.");
  }
  try {
    await q(
      `UPDATE bookings SET start_at=$1, end_at=$2,
         answers = answers || $3 WHERE id=$4`,
      [new Date(startMs).toISOString(), new Date(endMs).toISOString(),
        JSON.stringify(reason ? { _reschedule_reason: String(reason).slice(0, 300) } : {}), b.id]);
  } catch (e) {
    if (e.code === "23P01") return err(c, 409, "That time was just taken.");
    throw e;
  }
  // move the external calendar event: delete old, create new (best effort)
  try {
    const ref = b.external_refs?.google;
    if (ref) {
      const conn = (await q(`SELECT * FROM calendar_connections WHERE id=$1`, [ref.connectionId])).rows[0];
      if (conn) {
        await G.deleteEvent(conn, ref.eventId).catch(() => {});
        const host = (await q(`SELECT username FROM users WHERE id=$1`, [et.user_id])).rows[0];
        const evId = await G.createEvent(conn, {
          start_at: new Date(startMs), end_at: new Date(endMs),
          invitee_name: b.invitee_name, invitee_email: b.invitee_email,
          note: reason ? `Rescheduled: ${reason}` : "Rescheduled",
        }, et, host);
        await q(`UPDATE bookings SET external_refs = external_refs || $1 WHERE id=$2`,
          [JSON.stringify({ google: { connectionId: conn.id, eventId: evId } }), b.id]);
      }
    }
  } catch (e) { console.error("reschedule calendar sync:", e.message); }
  sendRescheduleEmails(b.id, b.start_at.toISOString()).catch(() => {});
  fireWebhooks(et.user_id, "booking.rescheduled", { bookingId: b.id, former: b.start_at, start: new Date(startMs).toISOString() });
  return c.json({ ok: true, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() });
});

app.post("/v1/public-bookings/:id/cancel", async (c) => {
  const { cancelToken, reason } = await c.req.json().catch(() => ({}));
  const chk = await q(
    `SELECT et.allow_cancel FROM bookings b JOIN event_types et ON et.id=b.event_type_id WHERE b.id=$1 AND b.cancel_token=$2`,
    [c.req.param("id"), cancelToken || ""]);
  if (chk.rows[0] && chk.rows[0].allow_cancel === false) return err(c, 403, "The host has disabled cancellation for this event — contact them directly.");
  const r = await q(
    `UPDATE bookings SET status='cancelled',
       answers = answers || $3
     WHERE id=$1 AND cancel_token=$2 AND status IN ('pending','confirmed') RETURNING id`,
    [c.req.param("id"), cancelToken || "",
      JSON.stringify(reason ? { _cancel_reason: String(reason).slice(0, 300) } : {})]);
  if (!r.rows.length) return err(c, 404, "Booking not found (or already cancelled).");
  await removeExternalEvent(c.req.param("id"));
  sendCancellationEmails(c.req.param("id"), "the invitee").catch(() => {});
  q(`SELECT user_id FROM bookings WHERE id=$1`, [c.req.param("id")]).then(rr => rr.rows[0] && fireWebhooks(rr.rows[0].user_id, "booking.cancelled", { bookingId: c.req.param("id"), by: "invitee" })).catch(() => {});
  return c.json({ ok: true });
});

/* ---------------- reminder loop ---------------- */
async function sendDueReminders() {
  // windows: 24h (23h-25h out, not sent) and 1h (50-70min out, not sent)
  const windows = [
    ["24h", "tomorrow", "start_at BETWEEN now() + interval '23 hours' AND now() + interval '25 hours'", "r24"],
    ["1h", "in about an hour", "start_at BETWEEN now() + interval '50 minutes' AND now() + interval '70 minutes'", "r1"],
  ];
  for (const [, label, cond, flag] of windows) {
    const rows = (await q(
      `SELECT b.id, b.start_at, b.end_at, b.invitee_email, b.location, b.cancel_token,
              et.title, u.name AS host_name, u.username, u.timezone
       FROM bookings b JOIN event_types et ON et.id=b.event_type_id JOIN users u ON u.id=b.user_id
       WHERE b.status='confirmed' AND ${cond} AND NOT (b.reminders_sent ? '${flag}') LIMIT 50`)).rows;
    for (const b of rows) {
      await q(`UPDATE bookings SET reminders_sent = reminders_sent || $1 WHERE id=$2`,
        [JSON.stringify({ [flag]: new Date().toISOString() }), b.id]);
      sendReminder(b, label).catch(() => {});
    }
  }
}

/* ---------------- boot ---------------- */
const port = +(process.env.PORT || 3000);
migrate().then(() => {
  setInterval(() => q(`DELETE FROM holds WHERE expires_at < now() - interval '1 hour'`).catch(() => {}), 600000);
  setInterval(() => q(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '1 day'`).catch(() => {}), 3600000);
  setInterval(() => sendDueReminders().catch(e => console.error("reminders:", e.message)), 300000);
  serve({ fetch: app.fetch, port });
  console.log("bookii-api listening on :" + port);
});
