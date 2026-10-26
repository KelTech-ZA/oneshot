// Turning a quote into money on a job.
//
// The parser reads a quote - in the mail body, in an attached PDF or Word
// file, or typed into a chat - and hands back two things per job: who is
// billed, and the priced lines. This writes both.
//
// Three rules shape everything here, and all three are about the same thing:
// an invoice is a claim on somebody's money, so being wrong is expensive in a
// way that being incomplete is not.
//
//   1. A PRICE IS NEVER INVENTED. A line with no figure is created at zero and
//      the job is flagged. A blank gets queried before it goes out; a guessed
//      number gets paid, and then it is your word against their quote.
//
//      A price taken from THIS WORKSPACE'S OWN CHARGE HISTORY is not an
//      invention and is allowed - see applyPriceHints below - but only on
//      these terms, which are what keep it from becoming one:
//        - it never overrides a figure the message stated;
//        - it carries where it came from, in words a person can argue with
//          ("last crate build was R3 135.00 on SEC-0142"), never a bare number;
//        - the job is flagged check_price, so the line is looked at before
//          anybody issues an invoice off the back of it.
//      The rate card was always allowed to price a line this way. The only
//      change is that a workspace which has never filled its rate card in can
//      now be asked what it actually charged instead.
//
//   2. THE RATE CARD IS NOT EDITED FROM A MAIL. A quote line is attached to an
//      existing charge type when its name matches one, so reporting by type
//      keeps working. When nothing matches, the line stands on its own rather
//      than inventing a new type - a rate card that anybody can add to by
//      sending an email stops being a rate card.
//
//   3. BILLING DETAILS ARE COPIED, NOT LINKED. Correcting a client's address
//      next year must not rewrite what was invoiced last year. The client is
//      recorded alongside, so statements can group by customer.

// deno-lint-ignore no-explicit-any
type Sb = any;

import { findClient } from "./clientmatch.ts";
import type { MatchableClient } from "./clientmatch.ts";

export interface ParsedCharge {
  description?: unknown;
  quantity?: unknown;
  unit?: unknown;
  unit_price?: unknown;
  currency?: unknown;
}

export interface ParsedBilling {
  bill_to_name?: unknown;
  bill_to_address?: unknown;
  vat_number?: unknown;
  reg_number?: unknown;
  billing_email?: unknown;
  their_reference?: unknown;
  payment_terms?: unknown;
  vat_applicable?: unknown;
  vat_rate?: unknown;
  currency?: unknown;
  quote_number?: unknown;
}

const UNITS = ["job", "item", "hour", "day", "km", "kg", "m2", "m3", "night", "week"];

const text = (v: unknown, max = 300): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

/**
 * A number out of whatever the quote wrote: 4250, "4 250.00", "R4,250",
 * "1 234,56" (European), "(500)" for a credit.
 *
 * Returns null rather than 0 for something unreadable, because the difference
 * between "this costs nothing" and "I could not read the price" is the whole
 * point of rule 1.
 */
