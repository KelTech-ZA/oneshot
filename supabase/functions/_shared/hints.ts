// What the parser has been taught, read back before it reads anything.
//
// 42 recorded corrections. 43 showed them. Neither changed how a message was
// read, so the loop was open: the app accumulated evidence and behaved exactly
// as it had the day it shipped. This is the closing piece - the one call that
// makes a decision somebody made last week change the answer today.
//
// Two ways a rule takes effect, and the difference matters:
//
//   MECHANICALLY, where there is an exact thing to point at. "Waiting time"
//   means the `waiting` charge type; "Avalon" means that client row. These are
//   applied in code, by lookup, and cannot be ignored or half-followed. Always
//   prefer this - a rule enforced by a Map is a rule that holds every time.
//
//   BY INSTRUCTION, where the lesson is about reading rather than naming. "A
//   stack date is the container cut-off, treat it as the scheduled date" is a
//   sentence for the model, because no lookup expresses it.
//
// Rules arrive from the maintenance console, written by crew. That is a small,
// trusted group - but the notes still end up inside a system prompt, so they
// are flattened to one line and capped. A prompt that can be extended by
// whatever somebody typed into a text box is a prompt with no floor under it,
// and "trusted author" is not a reason to leave that open.

// deno-lint-ignore no-explicit-any
type Sb = any;

export type HintKind = "job_type" | "charge_type" | "client_name" | "term";

export interface Hint {
  kind: HintKind;
  term: string;
  normalised: string;
  action: "map" | "ignore" | "teach";
  maps_to: string | null;
  note: string | null;
  scope: "workspace" | "global";
}

/** The same normalisation note_vocab() and decide_vocab() use, so a rule written
 *  about "Waiting  Time" is found by a quote line reading "waiting time". */
export const normaliseTerm = (s: unknown): string =>
  String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Load the rules in force for one workspace.
 *
 * Never throws and never blocks: a parse must not fail because the hint
 * lookup did. An empty list means the parser behaves exactly as it did
 * before any of this existed, which is the right failure.
 */
export async function loadHints(sb: Sb, tenantId: string): Promise<Hint[]> {
  try {
    const { data, error } = await sb.rpc("vocab_hints", { p_tenant: tenantId });
    if (error) { console.warn("hints not loaded:", error.message); return []; }
    return Array.isArray(data) ? data as Hint[] : [];
  } catch (e) {
    console.warn("hints not loaded:", e instanceof Error ? e.message : String(e));
    return [];
  }
}

/** One line, no control characters, capped. See the header. */
const flatten = (s: unknown, max = 240): string =>
  String(s ?? "")
    .replace(/[\r\n\t]+/g, " ")
    // Strip anything that could read as structure in the prompt around it.
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** At most this many lines reach the prompt. Beyond it the vocabulary wants
 *  pruning in the console, not a prompt nobody can read. */
const MAX_LINES = 60;

/**
 * The block handed to the model.
 *
 * Only two kinds of rule are worth a sentence: 'teach', which IS a sentence,
 * and 'ignore', which stops it inventing something from a phrase that is not
 * vocabulary. 'map' rules are deliberately left out - they are applied by
 * lookup after the model answers, and telling it about them as well only
 * invites it to half-apply them itself.
 */
export function renderHints(hints: Hint[]): string {
  const lines: string[] = [];

  for (const h of hints) {
    if (lines.length >= MAX_LINES) break;
    const term = flatten(h.term, 80);
    if (!term) continue;

    if (h.action === "teach" && h.note) {
      lines.push(`- "${term}": ${flatten(h.note)}`);
    } else if (h.action === "ignore") {
      const what = h.kind === "job_type"
        ? "is not a job type"
        : h.kind === "charge_type"
        ? "is not a charge"
        : h.kind === "client_name"
        ? "is not a customer name"
        : "is not a field value";
      lines.push(`- "${term}" ${what}; read past it.`);
    }
  }

  if (!lines.length) return "";

  return `
WHAT THIS WORKSPACE HAS ALREADY BEEN TAUGHT - these come from corrections a
person made to earlier parses of real mail, so they beat your own first
reading of the same words:
${lines.join("\n")}`;
}

/**
 * The lookup table for mechanical rules: normalised term -> target key or id.
 *
 * Workspace rules already beat global ones by the time they reach here
 * (vocab_hints orders them), and the first entry for a term wins.
 */
export function ruleMap(hints: Hint[], kind: HintKind): Map<string, string> {
  const m = new Map<string, string>();
  for (const h of hints) {
    if (h.kind !== kind || h.action !== "map" || !h.maps_to) continue;
    if (!m.has(h.normalised)) m.set(h.normalised, h.maps_to);
  }
  return m;
}

/** Terms this workspace has said are noise, so nothing re-queues them. */
export function ignoredTerms(hints: Hint[], kind: HintKind): Set<string> {
  const s = new Set<string>();
  for (const h of hints) if (h.kind === kind && h.action === "ignore") s.add(h.normalised);
  return s;
}

/**
 * Apply a job_type map rule.
 *
 * The parser proposes a type; the workspace's own job_types are the only legal
 * values. When the proposal is not one of them but a rule says what it means,
 * the rule wins - which is precisely the case that used to land in the
 * vocabulary queue and stay there.
 */
export function mapJobType(
  proposed: string | null | undefined,
  legal: string[],
  rules: Map<string, string>,
): { type: string | null; mapped: boolean } {
  const raw = String(proposed ?? "").trim();
  if (!raw) return { type: null, mapped: false };
  if (legal.includes(raw)) return { type: raw, mapped: false };

  const target = rules.get(normaliseTerm(raw));
  // A rule pointing at a type the workspace has since deleted is not applied:
  // the database would refuse the row anyway, and a job created with a silently
  // wrong type is worse than one flagged for a human.
  if (target && legal.includes(target)) return { type: target, mapped: true };

  return { type: null, mapped: false };
}
