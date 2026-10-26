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

  // Two surfaces, one strip. Mail is scanned on a cycle and offers
  // suggestions; a chat is read only when asked, about the conversation on
  // screen, and nothing else. WhatsApp deliberately runs one capability
  // behind: no scanning, no list, no timer.
  const CHAT = /(^|\.)web\.whatsapp\.com$/.test(location.host);

  // What gets sent to the parser for one thread or chat.
  //
  // Was written out by hand in three places, which is how `source` and the
  // photographs came to be read by the reader and then dropped on the floor
  // before they ever left the browser: the WhatsApp reader has always
  // reported which app it was, and every call site forgot to pass it on, so
  // every WhatsApp conversation was filed as an email.
  const threadOf = (m) => ({
    subject: m.subject,
    from: m.from,
    body: m.body,
    received_at: m.received,
    source: m.source || (CHAT ? "whatsapp" : "email"),
    // Capped in the reader; sent only when there are any, so an Outlook
    // thread's payload is exactly the shape it was before.
    ...(Array.isArray(m.images) && m.images.length ? { images: m.images } : {}),
  });

  const gate = window.OneShotGate.gate;
  const signals = window.OneShotGate.signals;

  let messages = [];        // newest first, from the reader
  let flagged = [];         // those that clear the gate and aren't settled
  let openPanel = false;
  // The mail they asked to be shown in the list. While this is set the panel
  // gets out of the way, because "show me this one" means they want to LOOK at
  // it, and a list covering half the screen is the opposite of that.
  let showing = null;          // { id, subject }
  // When set, the panel shows that one row and nothing else, so going back to
  // it after reading the mail costs a few lines of screen instead of half of it.
  let onlyId = null;
  let panelH = null;           // remembered height, in vh
  let lastScan = 0;
  let session = null;
  let clientDomains = [];
  let clientsByName = new Map();
  let decisions = {};       // id -> "no" | "done", persisted
  const laterThisLoad = new Set();   // "Later" = out of the way until reload or next cycle
  const justDone = new Map();        // conversation -> what was created, kept visible until the panel closes
  // conversation -> { thread, out }: a proposal asked for and not yet acted on.
  // Survives the panel being rebuilt, which the DOM-only version did not.
  const proposals = new Map();
  let manual = null;                 // the "this mail" flow, when it is running
  let amend = null;                  // the "change a job" flow, when it is running
  // Which taskbar button was pressed: what the card is going to end in.
  let intent = "job";                // job | quote | invoice
  let heartbeat = null;              // the three-hour clock, stoppable

  // -------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------
  // Reloading the extension kills the handle a content script already running
  // in an open tab holds, while the script itself carries on - timers and all.
  // Every chrome.* call it makes after that throws "Extension context
  // invalidated", once a minute, into a log nobody reads.
  //
  // So the strip notices, stops its own clock, and says what to do about it.
  // The page is still usable; it just cannot reach storage until it reloads.
  let dead = false;

  // Death is detected by a call FAILING, never by a capability being absent.
  // Testing for chrome.runtime up front looks tidier and is wrong: anything
  // that leaves it undefined would make the strip declare itself dead on a
  // perfectly good page.
  function died() {
    if (dead) return;
    dead = true;
    if (heartbeat) clearInterval(heartbeat);
    status.textContent = "OneShot was updated - reload this page to pick up the new version";
    dot.className = "";
    // The bar may currently be showing one mail instead of the status line.
    // Put the ordinary one back, or the notice has nowhere to appear.
    showing = null;
    try { bar.textContent = ""; bar.append(dot, status); } catch { /* not built yet */ }
    strip.classList.remove("panel-open");
    panel.classList.remove("open");
    panel.textContent = "";
  }

  // An invalidated handle keeps chrome.runtime but drops its id. Present and
  // id-less is dead; absent entirely is simply not something to judge on.
  const invalidated = () => {
    try { return !!(chrome.runtime && !chrome.runtime.id); } catch { return true; }
  };

  const store = {
    async load() {
      if (dead) return;
      try {
        const d = await chrome.storage.local.get(
          ["session", "decisions", "clientDomains", "jobTypes", "panelH"]);
        session = d.session || null;
        decisions = d.decisions || {};
        clientDomains = d.clientDomains || [];
        jobTypes = d.jobTypes || [];
        panelH = Number(d.panelH) || null;
      } catch { died(); }
    },
    save(patch) {
      if (dead) return;
      try {
        // In MV3 this returns a promise, and an invalidated extension REJECTS
        // rather than throwing - which is exactly why the error arrived as
        // "Uncaught (in promise)" and not as something a try/catch would see.
        const p = chrome.storage.local.set(patch);
        if (p && typeof p.catch === "function") p.catch(() => died());
      } catch { died(); }
    },
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
  /* Five task buttons and a status line. The buttons keep their size and the
     status gives way, because a truncated sentence is readable and a button
     pushed off the end of the bar is not. */
  #oneshot-bar { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px; }
  #oneshot-bar > button { flex: none; }
  #oneshot-status {
    flex: 1 1 auto; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
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
  #oneshot-panel.open {
    max-height: var(--oneshot-panel-h, 38vh);
    overflow-y: auto; border-top-color: #2b3033;
  }
  /* Drag this to make the list taller or shorter. It remembers. */
  #oneshot-grip {
    height: 7px; cursor: ns-resize; background: #15191b;
    border-bottom: 1px solid #1c2123; display: none;
  }
  #oneshot-grip::after {
    content: ""; display: block; width: 36px; height: 3px; margin: 2px auto 0;
    border-radius: 2px; background: #3a4145;
  }
  #oneshot-grip:hover::after { background: #5a646a; }
  #oneshot-strip.panel-open #oneshot-grip { display: block; }
  #oneshot-showing {
    flex: 1; min-width: 0; color: #eef1f2;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #oneshot-showing b { color: #8d979b; font-weight: 600; margin-right: 6px; }
  .oneshot-row { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-bottom: 1px solid #1c2123; }
  .oneshot-row:last-child { border-bottom: none; }
  .oneshot-main { flex: 1; min-width: 0; }
  .oneshot-goto { cursor: pointer; }
  .oneshot-goto:hover .oneshot-subj { text-decoration: underline; }
  .oneshot-subj { font-weight: 600; color: #eef1f2; }
  .oneshot-meta { color: #8d979b; font-size: 12px; margin-top: 2px; }
  .oneshot-acts { display: flex; gap: 6px; flex: none; }
  /* The buttons do not scroll away.
     The panel is a fixed-height scroller - 38vh by default - and the card
     inside it is taller than that: job fields, then the charges, then the
     reminder. Before the charges were added the actions were already below
     the fold; afterwards they sat 715px down a 292px window, which reads
     exactly like a feature that was never built. A decision is not something
     to go hunting for, so the row carrying it is pinned to the bottom of the
     scroller with the panel's own background behind it. */
  .oneshot-row .oneshot-acts {
    position: sticky; bottom: 0; z-index: 2;
    background: #101314; padding: 8px 0 2px;
    margin-top: 10px; border-top: 1px solid #2b3033;
    flex-wrap: wrap;
  }
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
  /* An amendment is read by comparing two values, so the old one stays on
     screen beside the new rather than being replaced by it. */
  .oneshot-diff { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
  .oneshot-chg { display: flex; gap: 8px; align-items: baseline; }
  .oneshot-chg input[type=checkbox] { margin: 3px 0 0; flex: none; }
  .oneshot-chg .k {
    font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
    color: #8d979b; flex: none; min-width: 104px;
  }
  .oneshot-chg .v { min-width: 0; }
  .oneshot-was { color: #8d979b; text-decoration: line-through; }
  .oneshot-now { color: #eef1f2; font-weight: 600; }
  .oneshot-arrow { color: #8d979b; margin: 0 5px; }
  .oneshot-job { margin-top: 10px; padding-left: 10px; border-left: 2px solid #2b3033; }
  .oneshot-jobname { font-weight: 600; color: #cdd5d8; font-size: 12px; }
  .oneshot-cands { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; align-items: flex-start; }
  .oneshot-refrow { display: flex; gap: 6px; margin-top: 8px; align-items: center; flex-wrap: wrap; }
  .oneshot-refrow input {
    background: #1c2123; border: 1px solid #343a3d; color: #eef1f2;
    border-radius: 6px; padding: 5px 8px; font: inherit; min-width: 210px;
  }
  .oneshot-warn { color: #e0a33e; }
  /* The money on the card.
     A table rather than a stack of labelled fields, because the thing being
     checked is a column of figures and a column is what people add up. The
     description takes the room it needs; quantity, unit and price are narrow
     and fixed, so the decimal points line up down the card.
     Each line carries a line of grey under it saying where its price came
     from. That line is the whole reason this is editable here: a number with
     no provenance is one somebody has to go and verify elsewhere. */
  .oneshot-money { grid-column: 1 / -1; border-top: 1px solid #2b3033; padding-top: 8px; margin-top: 2px; }
  .oneshot-money-head {
    display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
    font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #8d979b;
  }
  .oneshot-lines { display: flex; flex-direction: column; gap: 6px; margin-top: 7px; }
  .oneshot-line { display: grid; grid-template-columns: 1fr 48px 56px 78px 20px; gap: 5px; align-items: center; }
  .oneshot-line input {
    background: #1c2123; border: 1px solid #343a3d; color: #eef1f2;
    border-radius: 6px; padding: 5px 7px; font: inherit; font-size: 13px; min-width: 0; width: 100%;
  }
  .oneshot-line input.num { text-align: right; font-variant-numeric: tabular-nums; }
  /* A price nobody knows is left empty and marked, never filled with a zero.
     Zero is a price; blank is a question. */
  .oneshot-line input.blank { border-color: #6a5422; background: #241f14; }
  .oneshot-x {
    background: none; border: none; color: #8d979b; cursor: pointer;
    font-size: 15px; line-height: 1; padding: 2px 4px;
  }
  .oneshot-x:hover { color: #e0a33e; }
  .oneshot-from { grid-column: 1 / -1; font-size: 11px; color: #8d979b; margin: -2px 0 2px; }
  .oneshot-from.guess { color: #9a8a5e; }
  .oneshot-sum {
    display: flex; justify-content: space-between; align-items: baseline;
    margin-top: 8px; padding-top: 7px; border-top: 1px solid #2b3033;
    font-variant-numeric: tabular-nums;
  }
  .oneshot-sum b { color: #eef1f2; font-size: 15px; }
  .oneshot-addline {
    background: none; border: 1px dashed #343a3d; color: #8d979b;
    border-radius: 6px; padding: 4px 9px; font: inherit; font-size: 12px; cursor: pointer; margin-top: 7px;
  }
  .oneshot-addline:hover { color: #eef1f2; border-color: #4a5255; }
  /* Reminders. Two shapes: a pair of fields inside the job card, and the
     little "come back to this?" step the Later button opens. */
  .oneshot-rem { grid-column: 1 / -1; border-top: 1px solid #2b3033; padding-top: 8px; margin-top: 2px; }
  .oneshot-rem-head { display: flex; align-items: center; gap: 8px; }
  .oneshot-rem-head span { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #8d979b; }
  .oneshot-rem-when { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
  .oneshot-rem-when input {
    background: #1c2123; border: 1px solid #343a3d; color: #eef1f2;
    border-radius: 6px; padding: 5px 8px; font: inherit; font-size: 13px;
  }
  .oneshot-rem-says { font-size: 12px; color: #8d979b; margin-top: 6px; }
  .oneshot-rem-says.on { color: #cdd5d8; }
  .oneshot-learned { color: #7fb7e8; }
  .oneshot-rowcol { flex-direction: column; align-items: stretch; }
  .oneshot-rowtop { display: flex; gap: 10px; align-items: flex-start; }
  .oneshot-later { margin-top: 8px; padding: 8px 10px; background: #1c2123;
    border: 1px solid #2b3033; border-radius: 8px; }
  .oneshot-later-q { color: #eef1f2; font-size: 13px; margin-bottom: 8px; }
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
  // The taskbar.
  //
  // One row, one question: what do you want to do with what is on screen?
  // Every answer is a button here, and they read the same on mail and on
  // WhatsApp - the surface changes what can be read, not what a person is
  // trying to do.
  //
  // These used to differ: WhatsApp had one button and mail had three, and the
  // quote and invoice buttons were put on the CARD instead, where they sat
  // below the fold of a scrolling panel. Choosing the task is the first
  // decision, so it belongs where the eye already is.
  const mkBtn = el("button", { id: "oneshot-make", textContent: "Create job" });
  const amBtn = el("button", { id: "oneshot-amend", textContent: "Amend job" });
  const quoteBtn = el("button", { id: "oneshot-quote", textContent: "Create quote" });
  const invBtn = el("button", { id: "oneshot-inv", textContent: "Create invoice" });
  const btn = el("button", { id: "oneshot-jobs", textContent: "Show jobs" });
  // Shown INSTEAD of the usual bar contents while one mail is being looked at.
  const showingLbl = el("span", { id: "oneshot-showing" });
  const showMake = el("button", { className: "primary", textContent: "Make job" });
  const showBack = el("button", { textContent: "Back to list" });
  const showDone = el("button", { className: "ghost", textContent: "\u00d7", title: "Stop showing this one" });

  const bar = el("div", { id: "oneshot-bar" },
    [dot, status, mkBtn, amBtn, quoteBtn, invBtn, btn]);
  const grip = el("div", { id: "oneshot-grip", title: "Drag to resize the list" });
  const panel = el("div", { id: "oneshot-panel" });
  strip.append(bar, grip, panel);

  /** How much of the window the strip is covering, so the reader can scroll
   *  the row clear of it rather than behind it. */
  const stripInset = () => Math.ceil(strip.getBoundingClientRect().height);

  const stopShowing = () => {
    showing = null;
    onlyId = null;
    try { window.postMessage({ __oneshot: "unmark" }, "*"); } catch { /* page gone */ }
  };

  // --- resizing -------------------------------------------------------------
  const applyPanelH = () => {
    strip.style.setProperty("--oneshot-panel-h", `${panelH || 38}vh`);
  };
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = panelH || 38;
    const move = (ev) => {
      // Dragging UP makes it taller, which is the direction it grows.
      const dvh = ((startY - ev.clientY) / window.innerHeight) * 100;
      panelH = Math.min(70, Math.max(12, Math.round(startH + dvh)));
      applyPanelH();
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      store.save({ panelH });
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });

  showMake.onclick = () => { onlyId = showing && showing.id; openPanel = true; render(); };
  showBack.onclick = () => { onlyId = null; openPanel = true; render(); };
  showDone.onclick = () => { stopShowing(); render(); };

  btn.onclick = () => {
    // On WhatsApp there is no list to show. The reader only ever reads the
    // chat that is open, so there is nothing for this to toggle - it opens
    // the board instead, which is what somebody pressing "Show jobs" in a
    // chat window actually wants to see.
    if (CHAT) { window.open(APP + "/dashboard", "_blank"); return; }
    // Deliberately does NOT stop showing. Closing the list while still working
    // through one mail is the normal case, and throwing away which mail that
    // is would put them right back where they started. The "x" is how you say
    // you are done with it.
    openPanel = !openPanel;
    if (!openPanel) { justDone.clear(); proposals.clear(); manual = null; amend = null; scan(); }
    render();
  };

  // The deliberate route: whatever is open in the reading pane, right now.
  // Unlike a list row this carries the whole thread, so the parser gets the
  // real text rather than a preview line.
  //
  // Three buttons share it, because reading the thread is the same work
  // whatever is going to be made from it. Which one was pressed is kept in
  // `intent`, and the card ends in that one decision rather than offering all
  // three again at the bottom.
  const TASKS = { job: mkBtn, quote: quoteBtn, invoice: invBtn };
  const TASK_WORD = { job: "job", quote: "quote", invoice: "invoice" };

  const markIntent = () => {
    const live = !!(manual && !manual.error && !manual.done);
    for (const k of Object.keys(TASKS)) TASKS[k].classList.toggle("primary", live && k === intent);
    // Nothing read yet: "Create job" is the ordinary thing to want, so it is
    // the one that looks pressable.
    if (!live) mkBtn.classList.add("primary");
  };

  const startTask = async (which) => {
    intent = which;
    if (!session) { openPanel = true; render(); return; }

    // The thread has already been read and is sitting on screen. Changing
    // your mind about what to make of it is not a reason to read it again:
    // another parse costs money, takes seconds, and could come back saying
    // something different from what is being looked at.
    if (manual && !manual.error && !manual.done && manual.state === "proposed") {
      openPanel = true; render(); return;
    }

    const btnFor = TASKS[which];
    btnFor.disabled = true;
    const was = btnFor.textContent;
    btnFor.textContent = CHAT ? "Reading this chat..." : "Reading this mail...";
    const msg = await askReader();
    btnFor.disabled = false; btnFor.textContent = was;
    if (!msg || !msg.body || msg.body.length < 40) {
      openPanel = true;
      manual = { error: CHAT
        ? "Open a chat first - there is no conversation on screen to read."
        : "Open a message first - there is nothing in the reading pane to read." };
      render();
      return;
    }
    manual = { msg, state: "suggesting" };
    openPanel = true;
    render();
    const thread = threadOf(msg);
    const out = await api("suggest-job", { action: "suggest", thread });
    // Even a refusal opens the form. The click was the decision; the parser
    // only gets to pre-fill.
    //
    // The REASON is kept. It used to be dropped on the floor here - `out`
    // became null and the card then explained the empty fields as "nothing
    // job-shaped in this mail", which is a confident, wrong answer when the
    // truth was a timeout or an expired session. An empty card that blames
    // the mail is worse than one that says what went wrong.
    manual = { msg, thread, out: out.error ? null : out,
               failed: out.error || null, state: "proposed" };
    render();
  };

  mkBtn.onclick = () => startTask("job");
  quoteBtn.onclick = () => startTask("quote");
  invBtn.onclick = () => startTask("invoice");

  // Re-reads the open thread and asks which job it changes. Like the create
  // button, the click is the decision: it always opens, and a parser that
  // cannot find a reference asks for one rather than giving up.
  amBtn.onclick = async () => {
    if (!session) { openPanel = true; render(); return; }
    amBtn.disabled = true;
    const was = amBtn.textContent;
    amBtn.textContent = "Reading this mail...";
    const msg = await askReader();
    amBtn.disabled = false; amBtn.textContent = was;
    if (!msg || !msg.body || msg.body.length < 40) {
      openPanel = true;
      amend = { error: "Open the mail that asks for the change first - there is nothing in the reading pane to read." };
      render();
      return;
    }
    amend = { msg, stage: "reading" };
    openPanel = true;
    render();
    await proposeAmendment(msg, {});
  };

  // One round trip, used by the button and again whenever the reader pins down
  // a reference the parser could not. `hints` maps how the parser read a
  // reference to the job the reader chose instead.
  async function proposeAmendment(msg, hints) {
    const thread = threadOf(msg);
    const out = await api("suggest-job", { action: "amend", thread, hints: hints || {} });
    if (out.error) { amend = { msg, thread, hints, outcomes: [], reason: out.error }; render(); return; }
    amend = { msg, thread, hints: hints || {}, ...out };
    render();
  }

  function askReader() {
    return new Promise((res) => {
      // The WhatsApp reader waits for the lazily-rendered message list to
      // settle before it answers, which can take a couple of seconds.
      const t = setTimeout(() => { window.removeEventListener("message", h); res(null); }, 9000);
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
  // A parse can take fifteen seconds, so this waits a long time - but never
  // forever. It used to have no timeout and no catch at all: a dropped
  // connection rejected the fetch, the click handler died mid-await, and the
  // card sat on "Reading..." for the rest of the session with nothing on
  // screen to say what had happened. A request that fails has to come back as
  // an answer, or the reader is left watching a spinner.
  async function api(path, body, ms = 90_000) {
    let res;
    try {
      res = await fetch(`${FUNCTIONS}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json",
                   authorization: `Bearer ${session?.access_token || ""}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ms),
      });
    } catch (e) {
      const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
      return { error: timedOut
        ? "OneShot took too long to answer. Nothing is wrong with the mail - try again."
        : "Could not reach OneShot. Check your connection and try again." };
    }
    if (res.status === 401) { session = null; store.save({ session: null }); }
    const out = await res.json().catch(() => null);
    if (out && typeof out === "object") return out;
    return { error: `OneShot answered with ${res.status} and nothing readable.` };
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
      // billing_email, NOT email. There is no `email` column on clients and
      // never has been - this asked for one, PostgREST answered 400 every time
      // the strip loaded, and the catch below ate it. The visible effect was
      // not an error but an absence: clientsByName stayed empty, so no thread
      // and no chat was ever matched to a customer anybody already had.
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/clients?select=name,legal_name,aliases,billing_email`, {
        headers: { apikey: ANON, authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        // Said out loud. A silent catch is what hid the last one for weeks.
        console.warn("OneShot: could not load clients -", res.status, await res.text());
        return;
      }
      const rows = await res.json();
      if (!Array.isArray(rows)) return;

      clientDomains = [...new Set(
        rows.map((r) => String(r.billing_email || "").split("@")[1]).filter(Boolean))];

      // Every name a customer goes by, not just the one on the record. A
      // gallery writes itself three ways and signs mail a fourth.
      clientsByName = new Map();
      for (const r of rows) {
        const mail = String(r.billing_email || "").toLowerCase();
        if (!mail) continue;
        for (const n of [r.name, r.legal_name, ...(Array.isArray(r.aliases) ? r.aliases : [])]) {
          const k = String(n || "").trim().toLowerCase();
          if (k && !clientsByName.has(k)) clientsByName.set(k, mail);
        }
      }
      store.save({ clientDomains });
      console.log(`OneShot: ${clientsByName.size} client name(s) known`);
    } catch (e) {
      console.warn("OneShot: could not load clients -", e && e.message);
    }
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

  // What a decision is remembered against.
  //
  // Outlook's row id is regenerated every time the list draws, so a decision
  // keyed on it survived exactly until the next reload - which is why threads
  // already turned into jobs kept coming back as fresh suggestions. The
  // conversation id is the same for the whole thread and the same tomorrow.
  // The row id stays as the fallback for anything that has no conversation id.
  const keyOf = (m) => (m && (m.convId || m.id)) || "";

  // -------------------------------------------------------------------------
  // Saying a time
  // -------------------------------------------------------------------------
  // Native date and time inputs, not the wheel the web app uses: the strip is
  // a cramped overlay sitting on top of somebody's mail, and sixty scrolling
  // cells in it would be absurd. On a phone these ARE the wheel; on a desktop
  // they are two fields you can type into. Both of the person's ways in, with
  // no code of our own to get wrong.
  //
  // Built in local time on purpose. `new Date(y, m-1, d, hh, mm)` is the
  // constructor that means "here"; `new Date("2026-10-07")` is the one that
  // means UTC midnight and lands a reminder on the wrong day for anyone west
  // of Greenwich.
  const pad2 = (n) => String(n).padStart(2, "0");
  const dateVal = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const timeVal = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

  function whenISO(dateStr, timeStr) {
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || "").trim());
    const t = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || "").trim());
    if (!d || !t) return null;
    if (+t[1] > 23 || +t[2] > 59) return null;
    const when = new Date(+d[1], +d[2] - 1, +d[3], +t[1], +t[2], 0, 0);
    if (!(when.getTime() > Date.now())) return null;
    return when.toISOString();
  }

  /** "Wed 7 Oct at 09:30", for reading a picked time back before it is set. */
  const spellWhen = (iso) => {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })
      + ` at ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };

  const inDays = (n, hour) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    d.setHours(hour, 0, 0, 0);
    return d;
  };

  // Threads the SERVER says already produced a job, keyed the same way as
  // decisions. Held separately so a withdrawn job on the server can bring a
  // thread back, which clearing a local decision never would.
  let serverDone = {};
  // conversation -> { due_at, note }: threads this person has parked until
  // later. Kept apart from decisions for the same reason serverDone is - it is
  // the server's answer, and un-parking somewhere else has to bring the thread
  // back here.
  let parkedThreads = {};
  // conversation -> { stage, date, time, note, busy, error }: the Later step,
  // held in state rather than in the DOM so a republishing inbox cannot wipe a
  // half-filled answer out from under somebody.
  const laterAsk = new Map();
  let askingSeen = false;

  /**
   * Ask once per scan which of the threads on screen already have jobs.
   *
   * This is what makes the answer the same on a second machine, for a
   * colleague, and for a thread somebody forwarded to intake instead of using
   * the strip. Failure is silent and harmless: not knowing is exactly where
   * the strip stood before.
   */
  async function askSeen(list) {
    if (!session || askingSeen) return;
    const ids = [...new Set(list.map(keyOf).filter(Boolean))].slice(0, 100);
    if (!ids.length) return;
    askingSeen = true;
    try {
      // Two questions, one round trip each, asked together: which of these
      // already produced a job, and which have I parked until later. Both are
      // reasons not to offer a thread, and asking for one without the other
      // would leave the strip right about half of the threads on screen.
      const [doneOut, parkOut] = await Promise.all([
        api("suggest-job", { action: "seen", external_ids: ids }),
        api("suggest-job", { action: "parked", external_ids: ids }),
      ]);

      let moved = false;
      if (doneOut && doneOut.done && typeof doneOut.done === "object") {
        // Compared by content, not by size. {conv-a: ...} and {conv-b: ...}
        // are the same length and a completely different answer.
        if (JSON.stringify(doneOut.done) !== JSON.stringify(serverDone)) moved = true;
        serverDone = doneOut.done;
      }
      if (parkOut && parkOut.parked && typeof parkOut.parked === "object") {
        if (JSON.stringify(parkOut.parked) !== JSON.stringify(parkedThreads)) moved = true;
        parkedThreads = parkOut.parked;
      }

      // sift(), not render(): the answer has to go back through the FILTER,
      // which is what decides whether a thread is offered. render() only
      // redraws the list scan() had already worked out, so the server's
      // answer arrived one scan late - a thread a colleague had already
      // dealt with was offered once more before disappearing. Not scan()
      // either, or asking would ask again, for ever.
      if (moved) sift();
    } catch { /* leave it as it was */ } finally { askingSeen = false; }
  }

  // Work out what to offer, and redraw. Separate from scan() so that an answer
  // arriving from the server can be put through the filter without triggering
  // another round of asking.
  function sift() {
    const recent = messages.slice(0, HOW_MANY).map(resolve);
    flagged = recent
      .map(m => ({ m, g: gate(m, { clientDomains, ownDomains: [], sensitivity: 0 }) }))
      .filter(x => x.g.pass && !laterThisLoad.has(keyOf(x.m))
                // A thread with the Later question open stays on screen, or
                // the question disappears as it is being answered.
                && (laterAsk.has(keyOf(x.m))
                    || justDone.has(keyOf(x.m))
                    || (decisions[keyOf(x.m)] !== "no" && decisions[keyOf(x.m)] !== "done"
                        && !serverDone[keyOf(x.m)]
                        // Parked until Thursday: not undealt-with, just not now.
                        && !parkedThreads[keyOf(x.m)])))
      .sort((a, b) => b.g.score - a.g.score);
    refresh();
    return recent;
  }

  function scan() {
    lastScan = Date.now();
    // Asked about everything recent, not only what survived the filter - a
    // thread hidden by a local decision still wants its server answer, so the
    // two cannot drift apart.
    askSeen(sift());
  }

  // -------------------------------------------------------------------------
  // Not taking the work away from somebody mid-sentence
  // -------------------------------------------------------------------------
  // render() empties the panel and rebuilds it. That is fine when a person
  // asked for something, and ruinous when nobody did: Outlook republishes its
  // list whenever a mail arrives, is read, or simply re-renders, and every one
  // of those reached scan() -> render() and wiped a half-filled job card. The
  // reader was typing an address when their own inbox deleted it.
  //
  // So background changes - new mail, the three-hourly clock - do not touch an
  // open form. The data still updates underneath; only the redraw waits.
  let pendingScan = false;

  function editing() {
    if (!openPanel) return false;
    // A card being filled in, or an amendment being read. Neither is finished.
    if (manual && !manual.done && !manual.error) return true;
    if (amend && !amend.error) return true;
    // A Later question part-answered. The state survives a redraw, but the
    // caret does not, and having the cursor jump out of a date field while
    // somebody is typing into it is its own kind of broken.
    if (laterAsk.size) return true;
    // Anything else with the caret in it, including a row's own fields.
    const a = document.activeElement;
    return !!(a && strip.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  }

  function refresh() {
    if (editing()) { pendingScan = true; updateBar(); return; }
    render();
  }

  function updateBar() {
    if (CHAT) return;
    const n = flagged.length;
    dot.className = messages.length ? (n ? "hot" : "live") : "";
    status.textContent = !messages.length
      ? "OneShot - waiting for Outlook to load your mail..."
      : n
        ? `${n} of the last ${Math.min(messages.length, HOW_MANY)} look like they need a job`
        : `Nothing in the last ${Math.min(messages.length, HOW_MANY)} needs a job`;
    btn.textContent = n ? `Show ${n}` : "Show jobs";
    markIntent();

    // While one mail is being looked at, the bar is about that mail. Anything
    // else there is just competing for the one line they are reading.
    bar.textContent = "";
    if (showing && !openPanel) {
      showingLbl.textContent = "";
      showingLbl.append(el("b", { textContent: "Showing" }),
                        document.createTextNode(showing.subject));
      bar.append(dot, showingLbl, showDone, showBack, showMake);
    } else {
      bar.append(dot, status, mkBtn, amBtn, quoteBtn, invBtn, btn);
    }
  }

  function render() {
    // Checked here as well as on the clock: a reader who clicks finds out
    // immediately rather than up to a minute later, and this runs on every
    // interaction anyway.
    if (!dead && invalidated()) died();
    if (dead) return;
    if (CHAT) return renderChat();
    pendingScan = false;
    updateBar();

    strip.classList.toggle("panel-open", openPanel);
    panel.classList.toggle("open", openPanel);
    applyPanelH();
    if (!openPanel) { panel.textContent = ""; return; }

    panel.textContent = "";
    if (!session) { panel.append(authRow()); return; }
    if (amend) panel.append(amendRow());
    if (manual) panel.append(manualRow());
    if (!flagged.length && !manual && !amend) {
      panel.append(el("div", { className: "oneshot-empty",
        textContent: messages.length
          ? "Nothing here needs a job. Next look in 3 hours, or reload to look now."
          : "Open your inbox list so Outlook loads your mail, then reload." }));
      return;
    }
    const list = onlyId ? flagged.filter((x) => x.m.id === onlyId) : flagged;
    if (onlyId && !list.length) {
      // Dealt with, or dropped out of the window since. Fall back to the list
      // rather than showing an empty panel with no way out of it.
      onlyId = null;
      for (const { m, g } of flagged) panel.append(row(m, g));
      return;
    }
    for (const { m, g } of list) panel.append(row(m, g));
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
    // Only freight terms are deadlines. Saying so about "move" or "crate" is
    // noise, and noise in a nudge is how people learn to ignore it.
    const tail = s.freight.length ? "  -  freight terms usually mean a deadline." : "";
    return `Not enough to build a job, but it mentions ${seen.join(", ")}.` + tail;
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
      // The priced lines the parser read out of the body or an attachment.
      // These used to stop here: prefill never picked them up and
      // buildExtraction never put them back, so every price in a mail was
      // silently dropped the moment anybody pressed Create on the card. Jobs
      // beyond the first kept theirs, because those travel whole in `extra`,
      // which is why it looked like it worked.
      charges: (Array.isArray(j.charges) ? j.charges : []).map((c) => ({
        description: String(c.description ?? "").trim(),
        unit: c.unit ? String(c.unit) : "",
        quantity: c.quantity == null || c.quantity === "" ? 1 : Number(c.quantity) || 1,
        // null, not 0. A line the parser could not price is a question, and a
        // zero would answer it with "free".
        unit_price: c.unit_price == null || c.unit_price === "" ? null : Number(c.unit_price),
        // Filled in by the price lookup once the card is on screen.
        from: c.unit_price == null ? null : "from the message",
        stated: c.unit_price != null,
      })).filter((c) => c.description),
      // Who gets billed. Carried through untouched for the same reason, and
      // not shown on the card: it is not a decision anybody makes while
      // reading a mail, and the costs sheet shows it afterwards.
      billing: j.billing ?? null,
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
    // Lines as they stand on the card, which is not the same thing as lines as
    // the parser read them - the whole point of showing them is that what gets
    // written is what was looked at. A line still without a price goes through
    // as null so that planCharges records it at zero AND flags it, rather than
    // a zero that looks like a decision.
    const charges = (f.charges || [])
      .filter((c) => String(c.description || "").trim())
      .map((c) => ({
        description: String(c.description).trim(),
        quantity: Number(c.quantity) > 0 ? Number(c.quantity) : 1,
        unit: c.unit || null,
        unit_price: c.unit_price == null || c.unit_price === "" ? null : Number(c.unit_price),
      }));

    const job = {
      type: f.type || null, client_ref: f.ref || null, stops,
      scheduled_date: f.date || null, time_window: f.window || null,
      hard_deadline: !!f.hard, items, missing,
      charges, billing: f.billing ?? null,
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

  // ---------------------------------------------------------------------------
  // The money, on the card, before anything is written
  // ---------------------------------------------------------------------------
  // Three things happen here and they are all the same thing: the figures that
  // will end up on an invoice are put in front of a person while they can
  // still be changed.
  //
  //   - every line is editable - description, quantity, unit, price
  //   - every price says where it came from
  //   - nothing is written until a button is pressed
  //
  // It edits `f.charges` in place rather than keeping its own copy, so
  // whichever of the three buttons gets pressed sends what is on screen. A
  // second copy would be a second thing to keep in step, and the thing it
  // would get wrong is money.
  const money2 = (n) => (n == null || n === "" || isNaN(Number(n)))
    ? "" : Number(n).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function chargeBlock(f, onTotal) {
    const list = el("div", { className: "oneshot-lines" });
    const sum = el("div", { className: "oneshot-sum" });
    const head = el("div", { className: "oneshot-meta" });

    const total = () => (f.charges || []).reduce((t, c) =>
      t + (Number(c.quantity) || 0) * (Number(c.unit_price) || 0), 0);

    const retotal = () => {
      const blanks = (f.charges || []).filter((c) => c.unit_price == null).length;
      sum.replaceChildren(
        el("span", { className: "oneshot-meta",
          textContent: blanks
            ? `${blanks} line${blanks > 1 ? "s" : ""} with no price yet`
            : `${(f.charges || []).length} line${(f.charges || []).length === 1 ? "" : "s"}` }),
        el("b", { textContent: money2(total()) || "0.00" }),
      );
      if (onTotal) onTotal(total());
    };

    const draw = () => {
      list.replaceChildren();
      (f.charges || []).forEach((c, i) => {
        const from = el("div", {
          className: c.stated || c.from === "yours" ? "oneshot-from" : "oneshot-from guess",
          textContent: c.from || "",
        });
        const desc = el("input", { type: "text", value: c.description,
          placeholder: "What is being charged for" });
        const qty = el("input", { type: "number", className: "num", value: String(c.quantity ?? 1),
          step: "0.01", min: "0" });
        const unit = el("input", { type: "text", value: c.unit || "", placeholder: "unit" });
        const price = el("input", { type: "number", className: "num", step: "0.01", min: "0",
          value: c.unit_price == null ? "" : String(c.unit_price),
          placeholder: "price" });
        if (c.unit_price == null) price.classList.add("blank");

        desc.oninput = () => { c.description = desc.value; };
        qty.oninput = () => { c.quantity = qty.value === "" ? 1 : Number(qty.value); retotal(); };
        unit.oninput = () => { c.unit = unit.value; };
        price.oninput = () => {
          // Typing a price makes it the person's own figure, so whatever the
          // line said about where the number came from stops being true.
          //
          // Updated in place rather than by redrawing: a redraw replaces the
          // input the person is typing into, which takes the caret with it.
          // Every keystroke would land in a new empty box.
          c.unit_price = price.value === "" ? null : Number(price.value);
          c.from = price.value === "" ? null : "yours";
          c.stated = price.value !== "";
          price.classList.toggle("blank", c.unit_price == null);
          from.textContent = c.from || "";
          from.className = "oneshot-from";
          retotal();
        };

        const x = el("button", { className: "oneshot-x", textContent: "×",
          title: "Remove this line" });
        x.onclick = () => { f.charges.splice(i, 1); draw(); };

        list.append(el("div", { className: "oneshot-line" }, [desc, qty, unit, price, x]), from);
      });
      retotal();
    };

    const add = el("button", { className: "oneshot-addline", textContent: "+ Add a line" });
    add.onclick = () => {
      (f.charges = f.charges || []).push({
        description: "", unit: "", quantity: 1, unit_price: null, from: null, stated: false,
      });
      draw();
    };

    draw();

    // What the workspace usually charges, for the lines the message left
    // blank. Asked once, when the card opens. A failure is silent: the lines
    // are already correct at blank, and a card that refuses to appear because
    // a price lookup timed out would be a bad trade.
    const ask = async () => {
      // Once per card, not once per redraw. manualForm() runs again on every
      // scan, and without this the workspace would be asked what it charges
      // every time anything on screen changed.
      if (f.asked) return;
      const blanks = (f.charges || []).some((c) => c.unit_price == null);
      if (!blanks) { f.asked = true; return; }
      f.asked = true;
      head.textContent = "Checking what you usually charge…";
      let out = null;
      try {
        out = await api("suggest-job", {
          action: "price",
          lines: (f.charges || []).map((c) => ({
            description: c.description, unit: c.unit || null, quantity: c.quantity,
          })),
        });
      } catch { /* silent, see above */ }
      head.textContent = "";
      const prices = (out && out.prices) || [];
      let filled = 0;
      for (const p of prices) {
        const c = (f.charges || [])[p.idx];
        if (!c || c.unit_price != null) continue;      // never over a price already there
        const v = Number(p.unit_price);
        if (!p.unit_price || isNaN(v) || v <= 0) continue;
        c.unit_price = v;
        c.from = p.seen || p.source || "charged before";
        c.stated = false;
        filled++;
      }
      if (filled) draw();
    };

    return {
      node: el("div", { className: "oneshot-money" }, [
        el("div", { className: "oneshot-money-head" }, [
          el("span", { textContent: "Charges" }),
          el("span", { textContent: "qty / unit / price" }),
        ]),
        head, list, add, sum,
      ]),
      ask,
      total,
    };
  }

  function manualForm() {
    // Kept on `manual` rather than rebuilt from the parse each time, because
    // the charge lines below are EDITED here. prefill() returns the parser's
    // reading, and reading it again would quietly undo whatever somebody had
    // typed into the table the moment anything redrew the card. The plain
    // fields above get away with being rebuilt because their values live in
    // the DOM inputs and are only read when a button is pressed.
    const f = (manual.form = manual.form || prefill(manual.out));
    const note = el("div", { className: "oneshot-meta" });
    // A retry only exists when the attempt FAILED. Offering one after the
    // parser read the mail and found no job would just invite the same answer.
    let again = null;

    if (manual.failed) {
      note.className = "oneshot-meta oneshot-warn";
      note.textContent = `${manual.failed}  -  nothing was filled in. `
        + "Try again, or fill in what you know and create it anyway.";
      again = el("button", { textContent: "Try again" });
      again.onclick = async () => {
        again.disabled = true; again.textContent = "Reading...";
        const out = await api("suggest-job", { action: "suggest", thread: manual.thread });
        // form dropped deliberately: this is a fresh reading of the thread, so
        // the lines on the card should be the new ones rather than a mix.
        manual = { ...manual, out: out.error ? null : out, form: null,
                   failed: out.error || null, state: "proposed" };
        render();
      };
    } else if (manual.out && manual.out.isJob) {
      const miss = (manual.out.missing || []);
      note.textContent = (manual.out.summary || "Read from this mail")
        + (miss.length ? `  -  still needs: ${miss.join(", ")}` : "");
    } else if (f.collection || f.delivery || f.date || f.items || f.ref) {
      // Not judged a new request - a carrier's "out for delivery" notice, a
      // reply in a thread - but the parser still read addresses, a date or a
      // reference out of it, and those are now in the form. Saying "not enough
      // to build a job" over a form it has just filled in would be absurd.
      note.textContent = "This reads as an update rather than a new request, so nothing "
        + "was created on its own - but what it says is filled in below. Check it and "
        + "create the job if you want it on the board.";
    } else {
      note.textContent = notJobText(manual.out || {}, manual.msg.body)
        + "  -  fill in what you know and create it anyway.";
    }
    // What the reader KNOWS it did not get. This goes first and in the warning
    // colour, because the failure it describes is invisible otherwise: a card
    // built from one message of forty has the same fields filled in, in the
    // same way, as a card built from all forty.
    for (const lim of (manual.msg.limits || [])) {
      const warn = el("div", { textContent: lim });
      warn.style.cssText = "margin-top:6px;font-weight:600;color:#f0a500";
      note.append(warn);
    }

    // A chat is rarely all text. Say what was left out rather than let a
    // half-read conversation produce a confident-looking card.
    const m = manual.msg.media;
    if (m && (m.voice || m.images || m.docs)) {
      const bits = [];
      if (m.voice) bits.push(`${m.voice} voice note${m.voice > 1 ? "s" : ""}`);
      if (m.images) bits.push(`${m.images} photo${m.images > 1 ? "s" : ""}`);
      if (m.docs) bits.push(`${m.docs} document${m.docs > 1 ? "s" : ""}`);
      note.textContent += `  -  ${bits.join(", ")} in this chat could not be read.`;
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

    // ---- the reminder on the card ------------------------------------------
    // The second half of "build the reminder feature into the extensions": a
    // job made from a mail can carry one, set at the same moment, without
    // going to the app to do it.
    //
    // What the workspace has learned decides what is offered. reminder_hint
    // says whether jobs of this type usually get chased and how far ahead, so
    // the fields arrive filled in for the kinds of job that always need it and
    // empty for the kinds that never do. Filled in, never ticked: an alarm
    // that books itself is an alarm people turn off.
    const hint = (manual.out && manual.out.reminder_hint) || null;
    if (!manual.rem) {
      const sug = hint && hint.suggest && hint.suggested_at ? new Date(hint.suggested_at) : null;
      manual.rem = sug
        ? { on: false, date: dateVal(sug), time: timeVal(sug), note: "" }
        : { on: false, date: "", time: "", note: "" };
    }
    const rem = manual.rem;

    const remOn = el("input", { type: "checkbox" });
    remOn.checked = !!rem.on;
    const remDate = el("input", { type: "date", value: rem.date });
    const remTime = el("input", { type: "time", value: rem.time });
    const remNote = el("input", { type: "text", value: rem.note,
      placeholder: "What to chase (optional)" });
    const remSays = el("div", { className: "oneshot-rem-says" });

    const remRefresh = () => {
      rem.on = remOn.checked;
      rem.date = remDate.value; rem.time = remTime.value; rem.note = remNote.value;
      const iso = whenISO(rem.date, rem.time);
      for (const n of [remDate, remTime, remNote]) n.disabled = !rem.on;
      if (!rem.on) {
        remSays.className = "oneshot-rem-says";
        remSays.textContent = hint && hint.suggest
          ? `Jobs of this kind usually get one - ${hint.reminded} of the last ${hint.jobs}.`
          : hint && hint.jobs
            ? `${hint.reminded} of the last ${hint.jobs} jobs of this kind had one.`
            : "";
        if (hint && hint.suggest) remSays.className = "oneshot-rem-says oneshot-learned";
        return;
      }
      remSays.className = iso ? "oneshot-rem-says on" : "oneshot-rem-says oneshot-warn";
      remSays.textContent = iso
        ? `You will be reminded ${spellWhen(iso)}.`
        : "Pick a day and a time that has not already gone.";
    };
    remOn.onchange = () => {
      // Ticking it with nothing in the fields offers tomorrow morning rather
      // than an empty pair of boxes and a complaint.
      if (remOn.checked && !whenISO(remDate.value, remTime.value)) {
        const d = inDays(1, 8);
        remDate.value = dateVal(d); remTime.value = timeVal(d);
      }
      remRefresh();
    };
    for (const n of [remDate, remTime, remNote]) n.oninput = remRefresh;
    remRefresh();

    const remBlock = el("div", { className: "oneshot-rem" }, [
      el("label", { className: "oneshot-rem-head" }, [
        remOn, el("span", { textContent: "Remind me about this job" }),
      ]),
      el("div", { className: "oneshot-rem-when" }, [remDate, remTime, remNote]),
      remSays,
    ]);

    const charges = chargeBlock(f);
    charges.ask();

    // One button, saying what the taskbar was asked for. The three live up
    // there; repeating them down here would be asking the same question
    // twice and would put the answer below the fold of a scrolling panel.
    const go = el("button", { className: "primary",
      textContent: `Create ${TASK_WORD[intent]}` });
    const cancel = el("button", { className: "ghost", textContent: "Cancel" });
    const acts = again ? [again, cancel, go] : [cancel, go];
    const msg = el("div", { className: "oneshot-meta" });
    cancel.onclick = () => { manual = null; intent = "job"; scan(); };

    const fields = () => ({
      type: typeSel.value, date: date.value, window: win.value,
      collection: coll.value, delivery: del.value, items: items.value,
      ref: ref.value, hard: hard.checked, extra: f.extra,
      charges: f.charges, billing: f.billing,
    });
    const was = go.textContent;
    const busy = (on, label) => {
      go.disabled = on; cancel.disabled = on;
      go.textContent = on ? label : was;
    };

    // ---- a quote -----------------------------------------------------------
    // No job. Most quotes are for work that never happens, and a board full of
    // maybes is no use to whoever reads it at seven in the morning. The job as
    // it stands on the card travels with the quote, so accepting it later has
    // something to build from.
    async function makeQuote() {
      const lines = (f.charges || []).filter((c) => String(c.description || "").trim());
      if (!lines.length) { msg.textContent = "Add a line before quoting."; return; }
      busy(true, "Quoting...");
      const ex = buildExtraction(fields(), manual.thread);
      const out = await api("suggest-job", {
        action: "quote",
        lines: lines.map((c) => ({
          description: c.description, unit: c.unit || null,
          quantity: c.quantity, unit_price: c.unit_price,
        })),
        job_draft: (ex.jobs || [])[0] ?? null,
        their_reference: ref.value || null,
      });
      busy(false);
      if (!out || out.error) { msg.textContent = (out && out.error) || "Could not make that quote."; return; }
      // Same shape the create path leaves behind, so the panel renders it
      // without knowing which of the two made it.
      const n = (out.quote.lines || []).length;
      manual = { done: {
        subject: `Quote ${out.quote.number}`,
        text: `${out.quote.number} - ${n} line${n === 1 ? "" : "s"}, `
            + `${money2(out.quote.total)} ${out.quote.currency || ""}`.trim()
            + "  -  no job was made. Accepting it on the quote is what makes one.",
        ref: null,
      } };
      // The thread is NOT marked done. A quote is an offer, and the work it
      // offers has not been taken on - so the thread is still something
      // somebody has to come back to.
      intent = "job";
      scan();
    }

    // Whichever task the taskbar was asked for.
    //
    // An invoice makes the job and its charges, then opens the costs sheet
    // with the lines on it. It stops there rather than issuing: an invoice
    // number is permanent and sequential, so a mis-parse that takes one has to
    // be voided and the void stays on the record for good. One press, one
    // look, one click - and the look is the part that cannot be skipped.
    go.onclick = () => {
      if (intent === "quote") return makeQuote();
      return create(intent === "invoice" ? "Invoicing..." : "Creating...", intent === "invoice");
    };

    async function create(label, thenInvoice) {
      busy(true, label);
      const ex = buildExtraction(fields(), manual.thread);
      // The parser's original proposal travels with the edited one, so the
      // difference between them can be kept. That difference is the only
      // labelled correction this system ever gets, and it was being thrown
      // away every time anyone fixed a field before pressing Create.
      const remAt = rem.on ? whenISO(rem.date, rem.time) : null;
      const done = await api("suggest-job", {
        action: "create", thread: manual.thread, extraction: ex,
        proposed: (manual.out && manual.out.extraction) || null,
        // So the server knows which thread this job came from, and can say so
        // to any other browser that asks.
        external_id: keyOf(manual.msg) || null,
        // Attached after the job exists, server side, and unable to stop it
        // being made - see _shared/reminders.ts.
        reminder: remAt ? { due_at: remAt, note: rem.note.trim() || null } : null,
      });
      if (done.error) { busy(false); msg.textContent = done.error; return; }
      busy(false);

      // Mark the THREAD dealt with. This was missing entirely: a job created
      // from the reading pane recorded nothing, so the same thread kept being
      // suggested afterwards as though nothing had happened.
      const key = keyOf(manual.msg);
      if (key) {
        decisions[key] = "done";
        store.save({ decisions });
        justDone.set(key, { text: done.reply || "Created.", ref: (done.refs || [])[0] || null });
        // The card may have been opened FROM a row, which left a parsed
        // proposal behind. Leaving it there would offer the same thread for
        // review again, with a reading of a mail that has already become a
        // job.
        proposals.delete(key);
      }
      // Said out loud either way. A reminder silently not set is the failure
      // this whole feature cannot afford.
      let text = done.reply || "Created.";
      if (remAt) {
        text += done.reminder && done.reminder.set
          ? `  -  reminder set for ${spellWhen(remAt)}.`
          : "  -  the job was made but the reminder was NOT set.";
      } else if (rem.on) {
        // Ticked, but the day and time did not add up to a future instant. The
        // job is fine; saying nothing would leave somebody believing an alarm
        // exists that does not.
        text += "  -  no reminder was set: that day and time had already gone.";
      }
      // Straight to the costs sheet when that is what was asked for, with the
      // lines already on it. Opened here rather than server side because the
      // job exists either way and a popup blocker must not be able to undo a
      // job that was made.
      const firstRef = (done.refs || [])[0] || null;
      const firstId = firstRef && done.job_ids ? done.job_ids[firstRef] : null;
      if (thenInvoice) {
        if (firstId) {
          window.open(`${APP}/job/${firstId}?costs=1`, "_blank");
          text += "  -  opening the costs sheet. Check the lines, then Issue invoice.";
        } else {
          text += "  -  made, but the costs sheet could not be opened. Find it on the board.";
        }
      }

      manual = { done: { text, ref: firstRef, subject: manual.msg.subject } };
      intent = "job";
      scan();
    }

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
          charges.node,
          remBlock,
        ]),
        el("div", { className: "oneshot-acts", style: "margin-top:10px" }, acts),
        msg,
      ]),
    ]);
  }


  // In a chat the strip says one thing: whether there is a conversation open
  // to read. Everything else happens in the panel after the button.
  function renderChat() {
    dot.className = "live";
    status.textContent = manual && manual.msg
      ? `Read ${manual.msg.messageCount} message${manual.msg.messageCount > 1 ? "s" : ""} from ${manual.msg.fromName || "this chat"}`
      : session
        ? "OneShot - open a chat, then pick a task"
        : "OneShot - sign in to create jobs";
    markIntent();
    // panel-open is what the stylesheet hangs the drag handle off, and
    // applyPanelH is what makes the stored height mean anything. renderChat
    // set neither, so the panel could not be pulled up or down on WhatsApp -
    // it worked on mail only because render() does both and returns here
    // before reaching them.
    strip.classList.toggle("panel-open", openPanel);
    panel.classList.toggle("open", openPanel);
    applyPanelH();
    if (!openPanel) { panel.textContent = ""; return; }
    panel.textContent = "";
    if (!session) { panel.append(authRow()); return; }
    if (manual) panel.append(manualRow());
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
      close.onclick = () => { manual = null; scan(); };
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

  // The amendment card.
  //
  // A thread may change several jobs at once, so this renders a block per job
  // rather than a single form. That is not a nicety: the mail that prompted it
  // named three jobs, the old card showed one, and the other two were lost
  // without anybody being told.
  //
  // Every line carries a checkbox, because a parser that got one field wrong
  // should not cost the reader the other three.
  function amendRow() {
    const close = () => { amend = null; scan(); };
    const head = (t) => el("div", { className: "oneshot-subj", textContent: t });
    const note = (t, cls) => el("div", { className: "oneshot-meta" + (cls ? " " + cls : ""), textContent: t });
    const wrap = (kids) => el("div", { className: "oneshot-row" }, [
      el("div", { className: "oneshot-main" }, kids),
    ]);

    // Re-ask with an extra hint pinned down by the reader.
    const again = async (askedFor, ref) => {
      const hints = Object.assign({}, amend.hints || {});
      hints[askedFor || ""] = ref;
      const m = amend.msg;
      amend = { msg: m, stage: "reading" };
      render();
      await proposeAmendment(m, hints);
    };

    if (amend.error) {
      const x = el("button", { className: "ghost", textContent: "Close" });
      x.onclick = close;
      return el("div", { className: "oneshot-row" }, [
        el("div", { className: "oneshot-main" }, [head("Amend a job"), note(amend.error)]),
        el("div", { className: "oneshot-acts" }, [x]),
      ]);
    }

    if (amend.stage === "reading") {
      return wrap([
        head(amend.msg.subject || "(no subject)"),
        note("Reading this thread for changes..."),
      ]);
    }

    if (amend.done) {
      const open = el("button", { textContent: "Open the board" });
      open.onclick = () => window.open(APP + "/dashboard", "_blank");
      const x = el("button", { className: "ghost", textContent: "Close" });
      x.onclick = close;
      return el("div", { className: "oneshot-row" }, [
        el("div", { className: "oneshot-main" }, [
          head(amend.done.title),
          ...amend.done.lines.map((l) => note(l)),
        ]),
        el("div", { className: "oneshot-acts" }, [open, x]),
      ]);
    }

    const outcomes = amend.outcomes || [];

    // Nothing to work with: no job named anywhere in the thread.
    if (!outcomes.length) {
      const ref = el("input", { type: "text", placeholder: "Job number or their reference, e.g. 0142" });
      const look = el("button", { className: "primary", textContent: "Look again" });
      const x = el("button", { className: "ghost", textContent: "Cancel" });
      x.onclick = close;
      look.onclick = () => { const v = ref.value.trim(); if (v) again("", v); };
      ref.onkeydown = (e) => { if (e.key === "Enter") look.click(); };
      return wrap([
        head("Which job is this change for?"),
        note(amend.reason || "This thread doesn't name a job."),
        el("div", { className: "oneshot-refrow" }, [ref, look, x]),
      ]);
    }

    const show = (v) =>
      v === null || v === undefined || v === "" ? "(blank)"
        : v === true ? "yes" : v === false ? "no" : String(v);

    const boxes = [];          // { box, change, job_id }
    const blocks = [];
    const questions = [];
    let planned = 0;

    for (const o of outcomes) {
      for (const r of (o.refused || [])) questions.push(`${o.job ? o.job.ref : o.asked}: ${r}`);
      for (const u of (o.unassigned || [])) questions.push(u);

      if (o.status === "planned" && o.job) {
        planned++;
        const lines = (o.changes || []).map((c) => {
          const box = el("input", { type: "checkbox" });
          box.checked = true;
          boxes.push({ box, change: c, job_id: o.job.id });
          // An addition has no "before" and a removal has no "after", so
          // neither gets an arrow - "(blank) -> 4 x Crate" reads like a fault.
          const isAdd = c.field === "item:add";
          const isDrop = c.field === "item:remove";
          return el("label", { className: "oneshot-chg" }, [
            box,
            el("span", { className: "k", textContent: c.label }),
            el("span", { className: "v" }, isAdd ? [
              el("span", { className: "oneshot-now", textContent: show(c.to) }),
            ] : isDrop ? [
              el("span", { className: "oneshot-was", textContent: show(c.from) }),
            ] : [
              el("span", { className: "oneshot-was", textContent: show(c.from) }),
              el("span", { className: "oneshot-arrow", textContent: "\u2192" }),
              el("span", { className: "oneshot-now", textContent: show(c.to) }),
            ]),
          ]);
        });
        blocks.push(el("div", { className: "oneshot-job" }, [
          el("div", { className: "oneshot-jobname", textContent: o.job.name }),
          el("div", { className: "oneshot-diff" }, lines),
        ]));
        continue;
      }

      if (o.status === "ambiguous") {
        const cands = (o.candidates || []).map((m) => {
          const b = el("button", { textContent: m.name + (m.status ? `  -  ${m.status}` : "") });
          b.onclick = () => again(o.asked, m.ref);
          return b;
        });
        blocks.push(el("div", { className: "oneshot-job" }, [
          el("div", { className: "oneshot-jobname oneshot-warn", textContent: `"${o.asked}" matches ${cands.length} jobs` }),
          note("Nothing will change until you pick one."),
          el("div", { className: "oneshot-cands" }, cands),
        ]));
        continue;
      }

      if (o.status === "not-found") {
        const ref = el("input", { type: "text", placeholder: "The right job number" });
        const look = el("button", { textContent: "Find it" });
        look.onclick = () => { const v = ref.value.trim(); if (v) again(o.asked, v); };
        ref.onkeydown = (e) => { if (e.key === "Enter") look.click(); };
        blocks.push(el("div", { className: "oneshot-job" }, [
          el("div", { className: "oneshot-jobname oneshot-warn", textContent: `${o.asked} - not found` }),
          el("div", { className: "oneshot-refrow" }, [ref, look]),
        ]));
        continue;
      }

      // no-change
      blocks.push(el("div", { className: "oneshot-job" }, [
        el("div", { className: "oneshot-jobname", textContent: o.job ? o.job.name : o.asked }),
        note("Nothing to change - it already matches the thread."),
      ]));
    }

    const go = el("button", { className: "primary",
      textContent: planned > 1 ? `Apply to ${planned} jobs` : "Apply changes" });
    const x = el("button", { className: "ghost", textContent: "Cancel" });
    const msgEl = el("div", { className: "oneshot-meta" });
    x.onclick = close;
    if (!planned) go.disabled = true;

    go.onclick = async () => {
      const byJob = new Map();
      for (const b of boxes) {
        if (!b.box.checked) continue;
        if (!byJob.has(b.job_id)) byJob.set(b.job_id, []);
        byJob.get(b.job_id).push(b.change);
      }
      const jobs = [...byJob.entries()].map(([job_id, changes]) => ({ job_id, changes }));
      if (!jobs.length) { msgEl.textContent = "Tick at least one change."; return; }

      go.disabled = true; go.textContent = "Applying...";
      const out = await api("suggest-job", {
        action: "apply-amendment", thread: amend.thread, jobs,
        // Including the ones just unticked: a rejected line says more about
        // where the parser is weak than an accepted one does.
        proposed_changes: outcomes.flatMap((o) => o.changes || []),
      });
      if (out.error) {
        msgEl.textContent = out.error;
        go.disabled = false; go.textContent = "Apply changes";
        return;
      }
      // Say what happened to every job, not only the ones that worked.
      const lines = (out.outcomes || []).map((o) => {
        const name = o.job ? o.job.ref : o.asked;
        if (o.status === "applied") {
          const bad = (o.failed || []).length ? `  (not changed: ${o.failed.map((f) => f.label).join(", ")})` : "";
          return `${name}: ${o.summary || "updated"}${bad}`;
        }
        return `${name}: nothing changed`;
      });
      const okCount = (out.outcomes || []).filter((o) => o.status === "applied").length;
      amend = { done: {
        title: okCount > 1 ? `${okCount} jobs updated` : `${okCount} job updated`,
        lines,
      } };
      render();
    };

    const asked = outcomes.length;
    return wrap([
      head(asked > 1 ? `Change ${asked} jobs` : `Change ${outcomes[0].job ? outcomes[0].job.name : outcomes[0].asked}`),
      note("Untick anything that is wrong. Nothing is written until you apply."),
      ...blocks,
      questions.length
        ? el("div", { className: "oneshot-meta oneshot-warn" }, [
            el("div", { textContent: "I could not place these - handle them in the app:" }),
            ...questions.map((q) => el("div", { textContent: "  - " + q })),
          ])
        : el("span"),
      el("div", { className: "oneshot-acts", style: "margin-top:10px" }, [go, x]),
      msgEl,
    ]);
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

    // Keyed the same way the decision is. These two disagreed: scan() kept the
    // row on the list by conversation id while this looked the confirmation up
    // by row id, so a thread that had just produced a job rendered as a fresh
    // suggestion with a Make job button on it - an invitation to create the
    // same job twice.
    if (justDone.has(keyOf(m))) {
      const done = justDone.get(keyOf(m));
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

    // A proposal already asked for on this thread. Held in `proposals` rather
    // than written into the button, because the panel is rebuilt from scratch
    // whenever the inbox republishes - a mail arriving, a mail being read, the
    // list simply redrawing - and a state that lives only in the DOM is gone
    // the moment that happens. It looked exactly like the strip ignoring the
    // click: press Make job, watch it come back as Make job, nothing created.
    const prop = proposals.get(keyOf(m));
    if (prop) meta.textContent = proposalText(prop.out, prop.thread.body);

    // A row picks the THREAD. The taskbar picks what to do with it.
    //
    // This used to be the whole job in two clicks: press once to parse, press
    // again and the parser's output went straight onto the board. No fields to
    // correct, no charges to look at, no price to change - a second way in
    // that skipped the review the card exists to provide. It also had no way
    // to reach a quote or an invoice, because those are decided on the
    // taskbar and the row never went near it.
    //
    // So it hands off instead. Both routes now end at the same card, and the
    // question "what am I making" is asked in exactly one place.
    const make = el("button", { className: "primary",
      textContent: prop ? (prop.out.isJob ? "Review" : "Nothing to create") : "Review" });
    if (prop && !prop.out.isJob) make.disabled = true;
    const not  = el("button", { className: "ghost", textContent: "Not this one" });
    const later= el("button", { className: "ghost", textContent: "Later" });

    make.onclick = async () => {
      // Already parsed once: open it rather than paying for the same answer
      // twice. The proposal cache exists because this panel is rebuilt from
      // scratch every time the inbox republishes.
      if (prop) {
        manual = { msg: m, thread: prop.thread, out: prop.out,
                   failed: null, state: "proposed" };
        openPanel = true;
        render();
        return;
      }
      make.disabled = true; make.textContent = "Reading...";
      const thread = threadOf(m);
      const out = await api("suggest-job", { action: "suggest", thread });
      if (out.error) { meta.textContent = out.error; make.disabled = false; make.textContent = "Review"; return; }
      proposals.set(keyOf(m), { thread, out });
      // Straight onto the card. The click said "this one"; making them press
      // a second button to see it would be asking the same question twice.
      manual = { msg: m, thread, out, failed: null, state: "proposed" };
      openPanel = true;
      render();
    };
    not.onclick   = () => {
      proposals.delete(keyOf(m));
      decisions[keyOf(m)] = "no"; store.save({ decisions }); scan();
    };
    // "Later" now means something.
    //
    // It used to hide the row until the next load and then show it again,
    // which is forgetting with extra steps - and it is the exact complaint
    // that started all of this: the same threads, over and over, every reload.
    // What a person means by Later is "come back to this on Thursday", so it
    // asks, and if they say yes it becomes a reminder with no job behind it.
    //
    // Saying no still does the old thing, because sometimes later really does
    // just mean not in the next ten minutes.
    later.onclick = () => {
      proposals.delete(keyOf(m));
      laterAsk.set(keyOf(m), { stage: "ask" });
      render();
    };

    const main = el("div", { className: "oneshot-main oneshot-goto", title: "Show me this one in the list" }, [subj, meta]);
    main.onclick = () => {
      const held = meta.textContent;
      meta.textContent = "Finding it...";
      const h = (e) => {
        if (!e.data || e.data.__oneshot !== "revealed" || e.data.id !== m.id) return;
        window.removeEventListener("message", h);
        if (e.data.ok) {
          // They asked to look at it, so get out of the way and let them.
          // The bar keeps hold of which one it is, and offers the next step,
          // so reading the mail no longer costs a close-and-reopen.
          showing = { id: m.id, subject: m.subject || "(no subject)" };
          onlyId = null;
          openPanel = false;
          render();
        } else {
          meta.textContent = "Could not find it in the list - it may have scrolled out of the folder.";
        }
      };
      window.addEventListener("message", h);
      window.postMessage({ __oneshot: "reveal", id: m.id, bottomInset: stripInset() }, "*");
      setTimeout(() => { window.removeEventListener("message", h); if (meta.textContent === "Finding it...") meta.textContent = held; }, 6000);
    };
    const ask = laterAsk.get(keyOf(m));
    const acts = el("div", { className: "oneshot-acts" }, [later, not, make]);
    // With the Later question open the row becomes a column: the question goes
    // UNDER the subject and buttons rather than inside the clickable area, or
    // tapping a date field would also ask Outlook to scroll to the mail.
    if (!ask) return el("div", { className: "oneshot-row" }, [main, acts]);
    return el("div", { className: "oneshot-row oneshot-rowcol" }, [
      el("div", { className: "oneshot-rowtop" }, [main, acts]),
      laterStep(m, ask),
    ]);
  }

  // -------------------------------------------------------------------------
  // Later -> "come back to this?" -> when -> set
  // -------------------------------------------------------------------------
  // Two steps rather than one, because the question and the answer are
  // different decisions: most of the time somebody just wants the row gone,
  // and putting a date picker in front of them for that is a tax. The ones who
  // do want reminding get the full date and time on the second step.
  //
  // Every bit of state is in `laterAsk`, never in the DOM. The panel is
  // rebuilt whenever the inbox republishes, and a half-filled answer living in
  // input values would be wiped by a mail arriving.
  function laterStep(m, ask) {
    const key = keyOf(m);
    const close = () => { laterAsk.delete(key); };

    if (ask.stage === "ask") {
      const yes = el("button", { className: "primary", textContent: "Yes, remind me" });
      const no = el("button", { className: "ghost", textContent: "No, just hide it" });
      yes.onclick = () => {
        // Tomorrow morning, because that is what Later means most of the time.
        const d = inDays(1, 8);
        laterAsk.set(key, { stage: "when", date: dateVal(d), time: timeVal(d), note: "" });
        render();
      };
      no.onclick = () => { close(); laterThisLoad.add(key); scan(); };
      return el("div", { className: "oneshot-later" }, [
        el("div", { className: "oneshot-later-q",
          textContent: "Set a reminder to come back and make a job from this?" }),
        el("div", { className: "oneshot-acts" }, [no, yes]),
      ]);
    }

    const date = el("input", { type: "date", value: ask.date || "" });
    const time = el("input", { type: "time", value: ask.time || "" });
    const note = el("input", { type: "text", value: ask.note || "",
      placeholder: "What for (optional)" });
    const says = el("div", { className: "oneshot-rem-says" });
    const set = el("button", { className: "primary",
      textContent: ask.busy ? "Setting..." : "Set reminder" });
    const cancel = el("button", { className: "ghost", textContent: "Cancel" });
    cancel.onclick = () => { close(); render(); };

    // The sentence and the button are recomputed IN PLACE as the fields
    // change, not on the next render. Re-rendering would take the caret out of
    // the field being typed in; not recomputing at all left the readback
    // showing the time that was there before - so "You will be reminded
    // tomorrow at 08:00" sat under a date of 2020, and Set stayed live. The
    // readback is the only thing standing between a person and a reminder
    // quietly set for the wrong day, so it has to follow the fields.
    const sayIt = () => {
      const cur = laterAsk.get(key) || {};
      const iso = whenISO(cur.date, cur.time);
      if (cur.error) {
        says.className = "oneshot-rem-says oneshot-warn";
        says.textContent = cur.error;
      } else if (iso) {
        says.className = "oneshot-rem-says on";
        says.textContent = `You will be reminded ${spellWhen(iso)}.`;
      } else {
        says.className = "oneshot-rem-says oneshot-warn";
        says.textContent = "Pick a day and a time that has not already gone.";
      }
      set.disabled = !iso || !!cur.busy;
    };

    // Typing is kept in state as it happens, so a redraw does not lose it.
    const keep = () => {
      laterAsk.set(key, {
        ...laterAsk.get(key), date: date.value, time: time.value, note: note.value,
      });
      sayIt();
    };
    date.oninput = keep; time.oninput = keep; note.oninput = keep;
    date.onchange = keep; time.onchange = keep;
    sayIt();

    set.onclick = async () => {
      const at = whenISO(laterAsk.get(key)?.date, laterAsk.get(key)?.time);
      if (!at) return;
      laterAsk.set(key, { ...laterAsk.get(key), busy: true, error: null });
      render();
      const out = await api("suggest-job", {
        action: "park",
        external_id: key || null,
        due_at: at,
        note: (laterAsk.get(key)?.note || "").trim() || null,
        thread: { subject: m.subject, from: m.from, body: m.body, received_at: m.received },
      });
      if (out.error) {
        laterAsk.set(key, { ...laterAsk.get(key), busy: false, error: out.error });
        render();
        return;
      }
      // Remembered locally as well as on the server, so the row goes away now
      // rather than on whatever scan next happens to ask.
      parkedThreads[key] = { due_at: at, note: null };
      close();
      scan();
    };

    return el("div", { className: "oneshot-later" }, [
      el("div", { className: "oneshot-later-q", textContent: "When should it come back?" }),
      el("div", { className: "oneshot-rem-when" }, [date, time]),
      el("div", { className: "oneshot-rem-when" }, [note]),
      says,
      el("div", { className: "oneshot-acts", style: "margin-top:8px" }, [cancel, set]),
    ]);
  }

  // What a proposal says, so the row can be rebuilt from it rather than
  // remembering it in the button's own text.
  function proposalText(out, body) {
    if (!out.isJob) return notJobText(out, body);
    const missing = out.missing || [];
    return (out.summary || `${out.jobCount} job${out.jobCount > 1 ? "s" : ""} found`)
      + (missing.length ? `  -  still needs: ${missing.join(", ")}` : "");
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  function ingest(list) {
    if (!Array.isArray(list) || !list.length) return;
    // Keyed on the conversation, not on the row.
    //
    // This used to dedupe by m.id, and Outlook regenerates every row id on
    // every draw - so the merge merged nothing. Each redraw, and the list
    // redraws whenever mail arrives or is read, added another copy of every
    // thread: the same mail appeared two, three, four times in the strip and
    // "N of the last 30" climbed with it. Half of "it keeps showing me the
    // same threads" was this, not the forgotten decisions.
    //
    // The newer entry wins, because it carries the row id that is actually on
    // screen now - clicking a row and reading the open mail both need that. A
    // body already fetched is never given up for one that has not been.
    const byKey = new Map(messages.map(m => [keyOf(m), m]));
    for (const m of list) {
      const k = keyOf(m);
      if (!k) continue;
      const prev = byKey.get(k);
      if (!prev) { byKey.set(k, m); continue; }
      byKey.set(k, prev.hasFullBody && !m.hasFullBody
        ? { ...m, body: prev.body, hasFullBody: true }
        : m);
    }
    messages = [...byKey.values()]
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
    heartbeat = setInterval(() => {
        if (invalidated()) return died();
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
