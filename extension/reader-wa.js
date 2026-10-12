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
//
// ---------------------------------------------------------------------------
// WHY THIS WAS REWRITTEN
// ---------------------------------------------------------------------------
// The first version read a real conversation and produced this:
//
//   WhatsApp conversation with +27 64 175 3869, 16 messages.
//   Not readable here: 2 voice notes, 1 photo.
//
//   3:44 PM +27 64 175 3869: We are collecting only 4 of them.
//   ...
//
// It begins at "only 4 of them". Four of WHAT was said earlier in the chat and
// never reached the parser, so no job could be built from it - and none was.
// Three separate faults, all of which hid behind each other:
//
//   1. IT NEVER SCROLLED. WhatsApp renders a window of the message list and
//      drops the rest from the DOM entirely. querySelectorAll only ever saw
//      what happened to be on screen, and settled() - which waits for the
//      count to stop growing - actively guaranteed it stopped at that window.
//      A long chat was silently truncated to its last screenful.
//
//   2. A MULTI-LINE MESSAGE LOST ITS ATTRIBUTION. Lines were joined with "\n"
//      while the bodies contained newlines of their own, so "Pick up address
//      are the studios located at" and the address on the next line arrived as
//      two unrelated fragments, one of them with no speaker at all.
//
//   3. PHOTOS WERE COUNTED, NEVER SENT. unreadable() tallied them and the
//      summary said "not readable here" - which was true only because nothing
//      ever tried. In art logistics the photograph usually IS the brief.
//
// Scrolling the chat the user has already opened, when the user has just
// pressed Read, is still within the restraint above: it reads what they asked
// to read. It opens nothing, sends nothing, and puts the view back where it
// found it.

