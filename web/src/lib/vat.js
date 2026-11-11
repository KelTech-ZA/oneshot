// VAT on a line, for the screens.
//
// WHY THIS IS A SECOND IMPLEMENTATION, AND WHY THAT IS ALLOWED
//
// public.vat_on_lines and public.vat_breakdown (sql/66, sql/68) are the real
// ones. They decide what a quote or an invoice is worth, and the figures they
// produce are the figures that get printed and sent. This file does the same
// arithmetic in JavaScript, which is a duplicate rule and therefore a thing
// that can drift.
//
// It is here anyway because the alternative is worse. The charges sheet and
// the new-invoice form show a running total while somebody is typing, before
// there is anything in the database to ask. Today those screens do it with a
// hardcoded `sub * 0.15`, which is a duplicate rule too - just a wrong one,
// now that a line can carry its own rate.
//
// Two things keep the drift honest:
//
//   1. Nothing here is ever saved. Every figure these functions produce is
//      replaced by the server's own the moment the document is created or
//      retotalled. They describe a draft; they never describe a document.
//   2. sqltest/68-vat-ui.mjs runs the same cases through this file and
//      through the SQL and fails if they disagree.
//
// THE RULE, WHICH IS NOT OBVIOUS
//
// Every line on one rate -> round the subtotal.  (what the database did
//                                                 before per-line VAT, so
//                                                 ordinary invoices do not
//                                                 move by a cent)
// Rates differ          -> round each line and add those up, because on a
//                          mixed document the per-line figures are the ones
//                          that have to reconcile on the page.
//
// vat_applicable on the document overrides every line rate. False means this
// workspace is not charging VAT on this document at all, and no line can.

// Postgres numeric is exact decimal; a double is not. Working in whole cents
// keeps the two in step for every figure an invoice realistically carries.
// The epsilon is for the doubles that arrive a hair under, like 0.145 held as
// 0.14499999999999999 - without it that rounds down and Postgres rounds up.
const cents = (v) => {
  const x = Number(v) || 0;
  const s = x < 0 ? -1 : 1;
  return s * Math.round(Math.abs(x) * 100 + 1e-9);
};
const fromCents = (c) => c / 100;

/** Two decimals, away from zero on a half, which is what round(numeric,2) does. */
export const round2 = (v) => fromCents(cents(v));

/** quantity x unit_price, rounded the way bill_lines rounds it. */
export const lineTotal = (line) =>
  round2((Number(line?.quantity) || 0) * (Number(line?.unit_price) || 0));

/**
 * The rate a line is actually charged at: its own, else the document's.
 * null, undefined and "" all mean "no opinion".
 */
export const effectiveRate = (line, docRate) => {
  const own = line?.vat_rate;
  if (own === null || own === undefined || String(own).trim() === "") {
    return Number(docRate) || 0;
  }
  return Number(own) || 0;
};

/** The sum of the lines, before VAT. */
export const subtotalOf = (lines) =>
  fromCents((lines ?? []).reduce((t, l) => t + cents(l?.line_total ?? lineTotal(l)), 0));

/**
 * The per-rate split, mirroring public.vat_breakdown. Highest rate first.
 * Returns [] for no lines.
 */
export function vatBreakdown(lines, applicable, docRate) {
  const ls = lines ?? [];
  if (ls.length === 0) return [];

  const net = (l) => cents(l?.line_total ?? lineTotal(l));
  const subC = ls.reduce((t, l) => t + net(l), 0);

  if (!applicable) {
    return [{ rate: 0, net: fromCents(subC), vat: 0 }];
  }

  const groups = new Map();
  for (const l of ls) {
    const r = effectiveRate(l, docRate);
    const g = groups.get(r) ?? { rate: r, netC: 0, vatC: 0 };
    g.netC += net(l);
    g.vatC += Math.round((net(l) * r) / 100);     // per line, as the database does
    groups.set(r, g);
  }

  const out = [...groups.values()].sort((a, b) => b.rate - a.rate);

  // One rate: round the subtotal instead, so an ordinary document reads to
  // the cent as it always did.
  if (out.length === 1) {
    const r = out[0].rate;
    return [{ rate: r, net: fromCents(subC), vat: fromCents(Math.round((subC * r) / 100)) }];
  }

  return out.map((g) => ({ rate: g.rate, net: fromCents(g.netC), vat: fromCents(g.vatC) }));
}

/** The one figure, mirroring public.vat_on_lines. */
export const vatOnLines = (lines, applicable, docRate) =>
  vatBreakdown(lines, applicable, docRate).reduce((t, g) => t + (Number(g.vat) || 0), 0);

/** True when the document carries supplies at more than one rate. */
export const isMixed = (lines, applicable, docRate) =>
  vatBreakdown(lines, applicable, docRate).length > 1;

/** 15, "15.00" and 15.0 all read as "15%"; 7.5 keeps its half. */
export const pct = (v) => `${String(Number(v) || 0).replace(/\.0+$/, "")}%`;

/**
 * The choices on a line's VAT control.
 *
 * Deliberately two, not three. "" follows the document, so a workspace that
 * ever moves off 15% carries its lines with it; pinning a line to 15 would
 * leave it behind. A rate that is neither the document's nor zero is a thing
 * the column accepts and this control does not offer, because South Africa
 * has one standard rate and a dropdown of hypotheticals helps nobody.
 */
export const VAT_CHOICES = (docRate) => [
  { value: "", label: `VAT ${pct(docRate)}` },
  { value: "0", label: "No VAT" },
];

/** What the control should show for a line. "" when it follows the document. */
export const vatChoiceOf = (line) => {
  const own = line?.vat_rate;
  if (own === null || own === undefined || String(own).trim() === "") return "";
  return String(Number(own));
};

/** What to store for a chosen value: null to follow the document. */
export const vatValueOf = (choice) =>
  choice === "" || choice === null || choice === undefined ? null : Number(choice);
