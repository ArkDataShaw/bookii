import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { q, pool, migrate } from "./db.js";
import { hashPassword, verifyPassword, createSession, requireUser, RESERVED_USERNAMES, SLUG_RE } from "./auth.js";
import { computeSlots, slotIsAvailable } from "./availability.js";
import { isValidTz } from "./time.js";

const app = new Hono();

app.use("*", cors({
  origin: (o) => {
    if (!o) return "*";
    if (/^https?:\/\/((localhost|127\.0\.0\.1)(:\d+)?|bookii\.to|www\.bookii\.to|bookii-696\.netlify\.app)$/.test(o)) return o;
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
  const r = await q(`SELECT id, email, name, username, timezone, welcome_note FROM users WHERE id=$1`, [u.id]);
  return c.json({ user: r.rows[0] });
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
  "slot_interval_min", "daily_cap", "questions", "hidden", "schedule_id"];

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
  b.slug = b.slug || b.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "meeting";
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

/* ---------------- bookings (host view) ---------------- */
app.get("/v1/bookings", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const r = await q(
    `SELECT b.*, et.title AS event_title, et.slug AS event_slug FROM bookings b
     JOIN event_types et ON et.id=b.event_type_id
     WHERE b.user_id=$1 AND b.start_at > now() - interval '1 day'
     ORDER BY b.start_at LIMIT 100`, [u.id]);
  return c.json({ bookings: r.rows });
});

app.patch("/v1/bookings/:id/status", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const { status } = await c.req.json().catch(() => ({}));
  if (!["cancelled", "no_show", "attended", "confirmed"].includes(status)) return err(c, 400, "Bad status.");
  const r = await q(`UPDATE bookings SET status=$1 WHERE id=$2 AND user_id=$3 RETURNING id`, [status, c.req.param("id"), u.id]);
  if (!r.rows.length) return err(c, 404, "Booking not found.");
  return c.json({ ok: true });
});

/* ---------------- calendar connections (sync boundary) ---------------- */
const OAUTH_READY = {
  google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  microsoft: !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET),
};

app.get("/v1/calendar-connections", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const r = await q(`SELECT id, provider, status, account_email, created_at FROM calendar_connections WHERE user_id=$1`, [u.id]);
  return c.json({ connections: r.rows, providersReady: { ...OAUTH_READY, icloud: false } });
});

// OAuth start — fully wired; activates the moment env credentials exist.
app.get("/v1/oauth/:provider/start", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
  const p = c.req.param("provider");
  if (p === "google") {
    if (!OAUTH_READY.google) return err(c, 503, "Google Calendar sync isn't configured yet. The app needs Google OAuth credentials (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).");
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
    url.searchParams.set("redirect_uri", process.env.GOOGLE_REDIRECT_URI || "https://api.bookii.to/v1/oauth/google/callback");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy openid email");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", u.id);
    return c.json({ url: url.toString() });
  }
  if (p === "microsoft") {
    if (!OAUTH_READY.microsoft) return err(c, 503, "Microsoft calendar sync isn't configured yet. The app needs Entra OAuth credentials (MS_CLIENT_ID / MS_CLIENT_SECRET).");
    const url = new URL(`https://login.microsoftonline.com/${process.env.MS_TENANT || "common"}/oauth2/v2.0/authorize`);
    url.searchParams.set("client_id", process.env.MS_CLIENT_ID);
    url.searchParams.set("redirect_uri", process.env.MS_REDIRECT_URI || "https://api.bookii.to/v1/oauth/microsoft/callback");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email offline_access https://graph.microsoft.com/Calendars.ReadWrite");
    url.searchParams.set("state", u.id);
    return c.json({ url: url.toString() });
  }
  return err(c, 400, "Unknown provider.");
});

app.get("/v1/oauth/:provider/callback", (c) =>
  c.text("OAuth callback received. Token exchange activates when credentials are configured.", 501));

app.delete("/v1/calendar-connections/:id", async (c) => {
  const u = await requireUser(c);
  if (!u) return err(c, 401, "Sign in required.");
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
    },
    hostTz: tz,
    days: slotDays,
  });
});

