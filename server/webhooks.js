import { createHmac } from "crypto";
import { q } from "./db.js";

/* Deliver an event to all matching active webhooks for a user. Fire-and-forget. */
export async function fireWebhooks(userId, event, payload) {
  try {
    const hooks = (await q(
      `SELECT * FROM webhooks WHERE user_id=$1 AND active=true AND $2 = ANY(events)`, [userId, event])).rows;
    for (const h of hooks) deliver(h, event, payload).catch(() => {});
  } catch (e) { console.error("webhook query:", e.message); }
}

export async function deliver(hook, event, payload) {
  const body = JSON.stringify({ event, created_at: new Date().toISOString(), data: payload });
  const sig = createHmac("sha256", hook.secret).update(body).digest("hex");
  let statusCode = null, responseText = "", ok = false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    const res = await fetch(hook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bookii-Event": event,
        "X-Bookii-Signature": "sha256=" + sig,
      },
      body,
      signal: ctl.signal,
    });
    clearTimeout(t);
    statusCode = res.status;
    ok = res.ok;
    responseText = (await res.text().catch(() => "")).slice(0, 500);
  } catch (e) {
    responseText = String(e.message).slice(0, 500);
  }
  await q(
    `INSERT INTO webhook_deliveries (webhook_id, event, payload, status_code, response, ok) VALUES ($1,$2,$3,$4,$5,$6)`,
    [hook.id, event, JSON.stringify(payload), statusCode, responseText, ok]).catch(() => {});
  return { statusCode, ok, responseText };
}
