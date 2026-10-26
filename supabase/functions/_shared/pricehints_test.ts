// applyPriceHints: what happens to a line the message did not price.
//
//   deno test --node-modules-dir=none _shared/pricehints_test.ts
//
// The rules being tested are all one rule seen from different sides: a figure
// that came out of the message is the truth, and a figure that came out of
// history is a suggestion wearing a label.

import { applyPriceHints, pricingFlags } from "./billing.ts";
import type { ChargePlan, ChargeRow, PriceHint } from "./billing.ts";

function assertEquals(actual: unknown, expected: unknown, note = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${note ? note + ": " : ""}expected ${b}, got ${a}`);
}
function assert(cond: unknown, note = "") {
  if (!cond) throw new Error(note || "expected truthy");
}

const row = (description: string, unit_price: number, over: Partial<ChargeRow> = {}): ChargeRow => ({
  tenant_id: "t", job_id: "j", charge_type_id: null,
  description, unit: "job", quantity: 1, unit_price, sort: 0, created_by: null, ...over,
});

const plan = (rows: ChargeRow[], unpriced: string[]): ChargePlan => ({ rows, unpriced });
const hint = (idx: number, unit_price: number | string | null, seen = "last crate build was R3 135.00 on SEC-0142",
              source = "last crate build"): PriceHint => ({ idx, unit_price, source, seen });

Deno.test("a blank line takes the price history offers", () => {
  const out = applyPriceHints(
    plan([row("Crate build: 80 x 60cm", 0)], ["Crate build: 80 x 60cm"]),
    [hint(0, 3135)],
  );
  assertEquals(out.rows[0].unit_price, 3135);
  assertEquals(out.unpriced, []);
  assertEquals(out.guessed.length, 1);
  assertEquals(out.guessed[0].seen, "last crate build was R3 135.00 on SEC-0142");
});

Deno.test("a price the message stated is never overridden", () => {
  const out = applyPriceHints(
    plan([row("Tech handling", 150)], []),      // not in unpriced: the message priced it
    [hint(0, 9999)],
  );
  assertEquals(out.rows[0].unit_price, 150, "history must not win over the message");
  assertEquals(out.guessed, []);
});

Deno.test("a deliberate zero is left alone", () => {
  // "No charge" is a price. planCharges only lists a line in `unpriced` when
  // it could not read a figure at all, so a zero that is NOT listed there was
  // meant, and a hint must not quietly start charging for it.
  const out = applyPriceHints(plan([row("Collection — no charge", 0)], []), [hint(0, 230)]);
  assertEquals(out.rows[0].unit_price, 0);
  assertEquals(out.guessed, []);
});

Deno.test("a line history knows nothing about stays blank and stays flagged", () => {
  const out = applyPriceHints(plan([row("Hot air ballooning", 0)], ["Hot air ballooning"]), []);
  assertEquals(out.rows[0].unit_price, 0);
  assertEquals(out.unpriced, ["Hot air ballooning"]);
  assertEquals(out.guessed, []);
});

Deno.test("a hint of zero or null is not a price", () => {
  for (const v of [0, null, "", "0.00"] as (number | string | null)[]) {
    const out = applyPriceHints(plan([row("Loading", 0)], ["Loading"]), [hint(0, v)]);
    assertEquals(out.rows[0].unit_price, 0, `hint ${JSON.stringify(v)}`);
    assertEquals(out.unpriced, ["Loading"], `hint ${JSON.stringify(v)}`);
  }
});

Deno.test("hints are matched to lines by position, not by order of arrival", () => {
  const out = applyPriceHints(
    plan([row("A", 100), row("B", 0), row("C", 0)], ["B", "C"]),
    [hint(2, 300, "last C was R300"), hint(1, 200, "last B was R200")],
  );
  assertEquals(out.rows.map((r) => r.unit_price), [100, 200, 300]);
  assertEquals(out.guessed.map((g) => g.description), ["B", "C"]);
});

Deno.test("a hint for a line that is not there is ignored", () => {
  const out = applyPriceHints(plan([row("A", 0)], ["A"]), [hint(7, 500)]);
  assertEquals(out.rows[0].unit_price, 0);
  assertEquals(out.unpriced, ["A"]);
});

Deno.test("no hints at all changes nothing", () => {
  const before = plan([row("A", 0), row("B", 250)], ["A"]);
  const out = applyPriceHints(before, []);
  assertEquals(out.rows, before.rows);
  assertEquals(out.unpriced, ["A"]);
  assertEquals(out.guessed, []);
});

Deno.test("a money-shaped string from the database is read", () => {
  // Postgres numeric comes back as a string over PostgREST.
  const out = applyPriceHints(plan([row("Crate", 0)], ["Crate"]), [hint(0, "3135.00")]);
  assertEquals(out.rows[0].unit_price, 3135);
});

Deno.test("the two kinds of problem are flagged differently", () => {
  const out = applyPriceHints(
    plan([row("Crate", 0), row("Ballooning", 0)], ["Crate", "Ballooning"]),
    [hint(0, 3135)],
  );
  const flags = pricingFlags(out);
  assert(flags.some((f) => f.startsWith("check_price — Crate")), flags.join(" | "));
  assert(flags.some((f) => f.startsWith("missing_info:pricing — Ballooning")), flags.join(" | "));
  assertEquals(flags.length, 2);
});

Deno.test("a flag carries where the number came from", () => {
  const out = applyPriceHints(plan([row("Crate", 0)], ["Crate"]), [hint(0, 3135)]);
  const [flag] = pricingFlags(out);
  assert(flag.includes("SEC-0142"), flag);
  assert(flag.includes("3 135.00"), flag);
});

Deno.test("flags are short enough to store", () => {
  const long = "x".repeat(400);
  const out = applyPriceHints(plan([row(long, 0)], [long]), [hint(0, 10, "y".repeat(400))]);
  for (const f of pricingFlags(out)) assert(f.length <= 180, String(f.length));
});
