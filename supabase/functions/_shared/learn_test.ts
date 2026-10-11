// The correction signal. These pin what the console will be learning from, so
// a wrong diff here teaches the wrong lesson later.

function assertEquals(actual: unknown, expected: unknown, note = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${note ? note + ": " : ""}expected ${b}, got ${a}`);
}

import { diffChanges, diffJobs } from "./learn.ts";

const JOB = (over: Record<string, unknown> = {}) => ({
  type: "packing", client_ref: "THK/Gopal", scheduled_date: "2026-10-02",
  time_window: "08:00", hard_deadline: false,
  stops: [{ kind: "site", address: "Section 9 Workshop" }],
  items: [{ description: "Travel frame" }],
  charges: [{ description: "Crate fabrication", unit_price: 4250 }],
  ...over,
});

Deno.test("a proposal taken as it stands records no correction", () => {
  assertEquals(diffJobs([JOB()], [JOB()]), {});
});

Deno.test("a corrected date is the correction", () => {
  const d = diffJobs([JOB()], [JOB({ scheduled_date: "2026-10-05" })]);
  assertEquals(d, { scheduled_date: { from: "2026-10-02", to: "2026-10-05" } });
});

Deno.test("several fields at once", () => {
  const d = diffJobs([JOB()], [JOB({ type: "fabrication", time_window: "11:00" })]);
  assertEquals(Object.keys(d).sort(), ["time_window", "type"]);
});

Deno.test("a changed address names the stop and the field, not 'stops'", () => {
  const d = diffJobs([JOB()], [JOB({ stops: [{ kind: "site", address: "Art Central, Woodstock" }] })]);
  assertEquals(d["stops.site[0].address"],
    { from: "Section 9 Workshop", to: "Art Central, Woodstock" });
  assertEquals(Object.keys(d), ["stops.site[0].address"], "nothing else should be reported");
});

Deno.test("an item the reader added is an addition, not a rewrite of the list", () => {
  const d = diffJobs([JOB()], [JOB({ items: [{ description: "Travel frame" }, { description: "Plinth" }] })]);
  assertEquals(d["items.added"], { from: null, to: ["Plinth"] });
  assertEquals(Object.keys(d), ["items.added"], "the untouched first item must not be reported");
});

Deno.test("a price the reader fixed names the price", () => {
  const d = diffJobs([JOB()], [JOB({ charges: [{ description: "Crate fabrication", unit_price: 5000 }] })]);
  assertEquals(d["charges[0].unit_price"], { from: 4250, to: 5000 });
  assertEquals(Object.keys(d), ["charges[0].unit_price"]);
});

Deno.test("a job the reader deleted is its own lesson", () => {
  const d = diffJobs([JOB(), JOB({ client_ref: "THK/Nzuza" })], [JOB()]);
  assertEquals(d["jobs.count"], { from: 2, to: 1 });
});

Deno.test("with several jobs, corrections say which job", () => {
  const d = diffJobs(
    [JOB(), JOB({ client_ref: "THK/Nzuza" })],
    [JOB(), JOB({ client_ref: "THK/Nzuza", scheduled_date: "2026-10-06" })],
  );
  assertEquals(Object.keys(d), ["jobs[1].scheduled_date"]);
});

Deno.test("an empty proposal against a hand-filled job is all correction", () => {
  const d = diffJobs([{}], [JOB()]);
  assertEquals(Object.keys(d).length > 4, true, JSON.stringify(Object.keys(d)));
});

// --- amendments -------------------------------------------------------------

const C = (field: string, to: unknown) => ({ field, label: field, to });

Deno.test("an amendment approved whole records no correction", () => {
  const proposed = [C("scheduled_date", "2026-10-05"), C("time_window", "08:00")];
  assertEquals(diffChanges(proposed, proposed), {});
});

Deno.test("an unticked line is recorded as rejected", () => {
  const proposed = [C("scheduled_date", "2026-10-05"), C("item:add", "4 x Crate")];
  const d = diffChanges(proposed, [proposed[0]]);
  assertEquals(d, { "rejected.item:add": { from: "4 x Crate", to: null } });
});

Deno.test("rejecting everything is recorded as rejecting everything", () => {
  const proposed = [C("a", 1), C("b", 2)];
  assertEquals(Object.keys(diffChanges(proposed, [])).length, 2);
});

Deno.test("a line kept but with a different value is not counted as kept", () => {
  const proposed = [C("scheduled_date", "2026-10-05")];
  const d = diffChanges(proposed, [C("scheduled_date", "2026-10-09")]);
  assertEquals(d["rejected.scheduled_date"].from, "2026-10-05");
});

// ---------------------------------------------------------------------------
// THE WHOLE POINT: what was wrong, not merely that something was
// ---------------------------------------------------------------------------
// The old diff recorded `items: {from: [...], to: [...]}` - the entire list,
// both versions. True, and useless. Seven rows of real feedback in production
// read "items changed" three times and told us nothing about what to fix.

Deno.test("THE REAL ONE: dimensions pulled out of the description", () => {
  // Straight from parse_feedback: the parser wrote the size into the
  // description, which the prompt explicitly forbids, and a person moved it.
  const d = diffJobs(
    [JOB({ items: [{ description: "Framed black and white photograph - 100 x 90 x 20 cm" }] })],
    [JOB({ items: [{ description: "Framed photograph", dimensions: "100 x 90 x 20 cm" }] })],
  );
  assertEquals(d["items[0].description"],
    { from: "Framed black and white photograph - 100 x 90 x 20 cm", to: "Framed photograph" });
  assertEquals(d["items[0].dimensions"], { from: null, to: "100 x 90 x 20 cm" });
  // And NOT an add plus a remove, which is what a name-only match would make
  // of it - the description is the very thing that changed.
  assertEquals(d["items.added"], undefined, "it is the same item, corrected");
  assertEquals(d["items.removed"], undefined, "it is the same item, corrected");
});

Deno.test("one corrected field among many untouched ones reports only itself", () => {
  const three = (over: Record<string, unknown>[] = []) => JOB({
    items: [
      { description: "Travel frame", dimensions: "367 x 16 x 176cm" },
      { description: "Crate", dimensions: "79 x 62 x 46cm" },
      { description: "Plinth", dimensions: "40 x 40 x 100cm" },
      ...over,
    ],
  });
  const fixed = JSON.parse(JSON.stringify(three().items));
  fixed[1].dimensions = "79 x 62 x 47cm";
  const d = diffJobs([three()], [JOB({ items: fixed })]);
  assertEquals(Object.keys(d), ["items[1].dimensions"]);
});

Deno.test("a collection and a delivery are never paired, however alike", () => {
  // Both legs at the same address, and only the delivery moves. Pairing
  // across kinds would report an address nobody typed.
  const p = JOB({ stops: [
    { kind: "collection", address: "Stevenson, Woodstock" },
    { kind: "delivery", address: "Stevenson, Woodstock" }] });
  const a = JOB({ stops: [
    { kind: "collection", address: "Stevenson, Woodstock" },
    { kind: "delivery", address: "Norval Foundation" }] });
  assertEquals(Object.keys(diffJobs([p], [a])), ["stops.delivery[0].address"]);
});

Deno.test("billing is diffed key by key, because that is the actionable part", () => {
  const d = diffJobs(
    [JOB({ billing: { bill_to_name: "Southern Guild", payment_terms: "30 days" } })],
    [JOB({ billing: { bill_to_name: "Southern Guild Pty Ltd", payment_terms: "30 days" } })],
  );
  assertEquals(d["billing.bill_to_name"], { from: "Southern Guild", to: "Southern Guild Pty Ltd" });
  assertEquals(Object.keys(d), ["billing.bill_to_name"]);
});

// ---------------------------------------------------------------------------
// The two dialects
// ---------------------------------------------------------------------------

Deno.test("THE DATABASE DIALECT: attributes and repeated rows do not read as corrections", () => {
  // A job made from an email, opened in the office, saved with nothing
  // changed. The database says this in its own way - dimensions inside
  // attributes, and quantity 3 stored as three separate rows. If that alone
  // registered as a correction, every job ever opened would poison the signal.
  const proposed = JOB({ items: [
    { description: "Crate", dimensions: "79 x 62 x 46cm", quantity: 3, special_handling: "glass side up" },
  ] });
  const fromDatabase = JOB({ items: [
    { description: "Crate", attributes: { dimensions: "79 x 62 x 46cm", special_handling: "glass side up" } },
    { description: "Crate", attributes: { dimensions: "79 x 62 x 46cm", special_handling: "glass side up" } },
    { description: "Crate", attributes: { dimensions: "79 x 62 x 46cm", special_handling: "glass side up" } },
  ] });
  assertEquals(diffJobs([proposed], [fromDatabase], true), {},
    "opening a job and saving it unchanged must record nothing");
});

Deno.test("and a real correction still shows through the database dialect", () => {
  const proposed = JOB({ items: [{ description: "Crate", dimensions: "79 x 62 x 46cm", quantity: 2 }] });
  const fromDatabase = JOB({ items: [
    { description: "Crate", attributes: { dimensions: "79 x 62 x 47cm" } },
    { description: "Crate", attributes: { dimensions: "79 x 62 x 47cm" } },
  ] });
  const d = diffJobs([proposed], [fromDatabase], true);
  assertEquals(d["items[0].dimensions"], { from: "79 x 62 x 46cm", to: "79 x 62 x 47cm" });
});

Deno.test("a quantity changed in the office reads as a quantity, not as added items", () => {
  const proposed = JOB({ items: [{ description: "Crate", quantity: 2 }] });
  const fromDatabase = JOB({ items: [
    { description: "Crate", attributes: {} }, { description: "Crate", attributes: {} },
    { description: "Crate", attributes: {} }, { description: "Crate", attributes: {} },
  ] });
  const d = diffJobs([proposed], [fromDatabase], true);
  assertEquals(d["items[0].quantity"], { from: 2, to: 4 });
});

Deno.test("empty and absent are the same thing, in both dialects", () => {
  // Forms write "" where the parser wrote null. Without this every job saved
  // through the office would report a dozen corrections nobody made.
  const d = diffJobs(
    [JOB({ client_ref: null, items: [{ description: "Crate", dimensions: null }] })],
    [JOB({ client_ref: "", items: [{ description: "Crate", dimensions: "  " }] })],
  );
  assertEquals(d, {});
});
