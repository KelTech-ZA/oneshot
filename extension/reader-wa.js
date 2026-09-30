// OneShot - the reader for WhatsApp Web.
//
// Reads ONLY the conversation currently open on screen, and only when asked.
// It never touches the chat list, never opens a chat, never marks anything
// read, never sends. The user presses a button; that is the only thing that
// moves. That restraint is deliberate: automating WhatsApp is what gets
// numbers banned, and the signals Meta acts on - message velocity, bulk
// sending, protocol spoofing - are all things this does not do.
//
// The find that makes it work: every message carries
//
//   data-pre-plain-text="[1:23 pm, 3/10/2026] Andre Theron: "
//
// WhatsApp maintains it so copy-and-paste keeps its attribution, which makes
// it far more durable than a generated class name. Sender and timestamp come
// from there; the text comes from the node it sits on. Direction classes
// (.message-in / .message-out) have been obfuscated away, and are not needed -
// the sender's name is in the attribute.

(function () {
  "use strict";
  if (window.__oneshotWa) return;
  window.__oneshotWa = true;

  const MAX_MESSAGES = 30;
  const GAP_HOURS = 24;          // a silence this long ends the conversation

  const PRE = /^\[(\d{1,2}:\d{2})\s*([ap]\.?m\.?)?,\s*([\d/.-]+)\]\s*(.*?):\s*$/i;

  const paneOf = () => document.querySelector("#main");

  // Who this chat is with. NOT [title] - the only titled element in the header
  // is the "Profile details" button, and using it named every job that.
  // The name is a dir="auto" span; where the number is not in the address
  // book it is the number itself, which is exactly what we want to record.
  function contactName() {
    const hdr = document.querySelector("#main header");
    if (!hdr) return "";
    for (const sp of hdr.querySelectorAll('span[dir="auto"]')) {
      const t = (sp.textContent || "").trim();
      if (t && t.length < 80 && t !== "Profile details") return t;
    }
    const first = (hdr.innerText || "").split("\n").map((x) => x.trim()).filter(Boolean)[0];
    return first && first.length < 80 ? first : "";
  }

  // Failing that, the name WhatsApp stamps on the messages themselves - the
  // sender who is not you, seen most often.
  function senderFallback(picked) {
    const counts = {};
    for (const p of picked) counts[p.who] = (counts[p.who] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  }

  // "[1:23 pm, 3/10/2026] Andre Theron: " -> its parts.
  function parsePre(raw) {
    const m = PRE.exec(String(raw || "").trim());
    if (!m) return null;
    const [, time, ampm, date, who] = m;
    return { time: (time + " " + (ampm || "")).trim(), date, who: who.trim() };
  }

  // Day/month order differs by locale and getting it wrong would reorder the
  // conversation, so this is used only to measure the gap between messages -
  // never to date the job. The job's date comes from the text, through the
  // parser, the same as it does for email.
  function stamp(date, time) {
    const p = String(date).split(/[/.-]/).map(Number);
    if (p.length !== 3) return null;
    let [a, b, y] = p;
    if (y < 100) y += 2000;
    const day = a > 12 ? a : (b > 12 ? b : a);      // ambiguous dates stay ambiguous
    const mon = a > 12 ? b : (b > 12 ? a : b);
    const t = /(\d{1,2}):(\d{2})/.exec(time) || [];
    let hh = Number(t[1] || 0);
    if (/p/i.test(time) && hh < 12) hh += 12;
    if (/a/i.test(time) && hh === 12) hh = 0;
    const d = new Date(y, mon - 1, day, hh, Number(t[2] || 0));
    return isNaN(d) ? null : d;
  }

  function textOf(node) {
    const el = node.querySelector(".selectable-text") || node;
    return (el.innerText || "").replace(/ /g, " ").trim();
  }

  // What is in the conversation that a content script cannot read. Counted, so
  // the form can say so rather than let a half-read chat look complete.
  function unreadable(pane) {
    const n = (sel) => pane.querySelectorAll(sel).length;
    return {
      images: n('img[src^="blob:"]'),
      voice: n('audio, [aria-label*="voice" i], [data-testid*="audio"]'),
      docs: n('[data-testid*="document"], [title$=".pdf"], [title$=".docx"], [title$=".xlsx"]'),
    };
  }

  // WhatsApp renders the message list lazily: for a moment after a chat opens
  // the older bubbles exist but carry no text, and reading then returns only
  // the newest handful - silently, which is the dangerous part. Wait until the
  // count of readable messages stops growing before trusting it.
  async function settled() {
    let last = -1;
    for (let i = 0; i < 8; i++) {
      const pane = paneOf();
      if (!pane) return null;
      const n = [...pane.querySelectorAll("[data-pre-plain-text]")]
        .filter((x) => textOf(x)).length;
      if (n > 0 && n === last) return pane;
      last = n;
      await new Promise((r) => setTimeout(r, 250));
    }
    return paneOf();
  }

  function readOpenChat(pane) {
    if (!pane) return null;

    const nodes = [...pane.querySelectorAll("[data-pre-plain-text]")];
    if (!nodes.length) return null;

    // Walk backwards from the newest: the recent exchange is the job, and a
    // long silence before it belongs to a different conversation.
    const picked = [];
    let next = null;
    for (let i = nodes.length - 1; i >= 0 && picked.length < MAX_MESSAGES; i--) {
      const pre = parsePre(nodes[i].getAttribute("data-pre-plain-text"));
      if (!pre) continue;
      const when = stamp(pre.date, pre.time);
      if (next && when && (next - when) > GAP_HOURS * 3600e3) break;
      const body = textOf(nodes[i]);
      if (body) picked.push({ ...pre, when, body });
      if (when) next = when;
    }
    picked.reverse();
    if (!picked.length) return null;

    const who = contactName() || senderFallback(picked);
    const senders = [...new Set(picked.map((p) => p.who))];
    const lines = picked.map((p) => `${p.time} ${p.who}: ${p.body}`);
    const media = unreadable(pane);

    const notes = [];
    if (media.voice) notes.push(`${media.voice} voice note${media.voice > 1 ? "s" : ""}`);
    if (media.images) notes.push(`${media.images} photo${media.images > 1 ? "s" : ""}`);
    if (media.docs) notes.push(`${media.docs} document${media.docs > 1 ? "s" : ""}`);

    const body = `WhatsApp conversation with ${who || senders[0] || "a contact"}, `
      + `${picked.length} message${picked.length > 1 ? "s" : ""}`
      + (notes.length ? `. Not readable here: ${notes.join(", ")}.` : ".")
      + `\n\n${lines.join("\n")}`;

    return {
      id: "wa:" + (location.hash || who || "") + ":" + (picked[picked.length - 1].time || ""),
      subject: who ? `WhatsApp - ${who}` : "WhatsApp conversation",
      from: "",
      fromName: who || senders[0] || "",
      received: picked[picked.length - 1].when ? picked[picked.length - 1].when.toISOString() : "",
      isRead: true,
      body,
      hasFullBody: true,
      messageCount: picked.length,
      media,
      source: "whatsapp",
    };
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.__oneshot === "read-open") {
      settled().then((pane) => {
        let msg = null;
        try { msg = readOpenChat(pane); } catch { /* report nothing rather than throw */ }
        window.postMessage({ __oneshot: "open-message", msg }, "*");
      });
    }
    // The chat list is never scanned. Answer the poll with nothing, so the
    // strip settles into its one-button state instead of waiting forever.
    if (e.data.__oneshot === "please-publish") {
      window.postMessage({ __oneshot: "messages", list: [] }, "*");
    }
  });
})();
