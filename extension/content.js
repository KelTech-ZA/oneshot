// OneShot - the strip.
//
// A slim bar across the bottom of Outlook. It says what it found and nothing
// else; suggestions rise out of it when asked, and fold away again. There is
// no pane to keep open and nothing is created without a click.
//
// The cycle, as specified: scan on load, then every three hours. Reloading the
// page restarts the clock - which happens for free, because a content script
// is re-injected on every load and the timer lives here, not in a worker.

(function () {
  "use strict";
  if (window.top !== window) return initSubFrame();   // sub-frames only relay
  if (document.getElementById("oneshot-strip")) return;

  const SUPABASE_URL = "https://ntcvwosypcnwedxefwcr.supabase.co";
  const FUNCTIONS = SUPABASE_URL + "/functions/v1";
  const APP = "https://1oneshot.netlify.app";
  const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50Y3Z3b3N5cGNud2VkeGVmd2NyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ3MzI0ODEsImV4cCI6MjEwMDMwODQ4MX0.rFgFqxMpN6DaE3H74Pw74nTBUuNLdHUHECkyfKZ_Dz4";
  const CYCLE_MS = 3 * 60 * 60 * 1000;
  const HOW_MANY = 30;

  const gate = window.OneShotGate.gate;
  const signals = window.OneShotGate.signals;

  let messages = [];        // newest first, from the reader
  let flagged = [];         // those that clear the gate and aren't settled
  let openPanel = false;
  let lastScan = 0;
  let session = null;
  let clientDomains = [];
  let clientsByName = new Map();
  let decisions = {};       // id -> "no" | "done", persisted
  const laterThisLoad = new Set();   // "Later" = out of the way until reload or next cycle
  const justDone = new Map();        // id -> what was created, kept visible until the panel closes
  let manual = null;                 // the "this mail" flow, when it is running

  // -------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------
  const store = {
    async load() {
      const d = await chrome.storage.local.get(["session", "decisions", "clientDomains", "jobTypes"]);
      session = d.session || null;
      decisions = d.decisions || {};
      clientDomains = d.clientDomains || [];
      jobTypes = d.jobTypes || [];
    },
    save(patch) { chrome.storage.local.set(patch); },
  };

  // -------------------------------------------------------------------------
  // Chrome
  // -------------------------------------------------------------------------
  const css = `
  #oneshot-strip, #oneshot-strip * { box-sizing: border-box; font-family: "Segoe UI", system-ui, sans-serif; }
  #oneshot-strip {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483000;
    background: #101314; color: #eef1f2; border-top: 1px solid #2b3033;
    font-size: 13px; line-height: 1.4;
    box-shadow: 0 -2px 18px rgba(0,0,0,.28);
  }
  #oneshot-bar { display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 12px; }
  #oneshot-dot { width: 7px; height: 7px; border-radius: 50%; background: #3a4145; flex: none; }
  #oneshot-dot.live { background: #4ea373; }
  #oneshot-dot.hot  { background: #e0a33e; }
  #oneshot-make { white-space: nowrap; }
  #oneshot-status { flex: 1; color: #b6bfc3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #oneshot-strip button {
    font: inherit; border-radius: 6px; border: 1px solid #343a3d; cursor: pointer;
    background: transparent; color: #eef1f2; padding: 4px 10px;
  }
  #oneshot-strip button:hover { background: #1c2123; }
  #oneshot-strip button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; font-weight: 600; }
  #oneshot-strip button.ghost { border: none; color: #8d979b; padding: 4px 6px; }
  #oneshot-panel {
    max-height: 0; overflow: hidden; transition: max-height .22s ease;
    border-top: 1px solid transparent;
  }
  #oneshot-panel.open { max-height: 52vh; overflow-y: auto; border-top-color: #2b3033; }
  .oneshot-row { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-bottom: 1px solid #1c2123; }
  .oneshot-row:last-child { border-bottom: none; }
  .oneshot-main { flex: 1; min-width: 0; }
  .oneshot-goto { cursor: pointer; }
  .oneshot-goto:hover .oneshot-subj { text-decoration: underline; }
  .oneshot-subj { font-weight: 600; color: #eef1f2; }
  .oneshot-meta { color: #8d979b; font-size: 12px; margin-top: 2px; }
  .oneshot-acts { display: flex; gap: 6px; flex: none; }
  .oneshot-form { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; margin-top: 10px; }
  .oneshot-f { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: #8d979b; }
  .oneshot-f > span { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .oneshot-f input, .oneshot-f select, .oneshot-f textarea {
    background: #1c2123; border: 1px solid #343a3d; color: #eef1f2;
    border-radius: 6px; padding: 5px 8px; font: inherit; font-size: 13px; resize: vertical;
  }
  .oneshot-f.oneshot-hard { flex-direction: row; align-items: center; gap: 8px; }
  .oneshot-f.oneshot-hard input { width: auto; }
  .oneshot-formrow { align-items: stretch; }
  .oneshot-empty { padding: 14px 12px; color: #8d979b; }
  #oneshot-auth { padding: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  #oneshot-auth input {
    background: #1c2123; border: 1px solid #343a3d; color: #eef1f2;
    border-radius: 6px; padding: 5px 8px; font: inherit; min-width: 180px;
  }
  #oneshot-auth .msg { color: #d98b62; font-size: 12px; }
  `;

  const el = (tag, props = {}, kids = []) => {
    const n = document.createElement(tag);
    Object.assign(n, props);
    for (const k of kids) n.append(k);
    return n;
  };

  const strip = el("div", { id: "oneshot-strip" });
  strip.append(el("style", { textContent: css }));

  const dot = el("span", { id: "oneshot-dot" });
  const status = el("span", { id: "oneshot-status", textContent: "OneShot - reading your inbox..." });
  const mkBtn = el("button", { id: "oneshot-make", textContent: "Create job from this mail" });
  const btn = el("button", { className: "primary", textContent: "Suggestions" });
  const bar = el("div", { id: "oneshot-bar" }, [dot, status, mkBtn, btn]);
  const panel = el("div", { id: "oneshot-panel" });
  strip.append(bar, panel);

  btn.onclick = () => {
    openPanel = !openPanel;
    if (!openPanel) { justDone.clear(); manual = null; scan(); }
    render();
  };

  // The deliberate route: whatever is open in the reading pane, right now.
  // Unlike a list row this carries the whole thread, so the parser gets the
  // real text rather than a preview line.
  mkBtn.onclick = async () => {
    if (!session) { openPanel = true; render(); return; }
    mkBtn.disabled = true;
    const was = mkBtn.textContent;
    mkBtn.textContent = "Reading this mail...";
    const msg = await askReader();
    mkBtn.disabled = false; mkBtn.textContent = was;
    if (!msg || !msg.body || msg.body.length < 40) {
      openPanel = true;
      manual = { error: "Open a message first - there is nothing in the reading pane to read." };
      render();
      return;
    }
    manual = { msg, state: "suggesting" };
    openPanel = true;
    render();
    const thread = { subject: msg.subject, from: msg.from, body: msg.body, received_at: msg.received };
    const out = await api("suggest-job", { action: "suggest", thread });
    // Even a refusal opens the form. The click was the decision; the parser
    // only gets to pre-fill.
    manual = { msg, thread, out: out.error ? null : out, state: "proposed" };
    render();
  };

  function askReader() {
    return new Promise((res) => {
      const t = setTimeout(() => { window.removeEventListener("message", h); res(null); }, 2500);
      const h = (e) => {
        if (e.data && e.data.__oneshot === "open-message") {
          clearTimeout(t); window.removeEventListener("message", h); res(e.data.msg);
        }
      };
      window.addEventListener("message", h);
      window.postMessage({ __oneshot: "read-open" }, "*");
    });
  }

  // -------------------------------------------------------------------------
  // Talking to OneShot
  // -------------------------------------------------------------------------
  async function api(path, body) {
    const res = await fetch(`${FUNCTIONS}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json",
                 authorization: `Bearer ${session?.access_token || ""}` },
      body: JSON.stringify(body),
    });
    if (res.status === 401) { session = null; store.save({ session: null }); }
    return res.json().catch(() => ({ error: "Unreadable reply" }));
  }

  async function signIn(email, password, msgEl) {
    msgEl.textContent = "";
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: ANON },
      body: JSON.stringify({ email, password }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) { msgEl.textContent = j.error_description || "Sign in failed."; return; }
    session = j;
    store.save({ session });
    loadClients(); loadJobTypes();
    render();
  }

  let jobTypes = [];
  async function loadJobTypes() {
    if (!session) return;
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/job_types?select=key,label&active=eq.true&order=sort`, {
        headers: { apikey: ANON, authorization: `Bearer ${session.access_token}` },
      });
      const rows = await res.json();
      if (Array.isArray(rows)) { jobTypes = rows; store.save({ jobTypes }); }
    } catch { /* the form still works with a free-text type */ }
  }

  async function loadClients() {
    if (!session) return;
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/clients?select=email,name`, {
        headers: { apikey: ANON, authorization: `Bearer ${session.access_token}` },
      });
      const rows = await res.json();
      clientDomains = [...new Set(rows.map(r => String(r.email || "").split("@")[1]).filter(Boolean))];
      clientsByName = new Map(rows.filter(r => r.name && r.email)
        .map(r => [String(r.name).trim().toLowerCase(), String(r.email).toLowerCase()]));
      store.save({ clientDomains });
    } catch { /* scoring still works without it */ }
  }

  // -------------------------------------------------------------------------
  // The scan
  // -------------------------------------------------------------------------
  function resolve(m) {
    if (m.from || !m.fromName) return m;
    for (const part of m.fromName.split(/;|,/)) {
      const hit = clientsByName.get(part.trim().toLowerCase());
      if (hit) return { ...m, from: hit };
    }
    return m;
  }

  function scan() {
    lastScan = Date.now();
    const recent = messages.slice(0, HOW_MANY).map(resolve);
    flagged = recent
      .map(m => ({ m, g: gate(m, { clientDomains, ownDomains: [], sensitivity: 0 }) }))
      .filter(x => x.g.pass && !laterThisLoad.has(x.m.id)
                && (justDone.has(x.m.id) || (decisions[x.m.id] !== "no" && decisions[x.m.id] !== "done")))
      .sort((a, b) => b.g.score - a.g.score);
    render();
  }

  function render() {
    const n = flagged.length;
    dot.className = messages.length ? (n ? "hot" : "live") : "";
    status.textContent = !messages.length
      ? "OneShot - waiting for Outlook to load your mail..."
      : n
        ? `${n} of the last ${Math.min(messages.length, HOW_MANY)} look like they need a job`
        : `Nothing in the last ${Math.min(messages.length, HOW_MANY)} needs a job`;
    btn.textContent = n ? `Show ${n}` : "Suggestions";
    panel.classList.toggle("open", openPanel);
    if (!openPanel) { panel.textContent = ""; return; }

    panel.textContent = "";
    if (!session) { panel.append(authRow()); return; }
    if (manual) panel.append(manualRow());
    if (!flagged.length && !manual) {
      panel.append(el("div", { className: "oneshot-empty",
        textContent: messages.length
          ? "Nothing here needs a job. Next look in 3 hours, or reload to look now."
          : "Open your inbox list so Outlook loads your mail, then reload." }));
      return;
    }
    for (const { m, g } of flagged) panel.append(row(m, g));
  }


  // "Nothing job-shaped" is a dead end. When the parser cannot build a job but
  // the text is full of freight language - a stack date, a vessel, a cut-off -
  // the reader needs to know that, because those are deadlines whether or not
  // the mail bothered to list what is in the crate.
  function notJobText(out, body) {
    const s = signals(body);
    const seen = [...s.freight, ...s.work].slice(0, 5);
    if (!seen.length) {
      return out.reason ? `Nothing job-shaped - ${out.reason}.` : "Nothing job-shaped in this one.";
    }
    return `Not enough to build a job, but it mentions ${seen.join(", ")}`
         + "  -  worth a look, these are usually deadlines.";
  }


  // -------------------------------------------------------------------------
  // The job form.
  //
  // Clicking "Create job from this mail" is a DECISION, not a question. The
  // parser's job here is to fill in what it can; it does not get a veto. A
  // half-filled job on the board beats a refusal in an inbox - the same way
  // an incomplete email still creates a job with missing_info flags for ops
  // to finish later.
  // -------------------------------------------------------------------------
  const lines = (v) => String(v || "").split("\n").map((x) => x.trim()).filter(Boolean);

  function prefill(out) {
    const j = (out && out.extraction && (out.extraction.jobs || [])[0]) || {};
    const stops = Array.isArray(j.stops) ? j.stops : [];
    const pick = (k) => stops.filter((s) => s.kind === k).map((s) => s.address || s.label).filter(Boolean).join("\n");
    return {
      type: j.type || "",
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(j.scheduled_date || "")) ? j.scheduled_date : "",
      window: j.time_window || "",
      collection: pick("collection") || pick("site"),
      delivery: pick("delivery"),
      items: (Array.isArray(j.items) ? j.items : []).map((i) =>
        [i.description, i.dimensions].filter(Boolean).join(" - ")).join("\n"),
      ref: j.client_ref || "",
      hard: !!j.hard_deadline,
      extra: out && out.extraction && (out.extraction.jobs || []).length > 1
        ? (out.extraction.jobs || []).slice(1) : [],
    };
  }

  function buildExtraction(f, thread) {
    const missing = [];
    if (!f.date) missing.push("scheduled_date");
    if (!f.collection && !f.delivery) missing.push("address");
    if (!lines(f.items).length) missing.push("items");
    const stops = [];
    for (const a of lines(f.collection)) stops.push({ kind: "collection", address: a, label: null });
    for (const a of lines(f.delivery)) stops.push({ kind: "delivery", address: a, label: null });
    const items = lines(f.items).map((d) => ({ description: d, quantity: 1, identity_tier: 1 }));
    if (!items.length) items.push({ description: "Consignment", quantity: 1, identity_tier: 3 });
    const job = {
      type: f.type || null, client_ref: f.ref || null, stops,
      scheduled_date: f.date || null, time_window: f.window || null,
      hard_deadline: !!f.hard, items, missing,
    };
    // Jobs beyond the first that the parser found are carried through as-is,
    // so a schedule mail still creates all of them.
    return { kind: "request", confidence: 1, existing_job_ref: null,
             jobs: [job, ...(f.extra || [])], missing: [], amendment_changes: null };
  }

  function field(label, node) {
    return el("label", { className: "oneshot-f" }, [
      el("span", { textContent: label }), node,
    ]);
  }

  function manualForm() {
    const f = prefill(manual.out);
    const note = el("div", { className: "oneshot-meta" });
    if (manual.out && manual.out.isJob) {
      const miss = (manual.out.missing || []);
      note.textContent = (manual.out.summary || "Read from this mail")
        + (miss.length ? `  -  still needs: ${miss.join(", ")}` : "");
    } else {
      note.textContent = notJobText(manual.out || {}, manual.msg.body)
        + "  -  fill in what you know and create it anyway.";
    }

    const typeSel = el("select");
    typeSel.append(el("option", { value: "", textContent: "Type - choose one" }));
    for (const t of jobTypes) typeSel.append(el("option", { value: t.key, textContent: t.label || t.key }));
    if (f.type) typeSel.value = f.type;

    const date = el("input", { type: "date", value: f.date });
    const win = el("input", { type: "text", value: f.window, placeholder: "Time or window, e.g. stack closes Fri 16:00" });
    const coll = el("textarea", { value: f.collection, rows: 2, placeholder: "Collection address - one per line" });
    const del = el("textarea", { value: f.delivery, rows: 2, placeholder: "Delivery address - one per line" });
    const items = el("textarea", { value: f.items, rows: 2, placeholder: "Items - one per line" });
    const ref = el("input", { type: "text", value: f.ref, placeholder: "Their reference, vessel, booking no." });
    const hard = el("input", { type: "checkbox" });
    hard.checked = f.hard;

    const go = el("button", { className: "primary", textContent: "Create job" });
    const cancel = el("button", { className: "ghost", textContent: "Cancel" });
    const msg = el("div", { className: "oneshot-meta" });
    cancel.onclick = () => { manual = null; render(); };

    go.onclick = async () => {
      go.disabled = true; go.textContent = "Creating...";
      const ex = buildExtraction({
        type: typeSel.value, date: date.value, window: win.value,
        collection: coll.value, delivery: del.value, items: items.value,
        ref: ref.value, hard: hard.checked, extra: f.extra,
      }, manual.thread);
      const done = await api("suggest-job", { action: "create", thread: manual.thread, extraction: ex });
      if (done.error) { msg.textContent = done.error; go.disabled = false; go.textContent = "Create job"; return; }
      manual = { done: { text: done.reply || "Created.", ref: (done.refs || [])[0] || null, subject: manual.msg.subject } };
      render();
    };

    return el("div", { className: "oneshot-row oneshot-formrow" }, [
      el("div", { className: "oneshot-main" }, [
        el("div", { className: "oneshot-subj", textContent: manual.msg.subject || "(no subject)" }),
        note,
        el("div", { className: "oneshot-form" }, [
          field("Job type", typeSel), field("Date", date),
          field("Time / window", win), field("Reference", ref),
          field("Collection", coll), field("Delivery", del),
          field("Items", items),
          el("label", { className: "oneshot-f oneshot-hard" }, [
            el("span", { textContent: "Hard deadline" }), hard,
          ]),
        ]),
        el("div", { className: "oneshot-acts", style: "margin-top:10px" }, [go, cancel]),
        msg,
      ]),
    ]);
  }

  function manualRow() {
    if (manual.error) {
      return el("div", { className: "oneshot-row" }, [
        el("div", { className: "oneshot-main" }, [
          el("div", { className: "oneshot-subj", textContent: "This mail" }),
          el("div", { className: "oneshot-meta", textContent: manual.error }),
        ]),
      ]);
    }
    if (manual.done) {
      const open = el("button", { textContent: manual.done.ref ? `Open ${manual.done.ref}` : "Open the board" });
      open.onclick = () => window.open(APP + "/dashboard", "_blank");
      const close = el("button", { className: "ghost", textContent: "Close" });
      close.onclick = () => { manual = null; render(); };
      return el("div", { className: "oneshot-row" }, [
        el("div", { className: "oneshot-main" }, [
          el("div", { className: "oneshot-subj", textContent: manual.done.subject || "Job created" }),
          el("div", { className: "oneshot-meta", textContent: manual.done.text }),
        ]),
        el("div", { className: "oneshot-acts" }, [open, close]),
      ]);
    }
    if (manual.state === "suggesting") {
      return el("div", { className: "oneshot-row" }, [
        el("div", { className: "oneshot-main" }, [
          el("div", { className: "oneshot-subj", textContent: manual.msg.subject || "(no subject)" }),
          el("div", { className: "oneshot-meta",
            textContent: `Reading ${Math.round(manual.msg.body.length / 100) / 10}k characters...` }),
        ]),
      ]);
    }
    return manualForm();
  }

  function authRow() {
    const email = el("input", { type: "email", placeholder: "OneShot email", autocomplete: "username" });
    const pass  = el("input", { type: "password", placeholder: "Password", autocomplete: "current-password" });
    const msg   = el("span", { className: "msg" });
    const go    = el("button", { className: "primary", textContent: "Sign in" });
    go.onclick = () => signIn(email.value.trim(), pass.value, msg);
    pass.onkeydown = (e) => { if (e.key === "Enter") go.click(); };
    return el("div", { id: "oneshot-auth" }, [
      el("span", { textContent: "Sign in to OneShot to create jobs." }), email, pass, go, msg,
    ]);
  }

  function row(m, g) {
    const subj = el("div", { className: "oneshot-subj", textContent: m.subject || "(no subject)" });

    if (justDone.has(m.id)) {
      const done = justDone.get(m.id);
      const open = el("button", { textContent: done.ref ? `Open ${done.ref}` : "Open the board" });
      open.onclick = () => window.open(APP + "/dashboard", "_blank");
      return el("div", { className: "oneshot-row" }, [
        el("div", { className: "oneshot-main" }, [
          subj, el("div", { className: "oneshot-meta", textContent: done.text }),
        ]),
        el("div", { className: "oneshot-acts" }, [open]),
      ]);
    }
    const why = g.why.slice(0, 2).join(" - ");
    const meta = el("div", { className: "oneshot-meta",
      textContent: `${m.fromName || m.from || "unknown"}  -  ${why}${m.hasFullBody ? "" : "  -  preview only"}` });

    const make = el("button", { className: "primary", textContent: "Make job" });
    const not  = el("button", { className: "ghost", textContent: "Not this one" });
    const later= el("button", { className: "ghost", textContent: "Later" });

    make.onclick = async () => {
      make.disabled = true; make.textContent = "Reading...";
      const thread = { subject: m.subject, from: m.from, body: m.body, received_at: m.received };
      const out = await api("suggest-job", { action: "suggest", thread });
      if (out.error) { meta.textContent = out.error; make.disabled = false; make.textContent = "Make job"; return; }
      showProposal(m, thread, out, make, meta);
    };
    not.onclick   = () => { decisions[m.id] = "no";    store.save({ decisions }); scan(); };
    later.onclick = () => { laterThisLoad.add(m.id); scan(); };

    const main = el("div", { className: "oneshot-main oneshot-goto", title: "Show me this one in the list" }, [subj, meta]);
    main.onclick = () => {
      const held = meta.textContent;
      meta.textContent = "Finding it...";
      const h = (e) => {
        if (!e.data || e.data.__oneshot !== "revealed" || e.data.id !== m.id) return;
        window.removeEventListener("message", h);
        meta.textContent = e.data.ok ? held : "Could not find it in the list - it may have scrolled out of the folder.";
      };
      window.addEventListener("message", h);
      window.postMessage({ __oneshot: "reveal", id: m.id }, "*");
      setTimeout(() => { window.removeEventListener("message", h); if (meta.textContent === "Finding it...") meta.textContent = held; }, 6000);
    };
    return el("div", { className: "oneshot-row" }, [
      main, el("div", { className: "oneshot-acts" }, [later, not, make]),
    ]);
  }

  function showProposal(m, thread, out, make, meta) {
    if (!out.isJob) {
      meta.textContent = notJobText(out, thread.body);
      make.textContent = "Nothing to create";
      make.disabled = true;
      return;
    }
    const missing = out.missing || [];
    meta.textContent = (out.summary || `${out.jobCount} job${out.jobCount > 1 ? "s" : ""} found`)
      + (missing.length ? `  -  still needs: ${missing.join(", ")}` : "");
    make.textContent = "Create in OneShot";
    make.disabled = false;
    // Second click, and only the second click, writes anything.
    make.onclick = async () => {
      make.disabled = true; make.textContent = "Creating...";
      const done = await api("suggest-job", { action: "create", thread, extraction: out.extraction });
      if (done.error) { meta.textContent = done.error; make.disabled = false; make.textContent = "Create in OneShot"; return; }
      decisions[m.id] = "done"; store.save({ decisions });
      justDone.set(m.id, { text: done.reply || "Created.", ref: (done.refs || [])[0] || null });
      render();
    };
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  function ingest(list) {
    if (!Array.isArray(list) || !list.length) return;
    const byId = new Map(messages.map(m => [m.id, m]));
    for (const m of list) {
      const prev = byId.get(m.id);
      if (!prev || (m.hasFullBody && !prev.hasFullBody)) byId.set(m.id, m);
    }
    messages = [...byId.values()]
      .sort((a, b) => String(b.received).localeCompare(String(a.received)));
    scan();
  }

  window.addEventListener("message", (e) => {
    if (e.data && e.data.__oneshot === "messages") ingest(e.data.list);
  });

  (async function boot() {
    await store.load();
    document.documentElement.append(strip);
    // Outlook needs a moment to fetch the list; ask the reader to republish.
    const nudge = () => window.postMessage({ __oneshot: "please-publish" }, "*");
    [800, 2500, 6000, 12000].forEach(ms => setTimeout(nudge, ms));
    if (session) { loadClients(); loadJobTypes(); }
    render();
    setInterval(() => {
        if (Date.now() - lastScan >= CYCLE_MS) { laterThisLoad.clear(); nudge(); scan(); }
    }, 60_000);
  })();

  // Sub-frames: Outlook may fetch mail in a frame. Relay upward and stop.
  function initSubFrame() {
    window.addEventListener("message", (e) => {
      if (e.data && e.data.__oneshot === "messages") {
        try { window.top.postMessage({ __oneshot: "messages", list: e.data.list }, "*"); } catch {}
      }
    });
  }
})();
