import { q } from "./db.js";

const FROM = process.env.EMAIL_FROM || "Bookii <notifications@bookii.to>";
export const emailReady = () => !!process.env.RESEND_API_KEY;

async function send(to, subject, html) {
  if (!emailReady()) { console.log(`[email skipped — no RESEND_API_KEY] to=${to} subj="${subject}"`); return false; }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [to], subject, html }),
    });
    if (!res.ok) console.error("email send failed:", res.status, await res.text().catch(() => ""));
    return res.ok;
  } catch (e) { console.error("email send error:", e.message); return false; }
}

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function layout(inner) {
  return `<!doctype html><body style="margin:0;background:#F1F2EF;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1A1E2E">
  <div style="max-width:520px;margin:0 auto;padding:32px 20px">
    <p style="font-family:Georgia,serif;font-weight:600;font-size:20px;margin:0 0 20px">bookii<span style="color:#2B3EE5">.</span></p>
    <div style="background:#FAFAF8;border:1px solid #DBDCD4;border-radius:14px;padding:24px">${inner}</div>
    <p style="font-size:12px;color:#9a9c96;margin:16px 4px">Sent by Bookii · <a href="https://bookii.to/privacy" style="color:#9a9c96">privacy</a></p>
  </div></body>`;
}

function whenBlock(startIso, endIso, tz, tzLabel) {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(new Date(startIso));
  const t = iso => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  return `<p style="font-size:17px;font-weight:600;margin:4px 0">${day}</p>
    <p style="font-size:15px;margin:2px 0 0">${t(startIso)} – ${t(endIso)} <span style="color:#6b6e78">(${esc(tzLabel || tz)})</span></p>`;
}

const btn = (href, label) =>
  `<a href="${href}" style="display:inline-block;background:#2B3EE5;color:#fff;text-decoration:none;border-radius:999px;padding:10px 22px;font-size:14px;font-weight:600;margin-top:14px">${label}</a>`;
const links = (b) => {
  const base = "https://from.bookii.to/app.html";
  return `<p style="font-size:13px;color:#6b6e78;margin-top:18px">
    <a href="${base}#/reschedule/${b.id}/${b.cancel_token}" style="color:#2B3EE5">Reschedule</a> ·
    <a href="${base}#/cancel/${b.id}/${b.cancel_token}" style="color:#2B3EE5">Cancel</a></p>`;
};

/* ------- host prefs helper ------- */
async function hostWants(userId, kind) {
  const r = await q(`SELECT email, name, notify_prefs, timezone FROM users WHERE id=$1`, [userId]);
  const u = r.rows[0];
  if (!u) return null;
  const p = u.notify_prefs || {};
  if (kind === "booked" && p.booked === false) return null;
  if (kind === "cancelled" && p.cancelled === false) return null;
  return u;
}

export async function sendReminder(bookingRow, label) {
  const b = bookingRow;
  return send(b.invitee_email,
    `Reminder: ${b.title} ${label} — ${new Intl.DateTimeFormat("en-US", { timeZone: b.timezone, hour: "numeric", minute: "2-digit" }).format(new Date(b.start_at))}`,
    layout(`<p style="margin:0 0 4px;color:#2B3EE5;font-size:13px;font-weight:600">Coming up ${label}</p>
      <h2 style="font-family:Georgia,serif;margin:0 0 12px;font-size:22px">${esc(b.title)} with ${esc(b.host_name || b.username)}</h2>
      ${whenBlock(b.start_at, b.end_at, b.timezone, b.timezone)}
      ${b.location ? `<p style="font-size:14px;color:#6b6e78;margin-top:10px">Where: ${esc(b.location)}</p>` : ""}
      ${links(b)}`));
}

export async function sendTeamInvite(to, teamName, inviterName, role, url) {
  return send(to, `${inviterName || "A teammate"} invited you to ${teamName} on Bookii`,
    layout(`<p style="margin:0 0 4px;color:#2B3EE5;font-size:13px;font-weight:600">Team invitation</p>
      <h2 style="font-family:Georgia,serif;margin:0 0 12px;font-size:22px">Join ${esc(teamName)}</h2>
      <p style="font-size:15px;margin:0 0 8px">${esc(inviterName || "A teammate")} invited you to join <strong>${esc(teamName)}</strong> as ${esc(role)}. You'll share team booking pages and, if added as a host, take meetings in the rotation.</p>
      ${btn(url, "Accept invitation")}
      <p style="font-size:12px;color:#9a9c96;margin-top:16px">This invite expires in 7 days. If you weren't expecting it, you can ignore it.</p>`));
}

/* ------- auth emails ------- */
export async function sendMagicLink(to, url) {
  return send(to, "Your Bookii sign-in link",
    layout(`<p style="margin:0 0 8px;font-size:15px">Click to sign in to Bookii. This link works once and expires in 15 minutes.</p>
      ${btn(url, "Sign in to Bookii")}
      <p style="font-size:12px;color:#9a9c96;margin-top:16px">If you didn't request this, you can ignore it.</p>`));
}
export async function sendPasswordReset(to, url) {
  return send(to, "Reset your Bookii password",
    layout(`<p style="margin:0 0 8px;font-size:15px">Click to set a new password. This link works once and expires in 15 minutes.</p>
      ${btn(url, "Reset password")}
      <p style="font-size:12px;color:#9a9c96;margin-top:16px">If you didn't request this, your account is safe — ignore this email.</p>`));
}

