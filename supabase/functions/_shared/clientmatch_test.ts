// Client matching, against the real client list read out of the live database.
//
// These names are Section 9's actual customers, so the cases below are the
// ones that will really arrive: "Blank projects", "Stevenson", "WITW", "THK".
// A matcher that works on invented names and not on these is worthless.

function assertEquals(actual: unknown, expected: unknown, note = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${note ? note + ": " : ""}expected ${b}, got ${a}`);
}
function assert(cond: unknown, note = "assertion failed") { if (!cond) throw new Error(note); }

import { core, findClient, norm, suggestAliases } from "./clientmatch.ts";
import type { MatchableClient } from "./clientmatch.ts";

/** Copied from the console's own targets list on 5 October. */
const CLIENTS: MatchableClient[] = [
  { id: "c1",  legal_name: "A4 Arts Foundation NPC" },
  { id: "c2",  legal_name: "Aspire Art Auctions" },
  { id: "c3",  legal_name: "Blank Projects Contemporary (Pty) Ltd" },
  { id: "c4",  legal_name: "Comma Foundation" },
  { id: "c5",  legal_name: "Elsekon Bouers (Pty) Ltd" },
  { id: "c6",  legal_name: "Fine Art Logistics" },
  { id: "c7",  legal_name: "Kortmann Art Packers & Shippers" },
  { id: "c8",  legal_name: "KZNSA Gallery" },
  { id: "c9",  legal_name: "Michael Stevenson Fine Art (Pty) Ltd" },
  { id: "c10", legal_name: "Spier Art Trust" },
  { id: "c11", legal_name: "THK Gallery (PTY) LTD" },
  { id: "c12", legal_name: "WhatIfTheWorld Gallery" },
];

const find = (s: string, cs = CLIENTS) => findClient(cs, s);

// ---------------------------------------------------------------------------
// The one that started it
// ---------------------------------------------------------------------------

Deno.test("the real miss: 'Blank projects' finds Blank Projects Contemporary", () => {
  const m = find("Blank projects");
  assertEquals(m.client?.id, "c3");
  // Both sides reduce to "blank" once the furniture is off, so it is settled
  // at the core tier rather than needing the riskier fragment one.
  assertEquals(m.how, "core");
});

Deno.test("'Stevenson' finds Michael Stevenson Fine Art", () => {
  assertEquals(find("Stevenson").client?.id, "c9");
});

Deno.test("case and punctuation do not matter", () => {
  for (const s of ["BLANK PROJECTS", "blank  projects", "Blank Projects.", "blank-projects"]) {
    assertEquals(find(s).client?.id, "c3", s);
  }
});

Deno.test("the full legal name still matches, and matches first", () => {
  const m = find("Michael Stevenson Fine Art (Pty) Ltd");
  assertEquals(m.client?.id, "c9");
  assertEquals(m.how, "exact");
});

Deno.test("legal furniture is ignored on either side", () => {
  assertEquals(find("Blank Projects Contemporary").client?.id, "c3");
  assertEquals(find("Blank Projects (Pty) Ltd").client?.id, "c3");
  assertEquals(find("THK").client?.id, "c11");
  assertEquals(find("THK Gallery").client?.id, "c11");
});

// ---------------------------------------------------------------------------
// The guards. These matter more than the matches.
// ---------------------------------------------------------------------------

Deno.test("a word shared by several customers matches NONE of them", () => {
  // "Art" is in six of the twelve. Picking one would put a job on the wrong
  // statement, which is worse than leaving it unrecognised.
  for (const s of ["Art", "Arts", "Gallery", "Fine Art"]) {
    const m = find(s);
    assertEquals(m.client, null, s);
  }
});

Deno.test("'Foundation' is ambiguous between A4 and Comma, so it is refused", () => {
  const m = find("Foundation");
  assertEquals(m.client, null);
});

Deno.test("a genuinely unknown customer is not forced onto anybody", () => {
  const m = find("Goodman Gallery");
  assertEquals(m.client, null);
  assertEquals(m.how, "none");
});

Deno.test("a two or three letter scrap never matches by fragment", () => {
  // Too little to be sure of, so it is queued for a person instead.
  assertEquals(find("KZN").client, null, "KZN");
  assertEquals(find("Sp").client, null, "Sp");
});

Deno.test("an empty or missing name matches nothing", () => {
  assertEquals(find("").client, null);
  assertEquals(findClient(CLIENTS, null).client, null);
  assertEquals(findClient(CLIENTS, undefined).client, null);
});

Deno.test("no clients at all is not an error", () => {
  assertEquals(findClient([], "Blank projects").client, null);
});

// ---------------------------------------------------------------------------
// Aliases: what somebody types in once
// ---------------------------------------------------------------------------

const WITH_ALIASES: MatchableClient[] = CLIENTS.map((c) =>
  c.id === "c12" ? { ...c, aliases: ["WITW", "What If The World"] } : c);

Deno.test("'WITW' finds WhatIfTheWorld once it is an alias", () => {
  assertEquals(findClient(CLIENTS, "WITW").client, null, "not derivable on its own");
  const m = findClient(WITH_ALIASES, "WITW");
  assertEquals(m.client?.id, "c12");
  assertEquals(m.how, "exact");
});

Deno.test("an alias is matched the same way a name is, spacing and all", () => {
  assertEquals(findClient(WITH_ALIASES, "witw").client?.id, "c12");
  assertEquals(findClient(WITH_ALIASES, "What if the world").client?.id, "c12");
});

Deno.test("an alias that would now match two clients still refuses", () => {
  const clash: MatchableClient[] = [
    { id: "a", legal_name: "Alpha Logistics", aliases: ["AL"] },
    { id: "b", legal_name: "Beta Limited", aliases: ["AL"] },
  ];
  assertEquals(findClient(clash, "AL").client, null);
  assertEquals(findClient(clash, "AL").how, "ambiguous");
});

// ---------------------------------------------------------------------------
// A console decision beats everything
// ---------------------------------------------------------------------------

Deno.test("a map rule wins even over a name that would match something else", () => {
  const rules = new Map([["blank projects", "c6"]]);
  const m = findClient(CLIENTS, "Blank projects", rules);
  assertEquals(m.client?.id, "c6", "the person's decision stands");
  assertEquals(m.how, "rule");
});

Deno.test("a rule pointing at a deleted client falls through instead of failing", () => {
  const rules = new Map([["blank projects", "deleted-id"]]);
  assertEquals(findClient(CLIENTS, "Blank projects", rules).client?.id, "c3");
});

// ---------------------------------------------------------------------------
// Suggestions, which are only ever suggestions
// ---------------------------------------------------------------------------

Deno.test("WITW is offered, because nothing could derive it at read time", () => {
  const witw = suggestAliases(CLIENTS[11], CLIENTS); // WhatIfTheWorld Gallery
  assert(witw.includes("WITW"), JSON.stringify(witw));
});

Deno.test("a suggestion is never a mangled version of the real name", () => {
  // The bug this replaced: "Michael Stevenson Fine Art" came back as
  // "Michael Stevenson Fine", and "Fine Art Logistics" as "Fine Logistics".
  for (const c of CLIENTS) {
    const source = String(c.legal_name);
    for (const s of suggestAliases(c, CLIENTS)) {
      const isInitialism = /^[A-Z0-9]+$/.test(s);
      assert(isInitialism || source.includes(s),
        `"${s}" is not a contiguous piece of "${source}"`);
    }
  }
});

Deno.test("the corporate tail comes off, and nothing else", () => {
  assertEquals(suggestAliases(CLIENTS[8], CLIENTS)[0], "Michael Stevenson Fine Art");
  assertEquals(suggestAliases(CLIENTS[2], CLIENTS)[0], "Blank Projects Contemporary");
});

Deno.test("a name with nothing to trim offers no rewrite of itself", () => {
  assertEquals(suggestAliases({ id: "q", legal_name: "Comma Foundation" }, []), []);
});

Deno.test("a suggestion that would collide with another client is withheld", () => {
  const two: MatchableClient[] = [
    { id: "x", legal_name: "Stevenson Fine Art" },
    { id: "y", legal_name: "Stevenson Logistics" },
  ];
  const s = suggestAliases(two[0], two);
  assert(!s.map(norm).includes("stevenson"), JSON.stringify(s));
});

Deno.test("nothing is suggested for a client with no name", () => {
  assertEquals(suggestAliases({ id: "z", legal_name: "", name: "" }), []);
});

// ---------------------------------------------------------------------------
// The pieces underneath
// ---------------------------------------------------------------------------

Deno.test("normalising strips punctuation and collapses spaces", () => {
  assertEquals(norm("  THK   Gallery (PTY) LTD "), "thk gallery pty ltd");
  assertEquals(norm("O'Brien & Sons"), "obrien sons");
});

Deno.test("the core of a name is what distinguishes it", () => {
  assertEquals(core("Michael Stevenson Fine Art (Pty) Ltd"), "michael stevenson");
  assertEquals(core("THK Gallery (PTY) LTD"), "thk");
  assertEquals(core("Gallery"), "", "a bare furniture word has no core at all");
});
