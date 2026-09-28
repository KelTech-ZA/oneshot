// OneShot mail assistant — the Outlook wiring.
//
// Everything that decides anything lives in core.js, which knows nothing about
// Office. This file's whole job is: notice which message is open, read it, and
// put the result on screen.
//
// The one rule the code is built around: NOTHING is created without a click.
// `suggest` parses and returns; only the Create button calls `create`. There is
// no code path from opening a message to a row in the database.

import { gate, makeStore, makeDwell } from "./core.js";
import { startScan, connectScan } from "./scan.js";

// Same origin as the app, so the anon key here is the one already public in
// the web bundle. The user's own session does the authorising.
const SUPABASE_URL = "https://ntcvwosypcnwedxefwcr.supabase.co";
const SUPABASE_ANON = window.__ONESHOT_ANON__ || "";   // set in config.js
const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;
const APP_URL = "https://1oneshot.netlify.app";

const $ = (id) => document.getElementById(id);
const show = (id, on = true) => $(id).classList.toggle("hide", !on);

// ---------------------------------------------------------------------------
// Persistence. Office roaming settings follow the user between their desktop
// and the web, which is right for "I already said no to that thread".
// ---------------------------------------------------------------------------
const roaming = {
  get(k) { const v = Office.context.roamingSettings.get(k); return v ? JSON.parse(v) : null; },
  set(k, v) { Office.context.roamingSettings.set(k, JSON.stringify(v));
              Office.context.roamingSettings.saveAsync(); },
};
let store;

// Session token, kept in roaming settings so signing in once is enough.
const session = {
  get() { return roaming.get("oneshot_session"); },
  set(s) { roaming.set("oneshot_session", s); },
  clear() { roaming.set("oneshot_session", null); },
};

// ---------------------------------------------------------------------------
// State for the message currently on screen.
// ---------------------------------------------------------------------------
let current = null;          // { id, subject, from, body, stamp }
let proposal = null;         // extraction returned by suggest
let clientDomains = [];