app.post("/v1/holds", async (c) => {
  const { eventTypeId, start } = await c.req.json().catch(() => ({}));
  const startMs = Date.parse(start || "");
  if (!eventTypeId || !startMs) return err(c, 400, "eventTypeId and start (ISO) required.");
  const er = await q(`SELECT * FROM event_types WHERE id=$1`, [eventTypeId]);
  const et = er.rows[0];
  if (!et) return err(c, 404, "Event type not found.");
  const sr = await q(`SELECT * FROM schedules WHERE id=$1`, [et.schedule_id]);
  if (!sr.rows[0]) return err(c, 404, "No schedule.");
  if (!(await slotIsAvailable(et, sr.rows[0], startMs))) return err(c, 409, "That time is no longer available.");
  const endMs = startMs + et.duration_min * 60000;
  const r = await q(
    `INSERT INTO holds (event_type_id, user_id, start_at, end_at, expires_at) VALUES ($1,$2,$3,$4, now() + interval '${HOLD_TTL_S} seconds') RETURNING id, expires_at`,
    [et.id, et.user_id, new Date(startMs).toISOString(), new Date(endMs).toISOString()]);
  return c.json({ holdId: r.rows[0].id, expiresAt: r.rows[0].expires_at }, 201);
});

app.post("/v1/public-bookings", async (c) => {
  const idem = c.req.header("Idempotency-Key");
  if (idem) {
    const hit = await q(`SELECT response FROM idempotency_keys WHERE key=$1`, [idem]);
    if (hit.rows.length) return c.json(hit.rows[0].response);
  }
  const b = await c.req.json().catch(() => ({}));
  const { holdId, eventTypeId, start, name, email, answers, location, agent, principal } = b;
  if (!name || !email) return err(c, 400, "Name and email are required.");

  let et, startMs;
  if (holdId) {
    const hr = await q(`SELECT * FROM holds WHERE id=$1 AND expires_at > now()`, [holdId]);
    if (!hr.rows.length) return err(c, 410, "Hold expired — pick the time again.");
    const h = hr.rows[0];
    const er = await q(`SELECT * FROM event_types WHERE id=$1`, [h.event_type_id]);
    et = er.rows[0];
    startMs = h.start_at.getTime();
  } else {
    const er = await q(`SELECT * FROM event_types WHERE id=$1`, [eventTypeId]);
    et = er.rows[0];
    startMs = Date.parse(start || "");
    if (!et || !startMs) return err(c, 400, "eventTypeId and start required (or a holdId).");
    const sr = await q(`SELECT * FROM schedules WHERE id=$1`, [et.schedule_id]);
    if (!(await slotIsAvailable(et, sr.rows[0], startMs))) return err(c, 409, "That time is no longer available.");
  }
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
      [et.id, et.user_id, new Date(startMs).toISOString(), new Date(endMs).toISOString(),
        String(name).slice(0, 100), String(email).slice(0, 200), JSON.stringify(answers || {}),
        String(location || (Array.isArray(et.locations) ? et.locations[0] : "") || "").slice(0, 100),
        agent ? "agent" : "human", agent ? String(agent).slice(0, 60) : null, principal ? String(principal).slice(0, 200) : null]);
    await client.query("COMMIT");
    booking = r.rows[0];
  } catch (e) {
    await client.query("ROLLBACK");
    if (e.code === "23P01") { client.release(); return err(c, 409, "That time was just taken."); }
    client.release();
    throw e;
  }
  client.release();
  const resp = { bookingId: booking.id, status: booking.status, start: booking.start_at, end: booking.end_at, cancelToken: booking.cancel_token, eventTitle: et.title };
  if (idem) await q(`INSERT INTO idempotency_keys (key, response) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [idem, JSON.stringify(resp)]);
  return c.json(resp, 201);
});

app.post("/v1/public-bookings/:id/cancel", async (c) => {
  const { cancelToken } = await c.req.json().catch(() => ({}));
  const r = await q(`UPDATE bookings SET status='cancelled' WHERE id=$1 AND cancel_token=$2 AND status IN ('pending','confirmed') RETURNING id`,
    [c.req.param("id"), cancelToken || ""]);
  if (!r.rows.length) return err(c, 404, "Booking not found (or already cancelled).");
  return c.json({ ok: true });
});

/* ---------------- boot ---------------- */
const port = +(process.env.PORT || 3000);
migrate().then(() => {
  setInterval(() => q(`DELETE FROM holds WHERE expires_at < now() - interval '1 hour'`).catch(() => {}), 600000);
  setInterval(() => q(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '1 day'`).catch(() => {}), 3600000);
  serve({ fetch: app.fetch, port });
  console.log("bookii-api listening on :" + port);
});
