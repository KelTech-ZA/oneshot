// What the parser got wrong, kept.
//
// The signal this captures already exists and is thrown away a dozen times a
// day: a person reads a proposal, changes two fields, and presses Create. The
// change IS the correction, already labelled by someone who knows the answer.
// Until now the edited version was saved and the original forgotten, so the
// same mistake was available to be made again tomorrow.
//
// Nothing here decides anything. It records, the console shows, a person
// chooses. A parser that quietly retrains on its own output drifts somewhere
// nobody picked, and in a logistics system that means a crate at the wrong
// address with a confident audit trail behind it.

// deno-lint-ignore no-explicit-any
type Sb = any;

/** The fields worth comparing. Anything else is noise or housekeeping. */
const JOB_FIELDS = [
  "type", "client_ref", "scheduled_date", "time_window", "hard_deadline",
] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ---------------------------------------------------------------------------
// One shape, whichever end it came from
// ---------------------------------------------------------------------------
// A correction can arrive from two places that describe the same job in two
// different ways:
//
//   the PARSER'S proposal     items[].dimensions, quantity: 3
//   the DATABASE'S rows       attributes.dimensions, and THREE line_items rows
//
// Comparing those raw would report a difference in every field of every item
// on every job - a diff that screams constantly says nothing. So both ends are
// put into one canonical shape first, and the shape is what gets compared.

export interface CanonItem {
  description: string;
  dimensions: string | null;
  quantity: number;
  special_handling: string | null;
  declared_value: string | number | null;
}
export interface CanonStop {
  kind: string;
  address: string | null;
  label: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  notes: string | null;
}
export interface CanonCharge {
  description: string;
  quantity: number;
  unit: string | null;
  unit_price: number | null;
}

const text = (v: unknown): string | null => {
  const s = v == null ? "" : String(v).trim();
  return s === "" ? null : s;
};
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** For MATCHING only - never for display, and never written to the record. */
const key = (v: unknown): string =>
  String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * One job, from either end.
 *
 * `fromDb` says which dialect the collections are in. The scalar fields have
 * the same names on both sides, which is why only the collections need it.
 */
export function canonJob(
  job: Record<string, unknown>,
  fromDb = false,
): Record<string, unknown> {
  const raw = (k: string) => (job?.[k] ?? null);

  const stopsIn = Array.isArray(job?.stops) ? job.stops as Record<string, unknown>[] : [];
  const stops: CanonStop[] = stopsIn.map((s) => ({
    kind: String(s?.kind ?? "delivery"),
    address: text(s?.address),
    label: text(s?.label),
    contact_name: text(s?.contact_name),
    contact_phone: text(s?.contact_phone),
    notes: text(s?.notes),
  }));

  const itemsIn = Array.isArray(job?.items) ? job.items as Record<string, unknown>[] : [];
  let items: CanonItem[];
  if (fromDb) {
    // The database stores quantity by REPEATING the row - three crates are
    // three line_items - and the extras live in an attributes object. Fold
    // them back into one entry per distinct thing, or every multi-item job
    // would look like the reader had added items they never touched.
    const byThing = new Map<string, CanonItem>();
    for (const it of itemsIn) {
      const attrs = (it?.attributes ?? {}) as Record<string, unknown>;
      const one: CanonItem = {
        description: String(it?.description ?? "").trim(),
        dimensions: text(attrs?.dimensions),
        quantity: 1,
        special_handling: text(attrs?.special_handling),
        declared_value: text(attrs?.declared_value),
      };
      const k = `${key(one.description)}|${key(one.dimensions)}`;
      const seen = byThing.get(k);
      if (seen) seen.quantity += 1;
      else byThing.set(k, one);
    }
    items = [...byThing.values()];
  } else {
    items = itemsIn.map((it) => ({
      description: String(it?.description ?? "").trim(),
      dimensions: text(it?.dimensions),
      quantity: num(it?.quantity) ?? 1,
      special_handling: text(it?.special_handling),
      declared_value: text(it?.declared_value),
    }));
  }

  const chargesIn = Array.isArray(job?.charges) ? job.charges as Record<string, unknown>[] : [];
  const charges: CanonCharge[] = chargesIn.map((c) => ({
    description: String(c?.description ?? "").trim(),
    quantity: num(c?.quantity) ?? 1,
    unit: text(c?.unit),
    unit_price: num(c?.unit_price),
  }));

  return {
    type: text(raw("type")),
    client_ref: text(raw("client_ref")),
    scheduled_date: text(raw("scheduled_date")),
    time_window: text(raw("time_window")),
    hard_deadline: !!raw("hard_deadline"),
    stops, items, charges,
    billing: (job?.billing ?? null) as Record<string, unknown> | null,
  };
}