const api = async (path, body) => {
  const s = session.get();
  const res = await fetch(`${FUNCTIONS_URL}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${s?.access_token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ error: "Unreadable reply" }));
  if (res.status === 401) { session.clear(); renderSignedOut("Your session expired."); }
  return json;
};

// ---------------------------------------------------------------------------
// Reading the open message.
// ---------------------------------------------------------------------------
function readItem() {
  return new Promise((resolve) => {
    const item = Office.context.mailbox.item;
    if (!item) return resolve(null);
    const base = {
      id: item.itemId || item.conversationId || String(item.dateTimeCreated),
      subject: item.subject || "",
      from: item.from?.emailAddress || item.sender?.emailAddress || "",
      // The stamp is what makes "later" mean "when something new arrives".
      stamp: String(item.dateTimeCreated || ""),
    };
    item.body.getAsync(Office.CoercionType.Text, (r) => {
      resolve({ ...base, body: r.status === Office.AsyncResultStatus.Succeeded ? (r.value || "") : "" });
    });
  });
}

// ---------------------------------------------------------------------------
// The dwell timer. 3.5 seconds, or the first scroll — whichever the reader
// gets to first. Below that they are still triaging; past it they have
// committed, and a prompt is a contribution rather than an interruption.
// ---------------------------------------------------------------------------
const dwell = makeDwell(() => considerPrompt(), 3500);

// A pinned pane is a separate frame from the message, so we cannot see the
// reading pane's scrollbar. The pane's own scroll is a decent proxy for
// engagement, and any click in it means the same thing.
document.addEventListener("scroll", () => dwell.scrolled(), true);
document.addEventListener("click", () => dwell.scrolled(), true);

async function onItemChanged() {
  dwell.cancel();
  proposal = null;
  show("prompt", false); show("review", false); show("done", false);
  show("idle", true);
  current = await readItem();
  if (!current) { $("idleText").textContent = "No message open."; return; }

  $("idleText").textContent = "Nothing to suggest on this one.";

  const verdict = store.shouldAsk(current.id, current.stamp);
  if (!verdict.ask) {
    $("idleText").textContent = verdict.reason === "already a job"
      ? "You already made a job from this." : `Quiet here — ${verdict.reason}.`;
    return;
  }
  // Local gate first: free, instant, and keeps the parser off most mail.
  const g = gate(current, { clientDomains, ownDomains: ownDomains(), sensitivity: store.sensitivity() });
  if (!g.pass) return;
  dwell.start();
}

// ---------------------------------------------------------------------------
// The prompt. Still creates nothing — it only asks whether to look properly.
// ---------------------------------------------------------------------------
async function considerPrompt() {
  if (!current) return;
  const g = gate(current, { clientDomains, ownDomains: ownDomains(), sensitivity: store.sensitivity() });
  $("promptWhy").textContent = g.why.join(" · ");
  show("idle", false);
  show("prompt", true);
}

async function runSuggest() {
  show("prompt", false);
  show("idle", true);
  $("idleText").textContent = "Reading the thread…";
  const out = await api("suggest-job", { action: "suggest", thread: current });
  if (out.error) { $("idleText").textContent = out.error; return; }
  if (!out.isJob) {
    $("idleText").textContent = "Had a proper look — there's no job in this one.";
    store.record(current.id, "no", current.stamp);
    return;
  }
  proposal = out;
  renderReview(out);
}

// ---------------------------------------------------------------------------
// Review. Asks only about fields the parser itself flagged as absent — it
// already knows what it could not work out, so there is no need to invent a
// questionnaire or waste the reader's time on what it got right.
// ---------------------------------------------------------------------------
const LABELS = {
  scheduled_date: "What date?", time_window: "What time?",
  origin: "Collect from where?", destination: "Deliver where?",
  stops: "Which address?", items: "What is being moved or made?",
  type: "What kind of job?", client_ref: "Their reference?",
};

function renderReview(out) {
  show("idle", false); show("prompt", false); show("done", false);
  show("review", true);
  $("reviewSummary").textContent = out.summary || "Proposed job";
  $("reviewMsg").textContent = "";

  const q = $("questions");
  q.innerHTML = "";
  const asked = (out.missing || []).filter((m) => LABELS[m]);
  if (!asked.length) {
    const p = document.createElement("div");
    p.className = "muted tiny";
    p.style.marginTop = "6px";
    p.textContent = "Nothing missing — check it over and create it.";
    q.appendChild(p);
  }
  for (const field of asked) {
    const lab = document.createElement("label");
    lab.textContent = LABELS[field];
    lab.htmlFor = `q_${field}`;
    const inp = document.createElement("input");
    inp.id = `q_${field}`;
    inp.dataset.field = field;
    if (field === "scheduled_date") inp.type = "date";
    q.append(lab, inp);
  }

  const jobs = out.extraction?.jobs ?? [];
  $("proposal").textContent = jobs.map((j, i) =>
    `${i + 1}. ${[j.type, j.client_ref, j.scheduled_date, j.time_window].filter(Boolean).join(" · ")}`
    + ` — ${(j.items || []).length} item(s)`).join("\n") || "—";
}

// The answers are applied to EVERY job that was missing that field, then sent
// back. The server re-checks and drops any missing flag that is now satisfied,
// so a job never carries a warning about something it has.
function applyAnswers(ex) {
  const answers = [...document.querySelectorAll("#questions input")]
    .map((i) => [i.dataset.field, i.value.trim()]).filter(([, v]) => v);
  if (!answers.length) return ex;
  const jobs = (ex.jobs || []).map((j) => {
    const copy = { ...j };
    for (const [field, value] of answers) {
      const wasMissing = Array.isArray(j.missing) ? j.missing.includes(field) : true;
      const empty = copy[field] === null || copy[field] === undefined || copy[field] === "";
      if (wasMissing || empty) copy[field] = value;
    }
    return copy;
  });
  return { ...ex, jobs };
}

async function doCreate() {
  $("create").disabled = true;
  $("reviewMsg").textContent = "";
  const out = await api("suggest-job", {
    action: "create", thread: current, extraction: applyAnswers(proposal.extraction),
  });
  $("create").disabled = false;
  if (out.error) { $("reviewMsg").textContent = out.error; return; }
  store.record(current.id, "created", current.stamp);
  show("review", false); show("done", true);
  $("doneText").textContent = out.refs?.length
    ? `${out.refs.join(", ")} created.` : (out.reply || "Created.");
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function ownDomains() {
  const me = Office.context.mailbox.userProfile?.emailAddress || "";
  const d = me.toLowerCase().split("@")[1];
  return d ? [d] : [];
}

function renderSignedOut(msg = "") {
  show("signin", true); show("main", false);
  $("signinMsg").textContent = msg;
}

async function signIn() {
  $("doSignin").disabled = true;
  $("signinMsg").textContent = "";
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: SUPABASE_ANON },
      body: JSON.stringify({ email: $("email").value.trim(), password: $("password").value }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error_description || j.msg || "Could not sign in");
    session.set(j);
    await start();
  } catch (e) {
    $("signinMsg").textContent = e.message;
  } finally {
    $("doSignin").disabled = false;
  }
}

async function loadClients() {
  try {
    const s = session.get();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/clients?select=email,name`, {
      headers: { apikey: SUPABASE_ANON, authorization: `Bearer ${s.access_token}` },
    });
    const rows = await res.json();
    clientDomains = [...new Set((Array.isArray(rows) ? rows : [])
      .map((r) => String(r.email || "").toLowerCase().split("@")[1]).filter(Boolean))];
  } catch { clientDomains = []; }
  // The scan runs in its own module and scores subjects with the same gate,
  // so it needs the same client list. Without this it scored every inbox
  // subject as if it were from a stranger - losing the strongest signal there
  // is, and the one that makes "Thursday" from a client mean something.
  window.__ONESHOT_CLIENT_DOMAINS__ = clientDomains;
  window.__ONESHOT_OWN_DOMAINS__ = ownDomains();
}

