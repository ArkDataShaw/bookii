/* Bookii availability engine — pure, shared by browser + Netlify Function.
   Computes bookable slots: working hours ∩ ¬busy − buffers − min notice − caps. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.BookiiEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const HOST_TZ = "America/Chicago";
  const HOST = {
    name: "Shaw Cole",
    slug: "shaw",
    city: "Austin",
    tz: HOST_TZ,
    eventType: {
      id: "intro-30",
      title: "Intro call",
      durationMin: 30,
      bufferMin: 15,
      minNoticeMin: 240,
      dailyCap: 6,
      workday: { startH: 9, endH: 17 }, // host-local
      preferred: [{ startH: 10, endH: 12 }], // "works best" windows
      locations: ["Google Meet", "Phone"],
    },
  };

  // --- timezone helpers (no deps) ---
  function tzOffsetMin(tz, utcDate) {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts = {};
    for (const p of dtf.formatToParts(utcDate)) parts[p.type] = p.value;
    const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
      +(parts.hour === "24" ? 0 : parts.hour), +parts.minute, +parts.second);
    return (asUTC - utcDate.getTime()) / 60000;
  }
  // wall time in tz -> UTC ms
  function zonedToUtc(y, mo, d, h, mi, tz) {
    let guess = Date.UTC(y, mo - 1, d, h, mi);
    for (let i = 0; i < 3; i++) {
      const off = tzOffsetMin(tz, new Date(guess));
      const next = Date.UTC(y, mo - 1, d, h, mi) - off * 60000;
      if (next === guess) break;
      guess = next;
    }
    return guess;
  }
  function fmtInTz(ms, tz, opts) {
    return new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: tz }, opts)).format(new Date(ms));
  }
  function dateKeyInTz(ms, tz) {
    const p = {};
    for (const x of new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms))) p[x.type] = x.value;
    return p.year + "-" + p.month + "-" + p.day;
  }

  // --- deterministic busy blocks per host-local date (simulates external calendars) ---
  function seededRand(seed) {
    let s = 0;
    for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
    return function () { s = (s * 1103515245 + 12345) >>> 0; return (s >>> 8) / 16777216; };
  }
  function busyBlocksFor(dateKey) {
    // dateKey = YYYY-MM-DD (host-local). Returns [{startMs,endMs,source}]
    const [y, mo, d] = dateKey.split("-").map(Number);
    const rnd = seededRand("bookii:" + dateKey);
    const n = 2 + Math.floor(rnd() * 3); // 2-4 blocks
    const blocks = [];
    const sources = ["Google · work", "Outlook · client", "iCloud · personal"];
    for (let i = 0; i < n; i++) {
      const startH = 8 + Math.floor(rnd() * 9); // 8..16
      const startM = rnd() < 0.5 ? 0 : 30;
      const durMin = [30, 45, 60, 90][Math.floor(rnd() * 4)];
      const s = zonedToUtc(y, mo, d, startH, startM, HOST_TZ);
      blocks.push({ startMs: s, endMs: s + durMin * 60000, source: sources[Math.floor(rnd() * 3)] });
    }
    return blocks;
  }
  // simulated *invitee* calendar for the overlay demo
  function inviteeBusyFor(dateKey, viewerTz) {
    const [y, mo, d] = dateKey.split("-").map(Number);
    const rnd = seededRand("invitee:" + dateKey);
    const n = 1 + Math.floor(rnd() * 3);
    const blocks = [];
    for (let i = 0; i < n; i++) {
      const startH = 9 + Math.floor(rnd() * 8);
      const startM = rnd() < 0.5 ? 0 : 30;
      const durMin = [30, 60, 90][Math.floor(rnd() * 3)];
      const s = zonedToUtc(y, mo, d, startH, startM, viewerTz || HOST_TZ);
      blocks.push({ startMs: s, endMs: s + durMin * 60000 });
    }
    return blocks;
  }

  function overlaps(aS, aE, bS, bE) { return aS < bE && bS < aE; }

  /* Core: slots for one host-local date.
     opts: { nowMs, bookings:[{startMs,endMs}], holds:[{startMs,endMs,expiresAt}] } */
  function slotsForDate(dateKey, opts) {
    opts = opts || {};
    const now = opts.nowMs || Date.now();
    const et = HOST.eventType;
    const [y, mo, d] = dateKey.split("-").map(Number);
    const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    if (dow === 0 || dow === 6) return []; // weekends off
    const busy = busyBlocksFor(dateKey);
    const bookings = (opts.bookings || []).filter(b => dateKeyInTz(b.startMs, HOST_TZ) === dateKey);
    if (bookings.length >= et.dailyCap) return [];
    const holds = (opts.holds || []).filter(h => h.expiresAt > now);
    const out = [];
    for (let h = et.workday.startH; h < et.workday.endH; h++) {
      for (const mi of [0, 30]) {
        const s = zonedToUtc(y, mo, d, h, mi, HOST_TZ);
        const e = s + et.durationMin * 60000;
        if (s < now + et.minNoticeMin * 60000) continue;
        const endWork = zonedToUtc(y, mo, d, et.workday.endH, 0, HOST_TZ);
        if (e > endWork) continue;
        let blocked = busy.some(b => overlaps(s, e, b.startMs, b.endMs));
        if (!blocked) blocked = bookings.some(b =>
          overlaps(s - et.bufferMin * 60000, e + et.bufferMin * 60000, b.startMs, b.endMs));
        const held = !blocked && holds.some(hh => overlaps(s, e, hh.startMs, hh.endMs));
        if (blocked) continue;
        const preferred = et.preferred.some(p => h >= p.startH && h < p.endH);
        out.push({ start: new Date(s).toISOString(), startMs: s, endMs: e, preferred, held: held || false,
          holdId: held ? (holds.find(hh => overlaps(s, e, hh.startMs, hh.endMs)) || {}).id : undefined });
      }
    }
    return out;
  }

  function availableDays(fromMs, days, opts) {
    const res = {};
    for (let i = 0; i < days; i++) {
      const key = dateKeyInTz(fromMs + i * 86400000, HOST_TZ);
      res[key] = slotsForDate(key, opts).filter(s => !s.held).length;
    }
    return res;
  }

  return { HOST, HOST_TZ, slotsForDate, availableDays, busyBlocksFor, inviteeBusyFor,
    zonedToUtc, fmtInTz, dateKeyInTz, tzOffsetMin, overlaps };
});
