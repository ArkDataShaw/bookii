/* Bookii prototype app — shared live state between the invitee page,
   the agent console, and the host view (localStorage + BroadcastChannel). */
(function () {
  const E = window.BookiiEngine;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = v => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------------- state ---------------- */
  const KEY = "bookii-state-v1";
  const chan = "BroadcastChannel" in window ? new BroadcastChannel("bookii") : null;
  function loadState() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
  }
  function saveState(patch) {
    const s = Object.assign(loadState(), patch);
    localStorage.setItem(KEY, JSON.stringify(s));
    if (chan) chan.postMessage("update");
    render();
    return s;
  }
  function st() {
    const s = loadState();
    s.bookings = s.bookings || [];
    s.holds = (s.holds || []).filter(h => h.expiresAt > Date.now());
    s.proposal = s.proposal || null;
    return s;
  }
  window.addEventListener("storage", e => { if (e.key === KEY) render(); });
  if (chan) chan.onmessage = () => render();

  /* ---------------- timezone ---------------- */
  const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago";
  let viewerTz = detectedTz;
  const TZ_CHOICES = [
    [detectedTz, "Auto · " + detectedTz.split("/").pop().replace(/_/g, " ")],
    ["America/Chicago", "Austin / Chicago"],
    ["America/New_York", "New York"],
    ["America/Los_Angeles", "Los Angeles"],
    ["Europe/London", "London"],
    ["Europe/Lisbon", "Lisbon"],
    ["Europe/Berlin", "Berlin"],
    ["Asia/Tokyo", "Tokyo"],
  ];
  function timeIn(ms, tz) {
    return E.fmtInTz(ms, tz, { hour: "numeric", minute: "2-digit" });
  }
  function dualTzLine(ms) {
    const v = timeIn(ms, viewerTz);
    const h = timeIn(ms, E.HOST_TZ);
    const vCity = (TZ_CHOICES.find(t => t[0] === viewerTz) || [null, viewerTz.split("/").pop()])[1].replace(/^Auto · /, "");
    if (viewerTz === E.HOST_TZ) return `${v} — you and Shaw are both in ${E.HOST.city} time`;
    return `${v} for you in ${vCity} · ${h} for Shaw in ${E.HOST.city}`;
  }

  /* ---------------- router ---------------- */
  const VIEWS = ["landing", "book", "agent", "host", "proposal"];
  function route() {
    const h = (location.hash || "#/").replace("#/", "") || "landing";
    const v = VIEWS.includes(h) ? h : "landing";
    VIEWS.forEach(name => { $("#view-" + name).hidden = name !== v; });
    $$(".topnav a").forEach(a => a.classList.toggle("active", a.dataset.nav === v));
    window.scrollTo(0, 0);
    render();
  }
  window.addEventListener("hashchange", route);

  /* ---------------- booking view ---------------- */
  const now0 = Date.now();
  let calCursor = new Date(now0); // month being viewed
  let selectedDay = null; // dateKey
  let overlayOn = false, bothFree = false;
  let pendingSlot = null;

  function engineOpts() {
    const s = st();
    return {
      bookings: s.bookings.map(b => ({ startMs: b.startMs, endMs: b.endMs })),
      holds: s.holds,
      nowMs: Date.now(),
    };
  }

  function renderCalendar() {
    const y = calCursor.getFullYear(), m = calCursor.getMonth();
    $("#cal-month").textContent = calCursor.toLocaleString("en-US", { month: "long", year: "numeric" });
    const grid = $("#cal-grid");
    grid.innerHTML = "";
    for (const d of ["S", "M", "T", "W", "T", "F", "S"]) {
      const el = document.createElement("div");
      el.className = "cal-dow"; el.textContent = d; grid.appendChild(el);
    }
    const first = new Date(y, m, 1);
    for (let i = 0; i < first.getDay(); i++) grid.appendChild(document.createElement("div"));
    const daysIn = new Date(y, m + 1, 0).getDate();
    const opts = engineOpts();
    for (let d = 1; d <= daysIn; d++) {
      const key = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const slots = E.slotsForDate(key, opts);
      const btn = document.createElement("button");
      btn.className = "cal-day"; btn.textContent = d;
      btn.setAttribute("role", "gridcell");
      if (slots.length) {
        btn.classList.add("open");
        btn.setAttribute("aria-label", `${key}, ${slots.length} open times`);
        if (key === selectedDay) btn.classList.add("selected");
        btn.addEventListener("click", () => { selectedDay = key; render(); });
      } else btn.disabled = true;
      grid.appendChild(btn);
    }
  }

  let holdTicker = null;
  function renderSlots() {
    const list = $("#slots-list");
    const dateEl = $("#slots-date");
    list.innerHTML = "";
    if (!selectedDay) { dateEl.textContent = "Pick a day"; return; }
    const [y, mo, d] = selectedDay.split("-").map(Number);
    dateEl.textContent = new Date(y, mo - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    const slots = E.slotsForDate(selectedDay, engineOpts());
    // re-include held slots for display
    const s = st();
    const activeHolds = s.holds;
    const ghost = overlayOn ? E.inviteeBusyFor(selectedDay, viewerTz) : [];
    if (!slots.length && !activeHolds.length) {
      list.innerHTML = '<p class="mut">No open times this day.</p>'; return;
    }
    for (const sl of slots) {
      const isGhost = ghost.some(g => E.overlaps(sl.startMs, sl.endMs, g.startMs, g.endMs));
      const hold = activeHolds.find(h => E.overlaps(sl.startMs, sl.endMs, h.startMs, h.endMs));
      const el = document.createElement("button");
      el.className = "slot";
      let tag = "";
      if (hold) {
        el.classList.add("held");
        const secs = Math.max(0, Math.round((hold.expiresAt - Date.now()) / 1000));
        tag = `<span class="holdring">held by ${hold.agent || "an agent"} · ${secs}s</span>`;
        el.disabled = true;
      } else if (isGhost) {
        el.classList.add("ghosted");
        if (bothFree) el.classList.add("hidden");
        tag = '<span class="slot-tag">you\u2019re busy</span>';
      } else if (sl.preferred) {
        el.classList.add("preferred");
        tag = '<span class="slot-tag">works best</span>';
      }
      el.innerHTML = `<span>${timeIn(sl.startMs, viewerTz)}</span>${tag}`;
      if (!hold && !isGhost) el.addEventListener("click", () => openSheet(sl));
      list.appendChild(el);
    }
    clearInterval(holdTicker);
    if (activeHolds.length) holdTicker = setInterval(() => { if (!$("#view-book").hidden) renderSlots(); }, 1000);
  }

  function openSheet(sl) {
    pendingSlot = sl;
    $("#sheet-time").textContent =
      new Date(sl.startMs).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: viewerTz }) +
      " · " + timeIn(sl.startMs, viewerTz);
    $("#sheet-tzline").textContent = dualTzLine(sl.startMs);
    $("#sheet-backdrop").hidden = false;
    $("#book-sheet").hidden = false;
    $("#f-name").focus();
  }
  function closeSheet() {
    $("#sheet-backdrop").hidden = true;
    $("#book-sheet").hidden = true;
    pendingSlot = null;
  }
  $("#sheet-close").addEventListener("click", closeSheet);
  $("#sheet-backdrop").addEventListener("click", closeSheet);

  $("#book-form").addEventListener("submit", e => {
    e.preventDefault();
    if (!pendingSlot) return;
    const b = {
      id: "bk_" + Math.random().toString(36).slice(2, 9),
      startMs: pendingSlot.startMs, endMs: pendingSlot.endMs,
      name: $("#f-name").value.trim(), email: $("#f-email").value.trim(),
      note: $("#f-note").value.trim(), origin: "human", createdAt: Date.now(),
    };
    const s = st();
    saveState({ bookings: s.bookings.concat(b) });
    closeSheet();
    $("#confirmed-when").textContent =
      new Date(b.startMs).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: viewerTz }) +
      " · " + timeIn(b.startMs, viewerTz) + "–" + timeIn(b.endMs, viewerTz);
    $("#confirmed-tz").textContent = dualTzLine(b.startMs);
    $("#confirmed").hidden = false;
    lastBooking = b;
  });
  let lastBooking = null;
  $("#confirmed-back").addEventListener("click", () => { $("#confirmed").hidden = true; render(); });
  $("#add-ics").addEventListener("click", () => {
    if (!lastBooking) return;
    const dt = ms => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Bookii//EN", "BEGIN:VEVENT",
      "UID:" + lastBooking.id + "@bookii", "DTSTAMP:" + dt(Date.now()),
      "DTSTART:" + dt(lastBooking.startMs), "DTEND:" + dt(lastBooking.endMs),
      "SUMMARY:Intro call — Shaw Cole × " + lastBooking.name,
      "DESCRIPTION:Booked via Bookii", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const a = document.createElement("a");
    a.href = "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
    a.download = "bookii-intro-call.ics"; a.click();
  });

  // overlay
  $("#overlay-connect").addEventListener("click", () => {
    overlayOn = true;
    $("#overlay-box").hidden = true; $("#overlay-active").hidden = false;
    render();
  });
  $("#overlay-disconnect").addEventListener("click", () => {
    overlayOn = false; bothFree = false;
    $("#overlay-box").hidden = false; $("#overlay-active").hidden = true;
    $("#both-free").checked = false;
    render();
  });
  $("#both-free").addEventListener("change", e => { bothFree = e.target.checked; render(); });

  // month nav
  $("#cal-prev").addEventListener("click", () => { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1); render(); });
  $("#cal-next").addEventListener("click", () => { calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1); render(); });

  // tz select
  const tzSel = $("#tz-select");
  for (const [val, label] of TZ_CHOICES) {
    const o = document.createElement("option");
    o.value = val; o.textContent = label; tzSel.appendChild(o);
  }
  tzSel.addEventListener("change", () => { viewerTz = tzSel.value; render(); });

  /* ---------------- agent console ---------------- */
  const consoleEl = $("#console");
  let agentRunning = false;
  function cline(cls, html) {
    const el = document.createElement("div");
    el.className = "c-line " + cls; el.innerHTML = html;
    consoleEl.appendChild(el);
    consoleEl.scrollTop = consoleEl.scrollHeight;
    return el;
  }
  const wait = ms => new Promise(r => setTimeout(r, ms));
  function jsonBlock(obj) {
    return `<div class="c-json">${JSON.stringify(obj, null, 1).replace(/</g, "&lt;")}</div>`;
  }

  async function runAgent() {
    if (agentRunning) return;
    agentRunning = true;
    $("#agent-run").disabled = true;
    consoleEl.innerHTML = '<div class="console-hint">▸ live session — every request below hits the real engine</div>';
    cline("c-sys", "── session start · " + new Date().toLocaleTimeString());
    cline("c-agent", '<span class="c-emph">claude</span> ▸ My user asked: “Book 30 min with Shaw this week.” Finding availability…');
    await wait(900);

    // find first day with slots
    const opts = engineOpts();
    let dayKey = null, slots = [];
    for (let i = 0; i < 14; i++) {
      const k = E.dateKeyInTz(Date.now() + i * 86400000, E.HOST_TZ);
      const s = E.slotsForDate(k, opts).filter(x => !x.held);
      if (s.length) { dayKey = k; slots = s; break; }
    }
    cline("c-req", `GET /v1/slots?eventType=intro-30&date=${dayKey}&tz=America/Chicago`);
    await wait(700);
    const preview = slots.slice(0, 4).map(s => ({ start: s.start, preferred: s.preferred }));
    cline("c-res", `200 OK · ${slots.length} slots` + jsonBlock({ slots: preview, more: slots.length - preview.length }));
    await wait(1000);

    const pick = slots.find(s => s.preferred) || slots[0];
    cline("c-agent", `<span class="c-emph">claude</span> ▸ ${timeIn(pick.startMs, E.HOST_TZ)} is marked <em>works best</em> for Shaw and fits my user's afternoon. Placing a hold while I confirm.`);
    await wait(900);

    const hold = {
      id: "hold_" + Math.random().toString(36).slice(2, 8),
      startMs: pick.startMs, endMs: pick.endMs,
      expiresAt: Date.now() + 90 * 1000, agent: "Claude",
    };
    saveState({ holds: st().holds.concat(hold) });
    cline("c-req", `POST /v1/holds · Idempotency-Key: ${hold.id}` + jsonBlock({ eventType: "intro-30", start: pick.start, ttlSeconds: 90 }));
    await wait(700);
    cline("c-res", `201 Created` + jsonBlock({ holdId: hold.id, expiresAt: new Date(hold.expiresAt).toISOString() }));
    cline("c-sys", "· the slot is now pulsing apricot on every open booking page — try it in a second window");
    await wait(2400);

    cline("c-agent", '<span class="c-emph">claude</span> ▸ Confirming with my principal…');
    await wait(1600);
    cline("c-sys", "· jane@acme.com confirmed via one-click email (trust tier 2: verified principal)");
    await wait(800);

    cline("c-req", `POST /v1/bookings · Idempotency-Key: bk_${hold.id}` + jsonBlock({
      holdId: hold.id,
      attendee: { name: "Jane Park", email: "jane@acme.com" },
      agent: { name: "Claude", operator: "Anthropic", webBotAuth: "verified" },
      principal: { email: "jane@acme.com", confirmed: true },
    }));
    await wait(900);

    const booking = {
      id: "bk_" + Math.random().toString(36).slice(2, 9),
      startMs: pick.startMs, endMs: pick.endMs,
      name: "Jane Park", email: "jane@acme.com",
      note: "Intro re: Acme data pipeline — booked by Jane's assistant.",
      origin: "agent", agent: "Claude", tier: "verified principal",
      createdAt: Date.now(),
    };
    const s2 = st();
    saveState({
      bookings: s2.bookings.concat(booking),
      holds: s2.holds.filter(h => h.id !== hold.id),
    });
    cline("c-res", `201 Created` + jsonBlock({ bookingId: booking.id, status: "confirmed", start: pick.start }));
    await wait(600);
    cline("c-agent", `<span class="c-emph">claude</span> ▸ Done. ${new Date(pick.startMs).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })} at ${timeIn(pick.startMs, E.HOST_TZ)} (Shaw's time). Invites are out; Shaw sees exactly who booked and how.`);
    cline("c-sys", `── session end · view the provenance card in <a href="#/host">Host</a>`);
    agentRunning = false;
    $("#agent-run").disabled = false;
  }
  $("#agent-run").addEventListener("click", runAgent);
  $("#agent-reset").addEventListener("click", () => {
    localStorage.removeItem(KEY);
    if (chan) chan.postMessage("update");
    consoleEl.innerHTML = '<div class="console-hint">▸ state cleared — run the agent again, or make a human booking first and watch them share one truth</div>';
    render();
  });

  /* ---------------- host view ---------------- */
  function renderHost() {
    $("#host-date").textContent = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
    const wrap = $("#host-bookings");
    const s = st();
    const upcoming = s.bookings.slice().sort((a, b) => a.startMs - b.startMs);
    wrap.innerHTML = "";
    if (!upcoming.length) {
      wrap.innerHTML = '<p class="bk-empty">Nothing booked yet. Make a booking on the <a href="#/book">invitee page</a> or run the <a href="#/agent">agent</a>.</p>';
    }
    for (const b of upcoming) {
      const el = document.createElement("div");
      el.className = "bk-card" + (b.origin === "agent" ? " bk-agent" : "");
      const when = new Date(b.startMs).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: E.HOST_TZ });
      let prov = "";
      if (b.origin === "agent") {
        prov = `<div class="prov">
          <span class="prov-badge prov-agent">held by ${b.agent}</span>
          <span class="prov-badge prov-tier">${b.tier}</span>
          <span class="prov-badge prov-principal">confirmed by ${esc(b.email)}</span>
        </div>`;
      }
      el.innerHTML = `<div class="bk-time">${when}<br>${timeIn(b.startMs, E.HOST_TZ)}</div>
        <div><p class="bk-who">${esc(b.name)} · Intro call</p>
        ${b.note ? `<p class="bk-note">${esc(b.note)}</p>` : ""}${prov}</div>`;
      wrap.appendChild(el);
    }
    // show rate ticks up slightly with attended meetings for flavor
    $("#showrate-num").textContent = (94 + Math.min(upcoming.length, 4)) + "%";
    renderCopyAvail();
  }

  function renderCopyAvail() {
    const opts = engineOpts();
    const lines = [];
    let found = 0;
    for (let i = 1; i < 14 && found < 3; i++) {
      const k = E.dateKeyInTz(Date.now() + i * 86400000, E.HOST_TZ);
      const slots = E.slotsForDate(k, opts).filter(x => !x.held);
      if (!slots.length) continue;
      found++;
      const day = new Date(slots[0].startMs).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: E.HOST_TZ });
      const ranges = [];
      let rs = slots[0].startMs, re = slots[0].endMs;
      for (const sl of slots.slice(1)) {
        if (sl.startMs <= re) { re = sl.endMs; }
        else { ranges.push([rs, re]); rs = sl.startMs; re = sl.endMs; }
      }
      ranges.push([rs, re]);
      lines.push(`${day}: ` + ranges.slice(0, 3).map(([a, b]) => `${timeIn(a, E.HOST_TZ)}–${timeIn(b, E.HOST_TZ)}`).join(", ") + " CT");
    }
    $("#copyavail-pre").textContent =
      "A few times that work on my end:\n" + lines.map(l => "  · " + l).join("\n") +
      "\nOr grab anything here: bookii.to/shaw/intro";
  }
  $("#copyavail-btn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#copyavail-pre").textContent);
      $("#copied-flag").hidden = false;
      setTimeout(() => { $("#copied-flag").hidden = true; }, 1600);
    } catch {}
  });

  /* ---------------- mutual mode ---------------- */
  function proposalTimes() {
    const out = [];
    const opts = { bookings: [], holds: [], nowMs: Date.now() };
    for (let i = 1; i < 14 && out.length < 3; i++) {
      const k = E.dateKeyInTz(Date.now() + i * 86400000, E.HOST_TZ);
      const slots = E.slotsForDate(k, opts);
      const pick = slots.find(x => x.preferred) || slots[0];
      if (pick) out.push(pick);
    }
    return out;
  }
  function renderProposal() {
    const card = $("#prop-card");
    const s = st();
    const times = proposalTimes();
    card.innerHTML = "";
    const chosen = s.proposal && s.proposal.chosenMs;
    for (const t of times) {
      const el = document.createElement("button");
      el.className = "prop-opt";
      const day = new Date(t.startMs).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: viewerTz });
      el.innerHTML = `<span class="p-main">${day} · ${timeIn(t.startMs, viewerTz)}</span>
        <span class="p-tz">${timeIn(t.startMs, E.HOST_TZ)} for Shaw</span>`;
      if (chosen) {
        if (t.startMs === chosen) { el.classList.add("won"); el.innerHTML += " ✓"; }
        else el.classList.add("retracted");
        el.disabled = true;
      } else {
        el.addEventListener("click", () => {
          saveState({ proposal: { chosenMs: t.startMs } });
        });
      }
      card.appendChild(el);
    }
    let status = $("#prop-status");
    if (!status) {
      status = document.createElement("p");
      status.className = "prop-status"; status.id = "prop-status";
      card.appendChild(status);
    } else card.appendChild(status);
    status.innerHTML = chosen
      ? "<strong>Booked.</strong> The other two holds were released the instant you tapped."
      : "Tap a time — the first confirm wins.";
  }
  $("#prop-reset").addEventListener("click", () => saveState({ proposal: null }));

  /* ---------------- landing mini scene ---------------- */
  function renderScene() {
    const scene = $("#hero-scene");
    const opts = engineOpts();
    let dayKey = null, slots = [];
    for (let i = 0; i < 14; i++) {
      const k = E.dateKeyInTz(Date.now() + i * 86400000, E.HOST_TZ);
      const s = E.slotsForDate(k, opts);
      if (s.length) { dayKey = k; slots = s; break; }
    }
    const s = st();
    const day = dayKey ? new Date(slots[0].startMs).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: E.HOST_TZ }) : "";
    const held = s.holds[0];
    const agentBk = s.bookings.find(b => b.origin === "agent");
    scene.innerHTML = `<p class="scene-title">live · shaw / intro · ${day}</p>
      <div class="scene-row">` +
      slots.slice(0, 5).map(sl => {
        const isHeld = held && E.overlaps(sl.startMs, sl.endMs, held.startMs, held.endMs);
        const isBooked = agentBk && E.overlaps(sl.startMs, sl.endMs, agentBk.startMs, agentBk.endMs);
        const cls = isBooked ? "booked" : isHeld ? "held" : "";
        return `<span class="scene-slot ${cls}">${timeIn(sl.startMs, E.HOST_TZ)}${isBooked ? " ✓" : isHeld ? " · held" : ""}</span>`;
      }).join("") +
      `</div>`;
  }
  $("#curl-date").textContent = E.dateKeyInTz(Date.now() + 86400000, E.HOST_TZ);

  /* ---------------- master render ---------------- */
  function render() {
    if (!$("#view-book").hidden) { renderCalendar(); renderSlots(); }
    if (!$("#view-host").hidden) renderHost();
    if (!$("#view-proposal").hidden) renderProposal();
    if (!$("#view-landing").hidden) renderScene();
  }

  // default selected day = first available
  (function initDay() {
    const opts = engineOpts();
    for (let i = 0; i < 21; i++) {
      const k = E.dateKeyInTz(Date.now() + i * 86400000, E.HOST_TZ);
      if (E.slotsForDate(k, opts).length) { selectedDay = k; break; }
    }
    if (selectedDay) {
      const [y, m] = selectedDay.split("-").map(Number);
      calCursor = new Date(y, m - 1, 1);
    }
  })();

  route();
})();
