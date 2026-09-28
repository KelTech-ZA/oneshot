// The inbox scan — the only part that looks beyond the message on screen.
//
// Reading as you go is nearly worthless for spotting oversights: by the time a
// thread has been read, the decision has already been made. The value is in
// the mail you HAVEN'T opened. So this glances at recent subjects and senders
// and marks the ones worth a look. It never opens anything, never creates
// anything, and never reads a message body.
//
// That last point is enforced by the token, not by this code.
// Mail.ReadBasic returns subject, sender, received time and a web link, and
// EXCLUDES body and attachments. There is no code path here by which the
// add-in could read the contents of an email you have not opened - Microsoft
// will not issue the data. Declining consent leaves the rest of the add-in
// working exactly as before.
//
// Not configured until an Entra app registration exists. Until then the
// feature is simply absent and everything else runs, which is what lets the
// first demo happen without waiting on an app registration.

import { gate } from "./core.js";

const CLIENT_ID = window.__ONESHOT_ENTRA_CLIENT_ID__ || "";   // set in config.js
const SCOPES = ["Mail.ReadBasic"];
const HOW_MANY = 30;                 // the last 20-30, as specified
const CACHE_MS = 10 * 60 * 1000;     // don't re-scan on every message opened

let token = null, lastScan = 0, lastRows = [];

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// ---------------------------------------------------------------------------
// Consent. Nested app authentication: legacy Exchange tokens and
// getCallbackTokenAsync were turned off across all Microsoft 365 tenants, so
// MSAL + NAA is the supported route for an add-in to reach Graph.
// ---------------------------------------------------------------------------
async function getToken({ interactive = false } = {}) {
  if (!CLIENT_ID) throw new Error("not-configured");
  if (token && token.expiresOn > Date.now() + 60_000) return token.value;

  const msal = await import("https://cdn.jsdelivr.net/npm/@azure/msal-browser@3/+esm");
  const app = await msal.createNestablePublicClientApplication({
    auth: { clientId: CLIENT_ID, authority: "https://login.microsoftonline.com/common" },
  });
  let result;
  try {
    result = await app.acquireTokenSilent({ scopes: SCOPES });
  } catch {
    if (!interactive) throw new Error("consent-needed");
    result = await app.acquireTokenPopup({ scopes: SCOPES });
  }
  token = { value: result.accessToken, expiresOn: new Date(result.expiresOn).getTime() };
  return token.value;
}

// The user asked for this explicitly, from Settings, so a popup is expected.
export async function connectScan({ msgEl }) {
  if (!CLIENT_ID) {
    msgEl.textContent = "Inbox scanning isn't set up on this deployment yet.";
    return false;
  }
  try {
    await getToken({ interactive: true });
    msgEl.textContent = "Inbox scanning on — subjects and senders only.";
    await startScan({ force: true });
    return true;
  } catch (e) {
    msgEl.textContent = e.message === "not-configured"
      ? "Inbox scanning isn't set up on this deployment yet."
      : "Not connected. Everything else still works.";
    return false;
  }
}

// ---------------------------------------------------------------------------
// The scan itself.
// ---------------------------------------------------------------------------
export async function startScan({ store, api, force = false } = {}) {
  const box = document.getElementById("scan");
  const list = document.getElementById("scanList");
  if (!box || !list) return;

  if (!CLIENT_ID) { box.classList.add("hide"); return; }
  if (!force && Date.now() - lastScan < CACHE_MS && lastRows.length) {
    return paint(lastRows, list, box, store);
  }

  let t;
  try { t = await getToken(); }
  catch { box.classList.add("hide"); return; }      // never consented; stay silent

  try {
    // $select is the belt to Mail.ReadBasic's braces: we ask only for the
    // fields we use, so even the response carries nothing else.
    const url = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages"
      + `?$top=${HOW_MANY}&$orderby=receivedDateTime desc`
      + "&$select=id,subject,from,receivedDateTime,webLink,isRead";
    const res = await fetch(url, { headers: { authorization: `Bearer ${t}` } });
    if (!res.ok) throw new Error(`Graph ${res.status}`);
    const { value = [] } = await res.json();
    lastScan = Date.now();
    lastRows = value;
    paint(value, list, box, store);
  } catch {
    box.classList.add("hide");
  }
}

function paint(rows, list, box, store) {
  const clientDomains = window.__ONESHOT_CLIENT_DOMAINS__ || [];
  const own = window.__ONESHOT_OWN_DOMAINS__ || [];
  const sensitivity = store?.sensitivity?.() ?? 0;

  const hits = rows.map((m) => {
    const thread = {
      subject: m.subject || "",
      from: m.from?.emailAddress?.address || "",
      body: "",                                   // there is none, by design
    };
    // Subject-only scoring. The gate weights the subject heavily precisely
    // because this is the case it has to work for.
    const g = gate(thread, { clientDomains, ownDomains: own, sensitivity });
    return { m, g };
  }).filter(({ m, g }) => {
    if (!g.pass) return false;
    const seen = store?.shouldAsk?.(m.id, m.receivedDateTime);
    return seen ? seen.ask : true;                // never re-flag a settled thread
  }).slice(0, 6);

  list.innerHTML = "";
  if (!hits.length) {
    list.appendChild(el("div", "muted tiny", "Nothing in the last 30 looks unhandled."));
    box.classList.remove("hide");
    return;
  }

  for (const { m, g } of hits) {
    const row = el("div", "jobline");
    const a = el("a", "", m.subject || "(no subject)");
    a.href = m.webLink;
    a.target = "_blank";
    a.style.cssText = "color:var(--accent);text-decoration:none;font-weight:600;font-size:13px";
    const who = el("div", "muted tiny",
      `${m.from?.emailAddress?.name || m.from?.emailAddress?.address || ""} · ${g.why[0] || ""}`);
    const dismiss = el("button", "tiny", "not this one");
    dismiss.style.cssText = "border:none;background:none;color:var(--ink-soft);padding:2px 0";
    dismiss.onclick = () => { store?.record?.(m.id, "no", m.receivedDateTime); row.remove(); };
    row.append(a, who, dismiss);
    list.appendChild(row);
  }
  box.classList.remove("hide");
}
