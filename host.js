/* Bookii app — host dashboard + public booking, against api.bookii.to. */
(function () {
  const API = location.hostname === "localhost" ? "http://localhost:3000/v1" : "https://api.bookii.to/v1";
  const $ = (s, r) => (r || document).querySelector(s);
  const encPath = s => String(s).split("/").map(encodeURIComponent).join("/");
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
  const VIEWS = ["auth", "invite", "onboarding", "dashboard", "editor", "availability", "meetings", "calendars", "teams", "team", "insights", "settings", "profile", "public", "cancel"];
  function show(view) {
    for (const v of VIEWS) $("#view-" + v).hidden = v !== view;
    const appViews = ["dashboard", "editor", "availability", "meetings", "calendars", "teams", "team", "insights", "settings"];
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
      if (h[0] === "reschedule" && h[1] && h[2]) return renderReschedule(h[1], h[2]);
      if (p[0] === "team" && p[1]) {
        if (p[2]) return renderPublic("team/" + p[1], p[2]);
        return renderProfile("team/" + p[1]);
      }
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
    if (parts[0] === "t" && parts[1]) {
      if (parts[2]) return renderPublic("team/" + parts[1], parts[2]);
      return renderProfile("team/" + parts[1]);
    }
    if (parts[0] === "cancel" && parts[1] && parts[2]) return renderCancel(parts[1], parts[2]);
    if (parts[0] === "reschedule" && parts[1] && parts[2]) return renderReschedule(parts[1], parts[2]);
    if (parts[0] === "auth-token" && parts[1]) return consumeMagicLink(parts[1]);
    if (parts[0] === "reset" && parts[1]) return renderResetForm(parts[1]);
    // resolve session before invite (which needs to know if logged in)
    if (!me) {
      const token = localStorage.getItem("bookii-token");
      if (token) { try { me = (await api("/me")).user; } catch { localStorage.removeItem("bookii-token"); } }
    }
    if (parts[0] === "invite" && parts[1]) return renderInvite(parts[1]);
    // authed routes
    if (!me) { renderAuth(parts[0] === "login" ? "login" : "signup"); return; }
    if (!me.username) return renderOnboarding();
    switch (parts[0]) {
      case "availability": return renderAvailability();
      case "meetings": return renderMeetings();
      case "calendars": return renderCalendars();
      case "settings": return renderSettings();
      case "insights": return renderInsights();
      case "teams": return renderTeams();
      case "team": return renderTeamDetail(parts[1]);
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
    const titles = { signup: "Create your page", login: "Welcome back", reset: "Set a new password" };
    $("#auth-title").textContent = titles[mode];
    $("#auth-sub").hidden = mode !== "signup";
    $("#auth-name-wrap").hidden = mode !== "signup";
    $("#a-email").parentElement.hidden = mode === "reset";
    $("#auth-submit").textContent = mode === "signup" ? "Sign up" : mode === "reset" ? "Save password" : "Sign in";
    $("#auth-alt").hidden = mode !== "login";
    $("#auth-switch").parentElement.hidden = mode === "reset";
    $("#auth-switch-label").textContent = mode === "signup" ? "Already have an account?" : "New here?";
    $("#auth-switch").textContent = mode === "signup" ? "Sign in" : "Create an account";
    $("#auth-error").hidden = true;
    $("#auth-info").hidden = true;
    $("#a-email").readOnly = false;
    show("auth");
  }
  $("#auth-switch").addEventListener("click", () => renderAuth(authMode === "signup" ? "login" : "signup"));
  async function consumeMagicLink(token) {
    show("auth");
    renderAuth("login");
    $("#auth-info").textContent = "Signing you in…"; $("#auth-info").hidden = false;
    try {
      const data = await api("/auth/magic-verify", { method: "POST", body: { token } });
      localStorage.setItem("bookii-token", data.token);
      me = data.user;
      location.hash = "#/dashboard"; route();
    } catch (e) {
      $("#auth-info").hidden = true;
      $("#auth-error").textContent = e.message; $("#auth-error").hidden = false;
    }
  }
  let resetToken = null;
  function renderResetForm(token) {
    resetToken = token;
    renderAuth("reset");
  }
  $("#auth-magic").addEventListener("click", async () => {
    const email = $("#a-email").value.trim();
    if (!email) { $("#auth-error").textContent = "Enter your email first."; $("#auth-error").hidden = false; return; }
    $("#auth-error").hidden = true;
    try {
      const r = await api("/auth/magic-link", { method: "POST", body: { email } });
      $("#auth-info").textContent = r.message; $("#auth-info").hidden = false;
    } catch (e) { $("#auth-error").textContent = e.message; $("#auth-error").hidden = false; }
  });
  $("#auth-forgot").addEventListener("click", async () => {
    const email = $("#a-email").value.trim();
    if (!email) { $("#auth-error").textContent = "Enter your email first."; $("#auth-error").hidden = false; return; }
    $("#auth-error").hidden = true;
    try {
      const r = await api("/auth/forgot", { method: "POST", body: { email } });
      $("#auth-info").textContent = r.message; $("#auth-info").hidden = false;
    } catch (e) { $("#auth-error").textContent = e.message; $("#auth-error").hidden = false; }
  });
  $("#auth-form").addEventListener("submit", async e => {
    e.preventDefault();
    $("#auth-error").hidden = true;
    try {
      const body = { email: $("#a-email").value.trim(), password: $("#a-password").value };
      let data;
      if (authMode === "reset") {
        data = await api("/auth/reset", { method: "POST", body: { token: resetToken, password: body.password } });
      } else if (authMode === "signup") {
        body.name = $("#a-name").value.trim();
        body.timezone = detectedTz;
        data = await api("/auth/signup", { method: "POST", body });
      } else {
        data = await api("/auth/login", { method: "POST", body });
      }
      localStorage.setItem("bookii-token", data.token);
      me = data.user;
      if (pendingInvite) { location.hash = "#/invite/" + pendingInvite; return; }
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
    renderChecklist(eventTypes).catch(() => {});
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
  async function renderChecklist(eventTypes) {
    if (localStorage.getItem("bookii-checklist-done")) { $("#dash-checklist").hidden = true; return; }
    const [{ connections }, { bookings }] = await Promise.all([
      api("/calendar-connections"), api("/bookings"),
    ]);
    const items = [
      ["Claim your link", !!me.username, "#/settings"],
      ["Create an event type", eventTypes.length > 0, "#/event/new"],
      ["Connect a calendar", connections.some(c => c.status === "connected"), "#/calendars"],
      ["Share your link", bookings.length > 0, null], // done once someone books
    ];
    const doneCount = items.filter(i => i[1]).length;
    if (doneCount === items.length) { localStorage.setItem("bookii-checklist-done", "1"); $("#dash-checklist").hidden = true; return; }
    const wrap = $("#checklist-items");
    wrap.innerHTML = "";
    for (const [label, done, href] of items) {
      const row = document.createElement(done || !href ? "div" : "a");
      if (href && !done) row.href = href;
      row.className = "check-item" + (done ? " done" : "");
      row.innerHTML = `<span class="check-dot">${done ? "✓" : ""}</span><span>${label}</span>`;
      if (label === "Share your link" && !done) {
        const btn = document.createElement("button");
        btn.className = "linklike"; btn.textContent = "copy link";
        btn.addEventListener("click", async (e) => {
          e.preventDefault();
          await navigator.clipboard.writeText(`https://from.bookii.to/${me.username}`).catch(() => {});
          toast("Link copied — send it to someone!");
        });
        row.appendChild(btn);
      }
      wrap.appendChild(row);
    }
    $("#dash-checklist").hidden = false;
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
    $("#ed-allow-resched").checked = ed.allow_reschedule !== false;
    $("#ed-allow-cancel").checked = ed.allow_cancel !== false;
    $("#ed-policy").value = ed.cancel_policy || "";
    renderEmbedCode();
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
      allow_reschedule: $("#ed-allow-resched").checked,
      allow_cancel: $("#ed-allow-cancel").checked,
      cancel_policy: $("#ed-policy").value.trim(),
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
  /* embed generator */
  let embMode = "inline";
  function renderEmbedCode() {
    const url = `https://from.bookii.to/${me.username}/${ed.slug || "your-event"}?embed=1`;
    const code = embMode === "inline"
      ? `<iframe src="${url}"\n  style="width:100%;min-height:640px;border:0;border-radius:12px"\n  title="Book with ${me.name || me.username}"></iframe>`
      : `<button onclick="window.open('${url.replace("?embed=1", "")}','bookii','width=980,height=760')"\n  style="background:#2B3EE5;color:#fff;border:0;border-radius:999px;padding:12px 24px;\n  font-size:15px;font-weight:600;cursor:pointer">Book time with ${me.name || me.username}</button>`;
    $("#ed-embed-code").textContent = code;
  }
  document.querySelectorAll("[data-emb]").forEach(b => b.addEventListener("click", () => {
    embMode = b.dataset.emb;
    document.querySelectorAll("[data-emb]").forEach(x => x.classList.toggle("on", x === b));
    renderEmbedCode();
  }));
  $("#ed-embed-copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#ed-embed-code").textContent).catch(() => {});
    $("#ed-embed-copied").hidden = false;
    setTimeout(() => { $("#ed-embed-copied").hidden = true; }, 1500);
  });
  for (const id of ["ed-allow-resched", "ed-allow-cancel", "ed-policy"]) $("#" + id).addEventListener("input", onEdit);

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
    initTroubleshooter().catch(() => {});
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
  /* ---------- troubleshooter ---------- */
  const VERDICT_LABELS = {
    open: ["✓ offered", "ts-ok"],
    too_soon: ["min notice", "ts-warn"],
    beyond_window: ["window", "ts-warn"],
    booked: ["booked", "ts-block"],
    calendar_busy: ["calendar busy", "ts-block"],
    held: ["held", "ts-warn"],
  };
  async function initTroubleshooter() {
    const { eventTypes } = await api("/event-types");
    selOptions($("#ts-event"), eventTypes.map(e => [e.id, e.title]), eventTypes[0]?.id);
    if (!$("#ts-date").value) $("#ts-date").value = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  }
  $("#ts-run").addEventListener("click", async () => {
    const out = $("#ts-result");
    out.innerHTML = '<p class="mut small">Checking…</p>';
    try {
      const r = await api(`/troubleshoot/${$("#ts-event").value}/${$("#ts-date").value}`);
      let html = "";
      if (r.dayInfo.blockedAllDay) html += '<p class="ts-note">This date is <strong>blocked all day</strong> by a date override.</p>';
      else if (r.dayInfo.noRules) html += '<p class="ts-note">Your schedule has <strong>no working hours</strong> on this weekday.</p>';
      else {
        html += `<p class="ts-note">Working hours: ${r.dayInfo.workingRanges.map(([a, b]) => `${minToLabel(a)}–${minToLabel(b)}`).join(", ")}${r.dayInfo.hasOverride ? " (date override)" : ""}${r.externalBusy.length ? ` · ${r.externalBusy.length} busy block${r.externalBusy.length > 1 ? "s" : ""} from connected calendars` : ""}</p>`;
        html += '<div class="ts-slots">';
        for (const s of r.slots) {
          const [label, cls] = VERDICT_LABELS[s.verdict] || [s.verdict, "ts-warn"];
          html += `<div class="ts-slot ${cls}" ${s.detail ? `title="${esc(s.detail)}"` : ""}>
            <span>${fmtTime(s.start, r.tz)}</span><span class="ts-verdict">${label}</span></div>`;
        }
        html += "</div>";
        const blocked = r.slots.filter(s => s.verdict !== "open");
        if (blocked.length) {
          html += '<details class="ts-details"><summary>Details</summary><ul>';
          for (const s of blocked) html += `<li><strong>${fmtTime(s.start, r.tz)}</strong> — ${esc(s.detail || s.verdict)}</li>`;
          html += "</ul></details>";
        }
      }
      out.innerHTML = html || '<p class="mut small">Nothing to show.</p>';
    } catch (e) { out.innerHTML = `<p class="form-error">${esc(e.message)}</p>`; }
  });

  $("#av-new").addEventListener("click", async () => {
    const r = await api("/schedules", { method: "POST", body: { name: "New schedule" } }).catch(e => toast(e.message));
    if (r) { curSched = { ...r.schedule }; renderAvailability(); }
  });

  /* ---------- meetings ---------- */
  let mtFilter = "upcoming";
  const MT_TABS = [
    ["upcoming", "Upcoming", b => new Date(b.start_at) >= new Date() && ["pending", "confirmed"].includes(b.status)],
    ["pending", "Pending", b => b.status === "pending"],
    ["past", "Past", b => new Date(b.start_at) < new Date() && b.status !== "cancelled"],
    ["cancelled", "Cancelled", b => b.status === "cancelled"],
  ];
  async function renderMeetings() {
    show("meetings");
    const { bookings } = await api("/bookings");
    const tabs = $("#mt-tabs");
    tabs.innerHTML = "";
    for (const [id, label, pred] of MT_TABS) {
      const n = bookings.filter(pred).length;
      const btn = document.createElement("button");
      btn.className = "sched-tab" + (mtFilter === id ? " on" : "");
      btn.textContent = n ? `${label} · ${n}` : label;
      btn.addEventListener("click", () => { mtFilter = id; renderMeetings(); });
      tabs.appendChild(btn);
    }
    const pred = MT_TABS.find(t => t[0] === mtFilter)[2];
    let shown = bookings.filter(pred);
    if (mtFilter === "upcoming") shown = shown.slice().reverse(); // soonest first
    const list = $("#mt-list");
    list.innerHTML = "";
    if (!shown.length) list.innerHTML = `<p class="et-empty">${mtFilter === "upcoming" ? "No upcoming meetings. Share a link and they\u2019ll land here." : "Nothing here."}</p>`;
    for (const b of shown) {
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

  /* ---------- settings ---------- */
  let stTimer = null, stOrigUsername = null;
  async function renderSettings() {
    show("settings");
    const { user } = await api("/me");
    me = user;
    stOrigUsername = user.username;
    $("#st-name").value = user.name || "";
    $("#st-username").value = user.username || "";
    $("#st-welcome").value = user.welcome_note || "";
    tzOptions($("#st-tz"), user.timezone);
    $("#st-un-status").textContent = "";
    $("#st-un-warn").hidden = true;
    $("#st-error").hidden = true;
    const np = user.notify_prefs || {};
    $("#st-n-booked").checked = np.booked !== false;
    $("#st-n-cancelled").checked = np.cancelled !== false;
    $("#st-n-digest").checked = np.digest === true;
    renderDevKeys().catch(() => {});
    renderWebhooks().catch(() => {});
    renderAgentLog().catch(() => {});
    api("/billing").then(b => {
      $("#st-billing").innerHTML = `
        <p style="margin:0 0 .3rem"><span class="prov-state ready">${esc(b.planLabel)}</span></p>
        <p class="mut small">${esc(b.note)}</p>
        <p class="mut small"><a href="/pricing.html" target="_blank" rel="noopener">See future pricing →</a></p>`;
    }).catch(() => {});
  }
  $("#st-username").addEventListener("input", () => {
    const un = $("#st-username").value.trim().toLowerCase();
    $("#st-un-warn").hidden = un === stOrigUsername;
    clearTimeout(stTimer);
    if (un === stOrigUsername) { $("#st-un-status").textContent = ""; return; }
    stTimer = setTimeout(async () => {
      if (un.length < 3) { $("#st-un-status").textContent = ""; return; }
      try {
        const r = await api("/username-check/" + encodeURIComponent(un));
        $("#st-un-status").textContent = r.available ? "✓ available" : "taken";
        $("#st-un-status").className = "slug-status " + (r.available ? "ok" : "bad");
      } catch {}
    }, 350);
  });
  for (const id of ["st-n-booked", "st-n-cancelled", "st-n-digest"]) {
    $("#" + id).addEventListener("change", async () => {
      await api("/me", { method: "PATCH", body: { notify_prefs: {
        booked: $("#st-n-booked").checked,
        cancelled: $("#st-n-cancelled").checked,
        digest: $("#st-n-digest").checked,
      } } }).catch(e => toast(e.message));
      toast("Preferences saved");
    });
  }
  $("#st-save").addEventListener("click", async () => {
    $("#st-error").hidden = true;
    try {
      const r = await api("/me", { method: "PATCH", body: {
        name: $("#st-name").value.trim(),
        username: $("#st-username").value.trim().toLowerCase(),
        welcome_note: $("#st-welcome").value.trim(),
        timezone: $("#st-tz").value,
      } });
      me = r.user;
      stOrigUsername = me.username;
      $("#st-un-warn").hidden = true;
      toast("Saved");
    } catch (e) {
      $("#st-error").textContent = e.message;
      $("#st-error").hidden = false;
    }
  });
  /* ---------- developer: keys, agents, webhooks ---------- */
  async function renderDevKeys() {
    const { keys } = await api("/api-keys");
    const fill = (sel, kind) => {
      const el = $(sel);
      el.innerHTML = "";
      const mine = keys.filter(kk => kk.kind === kind);
      if (!mine.length) el.innerHTML = '<p class="mut small">None yet.</p>';
      for (const kk of mine) {
        const row = document.createElement("div");
        row.className = "dk-row";
        const used = kk.last_used ? new Date(kk.last_used).toLocaleDateString() : "never used";
        row.innerHTML = `<span class="dk-key">${esc(kk.prefix)}…${esc(kk.last4)}</span>
          <span class="dk-meta">${esc(kk.agent_name || kk.name)} · ${kk.scopes.map(esc).join(", ")} · ${used}</span>
          <button class="range-x" aria-label="Revoke">×</button>`;
        row.querySelector("button").addEventListener("click", async () => {
          if (!confirm("Revoke this key? Anything using it stops working immediately.")) return;
          await api("/api-keys/" + kk.id, { method: "DELETE" }).catch(e => toast(e.message));
          renderDevKeys();
        });
        el.appendChild(row);
      }
    };
    fill("#dk-list", "api");
    fill("#ag-list", "agent");
  }
  function showSecret(sel, secret) {
    const el = $(sel);
    el.innerHTML = `<p class="mut small">Copy this now — it won't be shown again.</p>
      <code>${esc(secret)}</code> <button class="linklike">copy</button>`;
    el.querySelector("button").addEventListener("click", async () => {
      await navigator.clipboard.writeText(secret).catch(() => {});
      toast("Copied");
    });
    el.hidden = false;
  }
  $("#dk-create").addEventListener("click", async () => {
    try {
      const r = await api("/api-keys", { method: "POST", body: { name: $("#dk-name").value.trim() || "API key", scopes: ["read-availability", "create-booking", "manage-bookings"] } });
      showSecret("#dk-secret", r.secret);
      $("#dk-name").value = "";
      renderDevKeys();
    } catch (e) { toast(e.message); }
  });
  $("#ag-create").addEventListener("click", async () => {
    const scopes = [];
    if ($("#ag-s-read").checked) scopes.push("read-availability");
    if ($("#ag-s-book").checked) scopes.push("create-booking");
    if ($("#ag-s-manage").checked) scopes.push("manage-bookings");
    try {
      const name = $("#ag-name").value.trim() || "Agent";
      const r = await api("/api-keys", { method: "POST", body: { kind: "agent", name, agent_name: name, scopes } });
      showSecret("#ag-secret", r.secret);
      $("#ag-name").value = "";
      renderDevKeys();
    } catch (e) { toast(e.message); }
  });
  async function renderAgentLog() {
    const { actions } = await api("/agent-actions").catch(() => ({ actions: [] }));
    const el = $("#ag-log");
    if (!actions.length) { el.innerHTML = '<p class="mut small">No agent activity yet.</p>'; return; }
    el.innerHTML = actions.slice(0, 30).map(a =>
      `<p class="mut small" style="margin:.25rem 0">${new Date(a.created_at).toLocaleString()} · <strong>${esc(a.agent_name || a.key_name || "agent")}</strong> ${esc(a.action)}${a.detail?.eventType ? " · " + esc(a.detail.eventType) : ""}</p>`).join("");
  }
  async function renderWebhooks() {
    const { webhooks } = await api("/webhooks");
    const el = $("#wh-list");
    el.innerHTML = "";
    if (!webhooks.length) el.innerHTML = '<p class="mut small">None yet.</p>';
    for (const w of webhooks) {
      const row = document.createElement("div");
      row.className = "wh-row";
      row.innerHTML = `
        <div class="dk-row"><span class="dk-key">${esc(w.url)}</span>
          <span class="dk-meta">${w.events.map(esc).join(", ")}${w.active ? "" : " · paused"}</span>
          <button class="linklike" data-a="test">test</button>
          <button class="linklike" data-a="log">deliveries</button>
          <button class="range-x" aria-label="Delete">×</button></div>
        <p class="mut small">secret: <code>${esc(w.secret)}</code></p>
        <div class="wh-log" hidden></div>`;
      row.querySelector('[data-a=test]').addEventListener("click", async () => {
        const r = await api(`/webhooks/${w.id}/test`, { method: "POST" }).catch(e => ({ ok: false, responseText: e.message }));
        toast(r.ok ? `Delivered (${r.statusCode})` : `Failed: ${r.responseText || r.statusCode || "no response"}`);
      });
      row.querySelector('[data-a=log]').addEventListener("click", async () => {
        const log = row.querySelector(".wh-log");
        if (!log.hidden) { log.hidden = true; return; }
        const { deliveries } = await api(`/webhooks/${w.id}/deliveries`);
        log.innerHTML = deliveries.length ? deliveries.map(d =>
          `<p class="mut small" style="margin:.2rem 0">${new Date(d.created_at).toLocaleString()} · ${esc(d.event)} · ${d.ok ? "✓" : "✗"} ${d.status_code ?? "—"} <button class="linklike" data-r="${d.id}">replay</button></p>`).join("")
          : '<p class="mut small">No deliveries yet.</p>';
        log.querySelectorAll("[data-r]").forEach(b => b.addEventListener("click", async () => {
          const r = await api(`/webhooks/${w.id}/deliveries/${b.dataset.r}/replay`, { method: "POST" }).catch(e => ({ ok: false }));
          toast(r.ok ? "Replayed ✓" : "Replay failed");
        }));
        log.hidden = false;
      });
      row.querySelector(".range-x").addEventListener("click", async () => {
        if (!confirm("Delete this webhook?")) return;
        await api("/webhooks/" + w.id, { method: "DELETE" }).catch(e => toast(e.message));
        renderWebhooks();
      });
      el.appendChild(row);
    }
  }
  $("#wh-create").addEventListener("click", async () => {
    try {
      await api("/webhooks", { method: "POST", body: { url: $("#wh-url").value.trim() } });
      $("#wh-url").value = "";
      renderWebhooks();
    } catch (e) { toast(e.message); }
  });

  $("#st-delete").addEventListener("click", async () => {
    const typed = prompt(`This permanently deletes your account, page, and all bookings.\n\nType your email (${me.email}) to confirm:`);
    if (typed === null) return;
    try {
      await api("/me", { method: "DELETE", body: { confirmEmail: typed.trim() } });
      localStorage.removeItem("bookii-token");
      me = null;
      alert("Your account has been deleted.");
      location.href = "https://bookii.to/";
    } catch (e) { toast(e.message); }
  });

  /* ---------- teams ---------- */
  let curTeam = null;
  async function renderTeams() {
    show("teams");
    const { teams } = await api("/teams");
    const list = $("#tm-list");
    list.innerHTML = "";
    if (!teams.length) list.innerHTML = '<p class="et-empty">No teams yet — create one for your company.</p>';
    for (const t of teams) {
      const el = document.createElement("div");
      el.className = "et-card pf-card";
      el.innerHTML = `<div class="et-info">
          <p class="et-title">${esc(t.name)} <span class="et-badge">${esc(t.role)}</span></p>
          <p class="et-link">from.bookii.to/team/${esc(t.slug)}</p>
        </div><span class="pf-arrow">→</span>`;
      el.addEventListener("click", () => { location.hash = "#/team/" + t.id; });
      list.appendChild(el);
    }
  }
  $("#tm-new").addEventListener("click", () => { $("#tm-create").hidden = !$("#tm-create").hidden; });
  $("#tm-name").addEventListener("input", () => {
    $("#tm-slug").value = $("#tm-name").value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  });
  $("#tm-create-go").addEventListener("click", async () => {
    try {
      const r = await api("/teams", { method: "POST", body: { name: $("#tm-name").value.trim(), slug: $("#tm-slug").value.trim() } });
      $("#tm-create").hidden = true;
      location.hash = "#/team/" + r.team.id;
    } catch (e) { toast(e.message); }
  });

  async function renderTeamDetail(id) {
    show("team");
    const d = await api("/teams/" + id).catch(() => null);
    if (!d) { location.hash = "#/teams"; return; }
    curTeam = d;
    const isAdmin = ["owner", "admin"].includes(d.team.role);
    $("#td-name").textContent = d.team.name;
    $("#td-link").innerHTML = `<a href="https://from.bookii.to/team/${esc(d.team.slug)}" target="_blank" rel="noopener">from.bookii.to/team/${esc(d.team.slug)}</a>`;
    $("#td-edit-name").value = d.team.name;
    $("#td-edit-bio").value = d.team.bio || "";

    // parallel loads
    const [{ meetings }, stats] = await Promise.all([
      api(`/teams/${id}/meetings`).catch(() => ({ meetings: [] })),
      api(`/teams/${id}/host-stats`).catch(() => ({ hosts: [], hostConfig: [] })),
    ]);

    // team show rate
    const att = stats.hosts.reduce((a, h) => a + h.attended, 0);
    const ns = stats.hosts.reduce((a, h) => a + h.no_show, 0);
    $("#td-showrate").textContent = att + ns > 0 ? Math.round(100 * att / (att + ns)) + "%" : "—";

    // team meetings — who got routed where
    const mtEl = $("#td-meetings");
    mtEl.innerHTML = "";
    const upcoming = meetings.filter(m => m.status !== "cancelled");
    if (!upcoming.length) mtEl.innerHTML = '<p class="mut small">No team meetings yet — share a team link.</p>';
    for (const m of upcoming.slice(0, 12)) {
      const when = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(m.start_at));
      const row = document.createElement("div");
      row.className = "bk-card" + (m.origin === "agent" ? " bk-agent" : "");
      row.innerHTML = `<span class="mt-when">${when}</span>
        <div style="flex:1"><p class="bk-who">${esc(m.invitee_name)} · ${esc(m.event_title)}</p>
        <p class="bk-note">→ ${esc(m.host_name || m.host_username)}${m.status !== "confirmed" ? " · " + esc(m.status) : ""}</p></div>`;
      mtEl.appendChild(row);
    }

    // availability strip
    selOptions($("#td-avail-et"), d.eventTypes.map(e => [e.slug, e.title]), d.eventTypes[0]?.slug);
    renderTeamAvail(d);
    $("#td-avail-et").onchange = () => renderTeamAvail(d);

    // members with rotation stats + priority + pause (config from first RR event as representative)
    const mEl = $("#td-members");
    mEl.innerHTML = "";
    const rrEt = d.eventTypes.find(e => e.scheduling_type === "round_robin");
    for (const m of d.members) {
      const st = stats.hosts.find(h => h.user_id === m.id) || {};
      const cfg = rrEt ? stats.hostConfig.find(hc => hc.event_type_id === rrEt.id && hc.user_id === m.id) : null;
      const last = st.last_assigned ? new Date(st.last_assigned).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "never";
      const noHours = st.rule_count === 0;
      const row = document.createElement("div");
      row.className = "tdm-row" + (cfg?.paused ? " tdm-paused" : "");
      row.innerHTML = `
        <div class="tdm-top">
          <span class="tdm-name">${esc(m.name || m.email)}</span>
          <span class="et-badge">${esc(m.role)}</span>
          ${noHours ? '<span class="et-badge tdm-warn">no working hours set</span>' : ""}
          ${cfg?.paused ? '<span class="et-badge tdm-warn">paused</span>' : ""}
        </div>
        <p class="tdm-stats">${st.bookings_30d || 0} bookings · 30d · last assigned ${last}</p>
        ${isAdmin && cfg ? `<div class="tdm-controls">
          <label class="check-row small"><input type="checkbox" data-pause ${cfg.paused ? "checked" : ""}> pause rotation</label>
          <label class="tdm-pri">priority <input type="range" min="0" max="4" value="${cfg.priority}" data-pri></label>
        </div>` : ""}
        ${isAdmin && m.role !== "owner" ? '<button class="range-x tdm-x" aria-label="Remove">×</button>' : ""}`;
      const pause = row.querySelector("[data-pause]");
      if (pause) pause.addEventListener("change", async () => {
        await api(`/teams/${id}/event-types/${rrEt.id}/hosts/${m.id}`, { method: "PATCH", body: { paused: pause.checked } }).catch(e => toast(e.message));
        toast(pause.checked ? "Paused — no new bookings routed here" : "Back in the rotation");
        renderTeamDetail(id);
      });
      const pri = row.querySelector("[data-pri]");
      if (pri) pri.addEventListener("change", async () => {
        await api(`/teams/${id}/event-types/${rrEt.id}/hosts/${m.id}`, { method: "PATCH", body: { priority: +pri.value } }).catch(e => toast(e.message));
        toast("Priority updated");
      });
      const x = row.querySelector(".tdm-x");
      if (x) x.addEventListener("click", async () => {
        if (!confirm(`Remove ${m.name || m.email} from the team?`)) return;
        await api(`/teams/${id}/members/${m.id}`, { method: "DELETE" }).catch(e => toast(e.message));
        renderTeamDetail(id);
      });
      mEl.appendChild(row);
    }

    // host picker for new event
    const hEl = $("#td-et-hosts");
    hEl.innerHTML = "";
    for (const m of d.members) {
      const lab = document.createElement("label");
      lab.className = "check-row small";
      lab.innerHTML = `<input type="checkbox" value="${m.id}" checked> ${esc(m.name || m.email)}`;
      hEl.appendChild(lab);
    }

    // pending invites list
    const invEl = $("#td-invites");
    invEl.innerHTML = "";
    for (const inv of (d.invites || [])) {
      const url = `https://from.bookii.to/app.html#/invite/${inv.token}`;
      const row = document.createElement("div");
      row.className = "tdm-row tdm-pending";
      row.innerHTML = `<div class="tdm-top">
          <span class="tdm-name">${esc(inv.email)}</span>
          <span class="et-badge">${esc(inv.role)}</span>
          <span class="et-badge tdm-warn">invite pending</span>
        </div>
        <p class="tdm-stats">Not yet accepted · expires ${new Date(inv.expires_at).toLocaleDateString()}</p>
        <div class="tdm-controls">
          <button class="linklike" data-copy>copy link</button>
          <button class="linklike" data-resend>resend</button>
          <button class="linklike danger" data-revoke>revoke</button>
        </div>`;
      row.querySelector("[data-copy]").addEventListener("click", async () => {
        await navigator.clipboard.writeText(url).catch(() => {}); toast("Invite link copied");
      });
      row.querySelector("[data-resend]").addEventListener("click", async () => {
        const r = await api(`/teams/${id}/invites/${inv.id}/resend`, { method: "POST" }).catch(e => toast(e.message));
        if (r) toast(r.emailSent ? "Invite re-sent" : "Invite refreshed — share the link");
      });
      row.querySelector("[data-revoke]").addEventListener("click", async () => {
        if (!confirm(`Revoke the invite for ${inv.email}?`)) return;
        await api(`/teams/${id}/invites/${inv.id}`, { method: "DELETE" }).catch(e => toast(e.message));
        renderTeamDetail(id);
      });
      invEl.appendChild(row);
    }

    // invite host pre-stage checkboxes (team events)
    const ihEl = $("#td-invite-hosts");
    ihEl.innerHTML = "";
    if (!d.eventTypes.length) ihEl.innerHTML = '<span class="mut small">No team events yet.</span>';
    for (const et of d.eventTypes) {
      const lab = document.createElement("label");
      lab.className = "check-row small";
      lab.innerHTML = `<input type="checkbox" value="${et.id}" checked> ${esc(et.title)}`;
      ihEl.appendChild(lab);
    }
    $("#td-invite-link").hidden = true;
    // only admins can invite
    $(".td-invite-box").style.display = isAdmin ? "" : "none";

    // team event type cards
    const eEl = $("#td-ets");
    eEl.innerHTML = "";
    if (!d.eventTypes.length) eEl.innerHTML = '<p class="mut small">No team events yet — create one below.</p>';
    for (const et of d.eventTypes) {
      const url = `https://from.bookii.to/team/${d.team.slug}/${et.slug}`;
      const hostNames = (et.host_ids || []).map(hid => {
        const m = d.members.find(mm => mm.id === hid);
        return m ? (m.name || m.email).split(" ")[0] : "?";
      }).join(", ");
      const el = document.createElement("div");
      el.className = "et-card";
      el.style.borderLeftColor = et.color;
      el.innerHTML = `<div class="et-info">
          <p class="et-title">${esc(et.title)} <span class="et-badge">${et.duration_min} min</span>
            <span class="et-badge">${et.scheduling_type === "collective" ? "collective" : "round robin"}</span></p>
          <p class="et-link">team/${esc(d.team.slug)}/${esc(et.slug)} · hosts: ${esc(hostNames)}</p>
        </div>
        <div class="et-actions">
          <button class="btn btn-ghost btn-sm" data-act="copy">Copy link</button>
          <a class="btn btn-ghost btn-sm" href="${url}" target="_blank" rel="noopener">View</a>
        </div>`;
      el.querySelector('[data-act=copy]').addEventListener("click", async () => {
        await navigator.clipboard.writeText(url).catch(() => {});
        toast("Link copied");
      });
      eEl.appendChild(el);
    }
  }
  async function renderTeamAvail(d) {
    const slug = $("#td-avail-et").value;
    const el = $("#td-avail");
    if (!slug) { el.innerHTML = '<p class="mut small">Create a team event first.</p>'; return; }
    el.innerHTML = '<p class="mut small">Computing…</p>';
    try {
      const p = await api(`/pages/team/${d.team.slug}/${slug}?days=7`);
      let html = "";
      for (const [day, slots] of Object.entries(p.days)) {
        const [y, m, dd] = day.split("-").map(Number);
        const label = new Date(y, m - 1, dd).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
        html += `<div class="tda-row"><span class="tda-day">${label}</span>`;
        if (!slots.length) html += '<span class="tda-none">—</span>';
        else html += `<span class="tda-slots">${slots.slice(0, 6).map(s => `<span class="scene-slot">${fmtTime(s.start, p.hostTz)}</span>`).join("")}${slots.length > 6 ? `<span class="mut small">+${slots.length - 6}</span>` : ""}</span>`;
        html += "</div>";
      }
      el.innerHTML = html || '<p class="mut small">Nothing bookable this week.</p>';
      if (Object.values(p.days).every(s => !s.length)) {
        el.innerHTML += `<p class="ts-note">Nothing bookable — ${p.eventType.schedulingType === "collective" ? "for collective events every host must be free; check each member has working hours" : "check that hosts have working hours set"}.</p>`;
      }
    } catch (e) { el.innerHTML = `<p class="form-error">${esc(e.message)}</p>`; }
  }
  $("#td-et-create").addEventListener("click", async () => {
    const hosts = [...document.querySelectorAll("#td-et-hosts input:checked")].map(i => i.value);
    try {
      await api(`/teams/${curTeam.team.id}/event-types`, { method: "POST", body: {
        title: $("#td-et-title").value.trim(),
        scheduling_type: $("#td-et-type").value,
        duration_min: +$("#td-et-dur").value,
        host_ids: hosts,
      }});
      $("#td-et-title").value = "";
      toast("Team event created");
      renderTeamDetail(curTeam.team.id);
    } catch (e) { toast(e.message); }
  });
  $("#td-edit-save").addEventListener("click", async () => {
    try {
      await api("/teams/" + curTeam.team.id, { method: "PATCH", body: {
        name: $("#td-edit-name").value.trim(),
        bio: $("#td-edit-bio").value.trim(),
      }});
      toast("Saved");
      renderTeamDetail(curTeam.team.id);
    } catch (e) { toast(e.message); }
  });
  $("#td-transfer").addEventListener("click", async () => {
    const others = curTeam.members.filter(m => m.role !== "owner");
    if (!others.length) return toast("No other members to transfer to.");
    const email = prompt("Transfer ownership to which member? Enter their email:\n" + others.map(m => "· " + m.email).join("\n"));
    if (!email) return;
    const target = others.find(m => m.email === email.trim().toLowerCase());
    if (!target) return toast("No member with that email.");
    if (!confirm(`Make ${target.name || target.email} the owner? You become an admin.`)) return;
    await api(`/teams/${curTeam.team.id}/transfer`, { method: "POST", body: { userId: target.id } }).catch(e => toast(e.message));
    renderTeamDetail(curTeam.team.id);
  });
  $("#td-delete").addEventListener("click", async () => {
    const typed = prompt(`Delete team "${curTeam.team.name}"? This removes its event types and their booking links permanently.\n\nType the team name to confirm:`);
    if (typed !== curTeam.team.name) { if (typed !== null) toast("Name didn't match."); return; }
    await api("/teams/" + curTeam.team.id, { method: "DELETE" }).catch(e => toast(e.message));
    location.hash = "#/teams";
  });
  $("#td-invite").addEventListener("click", async () => {
    try {
      const hostEvents = [...document.querySelectorAll("#td-invite-hosts input:checked")].map(i => i.value);
      const r = await api(`/teams/${curTeam.team.id}/invites`, { method: "POST", body: {
        email: $("#td-invite-email").value.trim(),
        role: $("#td-invite-role").value,
        host_event_ids: hostEvents,
      }});
      $("#td-invite-email").value = "";
      // always surface the copyable link (email may not be live)
      const box = $("#td-invite-link");
      box.innerHTML = `<p class="mut small">${r.emailSent ? "Invite emailed. You can also share this link:" : "Send this link to your teammate:"}</p>
        <code>${esc(r.url)}</code> <button class="linklike">copy</button>`;
      box.querySelector("button").addEventListener("click", async () => {
        await navigator.clipboard.writeText(r.url).catch(() => {});
        toast("Invite link copied");
      });
      box.hidden = false;
      renderTeamDetail(curTeam.team.id);
    } catch (e) { toast(e.message); }
  });

  /* ---------- invite acceptance ---------- */
  let pendingInvite = null;
  async function renderInvite(token) {
    show("invite");
    const card = $("#inv-card");
    card.innerHTML = '<p class="mut">Loading invitation…</p>';
    let info;
    try { info = await api("/invites/" + encodeURIComponent(token)); }
    catch { card.innerHTML = '<h1 class="serif">Invitation not found</h1><p class="mut">This link isn\'t valid.</p>'; return; }
    if (!info.valid) {
      const msg = { expired: "This invitation has expired — ask your team admin to send a new one.",
        accepted: `This invitation to ${esc(info.team?.name || "the team")} was already used.`,
        not_found: "This invitation link isn't valid." }[info.reason] || "This invitation isn't valid.";
      card.innerHTML = `<h1 class="serif">Invitation</h1><p class="mut">${msg}</p>
        ${me ? '<a class="btn btn-ghost" href="#/teams">Go to your teams</a>' : '<a class="btn btn-ghost" href="#/login">Sign in</a>'}`;
      return;
    }
    // logged in, matching email → accept immediately
    if (me && me.email.toLowerCase() === info.email.toLowerCase()) {
      card.innerHTML = `<h1 class="serif">Joining ${esc(info.team.name)}…</h1>`;
      try {
        const r = await api(`/invites/${encodeURIComponent(token)}/accept`, { method: "POST" });
        pendingInvite = null;
        inviteSuccess(r.team);
      } catch (e) { card.innerHTML = `<h1 class="serif">Invitation</h1><p class="form-error">${esc(e.message)}</p>`; }
      return;
    }
    // logged in as someone else
    if (me) {
      card.innerHTML = `<h1 class="serif">Wrong account</h1>
        <p class="mut">This invitation to <strong>${esc(info.team.name)}</strong> is for <strong>${esc(info.email)}</strong>, but you're signed in as ${esc(me.email)}.</p>
        <button class="btn btn-primary btn-wide" id="inv-switch">Sign out &amp; continue</button>`;
      $("#inv-switch").addEventListener("click", () => {
        pendingInvite = token;
        localStorage.removeItem("bookii-token"); me = null;
        renderAuth("login");
        $("#a-email").value = info.email;
      });
      return;
    }
    // logged out → prompt to sign up / in with locked email
    pendingInvite = token;
    card.innerHTML = `<p class="eyebrow">You're invited</p>
      <h1 class="serif">Join ${esc(info.team.name)}</h1>
      <p class="mut">${info.inviter ? esc(info.inviter) + " invited you" : "You've been invited"} to join as <strong>${esc(info.role)}</strong>, using <strong>${esc(info.email)}</strong>.</p>
      <div class="hero-ctas" style="justify-content:flex-start;margin-top:1rem">
        <button class="btn btn-primary" id="inv-signup">${info.hasAccount ? "Sign in to accept" : "Create account & join"}</button>
      </div>`;
    $("#inv-signup").addEventListener("click", () => {
      renderAuth(info.hasAccount ? "login" : "signup");
      $("#a-email").value = info.email;
      $("#a-email").readOnly = true;
    });
  }
  function inviteSuccess(team) {
    const noHours = true; // new members should confirm availability
    $("#inv-card").innerHTML = `<p class="confirmed-mark" style="margin:0 0 1rem">✓</p>
      <h1 class="serif">You're on ${esc(team.name)}</h1>
      <p class="mut">Welcome to the team. Set your availability so meetings can route to you, then you're in the rotation.</p>
      <div class="hero-ctas" style="justify-content:flex-start;margin-top:1rem">
        <a class="btn btn-primary" href="#/availability">Set my availability</a>
        <a class="btn btn-ghost" href="#/team/${team.teamId}">View team</a>
      </div>`;
  }

  /* ---------- insights ---------- */
  const DOWS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  async function renderInsights() {
    show("insights");
    const d = await api("/insights");
    const t = d.totals;
    $("#in-tiles").innerHTML = `
      <div class="in-tile"><p class="in-num">${t.booked || 0}</p><p class="in-lbl">bookings</p></div>
      <div class="in-tile"><p class="in-num">${d.last7Days}</p><p class="in-lbl">last 7 days</p></div>
      <div class="in-tile"><p class="in-num" style="color:var(--leaf)">${d.showRate === null ? "—" : d.showRate + "%"}</p><p class="in-lbl">show rate</p></div>
      <div class="in-tile"><p class="in-num">${t.cancelled || 0}</p><p class="in-lbl">cancelled</p></div>
      <div class="in-tile"><p class="in-num">${(d.byOrigin.find(o => o.origin === "agent") || {}).n || 0}</p><p class="in-lbl">via agents</p></div>`;
    const bar = (label, n, max) => `<div class="in-bar-row"><span class="in-bar-lbl">${esc(label)}</span>
      <div class="in-bar"><div class="in-bar-fill" style="width:${max ? Math.round(100 * n / max) : 0}%"></div></div>
      <span class="in-bar-n">${n}</span></div>`;
    const evMax = Math.max(1, ...d.byEvent.map(e => e.n));
    $("#in-events").innerHTML = d.byEvent.length ? d.byEvent.map(e => bar(e.title, e.n, evMax)).join("") : '<p class="mut small">No bookings yet.</p>';
    const dowMax = Math.max(1, ...d.byWeekday.map(e => e.n));
    $("#in-days").innerHTML = d.byWeekday.length ? d.byWeekday.map(e => bar(DOWS[e.dow], e.n, dowMax)).join("") : '<p class="mut small">No bookings yet.</p>';
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
      const data = await api("/pages/" + encPath(username));
      const host = data.host || { name: data.team.name, username: "team/" + data.team.slug, welcome_note: data.team.bio };
      const eventTypes = data.eventTypes;
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
        el.addEventListener("click", () => {
          location.hash = username.startsWith("team/") ? `#/t/${username.slice(5)}/${et.slug}` : `#/u/${username}/${et.slug}`;
        });
        list.appendChild(el);
      }
    } catch {
      $("#pf-host").innerHTML = '<h1 class="serif">Page not found</h1>';
      $("#pf-list").innerHTML = "";
    }
  }

  /* ---------- public booking ---------- */
  let pb = { data: null, monthCursor: null, selectedDay: null, viewerTz: detectedTz, slot: null, username: null, slug: null, booking: null, resched: null };

  /* ---------- reschedule mode ---------- */
  async function renderReschedule(id, token) {
    let info;
    try {
      info = (await api(`/public-bookings/${id}?token=${encodeURIComponent(token)}`)).booking;
    } catch {
      return renderPublicError("This reschedule link isn't valid anymore.", null);
    }
    if (info.status === "cancelled") {
      return renderPublicError("This booking was cancelled — you can book a fresh time instead.", info.username && `#/u/${info.username}/${info.slug}`);
    }
    if (info.allow_reschedule === false) {
      return renderPublicError("The host has disabled rescheduling for this event — contact them directly to change the time.", null);
    }
    pb.resched = { id, token, former: info.start_at, name: info.invitee_name, email: info.invitee_email };
    await renderPublic(info.username, info.slug);
    // banner with the former time
    const banner = document.createElement("div");
    banner.className = "resched-banner";
    banner.innerHTML = `Rescheduling <strong>${esc(info.title)}</strong> — currently
      <s>${fmtDay(info.start_at, pb.viewerTz)} · ${fmtTime(info.start_at, pb.viewerTz)}</s>.
      Pick a new time below.${info.cancel_policy ? `<br><span class="mut small">${esc(info.cancel_policy)}</span>` : ""}`;
    $("#pub-page").prepend(banner);
  }

  let pubPageTemplate = null;
  function ensurePubPage() {
    const el = $("#pub-page");
    if (pubPageTemplate === null) pubPageTemplate = el.innerHTML;
    else if (el.querySelector(".pub-error")) { el.innerHTML = pubPageTemplate; bindPublicControls(); }
    document.querySelectorAll(".resched-banner").forEach(x => x.remove());
  }
  function renderPublicError(msg, backHref) {
    show("public");
    ensurePubPage();
    $("#pub-page").innerHTML = `<div class="pub-error">
      <h2 class="serif">Hmm.</h2>
      <p class="mut">${esc(msg)}</p>
      ${backHref ? `<a class="btn btn-primary" href="${backHref}">Open the booking page</a>` : ""}
    </div>`;
  }

  const EMBED = new URLSearchParams(location.search).has("embed");
  if (EMBED) document.body.classList.add("embed-mode");
  async function renderPublic(username, slug) {
    show("public");
    pb.username = username; pb.slug = slug;
    // prefill from query params (?name=&email= — for embeds and links)
    const qp = new URLSearchParams(location.search);
    if (qp.get("name")) $("#pb-name").value = qp.get("name");
    if (qp.get("email")) $("#pb-email").value = qp.get("email");
    if (!location.hash.includes("reschedule")) pb.resched = null;
    $("#pb-confirmed").hidden = true;
    document.querySelectorAll(".resched-banner").forEach(el => el.remove());
    try {
      await loadPublicMonth(new Date());
    } catch (e) {
      let profileLink = null;
      try { await api("/pages/" + encPath(username)); profileLink = `#/u/${username}`; } catch {}
      return renderPublicError(
        e.status === 404 ? "That booking page doesn't exist — the link may have changed." : (e.message || "Something went wrong."),
        profileLink);
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
    pb.data = await api(`/pages/${encPath(pb.username)}/${encodeURIComponent(pb.slug)}?from=${fromKey}&days=45`);
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
  async function findNextAvailable() {
    // look 45-90 days out for the first open day
    const from = new Date(Date.now() + 45 * 86400000);
    try {
      const d = await api(`/pages/${encPath(pb.username)}/${encodeURIComponent(pb.slug)}?from=${from.toISOString().slice(0, 10)}&days=45`);
      const first = Object.entries(d.days).find(([, s]) => s.length);
      return first ? first[0] : null;
    } catch { return null; }
  }
  function renderPubSlots() {
    const list = $("#pb-slots");
    list.innerHTML = "";
    if (!pb.selectedDay) {
      $("#pb-date").textContent = "No open times right now";
      list.innerHTML = '<p class="mut">Looking further ahead…</p>';
      findNextAvailable().then(nextKey => {
        if (!$("#pb-slots")) return;
        if (nextKey) {
          const [y, m, d] = nextKey.split("-").map(Number);
          const label = new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
          list.innerHTML = "";
          const btn = document.createElement("button");
          btn.className = "btn btn-ghost";
          btn.textContent = `Next availability: ${label} →`;
          btn.addEventListener("click", async () => {
            await loadPublicMonth(new Date(y, m - 1, d));
            renderPubCal();
          });
          list.appendChild(btn);
        } else {
          list.innerHTML = '<p class="mut">Nothing bookable in the next three months. The host may have paused bookings.</p>';
        }
      });
      return;
    }
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
  function bindPublicControls() {
    $("#pb-prev").addEventListener("click", () => { pb.monthCursor = new Date(pb.monthCursor.getFullYear(), pb.monthCursor.getMonth() - 1, 1); renderPubCal(); });
    $("#pb-next").addEventListener("click", async () => {
      const next = new Date(pb.monthCursor.getFullYear(), pb.monthCursor.getMonth() + 1, 1);
      if (!Object.keys(pb.data.days).some(k => k.startsWith(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`))) {
        try { await loadPublicMonth(next); } catch {}
      } else pb.monthCursor = next;
      renderPubCal();
    });
    $("#pb-tz").addEventListener("change", e => { pb.viewerTz = e.target.value; renderPubSlots(); });
  }
  bindPublicControls();

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
    // reschedule mode: prefill + lock identity, ask only for a reason
    const isResched = !!pb.resched;
    $("#pb-name").value = isResched ? pb.resched.name : $("#pb-name").value;
    $("#pb-email").value = isResched ? pb.resched.email : $("#pb-email").value;
    $("#pb-name").readOnly = isResched;
    $("#pb-email").readOnly = isResched;
    $("#pb-confirm").textContent = isResched ? "Confirm new time" : "Confirm booking";
    // questions
    const qwrap = $("#pb-questions");
    qwrap.innerHTML = "";
    if (isResched) {
      const lab = document.createElement("label");
      lab.innerHTML = 'Reason for rescheduling <span class="opt">optional</span>';
      const input = document.createElement("textarea");
      input.rows = 2; input.id = "pb-resched-reason";
      lab.appendChild(input);
      qwrap.appendChild(lab);
    } else for (const qq of pb.data.eventType.questions || []) {
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
    if (pb.resched) {
      try {
        const r = await api(`/public-bookings/${pb.resched.id}/reschedule`, { method: "POST", body: {
          cancelToken: pb.resched.token,
          start: pb.slot.start,
          reason: ($("#pb-resched-reason") || {}).value || "",
        }});
        pb.booking = { bookingId: pb.resched.id, cancelToken: pb.resched.token, start: r.start, end: r.end, eventTitle: pb.data.eventType.title };
        closePubSheet();
        showConfirmed(pb.booking, "Rescheduled.");
      } catch (err) {
        $("#pb-error").textContent = err.message;
        $("#pb-error").hidden = false;
        if (err.status === 409) { try { await loadPublicMonth(pb.monthCursor); renderPubCal(); } catch {} }
      }
      $("#pb-confirm").disabled = false;
      return;
    }
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
      showConfirmed(booking, "It's done.");
    } catch (err) {
      $("#pb-error").textContent = err.message;
      $("#pb-error").hidden = false;
      if (err.status === 409 || err.status === 410) {
        try { await loadPublicMonth(pb.monthCursor); renderPubCal(); } catch {}
      }
    }
    $("#pb-confirm").disabled = false;
  });
  function calDeepLinks(b) {
    const fmt = iso => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const title = encodeURIComponent(`${b.eventTitle} — ${pb.data.host.name || pb.data.host.username}`);
    const s = fmt(b.start), e = fmt(b.end);
    return {
      google: `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${s}/${e}`,
      outlook: `https://outlook.live.com/calendar/0/deeplink/compose?subject=${title}&startdt=${encodeURIComponent(b.start)}&enddt=${encodeURIComponent(b.end)}`,
      yahoo: `https://calendar.yahoo.com/?v=60&title=${title}&st=${s}&et=${e}`,
    };
  }
  function showConfirmed(booking, heading) {
    $("#pb-confirmed .serif").textContent = heading;
    $("#pb-when").textContent = fmtDay(booking.start, pb.viewerTz) + " · " + fmtTime(booking.start, pb.viewerTz) + "–" + fmtTime(booking.end, pb.viewerTz);
    $("#pb-whentz").textContent = dualTz(booking.start);
    $("#pb-cancel-link").href = `#/cancel/${booking.bookingId}/${booking.cancelToken}`;
    $("#pb-resched-link").href = `#/reschedule/${booking.bookingId}/${booking.cancelToken}`;
    $("#pb-cancel-link").hidden = pb.data.eventType.allowCancel === false;
    $("#pb-resched-link").hidden = pb.data.eventType.allowReschedule === false;
    const links = calDeepLinks(booking);
    $("#pb-addcal").innerHTML =
      `<a href="${links.google}" target="_blank" rel="noopener">Google</a> ·
       <a href="${links.outlook}" target="_blank" rel="noopener">Outlook</a> ·
       <a href="${links.yahoo}" target="_blank" rel="noopener">Yahoo</a>`;
    $("#pb-book-another").href = pb.username.startsWith("team/") ? `#/t/${pb.username.slice(5)}/${pb.slug}` : `#/u/${pb.username}/${pb.slug}`;
    $("#pb-confirmed").hidden = false;
  }
  $("#pb-book-another").addEventListener("click", () => {
    $("#pb-confirmed").hidden = true;
    pb.resched = null;
    renderPublic(pb.username, pb.slug);
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
  async function renderCancel(id, token) {
    show("cancel");
    $("#cx-msg").textContent = "Are you sure you want to cancel this booking?";
    $("#cx-reason-wrap").hidden = false;
    $("#cx-rebook").hidden = true;
    const btn = $("#cx-btn");
    btn.hidden = false;
    let rebookHref = null;
    try {
      const { booking } = await api(`/public-bookings/${id}?token=${encodeURIComponent(token)}`);
      if (booking.allow_cancel === false) {
        $("#cx-msg").textContent = "The host has disabled cancellation for this event — contact them directly.";
        $("#cx-reason-wrap").hidden = true;
        btn.hidden = true;
        return;
      }
      $("#cx-msg").textContent = `Cancel ${booking.title} on ${fmtDay(booking.start_at, detectedTz)} at ${fmtTime(booking.start_at, detectedTz)}?` +
        (booking.cancel_policy ? `\n${booking.cancel_policy}` : "");
      if (booking.username) rebookHref = `#/u/${booking.username}/${booking.slug}`;
    } catch {}
    btn.onclick = async () => {
      try {
        await api(`/public-bookings/${id}/cancel`, { method: "POST", body: { cancelToken: token, reason: $("#cx-reason").value.trim() } });
        $("#cx-msg").textContent = "Cancelled. The time is open again.";
        btn.hidden = true;
        $("#cx-reason-wrap").hidden = true;
        if (rebookHref) {
          $("#cx-rebook").innerHTML = `Changed your mind? <a href="${rebookHref}">Book a new time</a>.`;
          $("#cx-rebook").hidden = false;
        }
      } catch (e) { $("#cx-msg").textContent = e.message; }
    };
  }

  route();
})();
