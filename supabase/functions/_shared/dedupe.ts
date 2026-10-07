// Jobs the board could not tell apart.
//
// The intake prompt tells the parser to split a message into several jobs when
// the activities differ in date, time, job type or client - which is right, and
// is how one email asking for a crate to be built, packed and exported becomes
// three jobs. Section 9 wants those three: the workshop builds, somebody else
// ships, and they are billed apart.
//
// What it was also doing was splitting AGAIN per item. One mail about three
// pieces for the same fair produced three "fabrication" jobs with the same
// client reference, the same date and no times - three rows on the board that
// nobody, including the person who sent the mail, could tell apart. The worst
// case seen was eight jobs from one message: fabrication three times, packing
// three times.
//
// The rule here is deliberately the operational one rather than a clever one:
//
//   IF TWO JOBS WOULD LOOK IDENTICAL TO THE PERSON READING THE BOARD,
//   THEY ARE ONE JOB.
//
// Same type, same client reference, same date, same time window. Those four
// are what the board shows and what a person sorts by. Differ in any of them -
// 08:15 collect and 12:30 deliver, two clients, two days - and nothing is
// merged, so a real schedule still produces the jobs it should.
//
// Addresses deliberately do NOT enter the comparison. Collecting from two
// places for one consignment is one job with two stops, which the prompt
// already says in PAIRED LEGS ARE ONE JOB; merging unions the stops rather
// than throwing the second address away.
//
// Nothing is lost and nothing is silent: items, stops and charges from the
// merged entries are carried onto the survivor, and the job gets a flag saying
// it happened, so a merge that was wrong is visible on the card rather than
// being something only this file knows about.

type Job = Record<string, unknown>;

const text = (v: unknown) => String(v ?? "").trim().toLowerCase();

/** The four fields the board shows. Two jobs agreeing on all four are one. */
function signature(j: Job): string {
  return [
    text(j.type),
    text(j.client_ref),
    text(j.scheduled_date),
    text(j.time_window),
  ].join("\u0000");
}

const listOf = (j: Job, key: string): Record<string, unknown>[] =>
  Array.isArray(j[key]) ? (j[key] as Record<string, unknown>[]).filter(Boolean) : [];

/** How a stop is recognised as the same stop. */
const stopKey = (s: Record<string, unknown>) =>
  [text(s.kind) || "delivery", text(s.address), text(s.label)].join("\u0000");

/** How an item is recognised as the same item. */
const itemKey = (i: Record<string, unknown>) =>
  [text(i.description), text(i.dimensions)].join("\u0000");

const chargeKey = (c: Record<string, unknown>) =>
  [text(c.description), text(c.unit), text(c.unit_price)].join("\u0000");

/**
 * Collapse jobs that are indistinguishable, keeping the first of each group.
 *
 * Items are unioned ACROSS the merge boundary only: two identical descriptions
 * inside one entry are two real items and both are kept, while the same
 * description arriving again from a duplicated entry is the artefact and is
 * dropped. That distinction is the whole point - a job really can carry two
 * identical crates, and a parser really did repeat the same crate three times.
 */
export function dedupeJobs(jobs: Job[]): Job[] {
  if (!Array.isArray(jobs) || jobs.length < 2) return Array.isArray(jobs) ? jobs : [];

  const order: string[] = [];
  const bySig = new Map<string, { job: Job; merged: number }>();

  for (const j of jobs) {
    if (!j || typeof j !== "object") continue;
    const sig = signature(j);
    const seen = bySig.get(sig);

    if (!seen) {
      order.push(sig);
      // Copied, so the caller's extraction is never mutated underneath it -
      // the original proposal is sent back for the learning diff and has to
      // stay exactly as the model wrote it.
      bySig.set(sig, { job: { ...j }, merged: 0 });
      continue;
    }

    const into = seen.job;
    seen.merged++;

    // Stops: union, because two collection addresses for one consignment are
    // two stops on one job.
    const stops = listOf(into, "stops");
    const haveStop = new Set(stops.map(stopKey));
    for (const s of listOf(j, "stops")) {
      if (haveStop.has(stopKey(s))) continue;
      haveStop.add(stopKey(s));
      stops.push(s);
    }
    if (stops.length) into.stops = stops;

    const items = listOf(into, "items");
    const haveItem = new Set(items.map(itemKey));
    for (const it of listOf(j, "items")) {
      if (haveItem.has(itemKey(it))) continue;
      haveItem.add(itemKey(it));
      items.push(it);
    }
    if (items.length) into.items = items;

    const charges = listOf(into, "charges");
    const haveCharge = new Set(charges.map(chargeKey));
    for (const c of listOf(j, "charges")) {
      if (haveCharge.has(chargeKey(c))) continue;
      haveCharge.add(chargeKey(c));
      charges.push(c);
    }
    if (charges.length) into.charges = charges;

    // A deadline asserted anywhere about this job is a deadline on it.
    if (j.hard_deadline) into.hard_deadline = true;

    // Fill blanks from the later entry; never overwrite something already read.
    for (const k of ["origin", "destination", "billing"]) {
      if ((into[k] === null || into[k] === undefined) && j[k] != null) into[k] = j[k];
    }

    // What either entry said was missing is still missing.
    const miss = new Set<string>([
      ...(Array.isArray(into.missing) ? into.missing as string[] : []),
      ...(Array.isArray(j.missing) ? j.missing as string[] : []),
    ].filter((x) => typeof x === "string"));
    if (miss.size) into.missing = [...miss];
  }

  const out: Job[] = [];
  for (const sig of order) {
    const entry = bySig.get(sig)!;
    if (entry.merged > 0) {
      // Said out loud on the job card. A merge that was wrong is then a thing
      // somebody can see and undo, rather than a job quietly missing.
      const flags = Array.isArray(entry.job.flags) ? entry.job.flags as string[] : [];
      const n = entry.merged + 1;
      flags.push(
        `check:merged_duplicates — the message produced ${n} "${String(entry.job.type ?? "job")}" `
        + `entries with the same reference, date and time; they were read as one job. `
        + `Split it if that is wrong.`,
      );
      entry.job.flags = flags;
    }
    out.push(entry.job);
  }
  return out;
}
