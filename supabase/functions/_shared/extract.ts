// Shared LLM extraction — classifies an inbound message and extracts job fields.
// Used by intake-email and intake-whatsapp.

import {
  applyPlanned, composeReply, mentionedRefs, planAmendments,
  readJobStates, renderJobStates, resolveJob,
} from "./amend.ts";
import type { JobMatch } from "./amend.ts";
import { planBilling, planCharges } from "./billing.ts";
import type { ChargeType, ClientRow } from "./billing.ts";
import { noteVocab, recordFeedback } from "./learn.ts";
import { ignoredTerms, loadHints, mapJobType, normaliseTerm, renderHints, ruleMap } from "./hints.ts";
import { checkYear, todayInZA, weekdayOf } from "./dates.ts";
import { describeFailure, explainFailure } from "./failure.ts";
import type { Hint } from "./hints.ts";

const buildSystem = (jobTypes: string, hints = "") => `You are the intake parser for OneShot, a logistics job system.
Given an inbound message (email or WhatsApp), respond ONLY with JSON, no prose, no markdown fences:
{
 "kind": "request" | "amendment" | "status_query" | "chatter",
 "confidence": 0.0-1.0,
 "existing_job_ref": "JOB-YYYY-NNNN or null",
 "jobs": [{
   "type": ${jobTypes},
   "client_ref": "the requester's own reference for this job, or null",
   "stops": [{"kind":"collection"|"delivery"|"site","label":null,"address":null,
              "contact_name":null,"contact_phone":null,"notes":null}],
   "scheduled_date": "STRICTLY YYYY-MM-DD, or null. Never words. \"Monday 7 September\"
     must be resolved to 2026-09-07 using the message date and timezone
     Africa/Johannesburg; if the year is absent assume the NEXT occurrence, never
     a past one. If you cannot resolve it confidently, use null and list
     scheduled_date in missing - a wrong date is worse than none.",
   "time_window": "text or null",
   "hard_deadline": bool,
   "items": [{"description":"","quantity":1,"identity_tier":1|2|3,
              "dimensions":null,"declared_value":null,"special_handling":null,
              "image_indexes":[],"from_stop":null,"to_stop":null}],
   "charges": [{"description":"","quantity":1,"unit":"job|item|hour|day|km|null",
                "unit_price":null,"currency":null}],
   "billing": {"bill_to_name":null,"bill_to_address":null,"vat_number":null,
               "reg_number":null,"billing_email":null,"their_reference":null,
               "payment_terms":null,"vat_applicable":null,"vat_rate":null,
               "currency":null,"quote_number":null},
   "missing": ["field names required but absent, for THIS job"]
 }],
 "missing": ["field names absent across the whole message"],
 "amendment_changes": {"field":"new value"} | null,
 "amendments": [{"existing_job_ref":"as the sender named it",
                 "changes":{"field":"new value"},
                 "unassigned":["a detail that belongs to no job you can identify"]}] | null
}

ONE JOB OR SEVERAL — decide this first:
- "jobs" is a LIST. Most messages hold a single job, and the list has one entry.
- A SCHEDULE holds many. A message laying out a day or a week — times down the
  page, each with its own activity — is ONE JOB PER ACTIVITY. "Fri 25 Sept:
  08:15 collect materials from the timber yard … 08:30 build crates at the
  workshop … 12:30 deliver a case to the auction house" is THREE jobs, each
  with its own date, time_window, type, stops and items.
- Split when activities differ in DATE, TIME, JOB TYPE or CLIENT. Building
  crates for one client and delivering another client's case are separate jobs
  even at the same hour of the same day.
- A heading like "Friday, 25 Sept 2026:" sets the date for every activity
  beneath it until the next date heading. Each job carries its own
  scheduled_date — never two dates in one job.
- Techs or staff named against an activity ("Techs assigned: Daveson + casual")
  are not items and not addresses. Put them in that job's special_handling or
  ignore them; never invent an item from a person's name.
- Lunch breaks, "end of day", travel between stops and similar are NOT jobs.
  Skip them entirely.
- At most 40 jobs from one message. If there are more, return the first 40 and
  add "further jobs beyond the first 40" to the top-level "missing".

ITEM FIELDS — keep these strictly separate. This matters more than anything else:
- "description" is WHAT THE OBJECT IS, as a short noun phrase: "Crate", "Framed painting",
  "Bronze sculpture", "Pallet of catalogues". Two or three words. NEVER put measurements,
  dates, addresses, instructions or prices in it.
- "dimensions" holds measurements ONLY, verbatim as written: "138 x 118 x 42 cm (h)".
  If the message gives sizes, they belong here and must NOT also appear in description.
- "special_handling" holds instructions: "pack on arrival", "glass side up", "two-person lift".
- "image_indexes": the photographs that show THIS item, as numbers. The body
  contains markers like [IMAGE 1], [IMAGE 2] placed exactly where each photo
  appeared in the original email. "Item 1: [IMAGE 3]" means item 1 is shown by
  image 3. Use the markers for the mapping - they are positional truth. Look at
  the photographs to write the description ("Framed work on paper", "Ceramic
  vessel", "Bronze sculpture") and to read any dimensions written on labels or
  crates. If a line names an item but no marker follows, leave image_indexes
  empty. Never guess a mapping the markers do not support.
- An email whose items are ONLY photographs is still a valid request: nine
  markers under nine "Item N:" headings means nine items, described from the
  pictures.
- "quantity" is the count. "1x crate of 138 x 118 x 42cm" is ONE item, quantity 1,
  description "Crate", dimensions "138 x 118 x 42 cm". Do not repeat the count in description.
- A line like "5 crates: 79x62x46 (x2), 73x62x47 (x2), 79x66x54 (x1)" is THREE item entries
  with quantities 2, 2 and 1 — not one item and not five identical ones.

STOPS - a job may have up to 3 collections, 3 deliveries and 3 sites:
- Each address in the message becomes one entry in "stops", in the order given.
- kind is "collection" where things are picked up, "delivery" where they are
  dropped, "site" where work happens and nothing moves (fabrication, install,
  packing, condition check).
- PAIRED LEGS ARE ONE JOB. A message reading "Collection 1 ... Delivery ...,
  Collection 2 ... Delivery ..." on the same date, for ONE consignment, is ONE
  job with two collections and two deliveries - not one job with the first pair
  only, and not two jobs. Record every address.
  This is about a single consignment moving through several addresses. It does
  NOT override "ONE JOB OR SEVERAL" above: distinct activities, with their own
  times and their own work, are separate jobs however many addresses each has.
- "from_stop" and "to_stop" on each item are ZERO-BASED INDEXES into "stops",
  saying where that item is collected and where it goes. In the example above
  the first table is from_stop 0 to_stop 1, the second from_stop 2 to_stop 3.
  This is what keeps each item with the right leg - get it right.
- For a job that only makes or installs something, give one "site" stop and set
  each item's to_stop to it, leaving from_stop null.

"type" must be one of the keys listed above, chosen by what the work IS: building or making
something, installing it, moving it, storing it, collecting it. If none fits, use null.

"client_ref": if the sender names the job in their own terms — a gallery and contact
("Stevenson / Wendy"), a PO or quote number, an exhibition or project name — put it here
verbatim. Do not invent one.

Rules: identity_tier 1 = visually unique (artworks, antiques, custom furniture);
2 = has serial/label/barcode; 3 = commodity/identical units.
kind=chatter for greetings, logistics banter, anything that is not a work request.

AMENDMENTS - changing jobs that already exist:
- kind=amendment when the sender is altering work already in hand rather than
  asking for new work: "please move Friday's collection to Monday", "the
  delivery address has changed", "make it 4 crates", "amend the following jobs".
  The giveaway is that the message refers to something already agreed.

- ONE AMENDMENT PER JOB. "amendments" is a LIST. A message naming three jobs
  produces THREE entries, even when the same change applies to all of them:
      "Please amend Job-2026-0142, Job-2026-0143 and Job-2026-0146 and change
       the reference to MSFA/Mawande"
  is three entries, each with its own existing_job_ref and the same change.
  NEVER collapse several jobs into one entry, and never pick one and drop the
  rest - a job you leave out is a job nobody amends.

- "existing_job_ref": copy HOW THE SENDER NAMED IT, verbatim, and do not tidy
  it. All of these are valid and each is looked up differently downstream:
      "JOB-2026-0142"     the full job number
      "0142" / "142"      the job number as people actually say it
      "Stevenson/Anele"   the sender's own reference for the job
  If a single job is named more than one way ("reference Moshekwa/Melly or job
  number 0161"), use the JOB NUMBER - it is the less ambiguous of the two.

- THE DETAILS ARE OFTEN BELOW, NOT ABOVE. "amend these jobs based on the new
  details received", "as per the mail below", "with the dimensions attached"
  all point DOWNWARD into the quoted thread. READ THE WHOLE MESSAGE INCLUDING
  EVERY QUOTED REPLY, find the details being referred to, and use them. The
  instruction at the top and the facts at the bottom are one request.

- "changes" holds ONLY what is changing for THAT job, with these field names:
    "scheduled_date"  STRICTLY YYYY-MM-DD, resolved the same careful way as for
                      a new job. If you cannot resolve it, omit it and say so in
                      "missing" - a wrong date on an existing job is worse than
                      on a new one, because nobody re-reads it.
    "time_window"     text, e.g. "stack closes Fri 16:00"
    "type"            one of the workspace's job types
    "client_ref"      their reference, if THAT is what changed
    "hard_deadline"   true or false
    "stops"           the SAME shape as a new job's stops. Include a stop only
                      if it is being added or its address is changing. To add a
                      second collection alongside the existing one, give both
                      stops in order - the first is the one already there.
    "items"           see below.

- CHANGING AN ITEM, not adding one. Each entry in "items" may carry "match":
      {"match":"Travel frame", "dimensions":"367 x 16 x 176cm(h)"}
  "match" names the item ALREADY on the job that is changing - by its
  description, or by its position as a number ("1" for the first). Give only
  the fields that change. WITHOUT "match" the entry is a NEW item being added
  and needs a description. Use "match" whenever the message revises details of
  something the job already has: new dimensions, a corrected size, a different
  special-handling note. Adding a duplicate item is not the same as correcting
  one, and is much harder to undo.

- DETAILS YOU CANNOT PLACE. When the message carries details that clearly
  belong to one of these jobs but NOTHING says which - four sets of dimensions
  listed against three job numbers, a measurement labelled only with a person's
  name - do NOT distribute them by guessing and do NOT silently drop them. Put
  each one, verbatim, in that amendment's "unassigned" list, or in the first
  amendment's if it belongs to no particular job. A question asked is recovered
  in a minute; a dimension quietly assigned to the wrong crate is found at the
  gallery door.

- Leave out anything that is NOT changing. Do not echo the job back. An empty
  "changes" is a legitimate answer for a message that mentions a job without
  altering it - that is a status_query.
- Removing an item is NOT an amendment you can express. Say so in "missing".


QUOTES, PRICES AND WHO IS BILLED:
- A message may carry a QUOTE as well as the work: priced lines in the body, or
  an attached PDF or Word document, or someone typing prices into a chat. Read
  it the same way you read the schedule, and put the money on the job it is for.
- "charges" is the priced work, ONE ENTRY PER LINE OF THE QUOTE:
      {"description":"Crate fabrication - Gopal Dagnogo travel frame",
       "quantity":1,"unit":"job","unit_price":4250,"currency":"ZAR"}
  Copy the description close to how the quote words it - that line ends up on
  an invoice the customer will compare against their quote.
- "unit_price" is the price for ONE of the unit, before VAT. If the quote shows
  a line total for a quantity, divide it out; if that does not divide cleanly,
  record quantity 1 and the line total as the unit price rather than inventing
  a rate.
- NEVER INVENT A PRICE. If work is described with no figure against it, record
  the charge with "unit_price": null and list "pricing" in that job's "missing".
  A blank on an invoice gets queried; a made-up number gets paid, and then it is
  your word against the customer's quote.
- Do NOT turn a total into lines, and do NOT add a VAT line as a charge. VAT is
  a flag, not a line item: put it in "billing" as "vat_applicable" and
  "vat_rate". A quote reading "Subtotal R4,250 / VAT @15% R637.50 / Total
  R4,887.50" has ONE charge of 4250, with vat_applicable true and vat_rate 15.
- Zero-rated, exempt, "excludes VAT" for an export: vat_applicable false.
- "currency": the currency the quote is in - ZAR, EUR, USD, GBP. Never convert.
- "billing" is WHO IS BILLED, which is often not who sent the message: a gallery
  instructing a move may be billed to a collector or a shipper. Take the billing
  name, address, VAT and registration numbers from the quote's "Bill to" or
  "Invoice to" block when it has one, not from the sender's signature.
- "their_reference" is the customer's own purchase order or quote number for
  this work; "quote_number" is YOUR quote's number if the document shows one.
- WHICH JOB GETS WHICH CHARGE: match on what the line names. A quote line that
  says "Gopal Dagnogo travel frame" belongs to the job carrying that reference.
  If a quote line cannot be tied to one job, put it on the FIRST job of the
  message and list "charge_allocation" in that job's "missing" so a person
  checks it. Never spread one line across several jobs, and never repeat the
  same line on every job - that multiplies the invoice.
- A message with prices but no new work is not a request. If it prices work
  already in hand, that is kind=amendment with the charges in "changes".


SEA AND AIR FREIGHT - a whole class of job this parser used to miss:
- A forwarder's mail often names no items at all. It names a VESSEL, a
  TERMINAL and a WINDOW. That is still a job: something has to be at the port
  by a deadline, and the deadline is the whole point of the message.
- STACK DATES are the window in which cargo may be delivered to the terminal
  for a sailing. "Stack opens Wed 1 Oct 07:00, closes Fri 3 Oct 16:00" is a
  DELIVERY to that terminal with hard_deadline true, scheduled_date the
  CLOSING date (the last moment it can arrive), and time_window carrying the
  window verbatim. A missed stack means the cargo misses the vessel.
- CUT-OFF times work the same way: doc cut-off, cargo cut-off, CY cut-off.
  Each is a deadline. Record it in time_window and set hard_deadline.
- The terminal, quay, depot or airport IS the delivery stop. "Cape Town
  Container Terminal" is an address, not chatter.
- Vessel name, voyage number, booking reference, container number, B/L or
  airway bill number go in client_ref, verbatim, preferring the booking or
  reference number if several are given.
- If no item is named, do NOT call it chatter. Record one item with
  description "Consignment", quantity 1, and put "items" in that job's
  "missing" - the reader knows what is in the crate and can say so. An unasked
  question is better than a missed sailing.
- Import mail is the mirror image: a vessel ARRIVING, cargo available for
  collection from a terminal once cleared. Collection stop, not delivery.
- Customs, clearing and documentation chasing with no cargo movement is
  chatter. A deadline to MOVE something is not.

DECIDING request vs chatter - read the WHOLE message before deciding:
- If the message contains a collection, delivery or site address AND any items
  (named, listed, or shown by [IMAGE n] markers), it IS a request. It stays a
  request even when the same email also carries internal commentary, staff
  instructions, forwarded discussion, or remarks about the OneShot system
  itself. Ignore the surrounding talk and extract the job underneath it.
- An email whose items are only photographs is a request, not chatter.
- An email whose details sit in an ATTACHED PDF is also a request. Attachments
  appear as [DOCUMENT n: filename]. Read them properly: packing lists, delivery
  notes, condition reports, quotes and schedules routinely carry the addresses,
  dates and the whole item list while the email body says only "see attached".
  An attached WORD document is unpacked before you see it: its text appears
  under "--- attached document ---" with [IMAGE n] markers where its pictures
  were, so an illustrated packing list maps picture to item exactly as an email
  does. A table of works in a PDF IS the item list - one entry per row, taking
  description, dimensions and values from the columns, and the quantity column
  if there is one. Where a PDF and the email body disagree, the email wins: it
  is the more recent instruction.
- Confidence reflects how well you read the JOB, not how tidy the email was.
  A clear address and clear items is high confidence even in a messy thread.
- Only chatter when there is genuinely no job present: no addresses, no items,
  nothing to move, make, pack or install.

ALWAYS FILL "jobs" WITH WHAT THE MESSAGE SAYS, WHATEVER YOU DECIDE "kind" IS.
This is the one place the two answers come apart, and it matters:
- "kind" is your judgement about what the message IS. Keep it honest. A carrier
  notification saying a parcel is out for delivery is a status_query, not a new
  request, and nothing is created from it automatically.
- "jobs" is what the message CONTAINS. A person may be looking at that same
  notification and asking for a job from it - an inbound consignment they have
  to receive is real work even though FedEx sent the mail. If you have left
  "jobs" empty, they get a blank form and retype an address that was sitting in
  front of you.
So when a message names addresses, a date, a reference or a consignment, put
them in "jobs" even for status_query or chatter. A carrier notification with a
From and a To address is one job: the delivery address is the destination, the
sender's address the origin, the tracking number goes in client_ref, and the
consignment description - often in a "This is concerning your shipment" line -
is the item. If nothing names the contents, one item called "Consignment".
Filling this in is never a claim that a job should be created. It is only
refusing to throw away what you have already read.
FORWARDED EMAILS: many requests arrive forwarded by staff. If the body contains a forwarded
message (Fwd:, "---------- Forwarded message", "From: ... Sent: ..."), extract the job from the
ORIGINAL message and treat the original sender as the requester (note them in origin/contact
fields where relevant). Provider verification emails (e.g. a Gmail forwarding confirmation
code) are kind=chatter — never a job.
A job requires a type, at least one item, and somewhere for the work to happen.
The freight exception above stands: a stack date or cut-off with a terminal is
a job even when the message never says what is being shipped.
WHERE depends on the kind of job:
- Moving work (collection, delivery, transport) needs an origin AND a destination.
- Work done in one place - fabrication, building, installation, packing,
  condition checking - needs only ONE address: where the work happens. Put it in
  "destination". Do NOT report a missing origin for this kind of job; there is
  no collection, nothing is being moved from anywhere.
List genuinely absent fields in "missing", judged against the job type above.

TODAY IS ${todayInZA()} (${weekdayOf(todayInZA())}). Dates are Africa/Johannesburg.
This line exists because without it the year came out of nowhere and jobs were
created twelve months in the past, where nobody looks for them.
- A date written WITHOUT a year means its NEXT occurrence from today. Never a
  past one. "5 Oct" read on ${todayInZA()} is ${new Date(Date.parse(todayInZA() + "T12:00:00Z")).getUTCFullYear()}-10-05 or later, never an earlier year.
- When the message names a WEEKDAY as well - "Monday, 5 Oct" - use it to choose
  the year. The weekday and the date only line up in some years, and that is
  the most reliable signal in the whole message.
- Work already done, being written up afterwards, is the one case that may be
  in the past. It will say so.${hints}`;


