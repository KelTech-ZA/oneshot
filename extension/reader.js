// OneShot - the reader. Runs in the PAGE's world so it can see Outlook's own
// network traffic.
//
// Why not scrape the DOM: OWA's markup is generated, obfuscated, virtualised
// (only ~15 rows exist at a time) and split across frames. Selectors written
// against it break on Microsoft's schedule, not ours. The JSON Outlook itself
// fetches is far more stable, and it is already on this page, fetched by the
// signed-in user. We read what the page read. Nothing extra is requested,
// no token is touched, and no mailbox permission is involved.
//
// This is deliberately shape-agnostic: rather than target FindConversation or
// GetConversationItems by name, it walks any JSON response and picks out
// anything that looks like a mail item. Microsoft can rename endpoints and
// reshape payloads without breaking it.

(function () {
  "use strict";
  if (window.__oneshotReader) return;
  window.__oneshotReader = true;

  const MAX = 120;                     // ring buffer; the strip uses the newest 30
  const seen = new Map();

  const str = (v) => (typeof v === "string" ? v : "");

  // Pull an email address out of the several shapes Outlook uses for a sender.
  function addressOf(o) {
    if (!o || typeof o !== "object") return "";
    const cands = [
      o.EmailAddress?.Address, o.emailAddress?.address,
      o.Mailbox?.EmailAddress, o.mailbox?.emailAddress,
      o.Address, o.address, o.SmtpAddress, o.smtpAddress,
    ];
    for (const c of cands) if (str(c).includes("@")) return str(c).toLowerCase();
    return "";
  }

  function nameOf(o) {
    if (!o || typeof o !== "object") return "";
    return str(o.EmailAddress?.Name || o.emailAddress?.name || o.Mailbox?.Name
            || o.mailbox?.name || o.Name || o.name);
  }

  // Does this object look like a mail item? A subject plus either a sender or
  // a received time is enough, and cheap to check.
  function asMessage(o) {
    if (!o || typeof o !== "object") return null;
    const subject = str(o.Subject ?? o.subject ?? o.ConversationTopic ?? o.conversationTopic);
    if (!subject) return null;

    const senderObj = o.From ?? o.from ?? o.Sender ?? o.sender;
    const fromAddr = addressOf(senderObj);
    const received = str(o.DateTimeReceived ?? o.receivedDateTime ?? o.LastDeliveryTime
                      ?? o.lastDeliveryTime ?? o.DateTimeCreated ?? o.createdDateTime);
    if (!fromAddr && !received) return null;

    // Body when Outlook happens to have fetched it (i.e. the user opened the
    // message). Otherwise the preview line, which is all the list view holds.
    const bodyRaw = o.UniqueBody?.Value ?? o.uniqueBody?.content
                 ?? o.NormalizedBody?.Value ?? o.normalizedBody?.content
                 ?? o.Body?.Value ?? o.body?.content ?? "";
    const preview = str(o.Preview ?? o.preview ?? o.BodyPreview ?? o.bodyPreview);
    const body = str(bodyRaw).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

    const id = str(o.ItemId?.Id ?? o.itemId?.id ?? o.Id ?? o.id
                ?? o.ConversationId?.Id ?? o.conversationId?.id) || (subject + "|" + received);

    return {
      id, subject,
      from: fromAddr, fromName: nameOf(senderObj),
      received: received || new Date().toISOString(),
      isRead: o.IsRead ?? o.isRead ?? null,
      body: body || preview,
      hasFullBody: Boolean(body && body.length > (preview.length + 40)),
      webLink: str(o.WebLink ?? o.webLink),
    };
  }

  function harvest(node, depth) {
    if (depth > 8 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const v of node) harvest(v, depth + 1); return; }
    const m = asMessage(node);
    if (m) {
      // A later capture may carry the full body; prefer the richer record.
      const prev = seen.get(m.id);
      if (!prev || (m.hasFullBody && !prev.hasFullBody)) seen.set(m.id, m);
      if (seen.size > MAX) seen.delete(seen.keys().next().value);
    }
    for (const k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      const v = node[k];
      if (v && typeof v === "object") harvest(v, depth + 1);
    }
  }

  let pending = null;
  function publish() {
    clearTimeout(pending);
    pending = setTimeout(() => {
      const list = [...seen.values()]
        .sort((a, b) => String(b.received).localeCompare(String(a.received)));
      window.postMessage({ __oneshot: "messages", list, href: location.href }, "*");
    }, 400);                            // coalesce bursts of responses
  }

  function consider(text) {
    if (!text || text.length > 4_000_000) return;
    const t = text.trimStart();
    if (t[0] !== "{" && t[0] !== "[") return;
    let data;
    try { data = JSON.parse(text); } catch { return; }
    const before = seen.size;
    harvest(data, 0);
    // also republish when an existing record gained a body
    publish(before);
  }

  // --- fetch -----------------------------------------------------------------
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("json")) res.clone().text().then(consider).catch(() => {});
    } catch { /* never let instrumentation break the page */ }
    return res;
  };

  // --- XMLHttpRequest --------------------------------------------------------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    this.__oneshotUrl = String(u || "");
    return origOpen.call(this, m, u, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      try {
        const t = this.responseType;
        if (t === "" || t === "text") consider(this.responseText);
        else if (t === "json" && this.response) { harvest(this.response, 0); publish(); }
      } catch { /* ignore */ }
    });
    return origSend.apply(this, args);
  };

  // The content script asks for whatever we have whenever it wants to rescan.
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.__oneshot === "please-publish") publish();
  });
})();
