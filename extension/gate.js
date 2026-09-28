// OneShot - the gate. Generated from the add-in's core.js.
(function (root) {
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

// Sea and air freight, split by how much the word can mean something else.
//
// STRONG terms have no innocent reading in a mailbox: nobody writes "stack
// dates" or "bill of lading" about anything but cargo. One of these in a
// SUBJECT is a deadline announcing itself, and is enough on its own.
//
// WEAK terms are real freight vocabulary that also lives ordinary lives -
// "export your report", "terminal", "customs" in a holiday story. They count,
// but they need company.
//
// Both match on word boundaries: "port" inside "report", "important" and
// "support" is exactly the bug that once made "satisfied" read as Saturday.
const FREIGHT_STRONG = [
  "stack date", "stack dates", "stacking", "stack opens", "stack closes",
  "cut off", "cut-off", "cutoff", "doc cut", "cargo cut", "cy cut",
  "bill of lading", "waybill", "airway bill", "airwaybill", "awb", "mawb", "hawb",
  "vessel", "voyage", "transhipment", "tranship",
  "port of loading", "port of discharge", "consignee", "consignor",
  "freight forwarder", "incoterm", "berth", "quay",
];
const FREIGHT_WEAK = [
  "sailing", "container", "reefer", "groupage", "consolidation",
  "terminal", "wharf", "depot", "closing date",
  "customs", "clearing", "clearance", "sars", "bonded",
  "shipper", "forwarder", "export", "import",
  "packing list", "commercial invoice", "certificate of origin",
  "exw", "fob", "cif", "ddp", "dap",
];
const reOf = (list) => new RegExp(
  "\\b(" + list.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b", "gi");
const STRONG_RE = reOf(FREIGHT_STRONG);
const WEAK_RE = reOf(FREIGHT_WEAK);
const hitsOf = (re, text) => [...new Set((String(text).match(re) || []).map((m) => m.toLowerCase()))];

// What a message mentions, in the reader's own words. Used when the parser
// cannot build a job: "nothing job-shaped" is a dead end, whereas "mentions
// stack dates and a vessel" is something a person can act on.
function signals(text) {
  const hay = String(text || "").slice(0, 8000);
  return {
    freight: [...hitsOf(STRONG_RE, hay), ...hitsOf(WEAK_RE, hay)].slice(0, 6),
    work: WORK_WORDS.filter((w) => hay.toLowerCase().includes(w)).slice(0, 6),
  };
}

const ADDRESS_RE = /\b(street|st\b|road|rd\b|avenue|ave\b|lane|drive|way|suburb|cape town|johannesburg|durban|gallery|studio|warehouse|unit \d)/i;

const domainOf = (addr) =>
  String(addr || "").toLowerCase().match(/@([a-z0-9.\-]+)/)?.[1] ?? "";

// sensitivity: -1 asks less, 0 default, +1 asks more. Exposed as a dial in the
// pane rather than buried here, because the right threshold is a matter of
// taste and one person's "helpful" is another's "noisy".
function gate(thread, opts = {}) {
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

  // Freight terms are strong evidence on their own. A forwarder writing about
  // a stack date is describing a deadline to deliver to a terminal, whether or
  // not the mail troubles itself to list what is in the crate.
  const strongSubj = hitsOf(STRONG_RE, subjectLower);
  const weakSubj = hitsOf(WEAK_RE, subjectLower);
  const strongBody = hitsOf(STRONG_RE, hay);
  const weakBody = hitsOf(WEAK_RE, hay);
  // Same principle as work words: the subject is the strongest signal. An
  // unambiguous freight term up there clears the bar by itself, because a
  // missed stack date means a missed sailing.
  if (strongSubj.length) { score += 4; why.push(`subject mentions ${strongSubj[0]}`); }
  else if (weakSubj.length) { score += 3; why.push(`subject mentions ${weakSubj[0]}`); }
  else if (strongBody.length) { score += 3; why.push(`freight terms (${strongBody.slice(0, 2).join(", ")})`); }
  else if (weakBody.length >= 2) { score += 2; why.push(`freight terms (${weakBody.slice(0, 2).join(", ")})`); }

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


  root.OneShotGate = { gate: gate, signals: signals };
})(window);