export interface InboundDoc {
  media_type: string;   // application/pdf
  data: string;         // base64
  filename: string;
}

export interface InboundImage {
  media_type: string;   // image/jpeg, image/png
  data: string;         // base64, no data: prefix
  filename?: string;
}

export interface Extraction {
  kind: string; confidence: number; existing_job_ref: string | null;
  // A message may describe a whole schedule, so this is a list. `job` is the
  // old single-job shape, still accepted so a model reply in the previous
  // format - or a replayed old message - keeps working.
  jobs?: Record<string, unknown>[] | null;
  job?: Record<string, unknown> | null;
  missing: string[];
  // The old single-amendment shape, still accepted so a replayed message or a
  // model reply in the previous format keeps working.
  amendment_changes: Record<string, unknown> | null;
  // One entry per job being changed. A mail naming three jobs has three.
  amendments?: AmendmentIn[] | null;
}

export interface AmendmentIn {
  existing_job_ref: string | null;
  changes: Record<string, unknown> | null;
  /** Details that plainly belong to this request but not to any job it names. */
  unassigned?: string[] | null;
}

export const MAX_JOBS = 40;

// One shape for the rest of the code to read, whichever the model returned.
/**
 * One shape for amendments, whichever the model returned. The singular fields
 * become a one-entry list, so callers never branch on which format arrived.
 *
 * Entries naming no job are dropped rather than applied to a guess, but their
 * unassigned details are kept and carried onto the first real entry - that is
 * how "here are four dimensions" survives to become a question instead of a
 * silent loss.
 */
