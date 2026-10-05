// Working out which customer a message means.
//
// Nobody writes "Blank Projects Contemporary (Pty) Ltd" in an email. They
// write "Blank projects", or "Stevenson", or "WITW". The matcher required an
// exact hit on name or legal_name, so every one of those missed - and a miss
// is not harmless: the job gets billing details copied onto it with no
// client_id, which means it never appears on that customer's statement.
//
// Four tiers, hardest evidence first. Each tier only answers if it answers
// UNAMBIGUOUSLY: two clients matching is the same as none, because a wrong
// customer on an invoice is worse than an unrecognised one. An unrecognised
// name is queued for a person; a wrong one is quietly billed.
//
//   1. A decision somebody made in the console (a map rule).
//   2. An exact name, legal name, or alias the workspace keeps on the record.
//   3. The same, with the legal furniture stripped - "(Pty) Ltd", "NPC",
//      "Gallery" - so "Blank Projects Contemporary" finds the full entity.
//   4. A distinctive fragment: "Stevenson" inside "Michael Stevenson Fine
//      Art". Guarded hard, because this is the tier that could go wrong.
//
// Tier 4 is why "Stevenson" and "Blank projects" work with no setup at all.
// "WITW" cannot be derived from "WhatIfTheWorld" by any rule worth trusting,
// so it is an alias somebody types once - which is what the alias list is for.

export interface MatchableClient {
  id: string;
  name?: string | null;
  legal_name?: string | null;
  aliases?: string[] | null;
}

export const norm = (s: unknown): string =>
  String(s ?? "").toLowerCase().replace(/[‘’'`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** The words that say what KIND of company it is, never which one. */
const FURNITURE = new RegExp(
  "\\b(" + [
    "pty", "ltd", "limited", "proprietary", "inc", "incorporated", "llc", "plc",
    "npc", "npo", "cc", "trust", "holdings", "group", "company", "co",
    "gallery", "galleries", "studio", "studios", "projects", "project",
    "foundation", "fine art", "fine arts", "art", "arts", "contemporary",
    "collection", "auctions", "auctioneers", "and", "the",
  ].join("|") + ")\\b", "g",
);

/** "Michael Stevenson Fine Art (Pty) Ltd" -> "michael stevenson" */
export const core = (s: unknown): string =>
  norm(s).replace(FURNITURE, " ").replace(/\s+/g, " ").trim();

/** Every written form of one client, normalised. */
function forms(c: MatchableClient): string[] {
  const out = [c.legal_name, c.name, ...(c.aliases ?? [])].map(norm).filter(Boolean);
  return [...new Set(out)];
}

/** Exactly one, or nothing. Two is the same as none - see the header. */
function only<T>(hits: T[]): T | null {
  return hits.length === 1 ? hits[0] : null;
}

export interface ClientMatch {
  client: MatchableClient | null;
  /** How it was found, for the log and for deciding whether to flag it. */
  how: "rule" | "exact" | "core" | "fragment" | "none" | "ambiguous";
}

/**
 * `rules` maps a normalised name somebody decided about to a clients.id.
 * Tier 1, because it is the only tier where a human said so outright.
 */
export function findClient(
  clients: MatchableClient[],
  rawName: string | null | undefined,
  rules?: Map<string, string>,
): ClientMatch {
  const want = norm(rawName);
  if (!want) return { client: null, how: "none" };

  // --- 1. a decision -------------------------------------------------------
  const ruled = rules?.get(want);
  if (ruled) {
    const byId = clients.find((c) => c.id === ruled);
    // A rule pointing at a client since deleted falls through rather than
    // failing: the name may still match on its own.
    if (byId) return { client: byId, how: "rule" };
  }

  // --- 2. a name they actually keep ----------------------------------------
  const exact = clients.filter((c) => forms(c).includes(want));
  if (exact.length) {
    const one = only(exact);
    return one ? { client: one, how: "exact" } : { client: null, how: "ambiguous" };
  }

  // --- 3. the same, without the legal furniture ----------------------------
  const wantCore = core(rawName);
  if (wantCore) {
    const byCore = clients.filter((c) =>
      [c.legal_name, c.name, ...(c.aliases ?? [])].some((f) => f && core(f) === wantCore));
    if (byCore.length) {
      const one = only(byCore);
      return one ? { client: one, how: "core" } : { client: null, how: "ambiguous" };
    }
  }

  // --- 4. a distinctive fragment -------------------------------------------
  // The risky tier, so three guards: the fragment must survive having the
  // furniture stripped (so "Art" and "Gallery" can never match anything), it
  // must be at least four characters, and it must sit on word boundaries
  // inside exactly one client.
  if (wantCore.length >= 4) {
    const boundary = new RegExp(`(^|\\s)${wantCore.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|\\s)`);
    const byFragment = clients.filter((c) =>
      [c.legal_name, c.name, ...(c.aliases ?? [])]
        .some((f) => f && boundary.test(core(f))));
    if (byFragment.length) {
      const one = only(byFragment);
      return one ? { client: one, how: "fragment" } : { client: null, how: "ambiguous" };
    }
  }

  return { client: null, how: "none" };
}

/**
 * Short forms worth OFFERING for a client, for a person to accept or ignore.
 *
 * Deliberately suggestions and nothing more. An initialism is a guess, and a
 * guess that silently decides whose invoice this is would be the worst kind
 * of helpfulness - so these are shown, never applied.
 */
export function suggestAliases(c: MatchableClient, others: MatchableClient[] = []): string[] {
  const source = String(c.legal_name || c.name || "");
  if (!source.trim()) return [];

  const taken = new Set(others.filter((o) => o.id !== c.id).flatMap(forms));
  const already = new Set(forms(c));
  const out: string[] = [];

  const offer = (s: string) => {
    const v = s.trim();
    if (!v || v.length < 3) return;
    const n = norm(v);
    // Never offer something that would now match somebody else as well.
    if (already.has(n) || taken.has(n) || out.some((o) => norm(o) === n)) return;
    out.push(v);
  };

  // Only ever TRIM FROM THE END, never pluck a word out of the middle. An
  // earlier version removed any word it considered furniture wherever it sat,
  // and turned "Michael Stevenson Fine Art" into "Michael Stevenson Fine" and
  // "Fine Art Logistics" into "Fine Logistics". A suggestion somebody has to
  // correct is worse than no suggestion.
  const CORPORATE = /^(pty|ltd|limited|proprietary|inc|incorporated|llc|plc|npc|npo|cc)$/i;

  const words = String(source)
    .replace(/[,.]/g, " ")
    .replace(/\(.*?\)/g, " ")          // "(Pty) Ltd" and anything else bracketed
    .replace(/\s+/g, " ").trim()
    .split(" ").filter(Boolean);

  const trimmed = [...words];
  while (trimmed.length > 1 && CORPORATE.test(trimmed[trimmed.length - 1])) trimmed.pop();
  if (trimmed.length && trimmed.length < words.length) offer(trimmed.join(" "));

  // The one short form no rule could ever derive at read time, and the reason
  // the alias list exists: WhatIfTheWorld -> WITW.
  const camel = trimmed.find((w) => /[a-z][A-Z]/.test(w));
  if (camel) {
    offer(camel);                       // "WhatIfTheWorld" on its own
    const letters = camel.replace(/([a-z])([A-Z])/g, "$1 $2").split(" ")
      .map((p) => p[0]).join("").toUpperCase();
    if (letters.length >= 3) offer(letters);
  }

  return out.slice(0, 4);
}
