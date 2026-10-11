// Last week's corrections, in front of the parser this morning.
//
// This is the half of the loop that was missing. parse_feedback has recorded
// what people change since 42; nothing has ever read it. The app accumulated
// evidence and behaved exactly as it did the day it shipped - which is the
// same open loop vocabulary had before 44 closed it, in a different place.
//
// WHY WORKED EXAMPLES RATHER THAN RULES
//
// The obvious thing to build is a rule-maker: count corrections, and when the
// same one appears five times, write a rule. It does not survive contact with
// the numbers. Seven rows in four days means a threshold of five would take
// months to trip, and a threshold low enough to trip sooner fires on noise.
//
// Examples need no threshold. One correction is already a useful example, ten
// are better, and the thing reading them is a model that is good at
// generalising from a handful of cases - which is precisely the job a rule
// engine would be doing badly. It also means nobody has to sit in a review
// queue approving rules, which was the other constraint.
//
// WHAT KEEPS IT HONEST
//
// Most of the safety is in sql/53, where recent_corrections refuses anything
// that is not a lesson about reading: a change made three weeks after the job
// was created (the world moved, the parser was not wrong), an item somebody
// added (that says what they wanted, not what should have been read), a
// proposal accepted as it stood. What is left here is the prompt discipline:
// one line each, capped, and newest first so a lesson that stopped being true
// falls out of the window on its own instead of needing to be withdrawn.

// deno-lint-ignore no-explicit-any
type Sb = any;

export interface Correction {
  field: string;
  was: string | null;
  now_is: string | null;
  at?: string;
}

/** At most this many lines reach the prompt. */
const MAX_LINES = 10;

/**
 * One line, no control characters, capped.
 *
 * These strings come out of real email - a customer's words, by way of the
 * parser - and they are about to be placed inside a system prompt. The author
 * is not hostile, but "the author is trusted" is not a floor, and a prompt
 * that can be extended by whatever arrived in the post has no floor under it.
 * The same treatment renderHints gives vocabulary notes, for the same reason.
 */
const flatten = (s: unknown, max = 120): string =>
  String(s ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/**
 * The corrections this workspace has made lately.
 *
 * Never throws and never blocks. A workspace that has not run 53, or a
 * database having a bad minute, gets an empty list and a prompt exactly as it
 * was before any of this existed - which is the right way to fail, because
 * the cost is a parse no better than yesterday's rather than no parse at all.
 */
export async function loadCorrections(
  sb: Sb, tenantId: string, limit = MAX_LINES,
): Promise<Correction[]> {
  try {
    const { data, error } = await sb.rpc("recent_corrections", {
      p_tenant: tenantId, p_limit: limit,
    });
    if (error) { console.warn("corrections not loaded:", error.message); return []; }
    return Array.isArray(data) ? data as Correction[] : [];
  } catch (e) {
    console.warn("corrections not loaded:", e instanceof Error ? e.message : String(e));
    return [];
  }
}

/** How a single correction reads as a sentence. */
function sentence(c: Correction): string | null {
  const field = flatten(c.field, 60);
  if (!field) return null;
  const to = flatten(c.now_is);
  if (!to) return null;                       // nothing to aim at; not a lesson
  const from = flatten(c.was);
  return from
    ? `- ${field}: you read "${from}" — they wanted "${to}".`
    : `- ${field}: you left it empty — they wanted "${to}".`;
}

/**
 * The block handed to the model, or "" when there is nothing to say.
 *
 * Empty for a workspace with no corrections yet, which is every workspace on
 * the day this ships. The prompt is then identical to the one before it, byte
 * for byte - the same promise diary.ts makes, and for the same reason.
 */
export function renderCorrections(rows: Correction[]): string {
  const lines: string[] = [];
  for (const r of rows) {
    if (lines.length >= MAX_LINES) break;
    const s = sentence(r);
    if (s) lines.push(s);
  }
  if (!lines.length) return "";

  return `

WHAT THIS WORKSPACE CORRECTED RECENTLY - each line is a real proposal of yours
that somebody who knew the answer changed afterwards. They are worked examples
of how this workspace wants its mail read, newest first. Where one of them
bears on what you are reading now, follow it; they beat your own first
instinct about the same words. Where none of them applies, ignore them - they
are a handful of cases, not a set of rules, and a lesson stretched to fit is
worse than no lesson.
${lines.join("\n")}`;
}