export function amendmentsOf(ex: Extraction): AmendmentIn[] {
  const raw: AmendmentIn[] = Array.isArray(ex.amendments) && ex.amendments.length
    ? ex.amendments.filter((a) => a && typeof a === "object")
    : (ex.existing_job_ref || ex.amendment_changes
        ? [{ existing_job_ref: ex.existing_job_ref, changes: ex.amendment_changes }]
        : []);

  const orphaned: string[] = [];
  const kept: AmendmentIn[] = [];
  for (const a of raw.slice(0, MAX_JOBS)) {
    const ref = a.existing_job_ref ? String(a.existing_job_ref).trim() : "";
    const loose = (Array.isArray(a.unassigned) ? a.unassigned : []).map(String);
    if (!ref) { orphaned.push(...loose); continue; }
    kept.push({ existing_job_ref: ref, changes: a.changes ?? {}, unassigned: loose });
  }
  if (orphaned.length && kept.length) {
    kept[0].unassigned = [...(kept[0].unassigned ?? []), ...orphaned];
  }
  return kept;
}

export function jobsOf(ex: Extraction): Record<string, unknown>[] {
  const list = Array.isArray(ex.jobs) ? ex.jobs : (ex.job ? [ex.job] : []);
  return list.filter((j) => j && typeof j === "object").slice(0, MAX_JOBS);
}

