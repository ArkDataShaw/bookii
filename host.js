/* Bookii app — host dashboard + public booking, against api.bookii.to. */
(function () {
  const API = location.hostname === "localhost" ? "http://localhost:3000/v1" : "https://api.bookii.to/v1";
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let me = null;

  /* ---------- api helper ---------- */
  async function api(path, opts = {}) {
    const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    const token = localStorage.getItem("bookii-token");
    if (token) headers.Authorization = "Bearer " + token;
    const res = await fetch(API + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || "Request failed"), { status: res.status });
    return data;
  }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, 2400);
  }

  /* ---------- time utils ---------- */
  const TZS = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix",
    "Europe/London", "Europe/Lisbon", "Europe/Berlin", "Europe/Paris", "Asia/Tokyo", "Asia/Singapore", "Australia/Sydney", "UTC"];
  const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago";
  function tzOptions(sel, chosen) {
    sel.innerHTML = "";
    const list = [...new Set([detectedTz, ...TZS])];
    for (const tz of list) {
      const o = document.createElement("option");
      o.value = tz; o.textContent = tz.replace(/_/g, " ") + (tz === detectedTz ? " (detected)" : "");
      if (tz === (chosen || detectedTz)) o.selected = true;
      sel.appendChild(o);
    }
  }
  const fmtTime = (iso, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  const fmtDay = (iso, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(new Date(iso));
  const minToLabel = m => {
    const h = Math.floor(m / 60), mi = m % 60;
    const ampm = h >= 12 ? "PM" : "AM";
    const hh = h % 12 === 0 ? 12 : h % 12;
    return `${hh}:${String(mi).padStart(2, "0")} ${ampm}`;
  };

  /* ---------- router ---------- */
  const VIEWS = ["auth", "onboarding", "dashboard", "editor", "availability", "meetings", "calendars", "profile", "public", "cancel"];
  function show(view) {
    for (const v of VIEWS) $("#view-" + v).hidden = v !== view;
    const appViews = ["dashboard", "editor", "availability", "meetings", "calendars"];
    $("#app-nav").hidden = !appViews.includes(view);
    $("#userchip").hidden = !me || !(appViews.includes(view) || view === "onboarding");
    if (me && view === "onboarding") $("#userchip-name").textContent = me.name || me.email;
    document.querySelectorAll("#app-nav a").forEach(a =>
      a.classList.toggle("active", a.dataset.nav === view || (view === "editor" && a.dataset.nav === "dashboard")));
    window.scrollTo(0, 0);
  }

  const PUB_HOST = location.hostname === "from.bookii.to";
  async function route() {
    // from.bookii.to — the app lives at the root; /username[/slug] are public booking pages
    if (PUB_HOST) {
      const p = location.pathname.split("/").filter(Boolean);
      const h = location.hash.replace(/^#\//, "").split("/").filter(Boolean);
      if (h[0] === "cancel" && h[1] && h[2]) return renderCancel(h[1], h[2]);
      if (p[0] && p[0] !== "app.html") {
        if (p[1]) return renderPublic(p[0], p[1]);
        return renderProfile(p[0]);
      }
      // no path → fall through to the normal app (auth/dashboard) routing
    }
    const h = location.hash.replace(/^#\//, "");
    const parts = h.split("/").filter(Boolean);
    // public routes
    if (parts[0] === "u" && parts[1]) {
      if (parts[2]) return renderPublic(parts[1], parts[2]);
      return renderProfile(parts[1]);
    }
    if (parts[0] === "cancel" && parts[1] && parts[2]) return renderCancel(parts[1], parts[2]);
    // authed routes
    if (!me) {
      const token = localStorage.getItem("bookii-token");
      if (token) { try { me = (await api("/me")).user; } catch { localStorage.removeItem("bookii-token"); } }
    }
    if (!me) { renderAuth(parts[0] === "login" ? "login" : "signup"); return; }
    if (!me.username) return renderOnboarding();
    switch (parts[0]) {
      case "availability": return renderAvailability();
      case "meetings": return renderMeetings();
      case "calendars": return renderCalendars();
      case "event": return renderEditor(parts[1]);
      default: return renderDashboard();
    }
  }
  window.addEventListener("hashchange", route);
  $("#logout").addEventListener("click", () => { localStorage.removeItem("bookii-token"); me = null; location.hash = "#/login"; });

  /* ---------- auth ---------- */
  let authMode = "signup";
  function renderAuth(mode) {
    authMode = mode;
    $("#auth-title").textContent = mode === "signup" ? "Create your page" : "Welcome back";
    $("#auth-sub").hidden = mode !== "signup";
    $("#auth-name-wrap").hidden = mode !== "signup";
    $("#auth-submit").textContent = mode === "signup" ? "Sign up" : "Sign in";
    $("#auth-switch-label").textContent = mode === "signup" ? "Already have an account?" : "New here?";
    $("#auth-switch").textContent = mode === "signup" ? "Sign in" : "Create an account";
    $("#auth-error").hidden = true;
    show("auth");
  }
  $("#auth-switch").addEventListener("click", () => renderAuth(authMode === "signup" ? "login" : "signup"));
  $("#auth-form").addEventListener("submit", async e => {
    e.preventDefault();
    $("#auth-error").hidden = true;
    try {
      const body = { email: $("#a-email").value.trim(), password: $("#a-password").value };
      let data;
      if (authMode === "signup") {
        body.name = $("#a-name").value.trim();
        body.timezone = detectedTz;
        data = await api("/auth/signup", { method: "POST", body });
      } else {
        data = await api("/auth/login", { method: "POST", body });
      }
      localStorage.setItem("bookii-token", data.token);
      me = data.user;
      location.hash = "#/dashboard";
      route();
    } catch (err) {
      $("#auth-error").textContent = err.message; $("#auth-error").hidden = false;
    }
  });

  /* ---------- onboarding ---------- */
  let obTimer = null;
  function renderOnboarding() {
    tzOptions($("#ob-tz"), me.timezone);
    const suggested = (me.name || me.email.split("@")[0]).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!$("#ob-username").value) $("#ob-username").value = suggested;
    checkUsername();
    show("onboarding");
  }
  async function checkUsername() {
    const un = $("#ob-username").value.trim().toLowerCase();
    const st = $("#ob-status");
    if (un.length < 3) { st.textContent = ""; return; }
    try {
      const r = await api("/username-check/" + encodeURIComponent(un));
      st.textContent = r.available ? "✓ available" : "taken";
      st.className = "slug-status " + (r.available ? "ok" : "bad");
    } catch { st.textContent = ""; }
  }
  $("#ob-username").addEventListener("input", () => { clearTimeout(obTimer); obTimer = setTimeout(checkUsername, 350); });
  $("#ob-go").addEventListener("click", async () => {
    $("#ob-error").hidden = true;
    try {
      const r = await api("/me", { method: "PATCH", body: {
        username: $("#ob-username").value.trim().toLowerCase(),
        welcome_note: $("#ob-welcome").value.trim(),
        timezone: $("#ob-tz").value,
      }});
      me = r.user;
      // starter event types
      const existing = await api("/event-types");
      if (!existing.eventTypes.length) {
        await api("/event-types", { method: "POST", body: { title: "Quick chat", slug: "15min", duration_min: 15, color: "#20794D" } });
        await api("/event-types", { method: "POST", body: { title: "Intro call", slug: "intro", duration_min: 30 } });
      }
      location.hash = "#/dashboard"; route();
    } catch (err) {
      $("#ob-error").textContent = err.message; $("#ob-error").hidden = false;
    }
  });

  /* ---------- dashboard ---------- */
  async function renderDashboard() {
    $("#userchip-name").textContent = me.name || me.email;
    const pageUrl = `https://from.bookii.to/${me.username}`;
    const link = $("#dash-pagelink");
    link.textContent = `from.bookii.to/${me.username}`;
    link.href = pageUrl;
    show("dashboard");
    const { eventTypes } = await api("/event-types");
    const list = $("#dash-list");
    list.innerHTML = "";
    if (!eventTypes.length) {
      list.innerHTML = '<p class="et-empty">No event types yet — create your first.</p>';
    }
    for (const et of eventTypes) {
      const url = `https://from.bookii.to/${me.username}/${et.slug}`;
      const el = document.createElement("div");
      el.className = "et-card";
      el.style.borderLeftColor = et.color;
      el.innerHTML = `
        <div class="et-info">
          <p class="et-title">${esc(et.title)} <span class="et-badge">${et.duration_min} min</span>${et.hidden ? '<span class="et-badge">hidden</span>' : ""}</p>
          <p class="et-link">from.bookii.to/${esc(me.username)}/${esc(et.slug)}</p>
        </div>
        <div class="et-actions">
          <button class="btn btn-ghost btn-sm" data-act="copy">Copy link</button>
          <a class="btn btn-ghost btn-sm" href="${url}" target="_blank" rel="noopener">View</a>
          <a class="btn btn-primary btn-sm" href="#/event/${et.id}">Edit</a>
        </div>`;
      el.querySelector('[data-act=copy]').addEventListener("click", async () => {
        await navigator.clipboard.writeText(url).catch(() => {});
        toast("Link copied");
      });
      list.appendChild(el);
    }
  }
  $("#dash-copy-page").addEventListener("click", async () => {
    await navigator.clipboard.writeText(`https://from.bookii.to/${me.username}`).catch(() => {});
    $("#dash-copied").hidden = false;
    setTimeout(() => { $("#dash-copied").hidden = true; }, 1500);
  });
  $("#dash-new").addEventListener("click", () => { location.hash = "#/event/new"; });

  /* ---------- event editor ---------- */
  const COLORS = ["#2B3EE5", "#20794D", "#EE8F45", "#B3261E", "#7B4FD8", "#0E7490", "#1B1E28"];
  const QTYPES = [["text", "Short answer"], ["textarea", "Long answer"], ["phone", "Phone number"], ["select", "Dropdown"]];
  let ed = null, edDirty = false, pvTimer = null;

  function selOptions(sel, opts, val) {
    sel.innerHTML = "";
    for (const [v, label] of opts) {
      const o = document.createElement("option");
      o.value = v; o.textContent = label;
      if (String(v) === String(val)) o.selected = true;
      sel.appendChild(o);
    }
  }

  async function renderEditor(id) {
    const { schedules } = await api("/schedules");
    if (id === "new") {
      // draft — nothing is created until first save
      ed = {
        id: null, title: "New meeting", slug: "", description: "", duration_min: 30,
        color: COLORS[0], locations: ["Google Meet"], buffer_before_min: 0, buffer_after_min: 0,
        min_notice_min: 240, window_days: 30, slot_interval_min: null, daily_cap: null,
        questions: [], hidden: false,
        schedule_id: (schedules.find(s => s.is_default) || schedules[0] || {}).id || null,
      };
    } else {
      const { eventTypes } = await api("/event-types");
      ed = eventTypes.find(e => e.id === id);
      if (!ed) { location.hash = "#/dashboard"; return; }
      ed.questions = ed.questions || [];
      ed.locations = ed.locations || [];
    }
    $("#ed-delete").textContent = ed.id ? "Delete this event type" : "Discard draft";
    slugTouched = !!ed.id;
    show("editor");
    $("#ed-heading").textContent = ed.id ? ed.title : "New event type";
    $("#ed-title").value = ed.title;
    $("#ed-slug").value = ed.slug;
    $("#ed-slug-prefix").textContent = `from.bookii.to/${me.username}/`;
    $("#ed-desc").value = ed.description;
    selOptions($("#ed-schedule"), schedules.map(s => [s.id, s.name + (s.is_default ? " (default)" : "")]), ed.schedule_id);
    const mins = [["0", "None"], ["5", "5 min"], ["10", "10 min"], ["15", "15 min"], ["30", "30 min"]];
    selOptions($("#ed-bufb"), mins, ed.buffer_before_min);
    selOptions($("#ed-bufa"), mins, ed.buffer_after_min);
    selOptions($("#ed-notice"), [["0", "None"], ["60", "1 hour"], ["240", "4 hours"], ["1440", "1 day"], ["2880", "2 days"]], ed.min_notice_min);
    selOptions($("#ed-window"), [["7", "1 week"], ["14", "2 weeks"], ["30", "1 month"], ["60", "2 months"]], ed.window_days);
    selOptions($("#ed-interval"), [["", "Event length"], ["15", "15 min"], ["30", "30 min"], ["60", "60 min"]], ed.slot_interval_min ?? "");
    selOptions($("#ed-cap"), [["", "No limit"], ["2", "2"], ["4", "4"], ["6", "6"], ["8", "8"]], ed.daily_cap ?? "");
    $("#ed-hidden").checked = ed.hidden;
    renderDurations(); renderLocations(); renderSwatches(); renderQuestions();
    setDirty(false);
    refreshPreview();
  }

  function setDirty(d) {
    edDirty = d;
    $("#ed-savestate").textContent = !ed || !ed.id ? "Not saved yet" : d ? "Unsaved changes" : "Saved";
  }
  function collectEd() {
    return {
      title: $("#ed-title").value.trim() || "Untitled",
      slug: $("#ed-slug").value.trim(),
      description: $("#ed-desc").value.trim(),
      duration_min: ed.duration_min,
      color: ed.color,
      locations: ed.locations,
      buffer_before_min: +$("#ed-bufb").value,
      buffer_after_min: +$("#ed-bufa").value,
      min_notice_min: +$("#ed-notice").value,
      window_days: +$("#ed-window").value,
      slot_interval_min: $("#ed-interval").value ? +$("#ed-interval").value : null,
      daily_cap: $("#ed-cap").value ? +$("#ed-cap").value : null,
      questions: ed.questions,
      hidden: $("#ed-hidden").checked,
      schedule_id: $("#ed-schedule").value,
    };
  }
  function renderDurations() {
    const wrap = $("#ed-durations");
    wrap.innerHTML = "";
    for (const d of [15, 30, 45, 60, 90]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "dur-chip" + (ed.duration_min === d ? " on" : "");
      b.textContent = d + " min";
      b.addEventListener("click", () => { ed.duration_min = d; renderDurations(); onEdit(); });
      wrap.appendChild(b);
    }
  }
  function renderLocations() {
    const wrap = $("#ed-locations");
    wrap.innerHTML = "";
    ed.locations.forEach((loc, i) => {
      const row = document.createElement("div");
      row.className = "loc-row";
      row.innerHTML = `<input type="text" value="${esc(loc)}" maxlength="60"><button type="button" class="range-x" aria-label="Remove">×</button>`;
      row.querySelector("input").addEventListener("input", e => { ed.locations[i] = e.target.value; onEdit(); });
      row.querySelector("button").addEventListener("click", () => { ed.locations.splice(i, 1); renderLocations(); onEdit(); });
      wrap.appendChild(row);
    });
  }
  $("#ed-addloc").addEventListener("click", () => { ed.locations.push(""); renderLocations(); });
  function renderSwatches() {
    const wrap = $("#ed-swatches");
    wrap.innerHTML = "";
    for (const ccol of COLORS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch" + (ed.color === ccol ? " on" : "");
      b.style.background = ccol;
      b.setAttribute("aria-label", ccol);
      b.addEventListener("click", () => { ed.color = ccol; renderSwatches(); onEdit(); });
      wrap.appendChild(b);
    }
  }
  function renderQuestions() {
    const wrap = $("#ed-questions");
    wrap.innerHTML = "";
    ed.questions.forEach((qq, i) => {
      const row = document.createElement("div");
      row.className = "q-row";
      row.innerHTML = `
        <input type="text" value="${esc(qq.label)}" placeholder="Question" maxlength="120">
        <select></select>
        <label class="check-row"><input type="checkbox" ${qq.required ? "checked" : ""}> required</label>
        <button type="button" class="range-x" aria-label="Remove">×</button>`;
      selOptions(row.querySelector("select"), QTYPES, qq.type);
      row.querySelector("input[type=text]").addEventListener("input", e => { qq.label = e.target.value; onEdit(); });
      row.querySelector("select").addEventListener("change", e => { qq.type = e.target.value; onEdit(); });
      row.querySelector("input[type=checkbox]").addEventListener("change", e => { qq.required = e.target.checked; onEdit(); });
      row.querySelector(".range-x").addEventListener("click", () => { ed.questions.splice(i, 1); renderQuestions(); onEdit(); });
      wrap.appendChild(row);
    });
  }
  $("#ed-addq").addEventListener("click", () => {
    if (ed.questions.length >= 10) return toast("Up to 10 questions");
    ed.questions.push({ id: "q" + Date.now(), label: "", type: "text", required: false });
    renderQuestions();
  });
  function onEdit() { setDirty(true); clearTimeout(pvTimer); pvTimer = setTimeout(refreshPreview, 400); }
  let slugTouched = false;
  $("#ed-slug").addEventListener("input", () => { slugTouched = true; });
  $("#ed-title").addEventListener("input", () => {
    if (ed && !ed.id && !slugTouched) {
      $("#ed-slug").value = $("#ed-title").value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    }
  });
  for (const id of ["ed-title", "ed-slug", "ed-desc", "ed-bufb", "ed-bufa", "ed-notice", "ed-window", "ed-interval", "ed-cap", "ed-hidden", "ed-schedule"]) {
    $("#" + id).addEventListener("input", onEdit);
  }
  function refreshPreview() {
    const d = collectEd();
    const pv = $("#ed-preview");
    pv.style.borderTop = `4px solid ${d.color}`;
    pv.innerHTML = `
      <p class="pv-host">${esc(me.name || me.username)}</p>
      <p class="pv-title serif">${esc(d.title)}</p>
      ${d.description ? `<p class="pv-desc">${esc(d.description)}</p>` : ""}
      <div class="event-meta"><span class="chip">${d.duration_min} min</span>${d.locations.filter(Boolean).map(l => `<span class="chip chip-alt">${esc(l)}</span>`).join("")}</div>
      <div class="pv-slots" id="pv-slots"><p class="mut small">Loading live availability…</p></div>`;
    if (!ed.id) { $("#pv-slots").innerHTML = '<p class="mut small">Live availability appears after the first save.</p>'; return; }
    api(`/pages/${me.username}/${ed.slug}?days=10`).then(p => {
      const el = $("#pv-slots");
      if (!el) return;
      el.innerHTML = "";
      let shown = 0;
      for (const [day, slots] of Object.entries(p.days)) {
        if (!slots.length || shown >= 2) continue;
        shown++;
        const dl = document.createElement("p");
        dl.className = "pv-day";
        dl.textContent = fmtDay(slots[0].start, p.hostTz);
        el.appendChild(dl);
        const row = document.createElement("div");
        row.className = "scene-row";
        for (const s of slots.slice(0, 4)) {
          row.innerHTML += `<span class="scene-slot">${fmtTime(s.start, p.hostTz)}</span>`;
        }
        el.appendChild(row);
      }
      if (!shown) el.innerHTML = '<p class="mut small">No open times in the next 10 days — check your schedule.</p>';
    }).catch(() => {
      const el = $("#pv-slots");
      if (el) el.innerHTML = '<p class="mut small">Preview updates after you save.</p>';
    });
  }
  $("#ed-save").addEventListener("click", async () => {
    try {
      const body = collectEd();
      if (!ed.id) {
        if (!body.slug) delete body.slug; // let the server auto-generate + suffix
        const r = await api("/event-types", { method: "POST", body });
        ed = { ...ed, ...r.eventType };
        toast("Created");
        location.hash = "#/event/" + ed.id; // re-enter as a real event
        return;
      }
      const r = await api("/event-types/" + ed.id, { method: "PUT", body });
      ed = { ...ed, ...r.eventType };
      setDirty(false);
      toast("Saved");
      $("#ed-heading").textContent = ed.title;
      refreshPreview();
    } catch (e) { toast(e.message); }
  });
  $("#ed-delete").addEventListener("click", async () => {
    if (!ed.id) { location.hash = "#/dashboard"; return; } // draft: nothing to delete
    if (!confirm("Delete this event type? Its link will stop working.")) return;
    await api("/event-types/" + ed.id, { method: "DELETE" }).catch(e => toast(e.message));
    location.hash = "#/dashboard";
  });

  /* ---------- availability ---------- */
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let schedules = [], curSched = null;
  const timeOpts = [];
  for (let m = 0; m <= 1440; m += 30) timeOpts.push([m, minToLabel(m === 1440 ? 1439 : m)]);

  async function renderAvailability() {
    show("availability");
    ({ schedules } = await api("/schedules"));
    if (!curSched || !schedules.find(s => s.id === curSched.id)) curSched = schedules.find(s => s.is_default) || schedules[0];
    else curSched = schedules.find(s => s.id === curSched.id);
    renderSchedTabs(); renderSchedEditor();
  }
  function renderSchedTabs() {
    const tabs = $("#av-tabs");
    tabs.innerHTML = "";
    for (const s of schedules) {
      const b = document.createElement("button");
      b.className = "sched-tab" + (curSched.id === s.id ? " on" : "");
      b.textContent = s.name + (s.is_default ? " ·" : "");
      b.addEventListener("click", () => { curSched = s; renderSchedTabs(); renderSchedEditor(); });
      tabs.appendChild(b);
    }
  }
  function renderSchedEditor() {
    $("#av-name").value = curSched.name;
    $("#av-default").checked = curSched.is_default;
    $("#av-default").disabled = curSched.is_default;
    tzOptions($("#av-tz"), curSched.timezone);
    $("#av-savestate").textContent = "";
    const week = $("#av-week");
    week.innerHTML = "";
    for (let wd = 1; wd <= 7; wd++) {
      const d = wd % 7;
      const ranges = curSched.rules.filter(r => r.weekday === d);
      const row = document.createElement("div");
      row.className = "day-row";
      const on = ranges.length > 0;
      row.innerHTML = `
        <input type="checkbox" class="day-toggle" ${on ? "checked" : ""} aria-label="${DAYS[d]}">
        <span class="day-name">${DAYS[d]}</span>
        <div class="day-ranges"></div>`;
      const rangesEl = row.querySelector(".day-ranges");
      const renderRanges = () => {
        rangesEl.innerHTML = "";
        const rs = curSched.rules.filter(r => r.weekday === d);
        if (!rs.length) { rangesEl.innerHTML = '<span class="day-off">Unavailable</span>'; return; }
        rs.forEach((r) => {
          const rr = document.createElement("div");
          rr.className = "range-row";
          const s1 = document.createElement("select"), s2 = document.createElement("select");
          selOptions(s1, timeOpts.slice(0, -1), r.start_min);
          selOptions(s2, timeOpts.slice(1), r.end_min);
          s1.addEventListener("change", () => { r.start_min = +s1.value; schedDirty(); });
          s2.addEventListener("change", () => { r.end_min = +s2.value; schedDirty(); });
          const x = document.createElement("button");
          x.className = "range-x"; x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", "Remove range");
          x.addEventListener("click", () => {
            curSched.rules.splice(curSched.rules.indexOf(r), 1);
            renderRanges(); schedDirty();
            row.querySelector(".day-toggle").checked = curSched.rules.some(q => q.weekday === d);
          });
          rr.append(s1, document.createTextNode("–"), s2, x);
          rangesEl.appendChild(rr);
        });
        const add = document.createElement("button");
        add.className = "range-add"; add.type = "button"; add.textContent = "+ add hours";
        add.addEventListener("click", () => {
          const last = curSched.rules.filter(r => r.weekday === d).sort((a, b) => a.end_min - b.end_min).pop();
          const start = last ? Math.min(last.end_min + 60, 1380) : 540;
          curSched.rules.push({ weekday: d, start_min: start, end_min: Math.min(start + 240, 1440) });
          renderRanges(); schedDirty();
        });
        rangesEl.appendChild(add);
      };
      row.querySelector(".day-toggle").addEventListener("change", e => {
        if (e.target.checked) curSched.rules.push({ weekday: d, start_min: 540, end_min: 1020 });
        else curSched.rules = curSched.rules.filter(r => r.weekday !== d);
        renderRanges(); schedDirty();
      });
      renderRanges();
      week.appendChild(row);
    }
    renderOverrides();
  }
  function schedDirty() { $("#av-savestate").textContent = "Unsaved changes"; }
  function renderOverrides() {
    const list = $("#av-overrides");
    list.innerHTML = "";
    if (!curSched.overrides.length) list.innerHTML = '<p class="mut small">None yet.</p>';
    curSched.overrides.forEach((o, i) => {
      const row = document.createElement("div");
      row.className = "ov-row";
      const what = o.start_min === null ? "Unavailable all day" : `${minToLabel(o.start_min)} – ${minToLabel(o.end_min)}`;
      row.innerHTML = `<span><strong>${o.date}</strong> <span class="mut">${what}</span></span><button class="range-x" aria-label="Remove">×</button>`;
      row.querySelector("button").addEventListener("click", () => { curSched.overrides.splice(i, 1); renderOverrides(); schedDirty(); });
      list.appendChild(row);
    });
  }
  selOptions($("#ov-start"), timeOpts.slice(0, -1), 540);
  selOptions($("#ov-end"), timeOpts.slice(1), 1020);
  $("#ov-kind").addEventListener("change", e => { $("#ov-custom").hidden = e.target.value !== "custom"; });
  $("#ov-addbtn").addEventListener("click", () => {
    const date = $("#ov-date").value;
    if (!date) return toast("Pick a date");
    const blocked = $("#ov-kind").value === "blocked";
    curSched.overrides = curSched.overrides.filter(o => o.date !== date);
    curSched.overrides.push({ date, start_min: blocked ? null : +$("#ov-start").value, end_min: blocked ? null : +$("#ov-end").value });
    curSched.overrides.sort((a, b) => a.date.localeCompare(b.date));
    renderOverrides(); schedDirty();
  });
  $("#av-save").addEventListener("click", async () => {
    try {
      await api("/schedules/" + curSched.id, { method: "PUT", body: {
        name: $("#av-name").value.trim() || "Schedule",
        timezone: $("#av-tz").value,
        is_default: $("#av-default").checked,
        rules: curSched.rules,
        overrides: curSched.overrides,
      }});
      toast("Availability saved");
      renderAvailability();
    } catch (e) { toast(e.message); }
  });
  $("#av-new").addEventListener("click", async () => {
    const r = await api("/schedules", { method: "POST", body: { name: "New schedule" } }).catch(e => toast(e.message));
    if (r) { curSched = { ...r.schedule }; renderAvailability(); }
  });

  /* ---------- meetings ---------- */
  async function renderMeetings() {
    show("meetings");
    const { bookings } = await api("/bookings");
    const list = $("#mt-list");
    list.innerHTML = "";
    if (!bookings.length) list.innerHTML = '<p class="et-empty">No upcoming meetings. Share a link and they\u2019ll land here.</p>';
    for (const b of bookings) {
      const el = document.createElement("div");
      el.className = "bk-card" + (b.origin === "agent" ? " bk-agent" : "");
      const when = new Intl.DateTimeFormat("en-US", { timeZone: me.timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(b.start_at));
      el.innerHTML = `
        <span class="mt-when">${when}</span>
        <div style="flex:1">
          <p class="bk-who">${esc(b.invitee_name)} · ${esc(b.event_title)}</p>
          <p class="bk-note">${esc(b.invitee_email)}${b.location ? " · " + esc(b.location) : ""}</p>
          ${Object.entries(b.answers || {}).map(([k, v]) => `<p class="bk-note">↳ ${esc(v)}</p>`).join("")}
        </div>
        <div class="mt-status"><select aria-label="Status">
          ${["confirmed", "attended", "no_show", "cancelled"].map(s => `<option value="${s}" ${b.status === s ? "selected" : ""}>${s.replace("_", "-")}</option>`).join("")}
        </select></div>`;
      el.querySelector("select").addEventListener("change", async e => {
        await api(`/bookings/${b.id}/status`, { method: "PATCH", body: { status: e.target.value } }).catch(er => toast(er.message));
        toast("Updated");
      });
      list.appendChild(el);
    }
  }

  /* ---------- calendars ---------- */
  async function renderCalendars() {
    show("calendars");
    // OAuth redirect outcome (e.g. #/calendars?connected=google)
    const qs = (location.hash.split("?")[1] || "");
    const params = new URLSearchParams(qs);
    if (params.get("connected")) { toast("Calendar connected"); history.replaceState(null, "", "#/calendars"); }
    if (params.get("error")) { toast(params.get("error")); history.replaceState(null, "", "#/calendars"); }
    const { connections, providersReady } = await api("/calendar-connections");
    const provs = [
      { id: "google", name: "Google Calendar", logo: "📅", desc: "Gmail and Google Workspace calendars. Busy times sync in, bookings write back." },
      { id: "microsoft", name: "Microsoft 365 / Outlook", logo: "🗓", desc: "Outlook.com and work Microsoft accounts via Microsoft Graph." },
      { id: "icloud", name: "Apple iCloud", logo: "🍎", desc: "Connects with an app-specific password over CalDAV. No OAuth needed." },
    ];
    const grid = $("#cal-providers");
    grid.innerHTML = "";
    for (const p of provs) {
      const conns = connections.filter(c => c.provider === p.id);
      const ready = providersReady[p.id];
      const el = document.createElement("div");
      el.className = "prov-card";
      let body = "";
      for (const conn of conns) {
        const reauth = conn.status === "needs_reauth";
        body += `<div class="conn-row">
          <span class="prov-state ${reauth ? "waiting" : "ready"}">${reauth ? "needs reconnect" : "connected"} · ${esc(conn.account_email || "account")}</span>
          <label class="check-row small"><input type="radio" name="dest" data-dest="${conn.id}" ${conn.is_destination ? "checked" : ""}> bookings write here</label>
          <button class="linklike danger" data-disc="${conn.id}">Disconnect</button>
        </div>`;
      }
      if (ready) body += `<button class="btn btn-primary btn-sm prov-btn" data-p="${p.id}">${conns.length ? "Connect another account" : "Connect"}</button>`;
      else if (!conns.length) body += `<span class="prov-state waiting">ready to wire · awaiting ${p.id === "icloud" ? "launch" : "OAuth credentials"}</span>`;
      el.innerHTML = `
        <div class="prov-logo" aria-hidden="true">${p.logo}</div>
        <h3 class="serif">${p.name}</h3>
        <p class="mut">${p.desc}</p>${body}`;
      const btn = el.querySelector("[data-p]");
      if (btn) btn.addEventListener("click", async () => {
        try {
          const r = await api(`/oauth/${p.id}/start`);
          location.href = r.url;
        } catch (e) { toast(e.message); }
      });
      el.querySelectorAll("[data-dest]").forEach(radio => radio.addEventListener("change", async () => {
        await api(`/calendar-connections/${radio.dataset.dest}`, { method: "PATCH", body: { is_destination: true } }).catch(e => toast(e.message));
        toast("Destination updated");
        renderCalendars();
      }));
      el.querySelectorAll("[data-disc]").forEach(b => b.addEventListener("click", async () => {
        if (!confirm("Disconnect this calendar? Its busy times will stop blocking your availability.")) return;
        await api(`/calendar-connections/${b.dataset.disc}`, { method: "DELETE" }).catch(e => toast(e.message));
        renderCalendars();
      }));
      grid.appendChild(el);
    }
  }

  /* ---------- public profile ---------- */
  async function renderProfile(username) {
    show("profile");
    try {
      const { host, eventTypes } = await api("/pages/" + encodeURIComponent(username));
      $("#pf-host").innerHTML = `
        <div class="host-avatar">${esc((host.name || host.username).slice(0, 2).toUpperCase())}</div>
        <h1 class="serif">${esc(host.name || host.username)}</h1>
        ${host.welcome_note ? `<p>“${esc(host.welcome_note)}”</p>` : ""}`;
      const list = $("#pf-list");
      list.innerHTML = "";
      for (const et of eventTypes) {
        const el = document.createElement("div");
        el.className = "et-card pf-card";
        el.style.borderLeftColor = et.color;
        el.innerHTML = `
          <div class="et-info">
            <p class="et-title">${esc(et.title)} <span class="et-badge">${et.duration_min} min</span></p>
            ${et.description ? `<p class="bk-note">${esc(et.description)}</p>` : ""}
          </div><span class="pf-arrow">→</span>`;
        el.addEventListener("click", () => { location.hash = `#/u/${username}/${et.slug}`; });
        list.appendChild(el);
      }
    } catch {
      $("#pf-host").innerHTML = '<h1 class="serif">Page not found</h1>';
      $("#pf-list").innerHTML = "";
    }
  }

  /* ---------- public booking ---------- */
  let pb = { data: null, monthCursor: null, selectedDay: null, viewerTz: detectedTz, slot: null, username: null, slug: null, booking: null };

  async function renderPublic(username, slug) {
    show("public");
    pb.username = username; pb.slug = slug;
    $("#pb-confirmed").hidden = true;
    try {
      await loadPublicMonth(new Date());
    } catch (e) {
      $("#pub-page").innerHTML = `<p class="et-empty">${esc(e.message || "Page not found.")}</p>`;
      return;
    }
    const d = pb.data;
    $("#pb-avatar").textContent = (d.host.name || d.host.username).slice(0, 2).toUpperCase();
    $("#pb-hostname").textContent = d.host.name || d.host.username;
    $("#pb-welcome").textContent = d.host.welcome_note ? `“${d.host.welcome_note}”` : "";
    $("#pb-title").textContent = d.eventType.title;
    $("#pb-desc").textContent = d.eventType.description;
    $("#pb-meta").innerHTML = `<span class="chip">${d.eventType.durationMin} min</span>` +
      (d.eventType.locations || []).filter(Boolean).map((l, i) => `<span class="chip ${i ? "chip-alt" : ""}">${esc(l)}</span>`).join("");
    tzOptions($("#pb-tz"), pb.viewerTz);
    renderPubCal();
  }
  async function loadPublicMonth(fromDate) {
    const fromKey = fromDate.toISOString().slice(0, 10);
    pb.data = await api(`/pages/${encodeURIComponent(pb.username)}/${encodeURIComponent(pb.slug)}?from=${fromKey}&days=45`);
    pb.monthCursor = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
    const firstOpen = Object.entries(pb.data.days).find(([, s]) => s.length);
    pb.selectedDay = firstOpen ? firstOpen[0] : null;
    if (firstOpen) {
      const [y, m] = firstOpen[0].split("-").map(Number);
      pb.monthCursor = new Date(y, m - 1, 1);
    }
  }
  function renderPubCal() {
    const y = pb.monthCursor.getFullYear(), m = pb.monthCursor.getMonth();
    $("#pb-month").textContent = pb.monthCursor.toLocaleString("en-US", { month: "long", year: "numeric" });
    const grid = $("#pb-grid");
    grid.innerHTML = "";
    for (const dd of ["S", "M", "T", "W", "T", "F", "S"]) {
      const el = document.createElement("div");
      el.className = "cal-dow"; el.textContent = dd; grid.appendChild(el);
    }
    const first = new Date(y, m, 1);
    for (let i = 0; i < first.getDay(); i++) grid.appendChild(document.createElement("div"));
    const daysIn = new Date(y, m + 1, 0).getDate();
    for (let d = 1; d <= daysIn; d++) {
      const key = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const slots = pb.data.days[key] || [];
      const btn = document.createElement("button");
      btn.className = "cal-day"; btn.textContent = d;
      if (slots.length) {
        btn.classList.add("open");
        if (key === pb.selectedDay) btn.classList.add("selected");
        btn.addEventListener("click", () => { pb.selectedDay = key; renderPubCal(); });
      } else btn.disabled = true;
      grid.appendChild(btn);
    }
    renderPubSlots();
  }
  function renderPubSlots() {
    const list = $("#pb-slots");
    list.innerHTML = "";
    if (!pb.selectedDay) { $("#pb-date").textContent = "No open times this month"; return; }
    const slots = pb.data.days[pb.selectedDay] || [];
    if (slots.length) $("#pb-date").textContent = fmtDay(slots[0].start, pb.viewerTz);
    for (const s of slots) {
      const el = document.createElement("button");
      el.className = "slot";
      el.innerHTML = `<span>${fmtTime(s.start, pb.viewerTz)}</span>`;
      el.addEventListener("click", () => openPubSheet(s));
      list.appendChild(el);
    }
  }
  $("#pb-prev").addEventListener("click", () => { pb.monthCursor = new Date(pb.monthCursor.getFullYear(), pb.monthCursor.getMonth() - 1, 1); renderPubCal(); });
  $("#pb-next").addEventListener("click", async () => {
    const next = new Date(pb.monthCursor.getFullYear(), pb.monthCursor.getMonth() + 1, 1);
    if (!Object.keys(pb.data.days).some(k => k.startsWith(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`))) {
      try { await loadPublicMonth(next); } catch {}
    } else pb.monthCursor = next;
    renderPubCal();
  });
  $("#pb-tz").addEventListener("change", e => { pb.viewerTz = e.target.value; renderPubSlots(); });

  function dualTz(iso) {
    const v = fmtTime(iso, pb.viewerTz);
    const h = fmtTime(iso, pb.data.hostTz);
    if (pb.viewerTz === pb.data.hostTz) return `${v} — you're in the same timezone as ${pb.data.host.name || "the host"}`;
    return `${v} for you · ${h} for ${pb.data.host.name || "the host"}`;
  }
  function openPubSheet(s) {
    pb.slot = s;
    $("#pb-sheettime").textContent = new Intl.DateTimeFormat("en-US", { timeZone: pb.viewerTz, weekday: "short", month: "short", day: "numeric" }).format(new Date(s.start)) + " · " + fmtTime(s.start, pb.viewerTz);
    $("#pb-tzline").textContent = dualTz(s.start);
    // questions
    const qwrap = $("#pb-questions");
    qwrap.innerHTML = "";
    for (const qq of pb.data.eventType.questions || []) {
      if (!qq.label) continue;
      const lab = document.createElement("label");
      lab.innerHTML = `${esc(qq.label)}${qq.required ? "" : ' <span class="opt">optional</span>'}`;
      let input;
      if (qq.type === "textarea") { input = document.createElement("textarea"); input.rows = 2; }
      else { input = document.createElement("input"); input.type = qq.type === "phone" ? "tel" : "text"; }
      input.dataset.qid = qq.id;
      if (qq.required) input.required = true;
      lab.appendChild(input);
      qwrap.appendChild(lab);
    }
    // location choice
    const lwrap = $("#pb-locpick");
    lwrap.innerHTML = "";
    const locs = (pb.data.eventType.locations || []).filter(Boolean);
    if (locs.length > 1) {
      const lab = document.createElement("label");
      lab.textContent = "Where";
      const sel = document.createElement("select");
      sel.id = "pb-loc";
      selOptions(sel, locs.map(l => [l, l]), locs[0]);
      lab.appendChild(sel);
      lwrap.appendChild(lab);
    }
    $("#pb-error").hidden = true;
    $("#pb-backdrop").hidden = false;
    $("#pb-sheet").hidden = false;
    $("#pb-name").focus();
  }
  function closePubSheet() { $("#pb-backdrop").hidden = true; $("#pb-sheet").hidden = true; }
  $("#pb-close").addEventListener("click", closePubSheet);
  $("#pb-backdrop").addEventListener("click", closePubSheet);

  $("#pb-form").addEventListener("submit", async e => {
    e.preventDefault();
    $("#pb-error").hidden = true;
    $("#pb-confirm").disabled = true;
    try {
      const hold = await api("/holds", { method: "POST", body: { eventTypeId: pb.data.eventType.id, start: pb.slot.start } });
      const answers = {};
      document.querySelectorAll("#pb-questions [data-qid]").forEach(i => { if (i.value) answers[i.dataset.qid] = i.value; });
      const booking = await api("/public-bookings", {
        method: "POST",
        headers: { "Idempotency-Key": hold.holdId },
        body: {
          holdId: hold.holdId,
          name: $("#pb-name").value.trim(),
          email: $("#pb-email").value.trim(),
          answers,
          location: $("#pb-loc") ? $("#pb-loc").value : undefined,
        },
      });
      pb.booking = booking;
      closePubSheet();
      $("#pb-when").textContent = fmtDay(booking.start, pb.viewerTz) + " · " + fmtTime(booking.start, pb.viewerTz) + "–" + fmtTime(booking.end, pb.viewerTz);
      $("#pb-whentz").textContent = dualTz(booking.start);
      $("#pb-cancel-link").href = `#/cancel/${booking.bookingId}/${booking.cancelToken}`;
      $("#pb-confirmed").hidden = false;
    } catch (err) {
      $("#pb-error").textContent = err.message;
      $("#pb-error").hidden = false;
      if (err.status === 409 || err.status === 410) {
        try { await loadPublicMonth(pb.monthCursor); renderPubCal(); } catch {}
      }
    }
    $("#pb-confirm").disabled = false;
  });
  $("#pb-ics").addEventListener("click", () => {
    if (!pb.booking) return;
    const dt = iso => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Bookii//EN", "BEGIN:VEVENT",
      "UID:" + pb.booking.bookingId + "@bookii.to", "DTSTAMP:" + dt(new Date().toISOString()),
      "DTSTART:" + dt(pb.booking.start), "DTEND:" + dt(pb.booking.end),
      "SUMMARY:" + pb.booking.eventTitle + " — " + (pb.data.host.name || pb.data.host.username),
      "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const a = document.createElement("a");
    a.href = "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
    a.download = "bookii-" + pb.slug + ".ics"; a.click();
  });

  /* ---------- cancel ---------- */
  function renderCancel(id, token) {
    show("cancel");
    $("#cx-msg").textContent = "Are you sure you want to cancel this booking?";
    const btn = $("#cx-btn");
    btn.hidden = false;
    btn.onclick = async () => {
      try {
        await api(`/public-bookings/${id}/cancel`, { method: "POST", body: { cancelToken: token } });
        $("#cx-msg").textContent = "Cancelled. The time is open again.";
        btn.hidden = true;
      } catch (e) { $("#cx-msg").textContent = e.message; }
    };
  }

  route();
})();