(function () {
  "use strict";
  if (window.__oneshotWa) return;
  window.__oneshotWa = true;

  const MAX_MESSAGES = 30;
  const GAP_HOURS = 24;          // a silence this long ends the conversation
  const MAX_SCROLLS = 12;        // ~5s of loading, then take what we have
  const SCROLL_WAIT = 420;
  const MAX_PHOTOS = 3;
  const MAX_PHOTO_BYTES = 1_200_000;
  const MAX_PHOTO_TOTAL = 3_000_000;

  const PRE = /^\[(\d{1,2}:\d{2})\s*([ap]\.?m\.?)?,\s*([\d/.-]+)\]\s*(.*?):\s*$/i;

  const paneOf = () => document.querySelector("#main");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // conversation, so this is used only to measure the gap between messages and
  // to sort them - never to date the job. The job's date comes from the text,
  // through the parser, the same as it does for email.
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
    return (el.innerText || "").replace(/ /g, " ").trim();
  }

  // What is in the conversation that a content script cannot read. Voice notes
  // stay here: there is no transcript in the DOM to take. Photos no longer do -
  // see grabPhotos.
  function unreadable(pane) {
    const n = (sel) => pane.querySelectorAll(sel).length;
    return {
      voice: n('audio, [aria-label*="voice" i], [data-testid*="audio"]'),
      docs: n('[data-testid*="document"], [title$=".pdf"], [title$=".docx"], [title$=".xlsx"]'),
    };
  }

  // ---------------------------------------------------------------------------
  // Loading the rest of the conversation
  // ---------------------------------------------------------------------------

  /** The element that actually scrolls the message list. WhatsApp's test ids
   *  are obfuscated now, so it is found by behaviour rather than by name: the
   *  tallest scrollable thing inside the pane. */
  function scrollerOf(pane) {
    let best = null;
    for (const d of pane.querySelectorAll("div")) {
      const s = getComputedStyle(d);
      if (!/auto|scroll/.test(s.overflowY)) continue;
      if (d.scrollHeight <= d.clientHeight + 40) continue;
      if (!best || d.scrollHeight > best.scrollHeight) best = d;
    }
    return best;
  }

  /** Every readable message currently in the DOM, with its identity. */
  function readPass(pane) {
    const out = [];
    for (const node of pane.querySelectorAll("[data-pre-plain-text]")) {
      const pre = parsePre(node.getAttribute("data-pre-plain-text"));
      if (!pre) continue;
      const body = textOf(node);
      if (!body) continue;
      out.push({ ...pre, body, when: stamp(pre.date, pre.time) });
    }
    return out;
  }

  const idOf = (m) => `${m.date}|${m.time}|${m.who}|${m.body.slice(0, 120)}`;

  /**
   * Scroll back until the conversation stops growing, collecting as we go.
   *
   * Collected per pass rather than read once at the end, because the list is
   * virtualised in BOTH directions: scrolling up far enough can drop the
   * newest messages out of the DOM, and reading only at the end would then
   * lose the very messages the first version managed to get right.
   *
   * Returns everything seen, in time order, and whether there is more above.
   */
  async function collect(pane) {
    const seen = new Map();
    const take = () => { for (const m of readPass(pane)) seen.set(idOf(m), m); };

    take();
    const sc = scrollerOf(pane);
    let more = false;

    if (sc) {
      const resting = sc.scrollTop;
      let stable = 0;
      for (let i = 0; i < MAX_SCROLLS && seen.size < MAX_MESSAGES; i++) {
        const before = seen.size;
        // Nudge down, then up. Assigning 0 to a scrollTop that is ALREADY 0
        // fires no scroll event at all, so the list is never asked to load the
        // next page and one screenful of history is all you ever get - which
        // looks exactly like working, and is how this went unnoticed.
        if (sc.scrollTop < 2) { sc.scrollTop = Math.min(140, sc.scrollHeight); await sleep(40); }
        sc.scrollTop = 0;
        await sleep(SCROLL_WAIT);
        take();
        if (seen.size === before) {
          // Two quiet passes: either the top of the chat, or WhatsApp is not
          // going to load any more however long we wait.
          if (++stable >= 2) break;
        } else {
          stable = 0;
        }
      }
      more = seen.size >= MAX_MESSAGES;
      // Put the user's view back where they left it. They opened this chat to
      // read it, not to be thrown to the top of it.
      sc.scrollTop = resting === 0 ? sc.scrollHeight : resting;
      await sleep(120);
      take();                       // whatever came back into view on the way down
    }

    // Time order. Where a timestamp could not be read the message keeps its
    // insertion position, which is the order the DOM had it in.
    const list = [...seen.values()];
    return {
      all: list
        .map((m, i) => ({ m, i }))
        .sort((x, y) =>
          (x.m.when && y.m.when ? x.m.when - y.m.when : 0) || (x.i - y.i))
        .map((x) => x.m),
      more,
    };
  }

  /**
   * The photographs, as bytes rather than as a count.
   *
   * Capped hard: three at most, and a total the edge function will actually
   * accept. A thumbnail that reads "a framed work, roughly square" is worth
   * far more than a line saying one photo could not be read, which is all
   * this used to manage.
   */
  async function grabPhotos(pane) {
    const out = [];
    let total = 0;
    const imgs = [...pane.querySelectorAll('img[src^="blob:"]')]
      // Profile pictures and stickers live in here too and are small; a shared
      // photograph is not.
      .filter((im) => (im.naturalWidth || im.width || 0) >= 150)
      .slice(-MAX_PHOTOS);

    for (const im of imgs) {
      try {
        const res = await fetch(im.src);
        const blob = await res.blob();
        if (blob.size > MAX_PHOTO_BYTES || total + blob.size > MAX_PHOTO_TOTAL) continue;
        const data = await new Promise((ok, no) => {
          const fr = new FileReader();
          fr.onload = () => ok(String(fr.result).split(",")[1] || "");
          fr.onerror = no;
          fr.readAsDataURL(blob);
        });
        if (!data) continue;
        total += blob.size;
        out.push({ media_type: blob.type || "image/jpeg", data });
      } catch {
        // A photo that will not read is not a reason to fail the whole read.
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------

  function assemble(pane, all, more, photos) {
    // Walk backwards from the newest: the recent exchange is the job, and a
    // long silence before it belongs to a different conversation.
    const picked = [];
    let next = null;
    let cutByGap = false;
    for (let i = all.length - 1; i >= 0 && picked.length < MAX_MESSAGES; i--) {
      const m = all[i];
      if (next && m.when && (next - m.when) > GAP_HOURS * 3600e3) { cutByGap = true; break; }
      picked.push(m);
      if (m.when) next = m.when;
    }
    picked.reverse();
    if (!picked.length) return null;

    const who = contactName() || senderFallback(picked);
    const senders = [...new Set(picked.map((p) => p.who))];

    // Each message is ONE entry however many lines it has. A message that
    // wraps gets its continuation indented, so "Pick up address are the
    // studios located at" and the address beneath it stay visibly the same
    // person saying one thing.
    const lines = picked.map((p) => {
      const [first, ...rest] = p.body.split("\n");
      const head = `${p.time} ${p.who}: ${first}`;
      return rest.length ? head + "\n" + rest.map((r) => "    " + r).join("\n") : head;
    });

    const media = unreadable(pane);
    const notes = [];
    if (media.voice) notes.push(`${media.voice} voice note${media.voice > 1 ? "s" : ""}`);
    if (media.docs) notes.push(`${media.docs} document${media.docs > 1 ? "s" : ""}`);

    // Said plainly, because a conversation that was cut should never look
    // complete. Both of these are things the reader KNOWS it does not have.
    const limits = [];
    if (cutByGap) {
      limits.push(`Earlier messages were left out: there is a gap of more than ${GAP_HOURS} hours before this exchange.`);
    } else if (more) {
      limits.push(`Only the most recent ${MAX_MESSAGES} messages are included; the chat goes back further.`);
    }
    if (notes.length) limits.push(`Not readable here: ${notes.join(", ")}.`);

    const head = `WhatsApp conversation with ${who || senders[0] || "a contact"}, `
      + `${picked.length} message${picked.length > 1 ? "s" : ""}`
      + (photos.length ? `, ${photos.length} photo${photos.length > 1 ? "s" : ""} attached` : "")
      + "."
      + (limits.length ? " " + limits.join(" ") : "");

    return {
      id: "wa:" + (location.hash || who || "") + ":" + (picked[picked.length - 1].time || ""),
      subject: who ? `WhatsApp - ${who}` : "WhatsApp conversation",
      from: "",
      fromName: who || senders[0] || "",
      received: picked[picked.length - 1].when ? picked[picked.length - 1].when.toISOString() : "",
      isRead: true,
      body: `${head}\n\n${lines.join("\n")}`,
      hasFullBody: true,
      messageCount: picked.length,
      media: { ...media, images: photos.length },
      images: photos,
      source: "whatsapp",
    };
  }

  async function readOpenChat() {
    const pane = paneOf();
    if (!pane) return null;
    const { all, more } = await collect(pane);
    if (!all.length) return null;
    let photos = [];
    try { photos = await grabPhotos(pane); } catch { photos = []; }
    return assemble(pane, all, more, photos);
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.__oneshot === "read-open") {
      readOpenChat()
        .catch(() => null)
        .then((msg) => window.postMessage({ __oneshot: "open-message", msg: msg || null }, "*"));
    }
    // The chat list is never scanned. Answer the poll with nothing, so the
    // strip settles into its one-button state instead of waiting forever.
    if (e.data.__oneshot === "please-publish") {
      window.postMessage({ __oneshot: "messages", list: [] }, "*");
    }
  });
})();