/**
 * The second pass over an amendment, made once the jobs have been identified
 * and read. `state` is what those jobs hold right now, so "match" refers to
 * something the model can see rather than something it has to guess.
 */
const buildAmendSystem = (jobTypes: string, state: string, hints = "") =>
`You are the amendment parser for OneShot, a logistics job system.

A message has asked for changes to jobs that already exist. THIS IS WHAT THOSE
JOBS HOLD RIGHT NOW:

${state}

Respond ONLY with JSON, no prose, no markdown fences:
{
 "amendments": [{
   "existing_job_ref": "the job number exactly as printed above, e.g. JOB-2026-0143",
   "changes": {
     "scheduled_date": "YYYY-MM-DD",
     "time_window": "text",
     "type": ${jobTypes},
     "client_ref": "their reference",
     "hard_deadline": true|false,
     "stops": [{"kind":"collection"|"delivery"|"site","address":"...","label":null,
                "contact_name":null,"contact_phone":null,"notes":null}],
     "items_replace": [{"description":"...","quantity":1,"dimensions":"...",
                        "declared_value":null,"special_handling":null}],
     "items": [{"match":"[n]","dimensions":"..."}],
     "remove_items": ["[n] or the exact description above"]
   },
   "unassigned": ["a detail that belongs to no job you can identify"]
 }]
}

HOW TO CHANGE ITEMS - this is the part that matters:

USE "items_replace" FOR ALMOST EVERYTHING. Give the COMPLETE list of what the
job should hold once the change is made - every item, not only the ones that
move. OneShot matches your list against what the job holds now, corrects what
stays, removes what you leave out, and creates what is new. You do not have to
work out which existing row is which, or whether something is an edit or an
addition. Describe the job as it should be.

  The job holds two travel frames for two Serge works. The thread says the
  Serge frames are off, and gives measurements for three Mawande works and one
  Deborah. The job should hold four frames, so:

    "items_replace": [
      {"description":"Travel frame - Mawande 1","dimensions":"Int: 367 x 16 x 176cm(h)",
       "special_handling":"Artwork: 361 x 10 x 170cm(h)"},
      {"description":"Travel frame - Mawande 2","dimensions":"Int: 350 x 13 x 180cm(h)",
       "special_handling":"Artwork: 344 x 7 x 174cm(h)"},
      {"description":"Travel frame - Mawande 3","dimensions":"Int: 260 x 11 x 156cm(h)",
       "special_handling":"Artwork: 254 x 5 x 150cm(h)"},
      {"description":"Travel frame - Deborah","dimensions":"Int: 236 x 11 x 156.5cm(h)",
       "special_handling":"Artwork: 230 x 5 x 150.5cm(h)"}
    ]

  The two Serge frames are not in that list, so they go. Nothing had to name
  them.

RULES FOR "items_replace":
- ONE ENTRY PER PHYSICAL OBJECT. Four frames of four different sizes are four
  entries. Never one entry meant to cover several things of different sizes -
  a measurement describes ONE object.
- Use "quantity" only for things that are genuinely identical in every respect.
- Keep items the change does not affect. Leaving one out DELETES it.
- Give each entry a description that tells them apart. "Travel frame" four
  times is four indistinguishable rows; name the work or the artist.
- An item marked ALREADY HANDLED above is kept even if you leave it out, and
  reported - it carries custody events. Include it if it still belongs.

THE NARROW CASE - "items" with "match":
Use this ONLY when nothing about the list changes and you are correcting one
field on one row: {"match":"[2]","dimensions":"350 x 13 x 180cm(h)"}. Each
number is ONE row; two rows reading "Travel frame" are two different frames.
If the COUNT of items changes, or which items they are changes, use
"items_replace" instead.


DIMENSIONS: when a message gives both an artwork size and an internal or crate
size for the same piece, the INTERNAL size is the frame or crate being built -
that is the dimension the job needs. Record it as given, units and all.

WHICH JOB GETS WHAT:
- Use what the jobs hold above to decide. A job whose items are travel frames
  takes the frame dimensions; a measure job that has already happened usually
  takes none.
- When the SAME change plainly applies to several jobs, repeat it in each
  amendment. Do not write it once and hope.
- NEVER DISTRIBUTE BY ORDER. If a message lists four sets of measurements and
  the jobs above offer no way to tell which belongs to which item, do NOT hand
  the first to the first, the second to the second, and so on. That produces a
  confident, plausible, wrong answer, and a frame gets built to another work's
  size. Put EVERY such detail in "unassigned", verbatim, and change nothing.
- The test is simple: could you point at the job above and say WHY this
  measurement belongs to that row? If not, it is unassigned. A label the items
  carry ("Mawande", "Deborah", a work title), a count that matches exactly, or
  the message saying so outright are reasons. Order of appearance is not.
- One measurement never describes two objects. Four measurements mean four
  entries in "items_replace", each with its own description.

READ THE WHOLE MESSAGE INCLUDING EVERY QUOTED REPLY. "Amend these jobs based on
the details received" points DOWNWARD into the thread. The instruction at the
top and the facts at the bottom are one request.

Today is ${new Date().toISOString().slice(0, 10)}. Dates are Africa/Johannesburg.
Return {"amendments":[]} if the message asks for no change you can express.${hints}`;

/**
 * Read the JSON out of a model reply, even when it did not arrive clean.
 *
 * This exists because of a real failure: a nine-job schedule came back
 * beginning "I need to ..." and JSON.parse threw on the first character. The
 * whole mail was lost - no jobs, no reply, nothing on screen but a parse error
 * nobody was looking at. The model had understood the mail perfectly; it had
 * simply started talking first.
 *
 * So: strip fences, and if the text still is not JSON, take the first balanced
 * {...} out of it. Balanced, not greedy-regex, because a brace inside a string
 * ("Int: 150 x 35 {sic}") must not end the object.
 */
export function readJson(text: string): unknown {
  const cleaned = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(cleaned); } catch { /* it came back wrapped in prose */ }

  const start = cleaned.indexOf("{");
  if (start === -1) throw new Error(`the parser replied with no JSON at all: "${cleaned.slice(0, 120)}"`);

  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (escaped) { escaped = false; continue; }
    if (c === "\\") { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      return JSON.parse(cleaned.slice(start, i + 1));
    }
  }
  throw new Error(`the parser's reply held no complete JSON object: "${cleaned.slice(0, 120)}"`);
}

