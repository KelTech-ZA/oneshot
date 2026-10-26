// The card's round trip: what the parser read -> what the card shows ->
// what gets sent back.
//
//   node extension/cardround_test.mjs
//
// This exists because of one bug. buildExtraction rebuilt the first job from
// the form fields and never copied `charges` or `billing` onto it, so every
// price the parser read out of a mail was silently dropped the moment anybody
// pressed Create. Jobs beyond the first kept theirs - they travel whole in
// `extra` - which is exactly why it looked like it worked.
//
// Nothing caught it because the two functions are halves of one round trip
// and neither was ever run against the other. So that is what is tested here:
// prefill(parse) -> buildExtraction(form) must preserve what the parser found.
//
// The functions are lifted out of content.js by name rather than imported,
// because content.js is a content script that runs inside an IIFE against a
// live Gmail. Lifting the source means the test reads the code that actually
// ships; a copy would drift.

import fs from "node:fs/promises";

const SRC = await fs.readFile(new URL("./content.js", import.meta.url), "utf8");

/** The source of one top-level `function name(...) { ... }`, braces balanced. */
function lift(name) {
  const at = SRC.indexOf(`  function ${name}(`);
  if (at < 0) throw new Error(`content.js has no function ${name}`);
  let i = SRC.indexOf("{", at), depth = 0, inStr = null, prev = "";
  for (let j = i; j < SRC.length; j++) {
    const ch = SRC[j];
    if (inStr) {
      if (ch === inStr && prev !== "\\") inStr = null;
    } else if (ch === '"' || ch === "'" || ch === "`") inStr = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return SRC.slice(at, j + 1);
    }
    prev = ch;
  }
  throw new Error(`unbalanced ${name}`);
}

const helpers = `
  const lines = (v) => String(v || "").split("\\n").map((x) => x.trim()).filter(Boolean);
`;
const mod = new Function(
  `${helpers}\n${lift("prefill")}\n${lift("buildExtraction")}\nreturn { prefill, buildExtraction };`,
)();
const { prefill, buildExtraction } = mod;

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? "\n         " + detail : "")); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want),
     `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

// A parse of the kind this is all about: a mail that priced some of the work
// and described the rest, for two jobs.
const parse = {
  extraction: {
    kind: "request",
    jobs: [
      {
        type: "collection", scheduled_date: "2026-11-03", time_window: "13:00-15:00",
        client_ref: "THK/0042", hard_deadline: true,
        stops: [
          { kind: "collection", address: "1 Sir Lowry Rd, Cape Town" },
          { kind: "delivery", address: "Blank Projects, Woodstock" },
        ],
        items: [{ description: "Travel frame", quantity: 1 }],
        charges: [
          { description: "Tech handling - 3x techs", quantity: 2, unit: "hour", unit_price: 150 },
          { description: "Crate build: 80 x 60 x 90cm(h)", quantity: 1, unit: "crate", unit_price: null },
        ],
        billing: { bill_to_name: "Blank Projects CC", vat_applicable: true },
      },
      {
        type: "delivery", scheduled_date: "2026-11-04",
        charges: [{ description: "Transport", quantity: 1, unit: "job", unit_price: 900 }],
        items: [],
      },
    ],
  },
};

const f = prefill(parse);

console.log("what the card is handed");
eq("the plain fields come through", [f.type, f.date, f.window, f.ref, f.hard],
   ["collection", "2026-11-03", "13:00-15:00", "THK/0042", true]);
eq("the addresses are split by kind", [f.collection, f.delivery],
   ["1 Sir Lowry Rd, Cape Town", "Blank Projects, Woodstock"]);
eq("the priced lines arrive", f.charges.length, 2);
eq("a price the mail stated is kept", f.charges[0].unit_price, 150);
eq("and is labelled as the mail's own", f.charges[0].from, "from the message");
eq("a line the mail did not price is null, not zero", f.charges[1].unit_price, null);
ok("and carries no provenance yet", f.charges[1].from === null);
eq("who is billed rides along", f.billing.bill_to_name, "Blank Projects CC");
eq("the second job is carried whole", f.extra.length, 1);

console.log("\nwhat goes back");
const ex = buildExtraction(f, { subject: "x" });
const j0 = ex.jobs[0];

eq("the first job still has its charges", (j0.charges || []).length, 2);
eq("with the stated price intact", (j0.charges || [])[0]?.unit_price, 150);
eq("the quantity intact", (j0.charges || [])[0]?.quantity, 2);
eq("the unit intact", (j0.charges || [])[0]?.unit, "hour");
eq("and the blank still blank", (j0.charges || [])[1]?.unit_price, null);
eq("billing survives too", j0.billing?.bill_to_name, "Blank Projects CC");
eq("and the second job is untouched", ex.jobs[1]?.charges?.[0]?.unit_price, 900);

console.log("\nwhat the person did to it");
// The point of the table: these are the figures that get written.
f.charges[1].unit_price = 3135;
f.charges[1].from = "yours";
f.charges[0].quantity = 4;
f.charges[0].description = "Tech handling - 4x techs";
f.charges.push({ description: "Waiting time", unit: "hour", quantity: 1, unit_price: 0, from: "yours" });

const ex2 = buildExtraction(f, { subject: "x" });
eq("an edited price is what goes", (ex2.jobs[0].charges || [])[1]?.unit_price, 3135);
eq("an edited quantity is what goes", (ex2.jobs[0].charges || [])[0]?.quantity, 4);
eq("an edited description is what goes", (ex2.jobs[0].charges || [])[0]?.description, "Tech handling - 4x techs");
eq("a line added by hand goes too", (ex2.jobs[0].charges || []).length, 3);
eq("and a deliberate zero stays zero, not null", (ex2.jobs[0].charges || [])[2]?.unit_price, 0);

f.charges.splice(0, 1);
eq("a line removed is gone", (buildExtraction(f, {}).jobs[0].charges || []).length, 2);

console.log("\nrubbish in");
const empty = prefill(null);
eq("no parse at all means no lines", empty.charges, []);
eq("and no billing", empty.billing, null);
eq("buildExtraction copes with that", buildExtraction(empty, {}).jobs[0].charges, []);

const junk = prefill({ extraction: { jobs: [{ charges: [
  { description: "  ", quantity: 1, unit_price: 10 },
  { description: "Real line", quantity: "two", unit_price: "" },
] }] } });
eq("a line with no description is dropped on the way in", junk.charges.length, 1);
eq("an unreadable quantity falls back to one", junk.charges[0]?.quantity, 1);
eq("an empty price is null", junk.charges[0]?.unit_price, null);

const blanked = prefill({ extraction: { jobs: [{ charges: [
  { description: "Keep me", quantity: 1, unit_price: 5 },
] }] } });
blanked.charges[0].description = "   ";
eq("and one blanked out on the card is dropped on the way back",
   (buildExtraction(blanked, {}).jobs[0].charges || []).length, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
