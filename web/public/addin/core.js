// OneShot mail assistant — the decision logic, with no Outlook in it.
//
// Deliberately free of Office.js and of the DOM: everything here is pure
// enough to test, and a Gmail client later reuses it unchanged. The mail
// client's only job is to supply a thread and a place to persist.
//
// Two questions live here:
//   1. Is this thread worth paying a parser call for?  (gate)
//   2. Should we interrupt this person about it?        (suppression)
//
// The second matters more than the first. A gate that is slightly too eager
// costs a fraction of a cent. An assistant that asks twice about the same
// thread gets switched off.

// ---------------------------------------------------------------------------
// 1. The gate — local, instant, free.
//
// Running the parser on every thread somebody opens would be slow and
// expensive, and most mail is not work. This runs in under a millisecond on
// text already in memory, and only threads that clear it cost anything.
// ---------------------------------------------------------------------------

// The words that actually appear in the subject line of a logistics request.
const WORK_WORDS = [
  "collect", "collection", "deliver", "delivery", "crate", "crating",
  "pack", "packing", "install", "installation", "measure", "uplift",
  "consignment", "shipment", "ship", "storage", "store", "transport",
  "move", "freight", "dispatch", "courier", "pickup", "pick up",
  "condition report", "artwork", "artworks", "fabricat",
  // A week's work often arrives under a subject that names none of the above.
  // "RE: Friday schedule" was the real 16-job email, and without these it
  // scored 2 and would have been skipped - the exact case this exists for.
  "schedule", "run sheet", "runsheet", "job sheet", "jobsheet", "booking",
  "movement", "programme", "logistics",
];

// Mail that looks like work but never is.
const NOT_WORK = [
  "unsubscribe", "newsletter", "no-reply", "noreply", "do not reply",
  "out of office", "automatic reply", "undeliverable", "delivery status",
  "delivery failure", "password", "verify your", "statement of account",
  "remittance", "payslip", "webinar", "invitation:", "accepted:", "declined:",
];

// Dates, carefully. The loose version of this matched "satisfied" as Saturday
// and "mark" as March, because `\b(sat)[a-z]*` and `\b(mar)[a-z]*` swallow any
// word that merely starts that way. Exact tokens only.
const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december"
  + "|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
const DAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday"
  + "|mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat|sun";
const DATE_RE = new RegExp(
  "\\b(" +
  "\\d{1,2}[\\/.\\-]\\d{1,2}([\\/.\\-]\\d{2,4})?" +          // 25/09, 25-09-2026
  "|\\d{1,2}(st|nd|rd|th)?\\s+(" + MONTHS + ")" +               // 25 Sept
  "|(" + MONTHS + ")\\s+\\d{1,2}" +                            // Sept 25
  "|(" + DAYS + ")" +                                        // Thursday
  "|today|tomorrow|next week|this week" +
  ")\\b", "i");
const DIMS_RE = /\d+(\.\d+)?\s*[x×]\s*\d+(\.\d+)?/i;
const ADDRESS_RE = /\b(street|st\b|road|rd\b|avenue|ave\b|lane|drive|way|suburb|cape town|johannesburg|durban|gallery|studio|warehouse|unit \d)/i;

const domainOf = (addr) =>
  String(addr || "").toLowerCase().match(/@([a-z0-9.\-]+)/)?.[1] ?? "";

// sensitivity: -1 asks less, 0 default, +1 asks more. Exposed as a dial in the
// pane rather than buried here, because the right threshold is a matter of
// taste and one person's "helpful" is another's "noisy".
export function gate(thread, opts = {}) {
  const { clientDomains = [], ownDomains = [], sensitivity = 0 } = opts;
  const subject = String(thread.subject || "");
  const body = String(thread.body || "").slice(0, 4000);
  const hay = `${subject}\n${body}`.toLowerCase();
  const subjectLower = subject.toLowerCase();

  const why = [];
  let score = 0;

  // The subject is the strongest signal and the cheapest to read - it is also
  // all the inbox scan ever gets to see, so it is weighted accordingly.
  const inSubject = WORK_WORDS.filter((w) => subjectLower.includes(w));
  if (inSubject.length) { score += 3; why.push(`subject mentions ${inSubject[0]}`); }

  // A body using SEVERAL different work words is describing work, whatever the
  // subject says. One mention is a passing reference; four is a schedule.
  const inBody = WORK_WORDS.filter((w) => hay.includes(w));
  if (!inSubject.length) {
    if (inBody.length >= 3) { score += 3; why.push(`body reads like work (${inBody.slice(0, 3).join(", ")})`); }
    else if (inBody.length) { score += 1; why.push(`body mentions ${inBody[0]}`); }
  }

  const from = domainOf(thread.from);
  if (from && clientDomains.includes(from)) { score += 3; why.push("from a known client"); }
  // Internal mail is usually a forward of a client request, so it is not a
  // negative - but it is not evidence either.
  else if (from && ownDomains.includes(from)) { why.push("internal"); }

  if (DIMS_RE.test(hay)) { score += 2; why.push("has dimensions"); }

  // A date or a day name IN THE SUBJECT is a real signal on its own: people
  // title logistics mail by when it happens. "Thursday" or "2 Oct" in a
  // subject line means something is being scheduled. The same date buried in
  // a body is much weaker - it might be a signature or a quoted reply.
  if (DATE_RE.test(subjectLower)) { score += 2; why.push("subject names a day or date"); }
  else if (DATE_RE.test(hay)) { score += 1; why.push("has a date"); }
  if (ADDRESS_RE.test(hay)) { score += 1; why.push("has an address"); }

  const killed = NOT_WORK.find((w) => hay.includes(w));
  if (killed) { score -= 5; why.push(`looks automated ("${killed}")`); }

  // Start conservative. A missed suggestion costs nothing - the manual button
  // is always there - while a wrong one costs trust, and trust is the product.
  const threshold = 4 - sensitivity;
  return { pass: score >= threshold, score, threshold, why };
}