/**
 * One call to the model, shared by both passes.
 *
 * `prefill` puts words in the model's mouth: the reply is made to BEGIN with
 * them, which is how a model that would otherwise open with "I need to..." is
 * held to JSON. The prefill is prepended back onto the answer, since the API
 * returns only what came after it.
 *
 * NOT EVERY MODEL ACCEPTS ONE. Some refuse a conversation that ends with an
 * assistant turn, with a 400 - and this is not hypothetical: adding the
 * prefill silently killed EVERY parse for a day and a half. Both the first
 * attempt and the retry sent it, both were refused identically, and four real
 * emails became "unknown" with no job and no visible cause. The lesson is not
 * "drop the prefill" - it earns its place when the model takes it - but that a
 * request shape the API may reject must never be the only shape tried.
 *
 * So: try it, and if the API says this model will not take one, say so once and
 * carry on without it for the rest of this isolate. readJson() already digs the
 * JSON out of a prose-wrapped reply, which is what the prefill was insurance
 * against rather than a substitute for.
 */
let prefillRefused = false;

async function post(body: unknown): Promise<Response> {
  return await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
}

async function callModel(system: string, content: unknown[], prefill = ""): Promise<string> {
  const base = { model: "claude-sonnet-4-6", max_tokens: 32000, system };
  const user = [{ role: "user", content }];
  const usePrefill = !!prefill && !prefillRefused;

  let res = await post(usePrefill
    ? { ...base, messages: [...user, { role: "assistant", content: prefill }] }
    : { ...base, messages: user });

  let echo = usePrefill ? prefill : "";

  if (!res.ok && usePrefill) {
    const detail = await res.text();
    // Matched on the API's own wording for this refusal, not on the status
    // alone: a 400 for any other reason still has to surface as an error.
    if (/prefill|must end with a user message/i.test(detail)) {
      console.warn("extract: this model refuses an assistant prefill - continuing without it");
      prefillRefused = true;
      echo = "";
      res = await post({ ...base, messages: user });
    } else {
      throw new Error(`Anthropic ${res.status}: ${detail}`);
    }
  }

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.stop_reason === "max_tokens")
    throw new Error("reply hit the 32000-token limit and was cut off");
  const text = (data.content ?? []).filter((c: { type: string }) => c.type === "text")
    .map((c: { text: string }) => c.text).join("");
  return echo + text;
}

/**
 * Re-read an amendment with the jobs' current contents in hand. Returns the
 * amendments only; everything else about the message was settled in pass one.
 */
export async function extractAmendments(
  body: string, meta: string, jobTypes: string, state: string, hints = "",
): Promise<AmendmentIn[]> {
  const text = await callModel(buildAmendSystem(jobTypes, state, hints), [
    { type: "text", text: `${meta}\n\n${body}` },
  ], "{");
  const parsed = readJson(text) as { amendments?: unknown };
  const list = Array.isArray(parsed?.amendments) ? parsed.amendments : [];
  return list.filter((a: unknown) => a && typeof a === "object") as AmendmentIn[];
}

export async function extract(body: string, meta: string, jobTypes: string, images: InboundImage[] = [], docs: InboundDoc[] = [], hints = ""): Promise<Extraction> {
  const content = [
    ...docs.map((d, i) => ([
      { type: "text", text: `[DOCUMENT ${i + 1}: ${d.filename}]` },
      { type: "document", source: { type: "base64", media_type: d.media_type, data: d.data } },
    ])).flat(),
    ...images.map((im, i) => ([
      { type: "text", text: `[IMAGE ${i + 1}]` },
      { type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } },
    ])).flat(),
    { type: "text", text: `${meta}\n\n${body}` },
  ];

  // The reply is made to begin with "{". A nine-job schedule was once lost
  // because the model opened with "I need to ..." and the whole mail went
  // nowhere; holding it to JSON from the first character is the cheapest way
  // that cannot happen again.
  const text = await callModel(buildSystem(jobTypes, hints), content, "{");
  return readJson(text) as Extraction;
}


// Creates message + (job + items) rows. Returns a human summary for the reply.
// deno-lint-ignore no-explicit-any
export async function ingest(sb: any, tenantId: string, channel: string, sender: string, subject: string | null, body: string, raw: unknown, images: InboundImage[] = [], docs: InboundDoc[] = []): Promise<string> {
  // The workspace defines its own job types, so the parser is told about
  // theirs rather than a list hardcoded here.
  const { data: types } = await sb.from("job_types")
    .select("key,label").eq("tenant_id", tenantId).eq("active", true).order("sort");
  const typeList = (types ?? []).length
    ? (types as { key: string; label: string }[])
        .map((t) => `"${t.key}" (${t.label})`).join(" | ") + " | null"
    : '"pickup"|"delivery"|"move"|"storage_in"|"storage_out"|null';

  // The same list as bare keys. The prompt gets the prose form above; an
  // amendment changing a job's type is checked against this, because a type
  // the workspace does not have would be refused by the database anyway and is
  // better caught with an explanation.
  const legalTypes = ((types ?? []) as { key: string }[]).map((t) => t.key);

  // What this workspace has already been taught. Loaded BEFORE the parse, so a
  // correction somebody made last week is in front of the model this morning.
  // An empty list leaves the prompt exactly as it was before any of this
  // existed, which is the right thing to fall back to.
  const hintRows = await loadHints(sb, tenantId);
  const hints = renderHints(hintRows);
  if (hintRows.length) console.log(`ingest: ${hintRows.length} vocabulary rule(s) in force`);

  let ex: Extraction;
  // Kept so the failure can be written onto the message. An email that arrived
  // and produced nothing must be visible in the app, not only in the logs.
  let parseError: string | null = null;
  // The prompt tells the model to resolve dates against the message date, so
  // the message date has to actually be in front of it. It was not, which is
  // how "Monday, 5 Oct" became October 2025.
  const meta = `Channel: ${channel}. Sender: ${sender}. Subject: ${subject ?? "-"}`
    + `. Received: ${todayInZA()} (${weekdayOf(todayInZA())}), Africa/Johannesburg`;
  try { ex = await extract(body, meta, typeList, images, docs, hints); }
  catch (e) {
    parseError = e instanceof Error ? e.message : String(e);
    console.error("ingest: extraction failed:", parseError);

    // ALWAYS try again. The old code only retried when there were attachments
    // to drop, so a plain-text mail got exactly one attempt - and the one
    // attempt a nine-job schedule got came back as prose, which lost the lot.
    // The same mail parsed perfectly when it was sent again two hours later,
    // which is the whole argument for a second go.
    const attempts: { why: string; run: () => Promise<Extraction> }[] = [];
    if (images.length || docs.length) {
      attempts.push({
        why: `without ${images.length} image(s) and ${docs.length} document(s)`,
        run: () => extract(body, meta, typeList, [], [], hints),
      });
    }
    attempts.push({ why: "a second time", run: () => extract(body, meta, typeList, images, docs, hints) });

    ex = { kind: "unknown", confidence: 0, existing_job_ref: null, job: null, missing: [], amendment_changes: null, amendments: null } as Extraction;
    for (const attempt of attempts) {
      console.warn(`ingest: retrying ${attempt.why}`);
      try {
        ex = await attempt.run();
        parseError = null;
        console.log(`ingest: retry ${attempt.why} succeeded`);
        break;
      } catch (e2) {
        parseError = e2 instanceof Error ? e2.message : String(e2);
        console.error(`ingest: retry ${attempt.why} also failed:`, parseError);
      }
    }
  }

  const msgRow = {
    tenant_id: tenantId, channel, kind: ex.kind ?? "unknown",
    sender, subject, body, raw,
  };
  let { data: msg, error: msgErr } = await sb.from("messages")
    .insert({ ...msgRow, parse_error: parseError ? describeFailure(parseError) : null })
    .select().single();

  // If step 38 has not been run yet, parse_error does not exist and the insert
  // above fails - which would lose EVERY inbound message, not just the ones
  // that failed to parse. Recording the message matters more than recording
  // why it failed, so fall back to the old shape rather than drop the mail.
  if (msgErr && /parse_error/.test(msgErr.message ?? "")) {
    console.warn("ingest: messages.parse_error missing - run step 38. Saving without it.");
    ({ data: msg, error: msgErr } = await sb.from("messages").insert(msgRow).select().single());
  }

  if (msgErr || !msg) {
    console.error("ingest: MESSAGE INSERT FAILED:", msgErr?.message ?? "no row returned");
    return `could not record the message: ${msgErr?.message ?? "insert returned nothing"}`;
  }

  {
    const js = jobsOf(ex);
    const itemCount = js.reduce((n, j) => n + (Array.isArray(j.items) ? j.items.length : 0), 0);
    console.log(`ingest: kind=${ex.kind} confidence=${ex.confidence} jobs=${js.length} items=${itemCount} images=${images.length} bodyChars=${body.length}`);
  }
  // An amendment that names a job is let through even on low confidence. For a
  // REQUEST, a shaky parse should create nothing - a wrong job is expensive.
  // For an amendment it is the opposite: the sender has told us which job, the
  // block below refuses to write unless exactly one matches, and every change
  // is reported back with its old value. Staying silent is the worse failure,
  // because the sender believes the change was made and nobody finds out.
  const namedAmendment = ex.kind === "amendment" && !!ex.existing_job_ref;
  // A mail that could not be read at all gets an answer. Returning "" here was
  // how a nine-job schedule produced total silence: no jobs, no reply, and a
  // parse error recorded where nobody was looking. The sender believed it had
  // been received.
  if (parseError) {
    // The sender gets the same answer the board gets. They are the person best
    // placed to send it again, and "the parser failed twice" tells them nothing
    // about whether doing so is worth their time.
    const { readable, retryable } = explainFailure(parseError);
    return `${readable}\n\nNothing was created from this email.`
      + (retryable ? "" : " Create the jobs in the app if they are urgent.");
  }

  if (ex.kind === "chatter" || (ex.confidence < 0.5 && !namedAmendment)) {
    console.log("ingest: not treated as a job. Body began:", body.slice(0, 400).replace(/\s+/g, " "));
    return "";
  }

  // Amendment to an existing job.
  //
  // The reference is resolved through the ladder in amend.ts, so "0161" and
  // "Moshekwa/Melly" now work as well as the full job number. The rule that
  // matters is below: when the reference is ambiguous or unknown, NOTHING is
  // written and the reply asks. An email that silently changes the wrong job's
  // date is the one failure nobody catches, because the mail looked answered.
  if (ex.kind === "amendment") {
    const asks = await refineAmendments(sb, tenantId, ex, body, meta, typeList, hints);
    if (!asks.length) {
      return "That reads like a change to an existing job, but it doesn't say which one. "
        + "Reply with the job number and I'll make the change.";
    }

    const outcomes = await planAmendments(sb, tenantId, asks, legalTypes);
    await applyPlanned(sb, tenantId, outcomes, { channel, by: sender, source_message: msg.id });
    // The parser chose which jobs to amend; this checks its work against the
    // message itself, so a job named in the mail and missed by the model is
    // reported rather than silently left out of the reply.
    return composeReply(outcomes, mentionedRefs(body));
  }

  if (ex.kind !== "request" || !jobsOf(ex).length) return "";
  return await materialise(sb, tenantId, msg, ex, images, docs);
}

