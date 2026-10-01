// Money read out of a quote. These are the tests that matter most in the app:
// everything else is a date or an address, and this is somebody's bill.

function assertEquals(actual: unknown, expected: unknown, note = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${note ? note + ": " : ""}expected ${b}, got ${a}`);
}

import { currency, matchClient, money, planBilling, planCharges, rate } from "./billing.ts";

// --- reading a figure -------------------------------------------------------

Deno.test("figures as a quote actually writes them", () => {
  assertEquals(money(4250), 4250);
  assertEquals(money("4250"), 4250);
  assertEquals(money("R4,250.00"), 4250);
  assertEquals(money("R 4 250.00"), 4250);
  assertEquals(money("€1.234,56"), 1234.56);      // European
  assertEquals(money("1,234.56"), 1234.56);       // the same number, our way
  assertEquals(money("ZAR 990"), 990);
  assertEquals(money("1,5"), 1.5);                // decimal comma
  assertEquals(money("1,500"), 1500);             // thousands comma
});

Deno.test("a credit keeps its sign", () => {
  assertEquals(money("(500)"), -500);
  assertEquals(money("-500"), -500);
});

Deno.test("an unreadable price is null, never zero", () => {
  // The distinction the whole design rests on.
  assertEquals(money("TBC"), null);
  assertEquals(money("on application"), null);
  assertEquals(money(""), null);
  assertEquals(money(null), null);
  assertEquals(money(0), 0);                      // zero IS a price
});

Deno.test("a VAT rate is read, an impossible one is not", () => {
  assertEquals(rate("15%"), 15);
  assertEquals(rate(15), 15);
  assertEquals(rate("0"), 0);
  assertEquals(rate("150"), null);
  assertEquals(rate("abc"), null);
});

Deno.test("currencies by code and by symbol", () => {
  assertEquals(currency("ZAR"), "ZAR");
  assertEquals(currency("eur"), "EUR");
  assertEquals(currency("R4 250"), "ZAR");
  assertEquals(currency("€"), "EUR");
  assertEquals(currency("bananas"), null);
});

// --- the quote lines --------------------------------------------------------

const TYPES = [
  { id: "t1", key: "crate_fab", label: "Crate fabrication", unit: "item" },
  { id: "t2", key: "transport", label: "Transport", unit: "job" },
  { id: "t3", key: "crate_fab_lg", label: "Crate fabrication - large", unit: "item" },
];

Deno.test("a priced quote becomes charge lines", () => {
  const p = planCharges("t", "j", [
    { description: "Crate fabrication", quantity: 2, unit: "item", unit_price: "R1,500.00" },
    { description: "Transport, Cape Town", quantity: 1, unit_price: 1250 },
  ], TYPES);
  assertEquals(p.rows.length, 2);
  assertEquals(p.rows[0].unit_price, 1500);
  assertEquals(p.rows[0].quantity, 2);
  assertEquals(p.unpriced.length, 0);
});

Deno.test("a line is attached to the workspace's own rate card", () => {
  const p = planCharges("t", "j", [
    { description: "Crate fabrication - Gopal Dagnogo travel frame", unit_price: 4250 },
  ], TYPES);
  // "Crate fabrication - large" is NOT in this description, so the type that
  // actually appears in it is the right answer.
  assertEquals(p.rows[0].charge_type_id, "t1");
  assertEquals(p.rows[0].unit, "item");
});

Deno.test("when two types both appear, the more specific one wins", () => {
  const p = planCharges("t", "j", [
    { description: "Crate fabrication - large, for the Singer sculpture", unit_price: 9000 },
  ], TYPES);
  assertEquals(p.rows[0].charge_type_id, "t3");
});

Deno.test("an exact label beats a longer one that merely contains it", () => {
  const p = planCharges("t", "j", [{ description: "Transport", unit_price: 1250 }], TYPES);
  assertEquals(p.rows[0].charge_type_id, "t2");
});

Deno.test("an unrecognised line stands on its own rather than inventing a type", () => {
  const p = planCharges("t", "j", [{ description: "Scaffold hire", unit_price: 800 }], TYPES);
  assertEquals(p.rows[0].charge_type_id, null);
  assertEquals(p.rows[0].unit, "job");
});

Deno.test("work with no price is created at zero AND reported", () => {
  const p = planCharges("t", "j", [
    { description: "Crate fabrication", unit_price: 1500 },
    { description: "Installation on site", unit_price: "TBC" },
  ], TYPES);
  assertEquals(p.rows.length, 2);                 // the line still exists
  assertEquals(p.rows[1].unit_price, 0);
  assertEquals(p.unpriced, ["Installation on site"]);
});

Deno.test("VAT and totals are not charges", () => {
  const p = planCharges("t", "j", [
    { description: "Crate fabrication", unit_price: 4250 },
    { description: "Subtotal", unit_price: 4250 },
    { description: "VAT @ 15%", unit_price: 637.5 },
    { description: "Total", unit_price: 4887.5 },
  ], TYPES);
  assertEquals(p.rows.length, 1, JSON.stringify(p.rows.map((r) => r.description)));
  assertEquals(p.rows[0].description, "Crate fabrication");
});

Deno.test("a nonsense quantity falls back to one", () => {
  const p = planCharges("t", "j", [{ description: "Crate", quantity: "many", unit_price: 10 }], TYPES);
  assertEquals(p.rows[0].quantity, 1);
});

Deno.test("a nonsense unit falls back to the rate card's", () => {
  const p = planCharges("t", "j", [{ description: "Crate fabrication", unit: "banana", unit_price: 1 }], TYPES);
  assertEquals(p.rows[0].unit, "item");
});

Deno.test("lines keep the order the quote put them in", () => {
  const p = planCharges("t", "j", [
    { description: "A", unit_price: 1 }, { description: "B", unit_price: 2 },
  ], TYPES);
  assertEquals(p.rows.map((r) => r.sort), [0, 10]);
});

Deno.test("nothing parsed means nothing written", () => {
  assertEquals(planCharges("t", "j", null, TYPES).rows.length, 0);
  assertEquals(planCharges("t", "j", [{ unit_price: 100 }], TYPES).rows.length, 0);  // no description
});

// --- who is billed ----------------------------------------------------------

const CLIENTS = [
  { id: "c1", name: "Stevenson", legal_name: "Stevenson Gallery (Pty) Ltd",
    billing_address: "160 Sir Lowry Rd", vat_number: "4180000000", billing_email: "accounts@stevenson.info",
    payment_terms: "30 days", reg_number: null },
];

Deno.test("a known customer is recognised and recorded", () => {
  const p = planBilling("t", "j", { bill_to_name: "Stevenson Gallery (Pty) Ltd" }, CLIENTS);
  assertEquals(p.row?.client_id, "c1");
  assertEquals(p.row?.bill_to_name, "Stevenson Gallery (Pty) Ltd");
});

Deno.test("the quote's own details are never overwritten by the client file", () => {
  const p = planBilling("t", "j", {
    bill_to_name: "Stevenson Gallery (Pty) Ltd",
    bill_to_address: "A different address on this quote",
  }, CLIENTS);
  assertEquals(p.row?.bill_to_address, "A different address on this quote");
  // Gaps the quote left are filled from the client file.
  assertEquals(p.row?.vat_number, "4180000000");
});

Deno.test("an unknown customer still records what the quote said", () => {
  const p = planBilling("t", "j", { bill_to_name: "Someone New", billing_email: "A@B.COM" }, CLIENTS);
  assertEquals(p.row?.client_id, undefined);
  assertEquals(p.row?.bill_to_name, "Someone New");
  assertEquals(p.row?.billing_email, "a@b.com");
});

Deno.test("VAT and currency go onto the job, not the billing row", () => {
  const p = planBilling("t", "j", { vat_rate: "15%", currency: "ZAR" }, CLIENTS);
  assertEquals(p.job, { currency: "ZAR", vat_rate: 15, vat_applicable: true });
});

Deno.test("an export quote that zero-rates is believed", () => {
  const p = planBilling("t", "j", { vat_applicable: false, vat_rate: 0, currency: "EUR" }, CLIENTS);
  assertEquals(p.job, { currency: "EUR", vat_applicable: false, vat_rate: 0 });
});

Deno.test("a quote that says nothing about billing writes nothing", () => {
  assertEquals(planBilling("t", "j", {}, CLIENTS).row, null);
  assertEquals(planBilling("t", "j", null, CLIENTS).row, null);
});

Deno.test("matching a customer ignores case and spacing", () => {
  assertEquals(matchClient(CLIENTS, "  stevenson   gallery (pty) ltd ")?.id, "c1");
  assertEquals(matchClient(CLIENTS, "Stevenson")?.id, "c1");
  assertEquals(matchClient(CLIENTS, "Nobody"), null);
});
