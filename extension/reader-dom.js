// OneShot - the DOM reader for Outlook on the web.
//
// Why this exists: Outlook's mail never passes through the page's fetch or
// XMLHttpRequest. I instrumented both, plus the service worker channel,
// MessagePort, BroadcastChannel and window messages on a live mailbox, and
// caught nothing - not even during a server-side search. Whatever Outlook
// does internally, the page's own HTTP layer does not carry mail.
//
// What it does carry is the list you can see, and each row publishes itself
// to screen readers:
//
//   div[role="option"][id="AQAAAAAAAQABAAAAB+QGzQ..."]
//   aria-label="Unread Collapsed Has attachments Katie Adams; Lauren Rossouw
//               SOUTHERN GUILD | It was lovely to meet you... Sun 4:42 PM ..."
//
// That is sender, subject, time, preview and read state in one string, and
// Microsoft maintains it deliberately for accessibility - which makes it far
// more durable than a generated class name. We read what the screen reader
// reads. Nothing is requested that Outlook did not already fetch.
//
// The list is virtualised: about six rows exist at any moment. To see thirty
// we step the scroller down, read as we go, and put it back where we found it.

(function () {
  "use strict";
  if (window.__oneshotDom) return;
  window.__oneshotDom = true;

  const WANT = 30;
  const LEADING = /^(Unread|Read|Collapsed|Expanded|Has attachments|Flagged|Draft|Pinned|Muted|Selected|Mentions you|High importance|Low importance)\s+/i;
  // Outlook always renders a timestamp between the subject and the preview.
  const TIME = /\s(\d{1,2}:\d{2}\s?(?:AM|PM)|(?:Mon|Tue|Tues|Wed|Weds|Thu|Thur|Thurs|Fri|Sat|Sun)\s+\d{1,2}:\d{2}\s?(?:AM|PM)|\d{1,2}\/\d{1,2}\/\d{2,4})\s/i;

  const rowsNow = () => [...document.querySelectorAll('div[role="option"][id]')]
    .filter((e) => (e.getAttribute("aria-label") || "").length > 45);

  // The scroller is whichever ancestor actually overflows.
  function scrollerFor(row) {
    let n = row;
    for (let i = 0; i < 14 && n; i++, n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight + 24) {
        const oy = getComputedStyle(n).overflowY;
        if (oy === "auto" || oy === "scroll") return n;
      }
    }
    return null;
  }

  function parse(el) {
    const label = (el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    if (!label) return null;

    const isRead = !/^Unread\b/i.test(label);
    let rest = label;
    for (let i = 0; i < 6; i++) rest = rest.replace(LEADING, "");

    // The sender is rendered as its own element; using it is exact, where
    // splitting the label on punctuation is guesswork.
    let fromName = "";
    for (const leaf of el.querySelectorAll("span")) {
      const t = (leaf.textContent || "").trim();
      if (t && t.length > 1 && t.length < 90 && rest.startsWith(t)) { fromName = t; break; }
    }
    if (fromName) rest = rest.slice(fromName.length).trim();

    const m = rest.match(TIME);
    const subject = (m ? rest.slice(0, m.index) : rest).trim();
    const preview = (m ? rest.slice(m.index + m[0].length) : "").trim();
    if (!subject) return null;

    return {
      id: el.id,
      subject,
      from: "",                       // the list shows display names, not addresses
      fromName,
      received: (m && m[1]) || "",
      isRead,
      body: preview,
      hasFullBody: false,             // a preview line, not the thread
      source: "list",
    };
  }


  // -------------------------------------------------------------------------
  // The message currently open in the reading pane.
  //
  // This is the one place we get the FULL text rather than a preview line, so
  // the manual button produces a much better job than a list row can.
  //
  // Finding the pane without depending on Outlook's generated class names:
  // it is the smallest element outside the message list that still holds a
  // substantial block of text. The list, the nav and the ribbon are excluded
  // by construction, which leaves the pane.
  // -------------------------------------------------------------------------
  // Outlook shows the latest message and hides everything it replies to behind
  // a "..." button. That hidden chain is where the facts usually live: "amend
  // these jobs based on the details received" is the instruction, and the
  // details are three replies down. Reading only what is on screen sends the
  // parser the instruction with none of the information.
  //
  // So the quoted history is opened before the pane is read. Clicking the
  // expander is tried first because it is what a person does; anything still
  // hidden afterwards is unhidden directly and put back immediately.
  const EXPANDERS = [
    '[aria-label*="trimmed" i]',
    '[aria-label*="see more" i]',
    '[aria-label*="show more" i]',
    '[title*="trimmed" i]',
    '[aria-expanded="false"]',
    'button[aria-label*="expand" i]',
  ].join(",");

  function openQuoted(root) {
    let clicked = 0;
    for (const el of root.querySelectorAll(EXPANDERS)) {
      const strip = document.getElementById("oneshot-strip");
      if (strip && strip.contains(el)) continue;
      // An expander is small. Anything large matching these selectors is a
      // container, and clicking it could navigate.
      if ((el.innerText || "").trim().length > 40) continue;
      try { el.click(); clicked++; } catch { /* not clickable, never mind */ }
      if (clicked > 8) break;
    }
    return clicked;
  }

  /**
   * Read innerText with every hidden descendant temporarily shown. Styles are
   * restored in a finally block, so the page is left exactly as it was even if
   * reading throws.
   */
  function textWithHidden(root) {
    const undo = [];
    try {
      for (const el of root.querySelectorAll("*")) {
        const cs = getComputedStyle(el);
        if (cs.display === "none") {
          undo.push([el, el.style.display]);
          el.style.setProperty("display", "block", "important");
        } else if (cs.visibility === "hidden") {
          undo.push([el, null]);
          el.style.setProperty("visibility", "visible", "important");
        }
      }
      return root.innerText || "";
    } finally {
      for (const [el, was] of undo) {
        if (was === null) el.style.removeProperty("visibility");
        else if (was) el.style.display = was;
        else el.style.removeProperty("display");
      }
    }
  }

  function readOpenMessage() {
    const rows = rowsNow();
    const selected = document.querySelector('div[role="option"][aria-selected="true"]')
      || rows.find((r) => location.pathname.includes(encodeURIComponent(r.id).slice(0, 12)))
      || null;

    const listHost = rows[0] && (rows[0].closest('[role="listbox"]') || rows[0].parentElement);
    const strip = document.getElementById("oneshot-strip");

    let pane = null, best = Infinity;
    for (const e of document.querySelectorAll("div, article, section")) {
      if (listHost && listHost.contains(e)) continue;
      if (strip && strip.contains(e)) continue;
      if (e.querySelector('div[role="option"]')) continue;
      const t = (e.innerText || "").trim();
      if (t.length < 200) continue;
      if (t.length < best) { best = t.length; pane = e; }
    }
    if (!pane) return null;

    // The tightest block over 200 characters is often just the newest message,
    // or - once the history is open - just the quoted part. Climb until the
    // parent stops being the message and starts being the application: no list
    // rows, not the strip, and not suddenly several times larger.
    for (let up = 0; up < 6; up++) {
      const parent = pane.parentElement;
      if (!parent) break;
      if (listHost && (listHost.contains(parent) || parent.contains(listHost))) break;
      if (strip && parent.contains(strip)) break;
      if (parent.querySelector('div[role="option"]')) break;
      const mine = (pane.innerText || "").length;
      const theirs = (parent.innerText || "").length;
      if (theirs > Math.max(mine * 4, mine + 20000)) break;
      if (theirs <= mine) break;
      pane = parent;
    }

    openQuoted(pane);

    // Whatever is still hidden after that is read anyway. A quoted chain that
    // did not open is not a reason to send the parser half a request.
    let text = (pane.innerText || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
    const full = textWithHidden(pane).replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
    if (full.length > text.length + 40) text = full;

    // A real address if the pane shows one; Outlook puts it in a title or a
    // mailto link. Falls back to the display name from the selected row.
    // The address usually sits in the pane's header, which is an ancestor of
    // the text block we picked - so look upward as well as inside, stopping
    // before we reach the list.
    let from = "";
    for (let n = pane, up = 0; n && up < 5 && !from; n = n.parentElement, up++) {
      if (listHost && listHost.contains(n)) break;
      for (const a of n.querySelectorAll('a[href^="mailto:"], [title*="@"]')) {
        const raw = a.getAttribute("href") || a.getAttribute("title") || "";
        const m = raw.replace(/^mailto:/i, "").match(/[^\s<>,;"]+@[^\s<>,;"]+/);
        if (m) { from = m[0].toLowerCase(); break; }
      }
    }
    // Last resort: the thread text itself often carries it in a signature.
    if (!from) {
      const m = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      if (m) from = m[0].toLowerCase();
    }

    const fromLabel = selected ? (parse(selected) || {}) : {};
    const subject = (fromLabel.subject) ||
      (document.title || "").replace(/\s*-\s*Outlook.*$/i, "").trim();

    return {
      id: (selected && selected.id) || "open:" + location.pathname.slice(-24),
      subject: subject || "(no subject)",
      from, fromName: fromLabel.fromName || "",
      received: fromLabel.received || "",
      isRead: true,
      body: text,
      hasFullBody: text.length > 240,
      source: "reading-pane",
    };
  }


  // -------------------------------------------------------------------------
  // Take me to it. The list is virtualised, so the row may not exist in the
  // DOM yet - step the scroller until it appears, then bring it into view and
  // mark it briefly. Deliberately does NOT click: opening a thread marks it
  // read, and finding it is not the same as dealing with it.
  // -------------------------------------------------------------------------
  async function reveal(id) {
    const at = () => document.getElementById(id);
    let el = at();

    if (!el) {
      const first = rowsNow()[0];
      const sc = first && scrollerFor(first);
      if (sc) {
        const was = sc.scrollTop;
        sc.scrollTop = 0;
        for (let i = 0; i < 25 && !at(); i++) {
          if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4) break;
          sc.scrollTop += Math.max(200, sc.clientHeight * 0.8);
          await new Promise((r) => setTimeout(r, 140));
        }
        el = at();
        if (!el) sc.scrollTop = was;          // not found; leave them where they were
      }
    }
    if (!el) return false;

    el.scrollIntoView({ block: "center", behavior: "smooth" });
    const prev = el.style.boxShadow;
    el.style.transition = "box-shadow .2s";
    el.style.boxShadow = "inset 4px 0 0 #1f6feb, 0 0 0 2px rgba(31,111,235,.45)";
    setTimeout(() => { el.style.boxShadow = prev; }, 2600);
    return true;
  }

  const found = new Map();
  const harvest = () => { for (const el of rowsNow()) { const m = parse(el); if (m && !found.has(m.id)) found.set(m.id, m); } };

  const publish = () => window.postMessage(
    { __oneshot: "messages", list: [...found.values()].slice(0, WANT) }, "*");

  let busy = false;
  async function collect() {
    if (busy) return;
    busy = true;
    try {
      found.clear();
      harvest();
      const first = rowsNow()[0];
      const sc = first && scrollerFor(first);
      if (sc) {
        const was = sc.scrollTop;                 // put it back exactly as found
        const step = Math.max(200, sc.clientHeight * 0.85);
        for (let i = 0; i < 10 && found.size < WANT; i++) {
          if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4) break;
          sc.scrollTop += step;
          await new Promise((r) => setTimeout(r, 160));   // let the list render
          harvest();
        }
        sc.scrollTop = was;
      }
      publish();
    } finally { busy = false; }
  }

  // Read again when the list changes on its own - new mail, a folder switch.
  let settle = null;
  const observer = new MutationObserver(() => {
    clearTimeout(settle);
    settle = setTimeout(() => { harvest(); publish(); }, 700);
  });
  const watch = () => {
    const r = rowsNow()[0];
    const host = r && (r.closest('[role="listbox"]') || r.parentElement);
    if (host) { observer.observe(host, { childList: true, subtree: true }); return true; }
    return false;
  };

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.__oneshot === "please-publish") collect();
    if (e.data.__oneshot === "reveal") {
      reveal(e.data.id).then((ok) =>
        window.postMessage({ __oneshot: "revealed", id: e.data.id, ok }, "*"));
    }
    if (e.data.__oneshot === "read-open") {
      let msg = null;
      try { msg = readOpenMessage(); } catch { /* report nothing rather than throw */ }
      window.postMessage({ __oneshot: "open-message", msg }, "*");
    }
  });

  // Outlook renders its list well after load; keep looking until it appears.
  let tries = 0;
  const boot = setInterval(() => {
    if (rowsNow().length) { clearInterval(boot); watch(); collect(); }
    else if (++tries > 40) clearInterval(boot);          // ~40s, then give up quietly
  }, 1000);
})();
