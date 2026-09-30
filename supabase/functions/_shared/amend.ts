// Finding the job an amendment is about, and changing it without guessing.
//
// Amendments used to work in exactly one case: a sender who wrote the job's
// full ref, "JOB-2026-0161", and asked to change one of five columns. Everyone
// else got "I couldn't find it", or worse, a patch that went somewhere.
//
// Three things are fixed here.
//
//   1. FINDING. "0161", "job 161", "Moshekwa/Melly" and "JOB-2026-0161" are
//      all how a real sender names a job. resolve() tries them in order of how
//      certain each is, and stops at the first tier that hits.
//
//   2. NEVER GUESSING. When a reference matches more than one job, or none,
//      nothing is written and the candidates come back for a human to choose
//      from. A patch applied to the wrong job is worse than no patch, because
//      nobody finds out until the truck is at the wrong address.
//
//   3. CHANGING MORE THAN FIVE FIELDS. Addresses live in job_stops, not in
//      jobs.origin - that column is filled by a trigger from the primary stop,
//      so the old code writing to it was fighting the database. Stops and items
//      are where real amendments land: "add a second collection", "make it 4
//      crates".
//
// Every change is computed as a before-and-after pair before anything is
// written, so the custody event says what it was as well as what it became.
// That is what makes an amendment auditable, and what fills the diff card the
// reader approves in the extension.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

// deno-lint-ignore no-explicit-any
type Sb = SupabaseClient<any, "public", any>;

const JOB_FIELDS =
  "id,ref,client_ref,type,status,scheduled_date,time_window,hard_deadline,created_at";

export interface JobMatch {
  id: string;
  ref: string;
  client_ref: string | null;
  type: string | null;
  status: string | null;
  scheduled_date: string | null;
  time_window: string | null;
  hard_deadline?: boolean | null;
  /** How this job was found, in words a reader can check: "job number 0161". */
  why: string;
}

export interface Resolution {
  matches: JobMatch[];
  /** What was looked for, for a reply that has to explain itself. */
  looked_for: string;
}

/**
 * PostgREST reads commas and parentheses as filter syntax, and ILIKE reads %
 * and _ as wildcards. A reference is letters, digits and light punctuation, so
 * everything else becomes a space rather than being escaped through two
 * layers. A client reference is never distinguished solely by a comma.
 */
