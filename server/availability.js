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

/* Team slots: compute per-host (each host's default schedule + busy), then
   union (round_robin — any host free) or intersect (collective — all free).
   Returns { tz, days: { dateKey: [{start,end,hosts:[userId]}] } } */
export async function computeTeamSlots(eventType, hostIds, fromMs, days, opts = {}) {
  const perHost = [];
  let tz = "UTC";
  for (const uid of hostIds) {
    const sched = (await q(
      `SELECT * FROM schedules WHERE user_id=$1 ORDER BY is_default DESC, created_at LIMIT 1`, [uid])).rows[0];
    if (!sched) continue;
    tz = sched.timezone; // presentation tz = first host's; slots are ISO anyway
    const r = await computeSlots({ ...eventType, user_id: uid }, sched, fromMs, days, opts);
    perHost.push({ uid, days: r.days });
  }
  if (!perHost.length) return { tz, days: {} };
  const out = {};
  const allKeys = new Set(perHost.flatMap(h => Object.keys(h.days)));
  for (const key of allKeys) {
    const bag = new Map(); // startIso -> {start,end,hosts[]}
    for (const h of perHost) {
      for (const s of h.days[key] || []) {
        const cur = bag.get(s.start) || { start: s.start, end: s.end, hosts: [] };
        cur.hosts.push(h.uid);
        bag.set(s.start, cur);
      }
    }
    const need = eventType.scheduling_type === "collective" ? perHost.length : 1;
    out[key] = [...bag.values()].filter(s => s.hosts.length >= need)
      .sort((a, b) => a.start.localeCompare(b.start))
      .map(s => ({ start: s.start, end: s.end }));
  }
  return { tz, days: out };
}

/* Which hosts are free at a specific start? */
export async function hostsFreeAt(eventType, hostIds, startMs) {
  const free = [];
  for (const uid of hostIds) {
    const sched = (await q(
      `SELECT * FROM schedules WHERE user_id=$1 ORDER BY is_default DESC, created_at LIMIT 1`, [uid])).rows[0];
    if (!sched) continue;
    if (await slotIsAvailable({ ...eventType, user_id: uid }, sched, startMs)) free.push(uid);
  }
  return free;
}

/* Round-robin pick: among free hosts, highest priority wins; ties go to
   least-recently-assigned. */
export async function pickHost(eventType, freeHostIds) {
  if (!freeHostIds.length) return null;
  if (freeHostIds.length === 1) return freeHostIds[0];
  const r = await q(
    `SELECT h.user_id, h.priority, max(b.created_at) AS last_assigned
     FROM event_type_hosts h
     LEFT JOIN bookings b ON b.user_id = h.user_id AND b.event_type_id = h.event_type_id
       AND b.status IN ('pending','confirmed','attended')
     WHERE h.event_type_id=$1 AND h.user_id = ANY($2)
     GROUP BY h.user_id, h.priority
     ORDER BY h.priority DESC, last_assigned ASC NULLS FIRST
     LIMIT 1`, [eventType.id, freeHostIds]);
  return r.rows[0]?.user_id || freeHostIds[0];
}