// ---------------------------------------------------------------------------
// Diffing INSIDE a collection
// ---------------------------------------------------------------------------
// The old version compared whole arrays: ["Travel frame"] against ["Travel
// frame - 367 x 16 x 176cm"] recorded as `items: {from: [...], to: [...]}`.
// True, and useless - it says the reader rewrote the items and nothing about
// what was wrong with them. "Dimensions keep ending up in the description" is
// a lesson; "items changed, 47 times" is not.
//
// So entries are MATCHED first and then compared field by field. Matching is
// by name where there is one, falling back to position, because the common
// case is a reader correcting one field of something that is obviously still
// the same thing.

/** Pair up two lists. Returns matched pairs plus what is only on one side. */
function pairUp<T>(
  from: T[], to: T[], nameOf: (x: T) => string,
): { pairs: [number, T, T][]; added: T[]; removed: T[] } {
  const pairs: [number, T, T][] = [];
  const usedFrom = new Set<number>();
  const usedTo = new Set<number>();

  // Pass one: by name. A reader who corrects a price has not renamed the
  // charge, so this catches most real corrections exactly.
  const byName = new Map<string, number[]>();
  from.forEach((x, i) => {
    const n = nameOf(x);
    if (!n) return;
    const list = byName.get(n) ?? [];
    list.push(i);
    byName.set(n, list);
  });
  to.forEach((x, j) => {
    const n = nameOf(x);
    if (!n) return;
    const list = byName.get(n);
    while (list && list.length) {
      const i = list.shift()!;
      if (usedFrom.has(i)) continue;
      usedFrom.add(i); usedTo.add(j);
      pairs.push([j, from[i], x]);
      return;
    }
  });

  // Pass two: by position, for whatever is left. This is the case where the
  // NAME itself was the correction - "Framed photograph - 100 x 90 cm"
  // becoming "Framed photograph" - which is the single most valuable pairing
  // of the lot and the one a name match can never make.
  for (let i = 0; i < from.length; i++) {
    if (usedFrom.has(i) || usedTo.has(i) || i >= to.length) continue;
    usedFrom.add(i); usedTo.add(i);
    pairs.push([i, from[i], to[i]]);
  }

  pairs.sort((a, b) => a[0] - b[0]);
  return {
    pairs,
    added: to.filter((_, j) => !usedTo.has(j)),
    removed: from.filter((_, i) => !usedFrom.has(i)),
  };
}

/** Compare matched entries field by field, writing `label[i].field` keys. */
function diffList<T>(
  label: string, from: T[], to: T[],
  nameOf: (x: T) => string, fields: readonly string[],
  describe: (x: T) => string,
  edits: Record<string, { from: unknown; to: unknown }>,
  prefix: string,
): void {
  const { pairs, added, removed } = pairUp(from, to, nameOf);
  const at = (x: T, f: string) => (x as Record<string, unknown>)[f];
  for (const [i, a, b] of pairs) {
    for (const f of fields) {
      if (!same(at(a, f), at(b, f))) {
        edits[`${prefix}${label}[${i}].${f}`] = { from: at(a, f) ?? null, to: at(b, f) ?? null };
      }
    }
  }
  // Added and removed are collected rather than listed one by one: the lesson
  // is "the reader added two items", not two separate lessons.
  if (added.length) edits[`${prefix}${label}.added`] = { from: null, to: added.map(describe) };
  if (removed.length) edits[`${prefix}${label}.removed`] = { from: removed.map(describe), to: null };
}

const ITEM_FIELDS = ["description", "dimensions", "quantity", "special_handling", "declared_value"] as const;
const STOP_FIELDS = ["address", "label", "contact_name", "contact_phone", "notes"] as const;
const CHARGE_FIELDS = ["description", "quantity", "unit", "unit_price"] as const;


function diffCollections(
  p: Record<string, unknown>, a: Record<string, unknown>,
  edits: Record<string, { from: unknown; to: unknown }>, prefix: string,
): void {
  // Stops are matched within their kind. A collection and a delivery are never
  // the same stop however alike their addresses look, and pairing them would
  // report a corrected address that nobody ever typed.
  const ps = (p.stops ?? []) as CanonStop[], as_ = (a.stops ?? []) as CanonStop[];
  for (const kind of ["collection", "delivery", "site"]) {
    diffList(
      `stops.${kind}`,
      ps.filter((s) => s.kind === kind), as_.filter((s) => s.kind === kind),
      (s) => key(s.address), STOP_FIELDS,
      (s) => s.address ?? s.label ?? "(no address)",
      edits, prefix,
    );
  }

  diffList(
    "items", (p.items ?? []) as CanonItem[], (a.items ?? []) as CanonItem[],
    (i) => key(i.description), ITEM_FIELDS,
    (i) => i.description || "(no description)",
    edits, prefix,
  );

  diffList(
    "charges", (p.charges ?? []) as CanonCharge[], (a.charges ?? []) as CanonCharge[],
    (c) => key(c.description), CHARGE_FIELDS,
    (c) => c.description || "(no description)",
    edits, prefix,
  );

  // Billing is one object, so it diffs key by key. "bill_to_name was wrong
  // eleven times" is a rate-card or client-alias problem; "billing changed"
  // is not anything.
  const pb = (p.billing ?? null) as Record<string, unknown> | null;
  const ab = (a.billing ?? null) as Record<string, unknown> | null;
  if (pb || ab) {
    for (const f of new Set([...Object.keys(pb ?? {}), ...Object.keys(ab ?? {})])) {
      if (!same(pb?.[f], ab?.[f])) {
        edits[`${prefix}billing.${f}`] = { from: pb?.[f] ?? null, to: ab?.[f] ?? null };
      }
    }
  }
}