export function money(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;

  let s = String(v).trim();
  if (!s) return null;

  const negative = /^\(.*\)$/.test(s) || s.startsWith("-");
  s = s.replace(/[()]/g, "").replace(/^-/, "");
  // Strip currency symbols, codes and any spacing used as a thousands break.
  s = s.replace(/[A-Za-z$€£¥]/g, "").replace(/\s| /g, "").trim();
  if (!s) return null;

  // Decide which separator is the decimal point by whichever comes last.
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lastComma > -1) {
    // A lone comma is a decimal comma only when it looks like one: 1,5 or 1,50.
    s = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** "15", "15%", "15.0" -> 15. Anything else -> null. */
export function rate(v: unknown): number | null {
  const n = money(typeof v === "string" ? v.replace("%", "") : v);
  return n != null && n >= 0 && n <= 100 ? n : null;
}

const CURRENCIES = ["ZAR", "EUR", "USD", "GBP", "AUD", "CHF", "JPY", "CNY"];
const SYMBOLS: Record<string, string> = { "R": "ZAR", "€": "EUR", "£": "GBP", "$": "USD", "¥": "JPY" };

export function currency(v: unknown): string | null {
  const s = text(v, 12);
  if (!s) return null;
  const up = s.toUpperCase().trim();
  if (CURRENCIES.includes(up)) return up;
  for (const [sym, code] of Object.entries(SYMBOLS)) if (up.startsWith(sym)) return code;
  return null;
}

export interface ChargeRow {
  tenant_id: string;
  job_id: string;
  charge_type_id: string | null;
  description: string;
  unit: string;
  quantity: number;
  unit_price: number;
  sort: number;
  created_by: string | null;
}

export interface ChargePlan {
  rows: ChargeRow[];
  /** Lines the quote described but did not price. */
  unpriced: string[];
}

export interface ChargeType { id: string; key: string; label: string; unit: string | null }

/** Loose name matching against the workspace's own rate card. See rule 2. */
function matchType(
  types: ChargeType[],
  description: string,
  rules?: Map<string, string>,
): ChargeType | null {
  const want = description.toLowerCase().replace(/\s+/g, " ").trim();
  if (!want) return null;

  // A decided rule comes first: it is the one case where a person has actually
  // said what this line means. A quote line matching no label is how a term
  // reached the vocabulary queue, and answering it is what the queue was for.
  const ruled = rules?.get(want);
  if (ruled) {
    const byKey = types.find((t) => t.key === ruled);
    if (byKey) return byKey;
    // A rule pointing at a type since deleted is dropped, not guessed around.
  }

  const exact = types.find((t) => (t.label ?? "").toLowerCase().trim() === want);
  if (exact) return exact;

  // "Crate fabrication - Gopal Dagnogo travel frame" should still find
  // "Crate fabrication". Longest label first, so the most specific type wins.
  const near = types
    .filter((t) => t.label && want.includes(t.label.toLowerCase().trim()))
    .sort((a, b) => b.label.length - a.label.length);
  return near[0] ?? null;
}

/**
 * Turn the parsed quote lines into job_charges rows.
 *
 * Nothing is written here - the caller inserts - so this is testable without a
 * database, which matters more for money than for anything else in the app.
 */
export function planCharges(
  tenantId: string,
  jobId: string,
  parsed: unknown,
  types: ChargeType[],
  createdBy: string | null = null,
  /** Decided charge-type rules: normalised description -> charge_types.key. */
  rules?: Map<string, string>,
): ChargePlan {
  const rows: ChargeRow[] = [];
  const unpriced: string[] = [];
  if (!Array.isArray(parsed)) return { rows, unpriced };

  for (const raw of parsed as ParsedCharge[]) {
    const description = text(raw?.description, 300);
    if (!description) continue;

    // A VAT or total line is not a charge, whatever the quote called it.
    if (/^(sub\s*total|total|vat|tax|balance due|amount due)\b/i.test(description)) continue;

    const price = money(raw?.unit_price);
    if (price == null) unpriced.push(description);

    const qtyRaw = money(raw?.quantity);
    const quantity = qtyRaw != null && qtyRaw > 0 ? qtyRaw : 1;

    const unitRaw = text(raw?.unit, 20)?.toLowerCase() ?? null;
    const type = matchType(types, description, rules);
    const unit = (unitRaw && UNITS.includes(unitRaw) ? unitRaw : null)
      ?? type?.unit ?? "job";

    rows.push({
      tenant_id: tenantId,
      job_id: jobId,
      charge_type_id: type?.id ?? null,
      description,
      unit,
      quantity,
      // Unpriced lines are created at zero AND flagged. The line has to exist:
      // work that was quoted and then silently left off the invoice is worse
      // than a line reading R0.00 that somebody has to fill in.
      unit_price: price ?? 0,
      sort: rows.length * 10,
      created_by: createdBy,
    });
  }

  return { rows, unpriced };
}

export interface BillingPlan {
  /** The job_billing row, or null when the quote said nothing about billing. */
  row: Record<string, unknown> | null;
  /** Changes for the jobs row itself: currency and VAT live there. */
  job: Record<string, unknown>;
}

export interface ClientRow {
  id: string; name: string | null; legal_name: string | null;
  /** Other names this customer is called in mail. See 46-client-aliases.sql. */
  aliases?: string[] | null;
  billing_address?: string | null; vat_number?: string | null;
  reg_number?: string | null; billing_email?: string | null;
  payment_terms?: string | null;
}

/**
 * Which customer a quote means.
 *
 * The matching itself lives in clientmatch.ts, which is where the tiers and
 * the guards are tested. This stays as the name the rest of the app already
 * calls, so nothing else had to change.
 */
export function matchClient(
  clients: ClientRow[],
  name: string | null,
  rules?: Map<string, string>,
): ClientRow | null {
  return findClient(clients as MatchableClient[], name, rules).client as ClientRow | null;
}

export function planBilling(
  tenantId: string,
  jobId: string,
  parsed: ParsedBilling | null | undefined,
  clients: ClientRow[],
  updatedBy: string | null = null,
  /** Decided client-name rules: normalised name -> clients.id. */
  rules?: Map<string, string>,
): BillingPlan {
  const job: Record<string, unknown> = {};
  if (!parsed || typeof parsed !== "object") return { row: null, job };

  const ccy = currency(parsed.currency);
  if (ccy) job.currency = ccy;

  if (typeof parsed.vat_applicable === "boolean") job.vat_applicable = parsed.vat_applicable;
  const r = rate(parsed.vat_rate);
  if (r != null) {
    job.vat_rate = r;
    // A quote that states a rate is charging it, unless it also said otherwise.
    if (job.vat_applicable === undefined && r > 0) job.vat_applicable = true;
  }

  const name = text(parsed.bill_to_name, 200);
  const client = matchClient(clients, name, rules);

  const row: Record<string, unknown> = {
    job_id: jobId, tenant_id: tenantId,
    updated_by: updatedBy, updated_at: new Date().toISOString(),
  };
  let any = false;
  const put = (k: string, v: unknown) => { if (v != null) { row[k] = v; any = true; } };

  put("bill_to_name", name);
  put("bill_to_address", text(parsed.bill_to_address, 400));
  put("vat_number", text(parsed.vat_number, 40));
  put("reg_number", text(parsed.reg_number, 40));
  put("billing_email", text(parsed.billing_email, 160)?.toLowerCase());
  put("reference", text(parsed.their_reference, 120));
  put("payment_terms", text(parsed.payment_terms, 60));

  // Recognising the customer is what lets a statement group this job's invoice
  // under them. The details above stay copied even so - see rule 3.
  if (client) {
    row.client_id = client.id;
    any = true;
    // Fill only what the quote left out, never overwrite what it said.
    if (row.bill_to_address == null && client.billing_address) row.bill_to_address = client.billing_address;
    if (row.vat_number == null && client.vat_number) row.vat_number = client.vat_number;
    if (row.reg_number == null && client.reg_number) row.reg_number = client.reg_number;
    if (row.billing_email == null && client.billing_email) row.billing_email = client.billing_email;
    if (row.payment_terms == null && client.payment_terms) row.payment_terms = client.payment_terms;
  }

  return { row: any ? row : null, job };
}

// ---------------------------------------------------------------------------
// Filling in prices the message did not state
// ---------------------------------------------------------------------------
// planCharges leaves those lines at zero and names them in `unpriced`. That is
// still the right answer when nothing is known. But a workspace that has
// quoted crates forty times does know roughly what a crate costs, and making
// somebody type it again - from a number they would have to go and look up -
// is work the app can save them.
//
// The source is price_lines_in in the database, which reads this workspace's
// own job_charges and rate card and returns what it found along with where it
// found it. Applying the answers is kept here, as a plain function over plain
// data, because it decides what goes on an invoice and that is worth being
// able to test without a database.

/** One row of price_lines_in. */
export interface PriceHint {
  idx: number;
  unit_price: number | string | null;
  source: string | null;
  seen: string | null;
}

/** A line this function priced, and what it priced it from. */
export interface GuessedPrice {
  description: string;
  unit_price: number;
  seen: string;
}

export interface HintedPlan {
  rows: ChargeRow[];
  /** Still unpriced after hinting: nothing was known about these at all. */
  unpriced: string[];
  /** Priced from history rather than from the message. Needs a human eye. */
  guessed: GuessedPrice[];
}

/**
 * Fill zero-priced lines from what this workspace has charged before.
 *
 * Hints are matched to rows by position, which is how price_lines_in returns
 * them - idx is the index of the line as it was sent. A hint for a row that
 * already has a price is ignored rather than preferred: rule 1.
 */
export function applyPriceHints(plan: ChargePlan, hints: PriceHint[]): HintedPlan {
  const unpriced = new Set(plan.unpriced);
  const byIdx = new Map<number, PriceHint>();
  for (const h of hints ?? []) {
    if (h && Number.isInteger(h.idx)) byIdx.set(h.idx, h);
  }

  const rows: ChargeRow[] = [];
  const guessed: GuessedPrice[] = [];
  const stillUnpriced: string[] = [];

  plan.rows.forEach((row, i) => {
    // Only a line the MESSAGE did not price is open to a hint. A line the
    // message priced at zero - "no charge", "waived" - said zero on purpose.
    if (!unpriced.has(row.description)) { rows.push(row); return; }

    const hint = byIdx.get(i);
    const price = hint == null ? null : money(hint.unit_price);

    // 'stated' means the hint only handed back the figure already in the
    // message. That cannot happen for a line in `unpriced`, but if it ever
    // did it would not be new information, so it is not treated as one.
    if (price == null || price <= 0 || hint?.source === "stated") {
      stillUnpriced.push(row.description);
      rows.push(row);
      return;
    }

    rows.push({ ...row, unit_price: price });
    guessed.push({
      description: row.description,
      unit_price: price,
      seen: hint?.seen ?? hint?.source ?? "charged before",
    });
  });

  return { rows, unpriced: stillUnpriced, guessed };
}

/**
 * The flags a hinted plan puts on the job.
 *
 * Two different things, kept apart because they need different actions: a
 * blank has to be filled in before invoicing, a guess has to be agreed with.
 */
export function pricingFlags(plan: HintedPlan): string[] {
  const out: string[] = [];
  for (const d of plan.unpriced) out.push(`missing_info:pricing — ${d}`.slice(0, 180));
  for (const g of plan.guessed) out.push(`check_price — ${g.description} (${g.seen})`.slice(0, 180));
  return out;
}