/* Troubleshooter: explain a single day — rules, busy blocks, and each candidate slot's fate. */
export async function explainDay(eventType, schedule, dateKey, opts = {}) {
  const tz = schedule.timezone;
  const now = opts.nowMs || Date.now();
  const et = eventType;
  const [y, mo, d] = dateKey.split("-").map(Number);
  const dayStart = zonedToUtc(y, mo, d, 0, 0, tz);
  const dayEnd = dayStart + 86400000 + 3600000;

  const [rules, overrides] = await Promise.all([
    q(`SELECT weekday, start_min, end_min FROM schedule_rules WHERE schedule_id=$1`, [schedule.id]),
    q(`SELECT date::text, start_min, end_min FROM date_overrides WHERE schedule_id=$1 AND date=$2`, [schedule.id, dateKey]),
  ]);
  const wd = weekdayInTz(dateKey, tz);
  const hasOverride = overrides.rows.length > 0;
  const ranges = hasOverride
    ? overrides.rows.filter(o => o.start_min !== null).map(o => [o.start_min, o.end_min])
    : rules.rows.filter(r => r.weekday === wd).map(r => [r.start_min, r.end_min]);

  const [bk, hd] = await Promise.all([
    q(`SELECT start_at, end_at, invitee_name FROM bookings WHERE user_id=$1 AND status IN ('pending','confirmed') AND start_at < $3 AND end_at > $2`,
      [et.user_id, new Date(dayStart).toISOString(), new Date(dayEnd).toISOString()]),
    q(`SELECT start_at, end_at FROM holds WHERE user_id=$1 AND expires_at > now() AND start_at < $3 AND end_at > $2`,
      [et.user_id, new Date(dayStart).toISOString(), new Date(dayEnd).toISOString()]),
  ]);
  const external = await providerBusy(et.user_id, dayStart, dayEnd);
  const bookings = bk.rows.map(r => ({ s: r.start_at.getTime(), e: r.end_at.getTime(), who: r.invitee_name }));
  const holdsArr = hd.rows.map(r => ({ s: r.start_at.getTime(), e: r.end_at.getTime() }));

  const step = (et.slot_interval_min || et.duration_min) * 60000;
  const dur = et.duration_min * 60000;
  const notice = now + et.min_notice_min * 60000;
  const windowEnd = now + et.window_days * 86400000;
  const slots = [];
  for (const [sm, em] of ranges) {
    const rs = zonedToUtc(y, mo, d, Math.floor(sm / 60), sm % 60, tz);
    const re = zonedToUtc(y, mo, d, Math.floor(em / 60), em % 60, tz);
    for (let s = rs; s + dur <= re; s += step) {
      const e = s + dur;
      let verdict = "open", detail = null;
      if (s < notice) { verdict = "too_soon"; detail = `inside your ${et.min_notice_min >= 1440 ? Math.round(et.min_notice_min / 1440) + "-day" : Math.round(et.min_notice_min / 60) + "-hour"} minimum notice`; }
      else if (s > windowEnd) { verdict = "beyond_window"; detail = `past your ${et.window_days}-day booking window`; }
      else {
        const hitB = bookings.find(b => overlaps(s - et.buffer_before_min * 60000, e + et.buffer_after_min * 60000, b.s, b.e));
        const hitX = external.find(b => overlaps(s, e, b.s, b.e));
        const hitH = holdsArr.find(h => overlaps(s, e, h.s, h.e));
        if (hitB) { verdict = "booked"; detail = `blocked by your booking with ${hitB.who}${et.buffer_before_min || et.buffer_after_min ? " (incl. buffers)" : ""}`; }
        else if (hitX) { verdict = "calendar_busy"; detail = "busy on a connected calendar"; }
        else if (hitH) { verdict = "held"; detail = "temporarily held by someone booking right now"; }
      }
      slots.push({ start: new Date(s).toISOString(), verdict, detail });
    }
  }
  return {
    tz, dateKey,
    dayInfo: {
      weekday: wd, hasOverride,
      workingRanges: ranges.map(([a, b]) => [a, b]),
      blockedAllDay: hasOverride && !ranges.length,
      noRules: !hasOverride && !ranges.length,
    },
    externalBusy: external.map(b => ({ start: new Date(b.s).toISOString(), end: new Date(b.e).toISOString() })),
    slots,
  };
}

/* Re-validate a single slot right before hold/booking. */
export async function slotIsAvailable(eventType, schedule, startMs, opts = {}) {
  const { days } = await computeSlots(eventType, schedule, startMs - 3600000, 2, opts);
  return Object.values(days).flat().some(s => new Date(s.start).getTime() === startMs);
}