/**
 * Field-by-field difference between what was proposed and what was approved.
 *
 * Jobs are aligned by position, which is right in practice: a reader edits the
 * card in front of them rather than reordering it. A job added or removed
 * shows up as its own entry rather than shifting every field after it, because
 * "they deleted the third job" and "they changed everything from the third job
 * onwards" are very different lessons.
 *
 * `fromDb` marks the ACCEPTED side as having come out of the database rather
 * than from a reader's edit of the proposal - the case where a job made from
 * an email is corrected in the office days later. Only the accepted side can
 * be in that dialect; the proposal is always the parser's own JSON.
 */
export function diffJobs(
  proposed: Record<string, unknown>[],
  accepted: Record<string, unknown>[],
  fromDb = false,
): Record<string, { from: unknown; to: unknown }> {
  const edits: Record<string, { from: unknown; to: unknown }> = {};

  if (proposed.length !== accepted.length) {
    edits["jobs.count"] = { from: proposed.length, to: accepted.length };
  }

  const n = Math.min(proposed.length, accepted.length);
  for (let i = 0; i < n; i++) {
    const p = canonJob(proposed[i] ?? {});
    const a = canonJob(accepted[i] ?? {}, fromDb);
    const prefix = proposed.length > 1 ? `jobs[${i}].` : "";

    for (const f of JOB_FIELDS) {
      if (!same(p[f], a[f])) edits[`${prefix}${f}`] = { from: p[f] ?? null, to: a[f] ?? null };
    }

    diffCollections(p, a, edits, prefix);
  }

  return edits;
}

/** The same, for an amendment: which proposed changes the reader kept. */
export function diffChanges(
  proposed: { field: string; label?: string; to?: unknown }[],
  accepted: { field: string; to?: unknown }[],
): Record<string, { from: unknown; to: unknown }> {
  const edits: Record<string, { from: unknown; to: unknown }> = {};
  const kept = new Set(accepted.map((c) => `${c.field}:${JSON.stringify(c.to ?? null)}`));

  for (const c of proposed) {
    // A line the reader unticked is the clearest correction the app ever gets:
    // the parser proposed it, somebody who knew better said no.
    if (!kept.has(`${c.field}:${JSON.stringify(c.to ?? null)}`)) {
      edits[`rejected.${c.field}`] = { from: c.to ?? null, to: null };
    }
  }
  return edits;
}

export interface FeedbackIn {
  tenantId: string;
  messageId?: string | null;
  jobId?: string | null;
  channel: string;
  surface: "create" | "amend";
  proposed: unknown;
  accepted: unknown;
  edits: Record<string, { from: unknown; to: unknown }>;
  confidence?: number | null;
  approvedBy?: string | null;
}

/**
 * Write one row. Never throws: a job must not fail to be created because the
 * app could not record how it felt about it.
 */
export async function recordFeedback(sb: Sb, f: FeedbackIn): Promise<void> {
  try {
    const { error } = await sb.from("parse_feedback").insert({
      tenant_id: f.tenantId,
      message_id: f.messageId ?? null,
      job_id: f.jobId ?? null,
      channel: f.channel,
      surface: f.surface,
      proposed: f.proposed ?? {},
      accepted: f.accepted ?? {},
      edits: f.edits ?? {},
      edited: Object.keys(f.edits ?? {}).length > 0,
      confidence: f.confidence ?? null,
      approved_by: f.approvedBy ?? null,
    });
    if (error) console.warn("feedback not recorded:", error.message);
  } catch (e) {
    console.warn("feedback not recorded:", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Note a word this workspace has no entry for. Also never throws, and
 * deliberately cheap: it is called from inside job creation.
 */
export async function noteVocab(
  sb: Sb, tenantId: string, kind: "job_type" | "charge_type" | "client_name" | "term",
  term: string | null | undefined, example?: string | null,
): Promise<void> {
  const t = String(term ?? "").trim();
  if (!t || t.length > 120) return;
  try {
    const { error } = await sb.rpc("note_vocab", {
      p_tenant: tenantId, p_kind: kind, p_term: t, p_example: example ?? null,
    });
    if (error) console.warn("vocab not noted:", error.message);
  } catch (e) {
    console.warn("vocab not noted:", e instanceof Error ? e.message : String(e));
  }
}