// Turns an extraction into jobs, stops, items, photographs and documents.
//
// Split out of ingest() so that a suggestion a human has reviewed and edited
// can be created from the extraction THEY approved. Re-parsing at confirm time
// would risk building something subtly different from what was on screen.
//
// deno-lint-ignore no-explicit-any
export async function materialise(
  sb: any, tenantId: string, msg: { id: string }, ex: Extraction,
  images: InboundImage[] = [], docs: InboundDoc[] = [],
): Promise<string> {
  const jobList = jobsOf(ex);
  if (!jobList.length) return "";

  // Read once for the whole message rather than per job: a schedule of nine
  // jobs would otherwise fetch the rate card nine times.
  const [{ data: typeRows }, { data: clientRows }] = await Promise.all([
    sb.from("charge_types").select("id,key,label,unit").eq("tenant_id", tenantId).eq("active", true),
    sb.from("clients").select("id,name,legal_name,aliases,billing_address,vat_number,reg_number,billing_email,payment_terms")
      .eq("tenant_id", tenantId),
  ]);
  const chargeTypes = (typeRows ?? []) as ChargeType[];
  const clients = (clientRows ?? []) as ClientRow[];

  const { data: jobTypeRows } = await sb.from("job_types")
    .select("key").eq("tenant_id", tenantId).eq("active", true);
  const chargeTypesSeen = {
    jobTypes: ((jobTypeRows ?? []) as { key: string }[]).map((t) => t.key),
  };

  // One short line of context per noted word, so a decision is made on
  // evidence rather than on a bare term.
  const subjectLine = `${(msg as { subject?: string }).subject ?? ""}`.slice(0, 200) || null;

  // The decided rules, applied MECHANICALLY below rather than suggested to the
  // model. A rule enforced by a lookup holds every time; a rule mentioned in a
  // prompt holds most of the time, and "most" is not good enough for which
  // customer an invoice belongs to.
  const hintRows: Hint[] = await loadHints(sb, tenantId);
  const chargeRules = ruleMap(hintRows, "charge_type");
  const clientRules = ruleMap(hintRows, "client_name");
  const typeRules   = ruleMap(hintRows, "job_type");
  // Terms somebody has marked as noise. Without this, an ignored term is
  // re-queued by the next mail that uses it and the queue never empties.
  const hushed = {
    job_type: ignoredTerms(hintRows, "job_type"),
    charge_type: ignoredTerms(hintRows, "charge_type"),
    client_name: ignoredTerms(hintRows, "client_name"),
  };
  const note = async (
    kind: "job_type" | "charge_type" | "client_name", term: string | null | undefined,
  ) => {
    const t = normaliseTerm(term);
    if (!t || hushed[kind].has(t)) return;
    await noteVocab(sb, tenantId, kind, String(term), subjectLine);
  };

  // The source paperwork is uploaded ONCE and linked to every job the message
  // produced. A schedule attached as a PDF is the provenance for all sixteen
  // jobs in it, and re-uploading the same file per job would be pure waste.
  const storedDocs: { name: string; path: string; mime: string; size: number }[] = [];
  for (const d of docs) {
    try {
      const safe = d.filename.replace(/[^\w.\-]+/g, "_").slice(-80);
      const path = `${tenantId}/intake/${msg.id}-${safe}`;
      const bytes = Uint8Array.from(atob(d.data), (c) => c.charCodeAt(0));
      const { error: upErr } = await sb.storage.from("documents")
        .upload(path, bytes, { contentType: d.media_type, upsert: true });
      if (upErr) { console.error("intake doc upload failed:", upErr.message); continue; }
      storedDocs.push({ name: d.filename, path, mime: d.media_type, size: bytes.length });
    } catch (e) {
      console.error("intake doc error:", e instanceof Error ? e.message : String(e));
    }
  }

  // Builds one job, its stops and its items. Returns the reply line, or an
  // error line - one bad job in a schedule must not take the other fifteen
  // down with it.
  const makeJob = async (j: Record<string, unknown>): Promise<{ ok: boolean; line: string }> => {
    const perJobMissing = Array.isArray(j.missing) ? j.missing as string[] : [];
    const flags = [...(ex.missing ?? []), ...perJobMissing].map((m) => `missing_info:${m}`);

    // A date the model wrote in words - "Monday 7 September" - is rejected by
    // Postgres and used to take the entire job down with it. Anything that is
    // not a plain YYYY-MM-DD is dropped and flagged for ops instead.
    const rawDate = j.scheduled_date == null ? null : String(j.scheduled_date).trim();
    let isoDate = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
    if (rawDate && !isoDate) {
      console.warn(`ingest: unusable date from parser: "${rawDate}" - job saved without one`);
      flags.push("missing_info:scheduled_date");
    }

    // The year, checked rather than trusted. Telling the model what today is
    // makes this rare; it does not make it impossible, and the failure is the
    // quiet kind - a job dated last October exists, answers a search, and is
    // simply absent from a board that shows work still to come.
    if (isoDate) {
      const year = checkYear(isoDate, todayInZA());
      if (year.corrected) {
        console.warn(`ingest: "${isoDate}" is in the past - read as ${year.date}`);
        flags.push(`check:date_year_assumed — read "${isoDate}" as ${year.date}`);
        isoDate = year.date;
      } else if (year.suspect) {
        // Left exactly as read. Too far back to be a missing year, so it is
        // either deliberate or a misreading, and only a person can say which.
        console.warn(`ingest: "${isoDate}" is long past and was kept as-is`);
        flags.push(`check:date_in_past — ${isoDate}`);
      }
    }
    // Same care for the time window: free text in the database, but an
    // over-long value usually means the model put the whole sentence in it.
    const timeWindow = typeof j.time_window === "string" && j.time_window.length <= 80
      ? j.time_window : null;

    // Stops are the source of truth for addresses. origin/destination are left
    // for the sync trigger to fill from the primary stop of each kind - setting
    // them here would make the seed trigger create a duplicate pair.
    const parsedStops = (Array.isArray(j.stops) ? j.stops : []) as Record<string, unknown>[];
    const legacyOrigin = parsedStops.length ? null : (j.origin ?? null);
    const legacyDest   = parsedStops.length ? null : (j.destination ?? null);

    // A type the workspace does not have, that somebody has since said what it
    // means, becomes the type they said. This is the case that used to land in
    // the vocabulary queue, sit there, and default the job to "move".
    const ruledType = mapJobType(j.type as string | null, chargeTypesSeen.jobTypes, typeRules);
    if (ruledType.mapped) {
      console.log(`ingest: job type "${String(j.type)}" read as "${ruledType.type}" by rule`);
    }

    const { data: job, error: jobErr } = await sb.from("jobs").insert({
      tenant_id: tenantId, type: ruledType.type ?? j.type ?? "move",
      origin: legacyOrigin, destination: legacyDest,
      client_ref: j.client_ref ?? null,
      scheduled_date: isoDate, time_window: timeWindow,
      hard_deadline: !!j.hard_deadline, source_message_id: msg.id, flags,
    }).select().single();

    // Never let this fail silently: the message is already saved, so a failure
    // here means part of an email that reached us and produced nothing visible.
    if (jobErr || !job) {
      console.error("ingest: JOB INSERT FAILED:", jobErr?.message ?? "no row returned",
        "| code:", jobErr?.code ?? "-", "| type:", j.type ?? "move",
        "| ref:", j.client_ref ?? "-");
      return { ok: false, line: `could not create "${j.client_ref ?? j.type ?? "a job"}": ${jobErr?.message ?? "insert returned nothing"}` };
    }

    // ---- the money, when the message carried a quote --------------------
    //
    // Written straight after the job, before stops and items, so that a
    // failure further down still leaves the billing attached to something
    // rather than stranded.
    {
      const billing = planBilling(tenantId, job.id, j.billing as never, clients, null, clientRules);

      if (Object.keys(billing.job).length) {
        await sb.from("jobs").update(billing.job).eq("id", job.id);
      }
      if (billing.row) {
        const { error } = await sb.from("job_billing")
          .upsert(billing.row, { onConflict: "job_id" });
        if (error) console.error("billing insert failed:", error.message);
      }

      // Words this workspace has no entry for. Noted, never acted on: a job
      // type invented by a mail does not become a job type because it was
      // used once.
      // Only words STILL unaccounted for after the rules have run. A term a
      // rule now answers is no longer a question, and re-queueing it would
      // make the review list unfinishable.
      const proposedType = String(j.type ?? "").trim();
      if (proposedType && !ruledType.mapped && !chargeTypesSeen.jobTypes.includes(proposedType)) {
        await note("job_type", proposedType);
      }
      if (billing.row && !billing.row.client_id && billing.row.bill_to_name) {
        await note("client_name", String(billing.row.bill_to_name));
      }

      const { rows: chargeRows, unpriced } = planCharges(
        tenantId, job.id, j.charges, chargeTypes, null, chargeRules,
      );
      for (const row of chargeRows) {
        // A priced line matching nothing on the rate card is either a new kind
        // of work or a wording the rate card should recognise. Either way a
        // person decides, not this function.
        if (!row.charge_type_id) await note("charge_type", row.description);
      }
      if (chargeRows.length) {
        const { error } = await sb.from("job_charges").insert(chargeRows);
        if (error) console.error("charges insert failed:", error.message);
        else console.log(`ingest: ${chargeRows.length} charge line(s) on ${job.ref}`);
      }
      // Quoted work with no figure against it is flagged on the job, so the
      // board shows it rather than it surfacing when the invoice goes out.
      if (unpriced.length) {
        const extra = unpriced.map((d) => `missing_info:pricing — ${d}`.slice(0, 180));
        await sb.from("jobs")
          .update({ flags: [...flags, ...extra] }).eq("id", job.id);
      }
    }

    // Every address the sender gave, in order, capped at 3 of each kind.
    const stopIds: (string | null)[] = [];
    const seqOf: Record<string, number> = { collection: 0, delivery: 0, site: 0 };
    for (const st of parsedStops) {
      const kind = ["collection", "delivery", "site"].includes(String(st.kind))
        ? String(st.kind) : "delivery";
      if (seqOf[kind] >= 3) { stopIds.push(null); continue; }
      const { data: row, error } = await sb.from("job_stops").insert({
        tenant_id: tenantId, job_id: job.id, kind, seq: seqOf[kind]++,
        label: st.label ?? null, address: st.address ?? null,
        contact_name: st.contact_name ?? null, contact_phone: st.contact_phone ?? null,
        notes: st.notes ?? null,
      }).select("id").single();
      if (error) { console.error("stop insert failed:", error.message); stopIds.push(null); continue; }
      stopIds.push(row?.id ?? null);
    }

    // Keep each row's source item alongside it, so its photographs can be
    // attached after insert. A quantity of 3 makes 3 rows that share the photos.
    const rows = ((j.items ?? []) as Record<string, unknown>[]).flatMap((it) =>
      Array.from({ length: Number(it.quantity ?? 1) }, () => ({
        row: {
          tenant_id: tenantId, job_id: job.id, description: it.description ?? "Item",
          identity_tier: it.identity_tier ?? 1,
          attributes: { dimensions: it.dimensions, declared_value: it.declared_value, special_handling: it.special_handling },
          // Which leg this item belongs to, so a two-pickup job keeps each item
          // with the right pair of addresses.
          from_stop_id: typeof it.from_stop === "number" ? stopIds[it.from_stop] ?? null : null,
          to_stop_id:   typeof it.to_stop   === "number" ? stopIds[it.to_stop]   ?? null : null,
        },
        imageIdx: (Array.isArray(it.image_indexes) ? it.image_indexes as number[] : [])
          .map((n) => Number(n) - 1)               // prompt is 1-based
          .filter((n) => n >= 0 && n < images.length),
      })));

    const items = rows.map((r) => r.row);
    let inserted: { id: string }[] = [];
    if (items.length) {
      const { data } = await sb.from("line_items").insert(items).select("id");
      inserted = data ?? [];
    }

    // Store the photographs against the item each one shows. Uploaded in
    // parallel - each item's photos are independent, and doing these one at a
    // time was adding seconds to every intake.
    let photosSaved = 0;
    const uploads: Promise<void>[] = [];
    for (let i = 0; i < inserted.length && i < rows.length; i++) {
      for (const idx of rows[i].imageIdx.slice(0, 3)) {     // db caps at 3 per item
        const im = images[idx];
        if (!im) continue;
        uploads.push((async () => {
          try {
            const ext = im.media_type === "image/png" ? "png" : "jpg";
            const path = `${tenantId}/${job.id}/${inserted[i].id}/intake-${idx + 1}.${ext}`;
            const bytes = Uint8Array.from(atob(im.data), (c) => c.charCodeAt(0));
            const { error: upErr } = await sb.storage.from("photos")
              .upload(path, bytes, { contentType: im.media_type, upsert: true });
            if (upErr) { console.error("intake photo upload failed:", upErr.message); return; }
            const { error: dbErr } = await sb.from("item_photos").insert({
              tenant_id: tenantId, job_id: job.id, item_id: inserted[i].id, path,
            });
            if (dbErr) { console.error("intake photo record failed:", dbErr.message); return; }
            photosSaved++;
          } catch (e) {
            console.error("intake photo error:", e instanceof Error ? e.message : String(e));
          }
        })());
      }
    }
    await Promise.all(uploads);

    // Link the already-uploaded source paperwork to this job.
    for (const d of storedDocs) {
      const { error } = await sb.from("job_documents").insert({
        tenant_id: tenantId, job_id: job.id, name: d.name, path: d.path,
        mime: d.mime, size_bytes: d.size,
      });
      if (error) console.error("intake doc record failed:", error.message);
    }

    const miss = perJobMissing.length ? ` (missing: ${perJobMissing.join(", ")})` : "";
    const when = [isoDate, timeWindow].filter(Boolean).join(" ");
    console.log(`ingest: ${job.ref} created - ${j.client_ref ?? "-"} - ${when || "no date"} - ${items.length} item(s)`);
    return { ok: true,
      line: `${job.ref}${when ? ` · ${when}` : ""}${j.client_ref ? ` · ${j.client_ref}` : ""} — ${items.length} item(s)${miss}` };
  };

  // Sequential on purpose: job refs are allocated by the database and reading
  // them back in order makes the reply match the order of the schedule.
  const lines: string[] = [];
  let madeCount = 0, failedCount = 0;
  for (const j of jobList) {
    const r = await makeJob(j);
    lines.push(r.line);
    r.ok ? madeCount++ : failedCount++;
  }

  // The message points at the first job for the existing job_id link; every
  // job carries source_message_id, which is the real association.
  const { data: firstJob } = await sb.from("jobs")
    .select("id").eq("source_message_id", msg.id).order("created_at").limit(1).maybeSingle();
  if (firstJob) await sb.from("messages").update({ job_id: firstJob.id }).eq("id", msg.id);

  const docNote = storedDocs.length ? `, ${storedDocs.length} document(s) attached to each` : "";
  const failNote = failedCount ? ` ${failedCount} could not be created.` : "";
  const topMiss = ex.missing?.length ? ` Missing: ${ex.missing.join(", ")}.` : "";

  if (madeCount === 1 && !failedCount)
    return `${lines[0]}${docNote}, pending confirmation.${topMiss}`;

  return `${madeCount} job(s) created from this message${docNote}, pending confirmation:\n`
    + lines.map((l) => `  • ${l}`).join("\n") + `${failNote}${topMiss}`;
}

