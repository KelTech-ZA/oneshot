// The diary block, and the promise it has to keep.
//
// The promise is the important half. A workspace that has never heard of a
// meeting must get the prompt it had yesterday, not a similar one - "DO NOT
// BREAK THE SEND EMAIL PARSE MODEL THAT CURRENTLY EXISTS" is a standing
// instruction, and a prompt that quietly grows a paragraph for everybody is
// exactly how that gets broken without anybody noticing.
//
// So the first two tests are about ABSENCE, and the rest about what the block
// says when it is there.

import { DIARY_KEYS, diaryBlock } from "./diary.ts";

function assert(cond: unknown, note = "assertion failed") { if (!cond) throw new Error(note); }
function eq(a: unknown, b: unknown, note = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${note ? note + ": " : ""}expected ${y}, got ${x}`);
}
/** Present, and said in those words - the wording IS the behaviour here. */
function says(haystack: string, needle: string) {
  if (!haystack.includes(needle)) throw new Error(`the block never says "${needle}"`);
}

const ORDINARY = ["pickup", "delivery", "move", "storage_in", "fabrication"];

Deno.test("a workspace with no diary type gets NOTHING - not a heading, not a newline", () => {
  eq(diaryBlock(ORDINARY), "");
  eq(diaryBlock([]), "");
});

Deno.test("the prompt around it is byte-identical when the block is empty", () => {
  // The shape buildSystem uses: the block sits directly against the sentence
  // before it, carrying its own leading blank line. If diaryBlock ever returns
  // " " or "\n" instead of "", this is what catches it.
  const render = (block: string) => `...not a work request.${block}\n\nAMENDMENTS`;
  eq(render(diaryBlock(ORDINARY)), "...not a work request.\n\nAMENDMENTS");
});

Deno.test("one diary type is described, and the other two are not mentioned", () => {
  const b = diaryBlock([...ORDINARY, "meeting"]);
  assert(b.length > 0, "a workspace with a meeting type must get the block");
  says(b, '"meeting"');
  assert(!b.includes('"conference"'), "must not describe a type this workspace has not got");
  assert(!b.includes('"conference_call"'), "must not describe a type this workspace has not got");
});

Deno.test("the no-address rule is printed only to a workspace that runs calls", () => {
  const withCall = diaryBlock(["meeting", "conference_call"]);
  const without = diaryBlock(["meeting", "conference"]);
  says(withCall, "A CALL HAS NO ADDRESS");
  assert(!without.includes("A CALL HAS NO ADDRESS"),
    "a workspace with no conference_call type should not be told how to record one");
});

Deno.test("all three described when all three are present", () => {
  const b = diaryBlock([...ORDINARY, ...DIARY_KEYS]);
  for (const k of DIARY_KEYS) says(b, `"${k}"`);
});

Deno.test("THE REASON THIS EXISTS: it overrides the chatter rule", () => {
  // "meeting" sat in job_types for months and produced zero jobs. The line
  // above it in the prompt says anything that is not a work request is
  // chatter, and an invitation is not a work request. Unless this block says
  // otherwise, adding two more unused types changes nothing.
  const b = diaryBlock(["meeting"]);
  says(b, "NOT CHATTER");
  says(b, "OVERRIDES");
});

Deno.test("it forbids inventing items for a meeting", () => {
  const b = diaryBlock(["meeting"]);
  says(b, "NO ITEMS");
  says(b, "An agenda is not an item");
});

Deno.test("it insists on the time, which is what keeps two meetings on one day apart", () => {
  // dedupeJobs collapses entries identical on type | client_ref |
  // scheduled_date | time_window. Two meetings on one day with no time are
  // indistinguishable to it and the second is folded away - so this is not
  // presentation, it is the thing that stops a job being lost.
  const b = diaryBlock(["meeting"]);
  says(b, "time_window");
});

Deno.test("it refuses the two over-reads: the work a meeting is about, and a meeting already held", () => {
  const b = diaryBlock(["meeting"]);
  says(b, "NOT THE WORK IT IS ABOUT");
  says(b, "ALREADY HELD IS NOT A JOB");
});

Deno.test("the RSVP words are named as answers, never as job types to propose", () => {
  const b = diaryBlock(["meeting"]);
  for (const w of ["attend", "attending", "not attending"]) says(b, w);
  says(b, "not job types");
});

Deno.test("an unknown diary-ish key is not guessed at", () => {
  // A workspace naming its own "site_visit" gets nothing: the block only
  // speaks for keys it can describe. Pointing other wording at one of these is
  // what vocab_rules is for.
  eq(diaryBlock(["site_visit", "catch_up"]), "");
});

// ---------------------------------------------------------------------------
// The drift this codebase has already been bitten by
// ---------------------------------------------------------------------------
// `seen` was broken in production for a week because the extension's function
// and the inbox's function disagreed about the order of two things, and
// nothing compared them. suggest-job's own comment says the extension and the
// inbox must not drift apart in what they have been taught - so this reads
// both files and checks it, rather than trusting the comment.

const SUGGEST = Deno.readTextFileSync(
  new URL("../suggest-job/index.ts", import.meta.url));
const INGEST = Deno.readTextFileSync(new URL("./extract.ts", import.meta.url));

Deno.test("THE EXTENSION GETS THE SAME PARAGRAPH AS THE INBOX", () => {
  assert(SUGGEST.includes('from "../_shared/diary.ts"'),
    "suggest-job does not import diaryBlock at all");
  // Every extract() call in either file must hand over the diary argument.
  // An extract(...) with six arguments is one that silently reads an
  // invitation as chatter.
  for (const [name, src] of [["suggest-job", SUGGEST], ["ingest", INGEST]] as const) {
    const calls = [...src.matchAll(/\bextract\(body, meta, typeList[^)]*\)/g)].map((m) => m[0]);
    assert(calls.length > 0, `no extract() call found in ${name} - has it been renamed?`);
    for (const c of calls) {
      assert(/,\s*diary\s*\)$/.test(c), `${name} calls extract without diary: ${c}`);
    }
  }
});

Deno.test("the block is built from the workspace's OWN types, in both files", () => {
  // Not from a constant, and not from the prompt's prose type list - from the
  // keys. A workspace that has not got "meeting" must not be told about it.
  assert(/diaryBlock\(\s*\(\(types[^)]*\)[\s\S]{0,120}?\.key\)/.test(SUGGEST),
    "suggest-job should build the block from its job_types keys");
  assert(/const diary = diaryBlock\(legalTypes\)/.test(INGEST),
    "ingest should build the block from legalTypes");
});