/* ------- public API ------- */
export async function sendBookingEmails(booking, et, hostUserId) {
  const host = (await q(`SELECT email, name, username, timezone, notify_prefs FROM users WHERE id=$1`, [hostUserId])).rows[0];
  if (!host) return;
  // invitee confirmation (always)
  await send(booking.invitee_email,
    `Confirmed: ${et.title} with ${host.name || host.username} — ${new Intl.DateTimeFormat("en-US", { timeZone: host.timezone, month: "short", day: "numeric" }).format(new Date(booking.start_at))}`,
    layout(`<p style="margin:0 0 4px;color:#6b6e78;font-size:13px">You're booked with ${esc(host.name || host.username)}</p>
      <h2 style="font-family:Georgia,serif;margin:0 0 12px;font-size:22px">${esc(et.title)}</h2>
      ${whenBlock(booking.start_at, booking.end_at, host.timezone, host.timezone)}
      ${booking.location ? `<p style="font-size:14px;color:#6b6e78;margin-top:10px">Where: ${esc(booking.location)}</p>` : ""}
      ${links(booking)}`));
  // host notice (pref-gated)
  if ((host.notify_prefs || {}).booked !== false) {
    await send(host.email,
      `New booking: ${booking.invitee_name} — ${et.title}`,
      layout(`<p style="margin:0 0 4px;color:#6b6e78;font-size:13px">New booking</p>
        <h2 style="font-family:Georgia,serif;margin:0 0 12px;font-size:22px">${esc(booking.invitee_name)} · ${esc(et.title)}</h2>
        ${whenBlock(booking.start_at, booking.end_at, host.timezone, "your time")}
        <p style="font-size:14px;margin-top:10px">${esc(booking.invitee_email)}</p>
        ${btn("https://from.bookii.to/app.html#/meetings", "Open meetings")}`));
  }
}

export async function sendCancellationEmails(bookingId, cancelledBy) {
  const r = await q(
    `SELECT b.*, et.title, u.id AS host_id, u.email AS host_email, u.name AS host_name, u.username, u.timezone, u.notify_prefs
     FROM bookings b JOIN event_types et ON et.id=b.event_type_id JOIN users u ON u.id=b.user_id WHERE b.id=$1`, [bookingId]);
  const b = r.rows[0];
  if (!b) return;
  const reason = (b.answers || {})._cancel_reason;
  const inner = (who) => layout(`<p style="margin:0 0 4px;color:#B3261E;font-size:13px;font-weight:600">Cancelled</p>
    <h2 style="font-family:Georgia,serif;margin:0 0 12px;font-size:22px">${esc(b.title)}</h2>
    ${whenBlock(b.start_at, b.end_at, b.timezone, b.timezone)}
    <p style="font-size:14px;color:#6b6e78;margin-top:10px">Cancelled by ${esc(cancelledBy)}${reason ? ` — “${esc(reason)}”` : ""}</p>
    ${who === "invitee" ? btn(`https://from.bookii.to/${b.username}`, "Book a new time") : ""}`);
  await send(b.invitee_email, `Cancelled: ${b.title}`, inner("invitee"));
  if ((b.notify_prefs || {}).cancelled !== false) {
    await send(b.host_email, `Cancelled: ${b.invitee_name} — ${b.title}`, inner("host"));
  }
}

export async function sendRescheduleEmails(bookingId, formerStartIso) {
  const r = await q(
    `SELECT b.*, et.title, u.email AS host_email, u.name AS host_name, u.username, u.timezone, u.notify_prefs
     FROM bookings b JOIN event_types et ON et.id=b.event_type_id JOIN users u ON u.id=b.user_id WHERE b.id=$1`, [bookingId]);
  const b = r.rows[0];
  if (!b) return;
  const fmt = iso => new Intl.DateTimeFormat("en-US", { timeZone: b.timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  // explicitly framed as a move, not a cancellation (top Calendly complaint)
  const inner = layout(`<p style="margin:0 0 4px;color:#2B3EE5;font-size:13px;font-weight:600">New time — same meeting</p>
    <h2 style="font-family:Georgia,serif;margin:0 0 12px;font-size:22px">${esc(b.title)}</h2>
    <p style="font-size:14px;color:#6b6e78;margin:0"><s>${fmt(formerStartIso)}</s></p>
    ${whenBlock(b.start_at, b.end_at, b.timezone, b.timezone)}
    ${links(b)}`);
  await send(b.invitee_email, `Moved: ${b.title} — now ${fmt(b.start_at)}`, inner);
  if ((b.notify_prefs || {}).cancelled !== false) {
    await send(b.host_email, `Rescheduled: ${b.invitee_name} — ${b.title}`, inner);
  }
}