// ---------------------------------------------------------------------------
// 2. Suppression — the difference between predictive and nagging.
//
// Every decision is written down. Nothing asks twice.
// ---------------------------------------------------------------------------

const KEY = "oneshot_assistant_v1";
const QUIET_MS = 3 * 60 * 60 * 1000;      // a working email cycle, roughly

const blank = () => ({ quietUntil: 0, decisions: {}, sensitivity: 0 });

export function makeStore(adapter) {
  const read = () => {
    try { return { ...blank(), ...(adapter.get(KEY) || {}) }; }
    catch { return blank(); }
  };
  const save = (s) => { try { adapter.set(KEY, s); } catch { /* best effort */ } };

  return {
    all: read,
    sensitivity: () => read().sensitivity,
    setSensitivity(n) { const s = read(); s.sensitivity = Math.max(-1, Math.min(1, n)); save(s); },

    // `stamp` is something that changes when the thread does - the time of its
    // newest message. It is what lets "later" mean "ask me when there is
    // actually something new", which is usually the reply carrying the date.
    shouldAsk(threadId, stamp, now = Date.now()) {
      const s = read();
      if (s.quietUntil > now) return { ask: false, reason: "quiet hours" };
      const d = s.decisions[threadId];
      if (!d) return { ask: true, reason: "not seen before" };
      if (d.verdict === "no") return { ask: false, reason: "answered no" };
      if (d.verdict === "created") return { ask: false, reason: "already a job" };
      if (d.verdict === "later")
        return String(stamp) !== String(d.stamp)
          ? { ask: true, reason: "new reply since you deferred" }
          : { ask: false, reason: "deferred, nothing new" };
      return { ask: true, reason: "unknown verdict" };
    },

    record(threadId, verdict, stamp, now = Date.now()) {
      const s = read();
      s.decisions[threadId] = { verdict, stamp: String(stamp ?? ""), at: now };
      // Keep the map from growing without bound on a busy mailbox.
      const ids = Object.keys(s.decisions);
      if (ids.length > 800) {
        ids.sort((a, b) => (s.decisions[a].at ?? 0) - (s.decisions[b].at ?? 0))
          .slice(0, ids.length - 800)
          .forEach((k) => delete s.decisions[k]);
      }
      save(s);
    },

    quiet(hours = 3, now = Date.now()) {
      const s = read();
      s.quietUntil = now + (hours * 60 * 60 * 1000 || QUIET_MS);
      save(s);
    },

    quietFor(now = Date.now()) {
      const left = read().quietUntil - now;
      return left > 0 ? left : 0;
    },
  };
}

// ---------------------------------------------------------------------------
// 3. The dwell rule.
//
// 1-2 seconds is triage: is this mine, do I care. By 3.5 the reader has
// committed, and a prompt is a contribution rather than an interruption.
// Scrolling is the same commitment arriving early, so it short-circuits.
// ---------------------------------------------------------------------------
export function makeDwell(onReady, ms = 3500) {
  let timer = null, armed = false, fired = false;
  const cancel = () => { if (timer) clearTimeout(timer); timer = null; armed = false; fired = false; };
  return {
    // Called on ItemChanged: the previous thread's timer is void.
    start() {
      cancel();
      armed = true;
      timer = setTimeout(() => { if (armed && !fired) { fired = true; onReady("dwell"); } }, ms);
    },
    scrolled() {
      if (armed && !fired) { fired = true; clearTimeout(timer); onReady("scroll"); }
    },
    cancel,
    get pending() { return armed && !fired; },
  };
}