/**
 * Amendments are read twice.
 *
 * Pass one (already done by the caller) works out WHICH jobs are being talked
 * about. This resolves them, reads what they currently hold, and asks again -
 * with the job's real items in front of the parser.
 *
 * That second look is not a refinement, it is the difference between working
 * and not. Pass one is asked to name an item on a job it has never seen, so
 * every item amendment it proposes is a guess at a description, and a guess
 * that misses is refused. Pass two can point at "[1] Travel frame x2".
 *
 * If the second pass fails for any reason, the first pass's answer is used, so
 * an amendment is never lost to this being clever.
 */
export async function refineAmendments(
  // deno-lint-ignore no-explicit-any
  sb: any, tenantId: string, ex: Extraction,
  body: string, meta: string, typeList: string, hints = "",
): Promise<AmendmentIn[]> {
  const first = amendmentsOf(ex);
  if (!first.length) return first;

  // Resolve only to read them. Ambiguity is settled later, by planAmendments.
  const jobs: JobMatch[] = [];
  for (const a of first) {
    const { matches } = await resolveJob(sb, tenantId, a.existing_job_ref);
    if (matches.length === 1 && !jobs.some((j) => j.id === matches[0].id)) jobs.push(matches[0]);
  }
  if (!jobs.length) return first;

  try {
    const states = await readJobStates(sb, tenantId, jobs);
    const second = await extractAmendments(body, meta, typeList, renderJobStates(states), hints);
    if (!second.length) return first;

    // Anything pass one named that pass two dropped is kept, so a second look
    // can only ever add detail - never quietly lose a job.
    const seen = new Set(second.map((a) => String(a.existing_job_ref ?? "").toLowerCase()));
    const byRef = new Map(jobs.map((j) => [j.ref.toLowerCase(), j]));
    const missing = first.filter((a) => {
      const asked = String(a.existing_job_ref ?? "").toLowerCase();
      if (seen.has(asked)) return false;
      const resolved = [...byRef.values()].find((j) =>
        j.ref.toLowerCase() === asked || (j.client_ref ?? "").toLowerCase() === asked);
      return !(resolved && seen.has(resolved.ref.toLowerCase()));
    });
    return [...second, ...missing];
  } catch (e) {
    console.warn("ingest: second amendment pass failed, using the first:",
      e instanceof Error ? e.message : String(e));
    return first;
  }
}
