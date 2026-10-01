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

/** Addresses, in the order given, so a changed stop shows as a changed stop. */
function stopList(job: Record<string, unknown>): string[] {
  const stops = Array.isArray(job?.stops) ? job.stops as Record<string, unknown>[] : [];
  return stops.map((s) => `${s?.kind ?? "delivery"}:${String(s?.address ?? "").trim()}`);
}

function itemList(job: Record<string, unknown>): string[] {
  const items = Array.isArray(job?.items) ? job.items as Record<string, unknown>[] : [];
  return items.map((i) => String(i?.description ?? "").trim()).filter(Boolean);
}

function chargeList(job: Record<string, unknown>): string[] {
  const ch = Array.isArray(job?.charges) ? job.charges as Record<string, unknown>[] : [];
  return ch.map((c) => `${String(c?.description ?? "").trim()}@${c?.unit_price ?? "?"}`);
}

/**
 * Field-by-field difference between what was proposed and what was approved.
 *
 * Jobs are aligned by position, which is right in practice: a reader edits the
 * card in front of them rather than reordering it. A job added or removed
 * shows up as its own entry rather than shifting every field after it, because
 * "they deleted the third job" and "they changed everything from the third job
 * onwards" are very different lessons.
 */
export function diffJobs(
  proposed: Record<string, unknown>[],
  accepted: Record<string, unknown>[],
): Record<string, { from: unknown; to: unknown }> {
  const edits: Record<string, { from: unknown; to: unknown }> = {};

  if (proposed.length !== accepted.length) {
    edits["jobs.count"] = { from: proposed.length, to: accepted.length };
  }

  const n = Math.min(proposed.length, accepted.length);
  for (let i = 0; i < n; i++) {
    const p = proposed[i] ?? {};
    const a = accepted[i] ?? {};
    const at = (field: string) => (proposed.length > 1 ? `jobs[${i}].${field}` : field);

    for (const f of JOB_FIELDS) {
      if (!same(p[f], a[f])) edits[at(f)] = { from: p[f] ?? null, to: a[f] ?? null };
    }

    const ps = stopList(p), as_ = stopList(a);
    if (!same(ps, as_)) edits[at("stops")] = { from: ps, to: as_ };

    const pi = itemList(p), ai = itemList(a);
    if (!same(pi, ai)) edits[at("items")] = { from: pi, to: ai };

    const pc = chargeList(p), ac = chargeList(a);
    if (!same(pc, ac)) edits[at("charges")] = { from: pc, to: ac };

    if (!same(p.billing ?? null, a.billing ?? null)) {
      edits[at("billing")] = { from: p.billing ?? null, to: a.billing ?? null };
    }
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
