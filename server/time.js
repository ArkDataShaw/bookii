// Timezone helpers — IANA-zone-correct without dependencies.

export function tzOffsetMin(tz, utcDate) {
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

// wall time (y,mo,d,h,mi) in tz -> UTC ms
export function zonedToUtc(y, mo, d, h, mi, tz) {
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const off = tzOffsetMin(tz, new Date(guess));
    const next = Date.UTC(y, mo - 1, d, h, mi) - off * 60000;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

export function dateKeyInTz(ms, tz) {
  const p = {};
  for (const x of new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

export function weekdayInTz(dateKey, tz) {
  const [y, mo, d] = dateKey.split("-").map(Number);
  // noon UTC avoids date-boundary issues for any tz
  const ms = Date.UTC(y, mo - 1, d, 12);
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(ms));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

export function isValidTz(tz) {
  if (!tz || typeof tz !== "string") return false; // Intl treats undefined as "use default" — reject it
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; }
  catch { return false; }
}
