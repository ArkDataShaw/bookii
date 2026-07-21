import { q } from "./db.js";
import { encrypt, decrypt } from "./crypto.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export const googleReady = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
export const redirectUri = () => process.env.GOOGLE_REDIRECT_URI || "https://api.bookii.to/v1/oauth/google/callback";

export function authUrl(state) {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.freebusy openid email");
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  return u.toString();
}

async function tokenPost(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error_description || data.error || "token exchange failed"), { code: data.error });
  return data;
}

export async function exchangeCode(code) {
  return tokenPost({
    code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(), grant_type: "authorization_code",
  });
}

/* Returns a valid access token for a connection, refreshing if needed. */
export async function accessTokenFor(conn) {
  if (conn.enc_access_token && conn.access_expires_at && new Date(conn.access_expires_at).getTime() > Date.now() + 60000) {
    return decrypt(conn.enc_access_token);
  }
  if (!conn.enc_refresh_token) throw Object.assign(new Error("no refresh token"), { needsReauth: true });
  try {
    const t = await tokenPost({
      refresh_token: decrypt(conn.enc_refresh_token),
      client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: "refresh_token",
    });
    await q(`UPDATE calendar_connections SET enc_access_token=$1, access_expires_at=$2, status='connected' WHERE id=$3`,
      [encrypt(t.access_token), new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString(), conn.id]);
    return t.access_token;
  } catch (e) {
    if (e.code === "invalid_grant") {
      await q(`UPDATE calendar_connections SET status='needs_reauth' WHERE id=$1`, [conn.id]);
      e.needsReauth = true;
    }
    throw e;
  }
}

async function gapi(token, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `google api ${res.status}`);
  return data;
}

/* Busy intervals [{s,e}] (ms) for the connection's primary calendar. */
export async function freeBusy(conn, fromMs, toMs) {
  const token = await accessTokenFor(conn);
  const data = await gapi(token, "POST", "https://www.googleapis.com/calendar/v3/freeBusy", {
    timeMin: new Date(fromMs).toISOString(),
    timeMax: new Date(toMs).toISOString(),
    items: [{ id: "primary" }],
  });
  return (data.calendars?.primary?.busy || []).map(b => ({ s: Date.parse(b.start), e: Date.parse(b.end) }));
}

export async function createEvent(conn, booking, eventType, host) {
  const token = await accessTokenFor(conn);
  const ev = await gapi(token, "POST",
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all", {
      summary: `${eventType.title} — ${booking.invitee_name}`,
      description: [booking.note, `Booked via Bookii · from.bookii.to/${host.username}/${eventType.slug}`].filter(Boolean).join("\n\n"),
      start: { dateTime: new Date(booking.start_at).toISOString() },
      end: { dateTime: new Date(booking.end_at).toISOString() },
      attendees: [{ email: booking.invitee_email, displayName: booking.invitee_name }],
      reminders: { useDefault: true },
    });
  return ev.id;
}

export async function deleteEvent(conn, eventId) {
  const token = await accessTokenFor(conn);
  await gapi(token, "DELETE", `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`);
}

export async function revoke(conn) {
  try {
    const t = conn.enc_refresh_token ? decrypt(conn.enc_refresh_token) : (conn.enc_access_token ? decrypt(conn.enc_access_token) : null);
    if (t) await fetch(REVOKE_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: t }),
    });
  } catch { /* best effort */ }
}