async function start() {
  if (!session.get()?.access_token) return renderSignedOut();
  show("signin", false); show("main", true);
  $("who").textContent = Office.context.mailbox.userProfile?.emailAddress || "signed in";
  $("sens").value = String(store.sensitivity());
  await loadClients();
  await onItemChanged();
  startScan({ store, api, onOpen: (id) => $("scanMsg").textContent = `Open “${id}” in your inbox.` });
}

Office.onReady(({ host }) => {
  if (host !== Office.HostType.Outlook) return;
  store = makeStore(roaming);

  // The event that makes the whole thing ambient: the pinned pane stays put
  // and tells us each time the reader moves to another message.
  Office.context.mailbox.addHandlerAsync(Office.EventType.ItemChanged, onItemChanged);

  $("doSignin").onclick = signIn;
  $("signout").onclick = () => { session.clear(); renderSignedOut("Signed out."); };
  $("manual").onclick = runSuggest;               // the deliberate route
  $("yes").onclick = runSuggest;
  $("no").onclick = () => { store.record(current.id, "no", current.stamp);
                            show("prompt", false); show("idle", true);
                            $("idleText").textContent = "Noted — won't ask again."; };
  $("later").onclick = () => { store.record(current.id, "later", current.stamp);
                               show("prompt", false); show("idle", true);
                               $("idleText").textContent = "I'll bring it up when there's a reply."; };
  $("quiet").onclick = () => { store.quiet(3);
                               show("prompt", false); show("idle", true);
                               $("idleText").textContent = "Quiet for three hours."; };
  $("cancel").onclick = () => { show("review", false); show("idle", true); };
  $("create").onclick = doCreate;
  $("openBoard").onclick = () => Office.context.ui.openBrowserWindow(`${APP_URL}/dashboard`);
  $("sens").onchange = (e) => store.setSensitivity(Number(e.target.value));
  $("enableScan").onclick = () => connectScan({ msgEl: $("scanMsg") });
  $("rescan").onclick = () => startScan({ store, api, force: true });

  start();
});
