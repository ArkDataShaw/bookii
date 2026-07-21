import { q } from "./db.js";
import { zonedToUtc, dateKeyInTz, weekdayInTz } from "./time.js";
import * as G from "./google.js";

const overlaps = (aS, aE, bS, bE) => aS < bE && bS < aE;

/* External-calendar busy times, cached 60s per user+window. */
const busyCache = new Map();
async function providerBusy(userId, loMs, hiMs) {
  const key = `${userId}:${Math.floor(loMs / 3600000)}:${Math.floor(hiMs / 3600000)}`;
  const hit = busyCache.get(key);
  if (hit && hit.at > Date.now() - 60000) return hit.busy;
  const conns = (await q(
    `SELECT * FROM calendar_connections WHERE user_id=$1 AND provider='google' AND status='connected'`, [userId])).rows;
  let busy = [];
  for (const conn of conns) {
    try {
      busy = busy.concat(await G.freeBusy(conn, loMs, hiMs));
    } catch (e) {
      // stale cache is better than blocking the page; needs_reauth already flagged by google.js
      const prev = busyCache.get(key);
      if (prev) busy = busy.concat(prev.busy);
    }
  }
  busyCache.set(key, { at: Date.now(), busy });
  if (busyCache.size > 500) busyCache.delete(busyCache.keys().next().value);
  return busy;
}

/* Compute bookable slots for an event type across [fromKey..], `days` calendar days
   in the schedule's timezone. Returns { tz, days: { dateKey: [{start,end,startMs}] } } */
export async function computeSlots(eventType, schedule, fromMs, days, opts = {}) {
  const tz = schedule.timezone;
  const now = opts.nowMs || Date.now();
  const et = eventType;
  const step = (et.slot_interval_min || et.duration_min) * 60000;
  const dur = et.duration_min * 60000;
  const notice = now + et.min_notice_min * 60000;
  const windowEnd = now + et.window_days * 86400000;

  const [rules, overrides] = await Promise.all([
    q(`SELECT weekday, start_min, end_min FROM schedule_rules WHERE schedule_id=$1`, [schedule.id]),
    q(`SELECT date::text, start_min, end_min FROM date_overrides WHERE schedule_id=$1`, [schedule.id]),
  ]);
  const ovByDate = {};
  for (const o of overrides.rows) (ovByDate[o.date] ||= []).push(o);

  // busy = host's confirmed/pending bookings (any event type) + active holds, window-scoped
  const lo = new Date(fromMs - 86400000).toISOString();
  const hi = new Date(fromMs + (days + 1) * 86400000).toISOString();
  const [bk, hd] = await Promise.all([
    q(`SELECT start_at, end_at FROM bookings WHERE user_id=$1 AND status IN ('pending','confirmed') AND start_at < $3 AND end_at > $2`, [et.user_id, lo, hi]),
    q(`SELECT start_at, end_at FROM holds WHERE user_id=$1 AND expires_at > now() AND start_at < $3 AND end_at > $2`, [et.user_id, lo, hi]),
  ]);
  const busy = bk.rows.map(r => ({
    s: r.start_at.getTime() - et.buffer_before_min * 60000,
    e: r.end_at.getTime() + et.buffer_after_min * 60000,
  })).concat(await providerBusy(et.user_id, Date.parse(lo), Date.parse(hi)));
  const held = hd.rows.map(r => ({ s: r.start_at.getTime(), e: r.end_at.getTime() }));
  const bookedPerDay = {};
  for (const r of bk.rows) {
    const k = dateKeyInTz(r.start_at.getTime(), tz);
    bookedPerDay[k] = (bookedPerDay[k] || 0) + 1;
  }

  const out = {};
  for (let i = 0; i < days; i++) {
    const key = dateKeyInTz(fromMs + i * 86400000, tz);
    const [y, mo, d] = key.split("-").map(Number);
    let ranges;
    if (ovByDate[key]) {
      ranges = ovByDate[key]
        .filter(o => o.start_min !== null)
        .map(o => [o.start_min, o.end_min]);
    } else {
      const wd = weekdayInTz(key, tz);
      ranges = rules.rows.filter(r => r.weekday === wd).map(r => [r.start_min, r.end_min]);
    }
    const slots = [];
    if ((et.daily_cap == null || (bookedPerDay[key] || 0) < et.daily_cap)) {
      for (const [sm, em] of ranges) {
        const rangeStart = zonedToUtc(y, mo, d, Math.floor(sm / 60), sm % 60, tz);
        const rangeEnd = zonedToUtc(y, mo, d, Math.floor(em / 60), em % 60, tz);
        for (let s = rangeStart; s + dur <= rangeEnd; s += step) {
          const e = s + dur;
          if (s < notice || s > windowEnd) continue;
          if (busy.some(b => overlaps(s, e, b.s, b.e))) continue;
          if (held.some(h => overlaps(s, e, h.s, h.e))) continue;
          slots.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString() });
        }
      }
    }
    out[key] = slots;
  }
  return { tz, days: out };
}

/* Re-validate a single slot right before hold/booking. */
export async function slotIsAvailable(eventType, schedule, startMs, opts = {}) {
  const { days } = await computeSlots(eventType, schedule, startMs - 3600000, 2, opts);
  return Object.values(days).flat().some(s => new Date(s.start).getTime() === startMs);
}
