// Telling a repeat from a failure.
//
//   node web/src/pages/repeats_test.mjs
//
// This one decision governs whether an email is shown in orange under
// "Couldn't be read", with an invitation to create it by hand, or quietly
// under "Arrived more than once" with nothing to do. Both ways of being
// wrong are costly and they are not symmetrical:
//
//   a repeat classed as a failure  -> you make the same jobs a second time,
//                                     which is what prompted this fix
//   a failure classed as a repeat  -> a real email is quietly filed as
//                                     handled and the job never gets made
//
// The second is worse, so the test for a repeat is narrow on purpose: the
// marker, or the exact sentence sayRepeat has always written.

// The helpers are lifted out of Dashboard.jsx by source rather than imported,
// because importing the page drags in React and the whole router. Lifting
// means the test reads the code that actually ships; a copy would drift.
import fs from "node:fs/promises";

const SRC = await fs.readFile(new URL("./Dashboard.jsx", import.meta.url), "utf8");
const at = SRC.indexOf("export const REPEAT_TAG");
const end = SRC.indexOf("\n\n", SRC.indexOf("export const refsIn"));
if (at < 0 || end < 0) throw new Error("Dashboard.jsx no longer exports the repeat helpers");
const { isRepeat, withoutTag, refsIn, REPEAT_TAG } =
  new Function(SRC.slice(at, end).replaceAll("export const", "const")
    + "\nreturn { isRepeat, withoutTag, refsIn, REPEAT_TAG };")();

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? "\n         " + detail : "")); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

// The real note from this workspace, 2026-10-29. Kept verbatim: it is the row
// that is actually sitting in the database, and a classifier that cannot
// recognise it is no use whatever it does with invented strings.
const LIVE = "the same mail arrived before (the same message id, 2026-10-29 11:13 UTC) "
           + "and already made JOB-2026-0287, JOB-2026-0288; nothing new was created";

console.log("repeats");
ok("the note already in the database is recognised", isRepeat({ parse_error: LIVE }));
ok("and so is a newly tagged one", isRepeat({ parse_error: REPEAT_TAG + LIVE }));
ok("a forward caught by body hash too",
   isRepeat({ parse_error: REPEAT_TAG + "the same mail arrived before (an identical body, 2026-10-21 07:29 UTC) and was already read; nothing new was created" }));

console.log("\nfailures stay failures");
for (const t of [
  "Anthropic returned no readable JSON for this message.",
  "The model timed out after 60 seconds.",
  "Could not read the attachment: unsupported format.",
  "the sender asked about a mail that arrived before, but gave no reference",
  "",
  null,
  undefined,
]) {
  ok(`not a repeat: ${JSON.stringify(String(t ?? "").slice(0, 46))}`,
     !isRepeat({ parse_error: t }));
}
ok("a message with no note at all is not a repeat", !isRepeat({}));
ok("nor is a null message", !isRepeat(null));

console.log("\nwhat gets shown");
eq("the marker is stripped before display", withoutTag(REPEAT_TAG + LIVE), LIVE);
eq("an untagged note is shown as it stands", withoutTag(LIVE), LIVE);
eq("and nothing copes with nothing", withoutTag(null), "");

console.log("\nthe jobs the first copy made");
eq("both references are pulled out", refsIn(LIVE), ["JOB-2026-0287", "JOB-2026-0288"]);
eq("a repeat that made nothing names nothing",
   refsIn(REPEAT_TAG + "the same mail arrived before (an identical body, 2026-10-21 07:29 UTC) and was already read; nothing new was created"), []);
eq("rubbish yields nothing", refsIn(null), []);

// The guard that matters most: the live row must not be routed to the panel
// that offers to create it by hand.
console.log("\nthe bug this fixes");
const noted = [
  { id: "a", parse_error: LIVE },
  { id: "b", parse_error: "The model returned nothing readable." },
  { id: "c", kind: "unknown", parse_error: null },
];
eq("only the genuine failures reach 'Couldn't be read'",
   noted.filter((m) => !isRepeat(m)).map((m) => m.id), ["b", "c"]);
eq("and the repeat goes to the quiet list",
   noted.filter(isRepeat).map((m) => m.id), ["a"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
