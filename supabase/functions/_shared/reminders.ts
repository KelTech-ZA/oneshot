// Reminders, shared by every path that makes a job.
//
// A reminder can be attached wherever a job is created - the web card, the
// Outlook strip, the mail intake - and every one of those paths needs the same
// three things: read what the workspace has learned, work out what to offer,
// and write one without being able to break the job it belongs to.
//
// The rule that matters: ATTACHING A REMINDER MUST NEVER COST A JOB. A job
// that exists with no reminder on it is a small annoyance. A thread that
// produced no job because the reminder insert failed is the thing OneShot is
// for, lost. So every write here swallows its own failure and says so in the
// return value rather than throwing.

// deno-lint-ignore no-explicit-any
type Sb = any;

export interface Hint {
  /** Do jobs of this type usually get chased? */
  suggest: boolean;
  /** How many of this type the workspace has run lately. */
  jobs: number;
  /** How many of those somebody set a reminder on. */
  reminded: number;
  share_pct: number;
  /** Days before the scheduled date those reminders usually sit. */
  lead_days: number;
  /** The hour of day they usually sit at, in the workspace's own time. */
  at_hour: number;
}

export const NO_HINT: Hint = {
  suggest: false, jobs: 0, reminded: 0, share_pct: 0, lead_days: 1, at_hour: 8,
};

/**
 * What the workspace has learned about chasing jobs of this type.
 *
 * Never throws and never blocks: a workspace that has not run 49 yet, or a
 * database having a bad minute, simply gets "no opinion" - which is exactly
 * where the app stood before any of this existed.
 */
export async function reminderHint(sb: Sb, type: string | null): Promise<Hint> {
  try {
    const { data, error } = await sb.rpc("reminder_hint", { p_type: type ?? "" });
    if (error || !data) return NO_HINT;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return NO_HINT;
    return {
      suggest:   !!row.suggest,
      jobs:      Number(row.jobs ?? 0),
      reminded:  Number(row.reminded ?? 0),
      share_pct: Number(row.share_pct ?? 0),
      lead_days: Number(row.lead_days ?? 1),
      at_hour:   Number(row.at_hour ?? 8),
    };
  } catch {
    return NO_HINT;
  }
}

/**
 * The instant a hint points at, for a job on a given day.
 *
 * Built in Africa/Johannesburg because that is where the people reading it
 * are, and because a hint saying "the day before at 07:00" means 07:00 to
 * them. Returns null when there is no date to count back from - a reminder
 * for an unscheduled job has nothing to be early for.
 */
export function hintedWhen(hint: Hint, scheduledDate: string | null): string | null {
  if (!scheduledDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(scheduledDate.trim());
  if (!m) return null;

  // Midnight on the scheduled day, in SAST (UTC+2), minus the lead, plus the hour.
  const dayStartUtc = Date.UTC(+m[1], +m[2] - 1, +m[3]) - 2 * 3600_000;
  const when = new Date(dayStartUtc
    - hint.lead_days * 86_400_000
    + hint.at_hour * 3_600_000);

  // A suggestion for a time that has gone is not a suggestion.
  if (when.getTime() <= Date.now()) return null;
  return when.toISOString();
}

export interface ReminderIn {
  due_at?: string | null;
  note?: string | null;
}

/** A due_at that is a real instant, in the future, and not absurdly far off. */
export function readDue(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  if (t <= Date.now()) return null;
  if (t > Date.now() + 3 * 365 * 86_400_000) return null;
  return new Date(t).toISOString();
}

/**
 * Attach a reminder to a job that has just been created.
 *
 * Returns what happened rather than throwing, so the caller can tell the
 * person "job made, reminder not" instead of losing the job to a bad date.
 */
export async function attachReminder(
  sb: Sb,
  opts: {
    tenantId: string;
    jobId: string;
    userId: string;
    reminder: ReminderIn;
    source: string;
  },
): Promise<{ set: boolean; at?: string; why?: string }> {
  const due = readDue(opts.reminder?.due_at);
  if (!due) return { set: false, why: "no usable time" };
  try {
    const { error } = await sb.from("job_reminders").insert({
      tenant_id: opts.tenantId,
      job_id: opts.jobId,
      user_id: opts.userId,
      created_by: opts.userId,
      due_at: due,
      note: opts.reminder?.note ?? null,
      source: opts.source,
    });
    if (error) return { set: false, why: error.message };
    return { set: true, at: due };
  } catch (e) {
    return { set: false, why: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Park a mail thread: a reminder with no job behind it.
 *
 * This is "Later" meaning something. There is deliberately no empty job
 * standing in for the thread - a placeholder on the board is worse than a
 * thread nobody has got to yet, because it looks like work that exists.
 */
export async function parkThread(
  sb: Sb,
  opts: {
    tenantId: string;
    userId: string;
    due_at: unknown;
    subject: string | null;
    externalId: string | null;
    note?: string | null;
    source?: string;
  },
): Promise<{ ok: boolean; at?: string; error?: string }> {
  const due = readDue(opts.due_at);
  if (!due) return { ok: false, error: "That time has already gone, or could not be read." };

  const subject = (opts.subject ?? "").trim().slice(0, 300);
  if (!subject) return { ok: false, error: "A parked thread needs a subject to show." };

  try {
    const { error } = await sb.from("job_reminders").insert({
      tenant_id: opts.tenantId,
      job_id: null,
      user_id: opts.userId,
      created_by: opts.userId,
      due_at: due,
      note: opts.note ?? null,
      subject,
      external_id: opts.externalId ?? null,
      source: opts.source ?? "extension_later",
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true, at: due };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
