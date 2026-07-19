// GET /api/slots?date=YYYY-MM-DD&tz=America/Chicago
// Live, curl-able availability from the same engine the human page uses.
const E = require("../../engine.js");

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=30",
    "X-Bookii-Surface": "agent",
  };
  const date = q.date || E.dateKeyInTz(Date.now() + 86400000, E.HOST_TZ);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "date must be YYYY-MM-DD" }) };
  }
  const tz = q.tz || "UTC";
  let slots;
  try {
    slots = E.slotsForDate(date, { nowMs: Date.now(), bookings: [], holds: [] });
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "invalid date or tz" }) };
  }
  const body = {
    page: "bookii.to/shaw/intro",
    eventType: { id: "intro-30", title: "Intro call", durationMin: 30, host: "Shaw Cole", hostTz: E.HOST_TZ },
    date,
    tz,
    slots: slots.map(s => ({
      start: s.start,
      local: E.fmtInTz(s.startMs, tz === "UTC" ? "UTC" : tz, { hour: "numeric", minute: "2-digit", timeZoneName: "short" }),
      preferred: s.preferred,
    })),
    next: {
      hold: "POST /v1/holds {eventType, start, ttlSeconds} — two-phase booking; holds arbitrate races between humans and agents (demo: client-side in the prototype)",
      docs: "/llms.txt",
      openapi: "/openapi.json",
      agentCard: "/.well-known/agent.json",
    },
  };
  return { statusCode: 200, headers, body: JSON.stringify(body, null, 2) };
};