function safe(s: string): string {
  return String(s ?? "")
    .replace(/[^A-Za-z0-9 /&.'\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * The bare number in a reference, if that is all it is. "0161", "job 161",
 * "Job number 0161" and "#161" all yield digits; "Moshekwa/Melly" does not.
 */
function bareNumber(raw: string): string | null {
  const stripped = raw
    .replace(/\b(job|number|no|nr|num|ref|reference|our|your)\b/gi, "")
    .replace(/[#:\-\s.]/g, "");
  return /^\d{1,6}$/.test(stripped) ? stripped : null;
}

/**
 * Find the job a human meant. Tiers run most certain first and the first tier
 * that returns anything wins, so an exact ref is never diluted by a fuzzy
 * client-reference match. Returns up to 6 candidates; more than one means the
 * caller must ask.
 */
export async function resolveJob(
  sb: Sb,
  tenantId: string,
  hint: string | null | undefined,
): Promise<Resolution> {
  const raw = String(hint ?? "").trim();
  const clean = safe(raw);
  if (!clean) return { matches: [], looked_for: raw || "(no reference given)" };

  const base = () =>
    sb.from("jobs").select(JOB_FIELDS).eq("tenant_id", tenantId)
      .order("created_at", { ascending: false }).limit(7);

  const found = (rows: unknown[] | null, why: string, looked: string): Resolution | null => {
    const list = (rows ?? []) as JobMatch[];
    if (!list.length) return null;
    return { matches: list.slice(0, 6).map((r) => ({ ...r, why })), looked_for: looked };
  };

  // 1. The ref as written: "JOB-2026-0161".
  {
    const { data } = await base().ilike("ref", clean);
    const hit = found(data, "job number", clean);
    if (hit) return hit;
  }

  // 2. A bare number. Refs end in a zero-padded sequence, so 161 is 0161.
  const digits = bareNumber(raw);
  if (digits) {
    const padded = digits.padStart(4, "0");
    const { data } = await base().ilike("ref", `%-${padded}`);
    const hit = found(data, `job number ${padded}`, `job number ${padded}`);
    if (hit) return hit;
  }

  // 3. The client's own reference, as written. This is the "Moshekwa/Melly"
  //    case, and in practice the commonest way a sender names a job.
  {
    const { data } = await base().ilike("client_ref", clean);
    const hit = found(data, "their reference", clean);
    if (hit) return hit;
  }

  // 4. The client's reference, partially. A sender who wrote "Moshekwa" about
  //    a job filed as "Moshekwa/Melly" still meant that job.
  if (clean.length >= 3) {
    const { data } = await base().ilike("client_ref", `%${clean}%`);
    const hit = found(data, "part of their reference", clean);
    if (hit) return hit;
  }

  // 5. Last resort: the ref, partially.
  if (clean.length >= 3) {
    const { data } = await base().ilike("ref", `%${clean}%`);
    const hit = found(data, "part of the job number", clean);
    if (hit) return hit;
  }

  return { matches: [], looked_for: clean };
}

// ---------------------------------------------------------------------------
// What may change
// ---------------------------------------------------------------------------

/** Columns on jobs that an amendment may set, and how to name them to a human. */
const DIRECT: Record<string, string> = {
  scheduled_date: "Date",
  time_window: "Time / window",
  type: "Job type",
  client_ref: "Their reference",
  hard_deadline: "Hard deadline",
};

/**
 * Words a sender or a parser may use for each column. The parser is told the
 * real names, but it is a language model reading free text, so "date" and
 * "collection_date" both arrive in practice.
 */
const ALIASES: Record<string, string> = {
  date: "scheduled_date",
  scheduled_date: "scheduled_date",
  collection_date: "scheduled_date",
  delivery_date: "scheduled_date",
  time: "time_window",
  time_window: "time_window",
  window: "time_window",
  type: "type",
  job_type: "type",
  client_ref: "client_ref",
  reference: "client_ref",
  their_reference: "client_ref",
  hard_deadline: "hard_deadline",
  deadline: "hard_deadline",
};

const STOP_KINDS = ["collection", "delivery", "site"] as const;
type StopKind = typeof STOP_KINDS[number];

export interface Change {
  field: string;
  /** What to call it on screen. */
  label: string;
  from: unknown;
  to: unknown;
  /** For an item edit: the rows it touches. Re-checked against the job on apply. */
  ids?: string[];
  /** For an item edit: which attribute, e.g. "dimensions". */
  attr?: string;
  /** For an item being added: the whole row, so its dimensions survive. */
  item?: { description: string; quantity: number; attributes: Record<string, unknown> };
}

export interface Proposal {
  changes: Change[];
  /** Things the parser asked for that cannot be done, said plainly. */
  refused: string[];
}

interface ItemRow {
  id: string;
  description: string | null;
  attributes: Record<string, unknown> | null;
}

/** The attributes an amendment may correct on an existing item. */
const ITEM_ATTRS = ["dimensions", "declared_value", "special_handling"] as const;

/**
 * Which rows a "match" names. A job of 3 identical crates is 3 rows sharing a
 * description, and a corrected dimension applies to all of them - so matching
 * returns every row that answers to the name, not the first.
 *
 * A bare number means position: "1" is the first distinct item on the job.
 */
function matchItems(rows: ItemRow[], match: string): ItemRow[] {
  // The parser is shown items as "[1] Travel frame", so it refers to them that
  // way. Strip the brackets rather than make the prompt and the matcher
  // disagree about the notation.
  const want = match.trim().toLowerCase().replace(/^\[(\d{1,3})\]$/, "$1");

  const exact = rows.filter((r) => String(r.description ?? "").trim().toLowerCase() === want);
  if (exact.length) return exact;

  // A number is a ROW, and exactly one row. This is how an amendment gives two
  // otherwise identical frames two different dimensions.
  if (/^\d{1,3}$/.test(want)) {
    const row = rows[Number(want) - 1];
    return row ? [row] : [];
  }

  // Partial, but only if it names exactly one item - "frame" must not silently
  // pick between "Travel frame" and "Crate frame".
  const near = rows.filter((r) => String(r.description ?? "").toLowerCase().includes(want));
  const names = new Set(near.map((r) => String(r.description ?? "").trim().toLowerCase()));
  return names.size === 1 ? near : [];
}

const isoDate = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

const asText = (v: unknown, max = 200): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

const asBool = (v: unknown): boolean | null => {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(s)) return true;
  if (["false", "no", "n", "0"].includes(s)) return false;
  return null;
};

/** One address, however the parser chose to express it. */
function stopText(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return asText(v, 400);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return asText(o.address ?? o.label ?? o.name ?? null, 400);
  }
  return asText(v, 400);
}

/**
 * Turn what the parser proposed into a list of before-and-after pairs against
 * the job as it stands. Nothing is written here: this is what the reader sees,
 * and what they approve is what apply() receives.
 *
 * Unchanged values are dropped, so a parser that echoes the whole job back
 * produces a card listing only what actually moved.
 */
export async function planAmendment(
  sb: Sb,
  tenantId: string,
  job: JobMatch,
  raw: Record<string, unknown>,
  legalTypes: string[] = [],
): Promise<Proposal> {
  const changes: Change[] = [];
  const refused: string[] = [];
  const seen = new Set<string>();

  // ---- plain columns ----
  for (const [key, value] of Object.entries(raw ?? {})) {
    const col = ALIASES[key.toLowerCase()];
    if (!col || seen.has(col)) continue;

    if (col === "scheduled_date") {
      const d = isoDate(value);
      if (!d) { refused.push(`"${key}: ${String(value)}" is not a date I can trust`); continue; }
      if (d !== (job.scheduled_date ?? null)) {
        changes.push({ field: col, label: DIRECT[col], from: job.scheduled_date, to: d });
      }
      seen.add(col);
      continue;
    }

    if (col === "hard_deadline") {
      const b = asBool(value);
      if (b === null) continue;
      if (b !== !!job.hard_deadline) {
        changes.push({ field: col, label: DIRECT[col], from: !!job.hard_deadline, to: b });
      }
      seen.add(col);
      continue;
    }

    if (col === "type") {
      const t = asText(value, 40);
      if (!t) continue;
      if (legalTypes.length && !legalTypes.includes(t)) {
        refused.push(`"${t}" is not one of this workspace's job types`);
        continue;
      }
      if (t !== (job.type ?? null)) {
        changes.push({ field: col, label: DIRECT[col], from: job.type, to: t });
      }
      seen.add(col);
      continue;
    }

    // time_window, client_ref
    const t = asText(value, col === "time_window" ? 80 : 120);
    const current = col === "time_window" ? job.time_window : job.client_ref;
    if (t !== (current ?? null)) {
      changes.push({ field: col, label: DIRECT[col], from: current, to: t });
    }
    seen.add(col);
  }

  // ---- addresses ----
  //
  // These live in job_stops. jobs.origin and jobs.destination are filled by a
  // trigger from the primary stop of each kind, so a parser that reported
  // "origin" is talking about the first collection, and is translated to it.
  const stopEdits: { kind: StopKind; seq: number; address: string }[] = [];
  const pushStop = (kind: StopKind, seq: number, address: string | null) => {
    if (!address) return;
    stopEdits.push({ kind, seq, address });
  };

  pushStop("collection", 0, stopText(raw.origin ?? raw.collection ?? raw.collection_address));
  pushStop("delivery", 0, stopText(raw.destination ?? raw.delivery ?? raw.delivery_address));

  if (Array.isArray(raw.stops)) {
    const nextSeq: Record<string, number> = { collection: 0, delivery: 0, site: 0 };
    for (const s of raw.stops as Record<string, unknown>[]) {
      const kind = (STOP_KINDS as readonly string[]).includes(String(s?.kind))
        ? String(s.kind) as StopKind
        : "delivery";
      const seq = Number.isInteger(s?.seq) ? Number(s.seq) : nextSeq[kind]++;
      if (seq > 2) { refused.push(`a fourth ${kind} - three is the limit`); continue; }
      pushStop(kind, seq, stopText(s));
    }
  }

  if (stopEdits.length) {
    const { data: current } = await sb.from("job_stops")
      .select("id,kind,seq,address").eq("job_id", job.id);
    const byKey = new Map(
      ((current ?? []) as Record<string, unknown>[])
        .map((r) => [`${r.kind}:${r.seq}`, r]),
    );
    for (const edit of stopEdits) {
      const key = `${edit.kind}:${edit.seq}`;
      const was = byKey.get(key);
      const from = (was?.address as string | null) ?? null;
      if (from === edit.address) continue;
      const nth = edit.seq === 0 ? "" : ` ${edit.seq + 1}`;
      changes.push({
        field: `stop:${key}`,
        label: `${edit.kind[0].toUpperCase()}${edit.kind.slice(1)}${nth}`,
        from,
        to: edit.address,
      });
    }
  }

  // ---- items ----
  //
  // Two different things wear the same word. ADDING an item appends a row.
  // CORRECTING one - new dimensions, a revised size - changes rows already on
  // the job, and getting that wrong by adding a duplicate instead is much
  // harder to undo than to prevent. An entry carrying "match" is a correction.
  //
  // Removing is neither: an item may already carry custody events, photographs
  // and a signature, so removals are reported rather than performed.
  // The whole list, reconciled. This is the normal way an amendment changes
  // items and it is tried first: the message says what the job holds, and the
  // difference against what it holds now IS the change.
  const replacement = desiredItems(raw.items_replace);
  if (replacement.length) {
    const [{ data: rawRows }, { data: events }] = await Promise.all([
      sb.from("line_items").select("id,description,attributes").eq("job_id", job.id).order("created_at"),
      sb.from("custody_events").select("item_id").eq("job_id", job.id).not("item_id", "is", null),
    ]);
    const handled = new Set(((events ?? []) as { item_id: string }[]).map((e) => e.item_id));
    const plan = planItemReplacement(job, replacement, (rawRows ?? []) as ItemRow[], handled);
    changes.push(...plan.changes);
    refused.push(...plan.refused);
  }

  const entries = Array.isArray(raw.items) ? raw.items as Record<string, unknown>[] : [];
  if (entries.length) {
    const { data: existingRows } = await sb.from("line_items")
      .select("id,description,attributes").eq("job_id", job.id);
    const rows = (existingRows ?? []) as ItemRow[];
    const have = new Set(rows.map((r) => String(r.description ?? "").trim().toLowerCase()));

    for (const it of entries) {
      const matchOn = asText(it?.match ?? null, 200);

      // --- a correction to something already there ---
      if (matchOn) {
        const targets = matchItems(rows, matchOn);
        if (!targets.length) {
          refused.push(`no item matching "${matchOn}" on ${job.ref}`);
          continue;
        }
        const ids = targets.map((r) => r.id);
        const label = targets[0].description ?? matchOn;
        const n = targets.length > 1 ? ` (${targets.length} rows)` : "";

        const newDesc = asText(it?.description ?? null, 200);
        if (newDesc && newDesc !== targets[0].description) {
          changes.push({
            field: "item:set", attr: "description", ids,
            label: `Item "${label}"${n}`, from: targets[0].description ?? null, to: newDesc,
          });
        }
        for (const attr of ITEM_ATTRS) {
          if (!(attr in it)) continue;
          const to = asText(it[attr], 200);
          const from = asText((targets[0].attributes ?? {})[attr], 200);
          if (to === from) continue;

          // A measurement describes ONE physical object. Writing a single set
          // of dimensions onto several rows at once is how four frames of
          // different sizes ended up recorded as three identical pairs, so a
          // dimensions change that would touch more than one row is refused
          // and the numbers are asked for instead. Handling notes and declared
          // values are genuinely shared, so they pass.
          if (attr === "dimensions" && targets.length > 1) {
            refused.push(
              `dimensions for "${label}" on ${job.ref} - that name covers `
              + `${targets.length} separate items, and one measurement cannot describe `
              + `${targets.length > 2 ? "them all" : "both"}. Give each its own number`,
            );
            continue;
          }

          changes.push({
            field: "item:set", attr, ids,
            label: `Item "${label}"${n} ${attr.replace(/_/g, " ")}`, from, to,
          });
        }
        continue;
      }

      // --- a new item ---
      const desc = asText(it?.description ?? it, 200);
      if (!desc) continue;
      if (have.has(desc.toLowerCase())) continue;
      const qty = Math.max(1, Math.min(200, Number(it?.quantity ?? 1) || 1));
      changes.push({
        field: "item:add",
        label: "Add item",
        from: null,
        to: qty > 1 ? `${qty} x ${desc}` : desc,
      });
    }
  }
  // ---- items being removed ----
  //
  // This used to be refused outright, on the grounds that an item might carry
  // custody events and photographs. That is true of SOME items and was applied
  // to all of them, which made a whole class of ordinary amendment impossible:
  // "those two Serge frames are off, it's four frames for Mawande and Deborah
  // now" is a replacement, and a replacement needs a removal.
  //
  // So the test is now per item, and it is the real one: has anything been
  // recorded against it? An item nobody has touched can go. An item with
  // custody events cannot, because deleting the row orphans the record of what
  // was handled - and that record is what OneShot is for.
  const removals = Array.isArray(raw.remove_items)
    ? (raw.remove_items as unknown[]).map((v) => asText(v, 200)).filter(Boolean) as string[]
    : [];
  if (removals.length) {
    const { data: rawRows } = await sb.from("line_items")
      .select("id,description,attributes").eq("job_id", job.id);
    const rows = (rawRows ?? []) as ItemRow[];
    const { data: events } = await sb.from("custody_events")
      .select("item_id").eq("job_id", job.id).not("item_id", "is", null);
    const touched = new Set(((events ?? []) as { item_id: string }[]).map((e) => e.item_id));

    for (const want of removals) {
      const targets = matchItems(rows, want);
      if (!targets.length) { refused.push(`no item matching "${want}" on ${job.ref}`); continue; }

      const locked = targets.filter((r) => touched.has(r.id));
      if (locked.length) {
        refused.push(
          `"${targets[0].description ?? want}" on ${job.ref} has already been handled - `
          + `it carries custody events, so it must be removed in the app, not by mail`,
        );
        continue;
      }
      const n = targets.length > 1 ? ` (${targets.length})` : "";
      changes.push({
        field: "item:remove", ids: targets.map((r) => r.id),
        label: "Remove item", from: `${targets[0].description ?? want}${n}`, to: null,
      });
    }
  }

  return { changes, refused };
}

export interface DesiredItem {
  description: string;
  quantity: number;
  attributes: Record<string, unknown>;
}

/** What the parser said the job should hold, cleaned up. */
export function desiredItems(raw: unknown): DesiredItem[] {
  if (!Array.isArray(raw)) return [];
  const out: DesiredItem[] = [];
  for (const v of raw) {
    const o = (v && typeof v === "object" ? v : { description: v }) as Record<string, unknown>;
    const description = asText(o.description ?? o.item ?? null, 200);
    if (!description) continue;
    const attributes: Record<string, unknown> = {};
    for (const a of ITEM_ATTRS) {
      const t = asText(o[a], 200);
      if (t !== null) attributes[a] = t;
    }
    out.push({
      description,
      quantity: Math.max(1, Math.min(200, Number(o.quantity ?? 1) || 1)),
      attributes,
    });
  }
  return out;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Reconcile the job's items against the list the message describes.
 *
 * This is how a person reads an amendment, and it is the primitive the
 * field-by-field version should have been from the start: take in what the
 * message says the job holds, match up what you can against what is already
 * there, and whatever is left over is the change. Rows that still answer to a
 * description stay and are corrected; rows nothing claims any more go; details
 * with no row to sit on become new rows.
 *
 * Doing it this way removes the failure that produced three frames with one
 * measurement between them: the parser never has to name an existing row, so
 * it never has to guess a handle, and four frames with four dimensions is just
 * a list of four.
 *
 * An item that already carries custody events is never deleted. It is kept and
 * reported, because the events are the record of what was handled.
 */
export function planItemReplacement(
  job: JobMatch,
  desired: DesiredItem[],
  rows: ItemRow[],
  handled: Set<string>,
): Proposal {
  const changes: Change[] = [];
  const refused: string[] = [];

  // Expand quantities: the table holds one row per physical object.
  const wanted: DesiredItem[] = [];
  for (const d of desired) {
    for (let i = 0; i < d.quantity; i++) wanted.push({ ...d, quantity: 1 });
  }

  // Pair each wanted item with an existing row of the same description.
  const spare = [...rows];
  const pairs: { want: DesiredItem; row: ItemRow }[] = [];
  const fresh: DesiredItem[] = [];
  for (const want of wanted) {
    const at = spare.findIndex((r) => norm(String(r.description ?? "")) === norm(want.description));
    if (at === -1) fresh.push(want);
    else pairs.push({ want, row: spare.splice(at, 1)[0] });
  }

  // Rows nothing claims any more.
  for (const row of spare) {
    const name = row.description ?? "(no description)";
    if (handled.has(row.id)) {
      refused.push(
        `"${name}" on ${job.ref} is no longer in the list, but it has already been `
        + `handled - it carries custody events, so it was kept. Remove it in the app if it should go`,
      );
      continue;
    }
    changes.push({ field: "item:remove", ids: [row.id], label: "Remove item", from: name, to: null });
  }

  // Rows that stay, corrected where the message differs.
  for (const { want, row } of pairs) {
    const have = row.attributes ?? {};
    for (const attr of ITEM_ATTRS) {
      if (!(attr in want.attributes)) continue;
      const to = asText(want.attributes[attr], 200);
      const from = asText(have[attr], 200);
      if (to === from) continue;
      changes.push({
        field: "item:set", attr, ids: [row.id],
        label: `Item "${row.description ?? want.description}" ${attr.replace(/_/g, " ")}`,
        from, to,
      });
    }
  }

  // Details with no row to sit on.
  for (const want of fresh) {
    const bits = [want.description];
    if (want.attributes.dimensions) bits.push(String(want.attributes.dimensions));
    changes.push({
      field: "item:add", label: "Add item", from: null, to: bits.join("  -  "),
      item: { description: want.description, quantity: 1, attributes: want.attributes },
    });
  }

  return { changes, refused };
}

export interface Applied {
  applied: Change[];
  failed: { change: Change; reason: string }[];
}

/**
 * Write an approved plan. Each change is applied on its own so that one
 * refusal - a stop that hit its cap, a column RLS will not let this user
 * touch - does not take the rest of the amendment down with it.
 */
export async function applyAmendment(
  sb: Sb,
  tenantId: string,
  job: JobMatch,
  changes: Change[],
  meta: { channel: string; by: string; source_message?: string | null; approved_by?: string | null },
): Promise<Applied> {
  const applied: Change[] = [];
  const failed: { change: Change; reason: string }[] = [];

  // Plain columns go in one statement - they are one row.
  const patch: Record<string, unknown> = {};
  for (const c of changes) {
    if (DIRECT[c.field]) patch[c.field] = c.to;
  }
  if (Object.keys(patch).length) {
    const { data, error } = await sb.from("jobs")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", job.id).eq("tenant_id", tenantId).select("id");
    const ok = !error && (data ?? []).length > 0;
    for (const c of changes.filter((x) => DIRECT[x.field])) {
      if (ok) applied.push(c);
      else failed.push({ change: c, reason: error?.message ?? "the database refused that change" });
    }
  }

  // Stops, one row each.
  for (const c of changes.filter((x) => x.field.startsWith("stop:"))) {
    const [, kind, seqText] = c.field.split(":");
    const seq = Number(seqText);
    const { data: existing } = await sb.from("job_stops")
      .select("id").eq("job_id", job.id).eq("kind", kind).eq("seq", seq).maybeSingle();

    const { error } = existing?.id
      ? await sb.from("job_stops").update({ address: c.to }).eq("id", existing.id)
      : await sb.from("job_stops").insert({
          tenant_id: tenantId, job_id: job.id, kind, seq, address: c.to,
        });
    if (error) failed.push({ change: c, reason: error.message });
    else applied.push(c);
  }

  // Corrections to items already on the job. The ids came back from the
  // reader's browser, so they are re-checked against this job before anything
  // is written - a tampered or stale id must not reach another job's rows.
  for (const c of changes.filter((x) => x.field === "item:set")) {
    const ids = (c.ids ?? []).filter((id) => typeof id === "string");
    if (!ids.length || !c.attr) { failed.push({ change: c, reason: "no item to change" }); continue; }

    const { data: mine } = await sb.from("line_items")
      .select("id,attributes").eq("job_id", job.id).in("id", ids);
    const rows = (mine ?? []) as { id: string; attributes: Record<string, unknown> | null }[];
    if (!rows.length) { failed.push({ change: c, reason: "those items are not on this job" }); continue; }

    let bad = "";
    for (const r of rows) {
      const patch = c.attr === "description"
        ? { description: c.to }
        // The attributes column carries more than this amendment touches, so
        // it is merged rather than replaced.
        : { attributes: { ...(r.attributes ?? {}), [c.attr]: c.to } };
      const { error } = await sb.from("line_items").update(patch).eq("id", r.id).eq("job_id", job.id);
      if (error) bad = error.message;
    }
    if (bad) failed.push({ change: c, reason: bad });
    else applied.push(c);
  }

  // Items being removed. Scoped to this job, and re-checked for custody events
  // at the moment of writing - the reader may have approved the card after
  // somebody scanned the item on the floor.
  for (const c of changes.filter((x) => x.field === "item:remove")) {
    const ids = (c.ids ?? []).filter((id) => typeof id === "string");
    if (!ids.length) { failed.push({ change: c, reason: "no item to remove" }); continue; }

    const { data: events } = await sb.from("custody_events")
      .select("item_id").eq("job_id", job.id).in("item_id", ids);
    if ((events ?? []).length) {
      failed.push({ change: c, reason: "it has been handled since you approved this - remove it in the app" });
      continue;
    }
    const { error } = await sb.from("line_items").delete().eq("job_id", job.id).in("id", ids);
    if (error) failed.push({ change: c, reason: error.message });
    else applied.push(c);
  }

  // Items being added. The whole row travels on the change when the reconciler
  // built it, so a new frame arrives WITH its dimensions - an earlier version
  // carried only a description string and silently dropped everything else.
  for (const c of changes.filter((x) => x.field === "item:add")) {
    let desc: string;
    let qty = 1;
    let attributes: Record<string, unknown> = {};
    if (c.item?.description) {
      desc = c.item.description;
      qty = Math.max(1, Math.min(200, Number(c.item.quantity ?? 1) || 1));
      attributes = c.item.attributes ?? {};
    } else {
      const text = String(c.to ?? "");
      const m = text.match(/^(\d+)\s*x\s*(.+)$/i);
      qty = m ? Number(m[1]) : 1;
      desc = m ? m[2] : text;
    }
    const rows = Array.from({ length: Math.max(1, Math.min(200, qty)) }, () => ({
      tenant_id: tenantId, job_id: job.id, description: desc, identity_tier: 1,
      attributes,
    }));
    const { error } = await sb.from("line_items").insert(rows);
    if (error) failed.push({ change: c, reason: error.message });
    else applied.push(c);
  }

  // One event for the whole amendment, carrying before and after. This is the
  // audit trail, and it is what makes an amendment reversible by hand.
  if (applied.length) {
    await sb.from("custody_events").insert({
      tenant_id: tenantId, job_id: job.id, type: "amendment",
      taken_at: new Date().toISOString(),
      payload: {
        source_message: meta.source_message ?? null,
        approved_by: meta.approved_by ?? null,
        // The row ids travel with the record. Without them an item amendment
        // can be read but not undone: "Travel frame dimensions null -> 350 x
        // 13 x 180" does not say WHICH of two identical-looking rows moved.
        changes: applied.map((c) => ({
          field: c.field, label: c.label, from: c.from, to: c.to,
          ...(c.attr ? { attr: c.attr } : {}),
          ...(c.ids?.length ? { ids: c.ids } : {}),
          ...(c.item ? { item: c.item } : {}),
        })),
        refused: failed.map((f) => ({ field: f.change.field, reason: f.reason })),
      },
      notes: `Amended via ${meta.channel} by ${meta.by}`,
    });
  }

  return { applied, failed };
}

/** "Date 2026-10-01 → 2026-10-03" — for an email reply or a strip line. */
export function describe(changes: Change[]): string {
  const show = (v: unknown) =>
    v == null || v === "" ? "(blank)" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v);
  return changes.map((c) => `${c.label}: ${show(c.from)} → ${show(c.to)}`).join("; ");
}

/** "JOB-2026-0161 (Moshekwa/Melly, 1 Oct)" — how to name a candidate. */
export function nameJob(j: JobMatch): string {
  const bits = [j.client_ref, j.scheduled_date].filter(Boolean);
  return bits.length ? `${j.ref} (${bits.join(", ")})` : j.ref;
}

// ---------------------------------------------------------------------------
// Several jobs at once
// ---------------------------------------------------------------------------
//
// "Please amend Job-2026-0142, Job-2026-0143 and Job-2026-0146" is three
// amendments, and the thing that makes a multi-job amendment dangerous is not
// the writing - it is the REPORTING. A reply that confirms the one job it
// managed, and says nothing about the two it did not, reads as done. The
// sender files it and nobody looks again until the truck is at the wrong
// address.
//
// So every job the sender named leaves a trace here, whatever happened to it,
// and details that could not be tied to a job become questions rather than
// silence.

export interface AmendmentAsk {
  existing_job_ref: string | null;
  changes: Record<string, unknown> | null;
  unassigned?: string[] | null;
}

export interface JobOutcome {
  /** How the sender named it, for a reply they can recognise. */
  asked: string;
  status: "planned" | "applied" | "no-change" | "not-found" | "ambiguous";
  job?: JobMatch;
  candidates?: JobMatch[];
  changes: Change[];
  failed: { label: string; reason: string }[];
  refused: string[];
  unassigned: string[];
}

/** Resolve and plan every entry. Writes nothing. */
export async function planAmendments(
  sb: Sb,
  tenantId: string,
  asks: AmendmentAsk[],
  legalTypes: string[] = [],
): Promise<JobOutcome[]> {
  const out: JobOutcome[] = [];
  for (const ask of asks) {
    const asked = String(ask.existing_job_ref ?? "").trim();
    const unassigned = (ask.unassigned ?? []).map(String).filter(Boolean);
    const blank: JobOutcome = {
      asked, status: "not-found", changes: [], failed: [], refused: [], unassigned,
    };

    const { matches, looked_for } = await resolveJob(sb, tenantId, asked);
    if (!matches.length) { out.push({ ...blank, asked: looked_for }); continue; }
    if (matches.length > 1) {
      out.push({ ...blank, status: "ambiguous", candidates: matches });
      continue;
    }

    const job = matches[0];
    const { changes, refused } = await planAmendment(sb, tenantId, job, ask.changes ?? {}, legalTypes);
    out.push({
      ...blank,
      status: changes.length ? "planned" : "no-change",
      job, changes, refused,
    });
  }
  return out;
}

/** Write every outcome that resolved to exactly one job and has changes. */
export async function applyPlanned(
  sb: Sb,
  tenantId: string,
  outcomes: JobOutcome[],
  meta: { channel: string; by: string; source_message?: string | null; approved_by?: string | null },
): Promise<JobOutcome[]> {
  for (const o of outcomes) {
    if (o.status !== "planned" || !o.job || !o.changes.length) continue;
    const { applied, failed } = await applyAmendment(sb, tenantId, o.job, o.changes, meta);
    o.changes = applied;
    o.failed = failed.map((f) => ({ label: f.change.label, reason: f.reason }));
    o.status = applied.length ? "applied" : "no-change";
  }
  return outcomes;
}

/**
 * The reply. Every job named gets a line, in the order the sender named them,
 * and anything unplaced is quoted back as a question. Written to be read on a
 * phone, in a hurry, by someone who will act on the first line and skim the
 * rest - so the failures come last and are impossible to miss.
 */
/**
 * Job numbers written out in full anywhere in the message, including the
 * quoted thread below it.
 *
 * This exists as a backstop against the parser, not as a way of finding jobs.
 * If a message plainly says JOB-2026-0146 and the amendment never mentions it,
 * something was dropped - and the reply must say so, because the whole failure
 * this guards against is a confident answer about two jobs out of three.
 */
export function mentionedRefs(body: string): string[] {
  const out = new Set<string>();
  const re = /\bJOB[\s-]?(\d{4})[\s-]?(\d{3,6})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.add(`JOB-${m[1]}-${m[2]}`.toUpperCase());
  return [...out];
}

export function composeReply(outcomes: JobOutcome[], alsoMentioned: string[] = []): string {
  if (!outcomes.length) return "";

  const lines: string[] = [];
  const questions: string[] = [];
  let changed = 0;

  for (const o of outcomes) {
    const name = o.job?.ref ?? o.asked;
    switch (o.status) {
      case "applied": {
        changed++;
        let l = `${name} updated: ${describe(o.changes)} ✓`;
        if (o.failed.length) l += `  (could not change ${o.failed.map((f) => f.label).join(", ")})`;
        lines.push(l);
        break;
      }
      case "no-change":
        lines.push(`${name} - nothing to change; it already matches what the message describes.`);
        break;
      case "not-found":
        lines.push(`${name} - NOT FOUND. Nothing was changed. Reply with the job number and I'll make the change.`);
        break;
      case "ambiguous":
        lines.push(
          `${o.asked} - matches ${o.candidates?.length ?? 0} jobs `
          + `(${(o.candidates ?? []).map(nameJob).join(", ")}). `
          + `Nothing was changed. Reply with the job number you meant.`,
        );
        break;
      default:
        lines.push(`${name} - not applied.`);
    }
    for (const r of o.refused) questions.push(`${name}: ${r}`);
    for (const u of o.unassigned) questions.push(u);
  }

  const head = outcomes.length > 1
    ? `${changed} of ${outcomes.length} jobs updated.`
    : "";

  const parts = [head, lines.join("\n")].filter(Boolean);

  // Anything the message named that never reached an amendment. The parser
  // decides what to change; this decides what the reader is told was missed.
  const touched = new Set(
    outcomes.flatMap((o) => [o.job?.ref, o.asked].filter(Boolean).map((v) => String(v).toUpperCase())),
  );
  const missed = alsoMentioned.filter((r) => {
    if (touched.has(r)) return false;
    const tail = r.split("-").pop() ?? "";
    // "0142" was how the sender asked; JOB-2026-0142 is the same job.
    return ![...touched].some((t) => t.endsWith(tail));
  });
  if (missed.length) {
    parts.push(
      `This message also mentions ${missed.join(", ")}, which I did NOT change - `
      + `I couldn't tell what to change about ${missed.length > 1 ? "them" : "it"}. `
      + `Reply telling me and I'll apply it.`,
    );
  }

  if (questions.length) {
    parts.push(
      "I could not place the following. Reply telling me which job each belongs to "
      + "and I'll apply them:\n"
      + questions.map((q) => `  - ${q}`).join("\n"),
    );
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Showing the parser what the job actually holds
// ---------------------------------------------------------------------------
//
// The first version of this asked the model to write match:"Travel frame"
// naming an item on a job it had never been shown. That is not a hard problem,
// it is an impossible one: it had to guess a description exactly, and a guess
// that missed was refused as "no item matching ...". Every item amendment
// failed silently for that reason.
//
// So amendments are now read in two passes. The first finds which jobs are
// being talked about; this renders what those jobs currently hold; the second
// asks what changes, with the answer in front of it.

export interface JobState {
  job: JobMatch;
  items: { n: number; description: string; count: number; ids: string[]; attributes: Record<string, unknown>; locked: boolean }[];
  stops: { kind: string; seq: number; address: string | null }[];
}

/**
 * Read each job's current items and stops. Identical units are folded into one
 * numbered line - a job of two identical frames reads as "[1] Travel frame x2",
 * which is how a person would describe it and how the parser should refer to it.
 *
 * `locked` marks an item that already carries custody events. Those can be
 * corrected but never removed: the events are the record of what was handled,
 * and deleting the row orphans them.
 */
export async function readJobStates(
  sb: Sb,
  tenantId: string,
  jobs: JobMatch[],
): Promise<JobState[]> {
  const states: JobState[] = [];
  for (const job of jobs) {
    const [{ data: rawItems }, { data: rawStops }, { data: events }] = await Promise.all([
      sb.from("line_items").select("id,description,attributes").eq("job_id", job.id).order("created_at"),
      sb.from("job_stops").select("kind,seq,address").eq("job_id", job.id).order("kind").order("seq"),
      sb.from("custody_events").select("item_id").eq("job_id", job.id).not("item_id", "is", null),
    ]);

    const touched = new Set(((events ?? []) as { item_id: string }[]).map((e) => e.item_id));

    // ONE NUMBER PER ROW. An earlier version folded identical descriptions into
    // a single numbered line - "[1] Travel frame x2" - which read nicely and
    // was wrong in a way that took a real amendment to expose: two frames for
    // two different artworks share a description but are not the same thing,
    // and a folded handle cannot give them different dimensions. The parser,
    // offered one handle per job and three sets of measurements, put one set on
    // each job and wrote it to both rows. It had no way to say anything else.
    //
    // A row is a physical object. It gets its own number.
    const items = ((rawItems ?? []) as ItemRow[]).map((it, i) => ({
      n: i + 1,
      description: String(it.description ?? "").trim(),
      count: 1,
      ids: [it.id],
      attributes: it.attributes ?? {},
      locked: touched.has(it.id),
    }));

    states.push({
      job,
      items,
      stops: ((rawStops ?? []) as { kind: string; seq: number; address: string | null }[]),
    });
  }
  return states;
}

/** The same thing as text, for the parser to read. */
export function renderJobStates(states: JobState[]): string {
  return states.map((s) => {
    const lines: string[] = [];
    lines.push(`${s.job.ref} - ${s.job.type ?? "no type"}, `
      + `${s.job.scheduled_date ?? "no date"}`
      + (s.job.time_window ? ` ${s.job.time_window}` : "")
      + `, their reference "${s.job.client_ref ?? "-"}"`);

    if (s.stops.length) {
      for (const st of s.stops) {
        lines.push(`    ${st.kind} ${st.seq + 1}: ${st.address ?? "(no address)"}`);
      }
    }

    if (!s.items.length) lines.push("    items: none");
    else {
      lines.push("    items:");
      for (const it of s.items) {
        const a = it.attributes ?? {};
        const bits = [
          it.count > 1 ? `x${it.count}` : null,
          a.dimensions ? `dimensions: ${a.dimensions}` : "dimensions: none",
          a.declared_value ? `value: ${a.declared_value}` : null,
          a.special_handling ? `handling: ${a.special_handling}` : null,
          it.locked ? "ALREADY HANDLED - may be corrected, never removed" : null,
        ].filter(Boolean);
        lines.push(`      [${it.n}] ${it.description || "(no description)"}  ${bits.join("  ")}`);
      }
    }
    return lines.join("\n");
  }).join("\n\n");
}
