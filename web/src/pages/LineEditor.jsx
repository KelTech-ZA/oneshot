import React from "react";
import { money } from "../lib/money";
import { VAT_CHOICES, pct, subtotalOf, vatBreakdown, vatChoiceOf } from "../lib/vat";

// The rows of a quote or an invoice, and the totals under them.
//
// WHY IT IS ITS OWN COMPONENT
//
// Four screens need this now: raising an invoice, raising a quote, and - since
// retotal_invoice and retotal_quote finally have a screen - editing either one
// afterwards. Four copies of a line row carrying a VAT control would be four
// things to keep in step, and this project has already paid for that lesson
// twice: create_quote kept its own copy of the line normaliser and silently
// dropped vat_rate for a week, and billing-run kept a third copy and did the
// same to the monthly pack.
//
// So there is one of these. A line looks the same wherever it is typed, and
// the totals under it are worked out by web/src/lib/vat.js, which is itself
// pinned against the database's arithmetic by sqltest/68-vat-ui.mjs.
//
// WHAT IT DOES NOT DO
//
// It does not save anything and it does not know what it is editing. It is
// handed lines and hands back lines. Whether those go to create_invoice,
// retotal_quote or nowhere at all is the caller's business.

export const blankLine = () => ({
  description: "", unit: "", quantity: "1", unit_price: "", vat_rate: "",
});

/** The server's own shape. Blank descriptions are dropped, as bill_lines does. */
export const toServerLines = (lines, vatValueOf) =>
  (lines ?? [])
    .filter((l) => String(l.description ?? "").trim())
    .map((l) => ({
      description: String(l.description).trim(),
      unit: String(l.unit ?? "").trim() || null,
      quantity: Number(l.quantity) || 1,
      unit_price: Number(l.unit_price) || 0,
      vat_rate: vatValueOf(l.vat_rate),
    }));

/** Lines off a saved document, back into the shape this editor types in. */
export const fromServerLines = (lines) => {
  const rows = (lines ?? []).map((l) => ({
    description: l.description ?? "",
    unit: l.unit ?? "",
    quantity: l.quantity == null ? "1" : String(l.quantity),
    unit_price: l.unit_price == null ? "" : String(l.unit_price),
    // A rate the document does not carry is "at whatever rate this document
    // is at", which is the empty choice, not zero.
    vat_rate: l.vat_rate == null ? "" : String(Number(l.vat_rate)),
  }));
  return rows.length ? rows : [blankLine()];
};

export default function LineEditor({
  lines,
  onChange,
  vatable,
  rate,
  currency,
  /** Shown above the rows. */
  label = "Lines",
}) {
  const setLine = (i, patch) =>
    onChange(lines.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  const removeLine = (i) => onChange(lines.filter((_, n) => n !== i));
  const addLine = () => onChange([...lines, blankLine()]);

  const split = vatBreakdown(lines, vatable, rate);
  const sub = subtotalOf(lines);
  const vat = split.reduce((t, g) => t + Number(g.vat), 0);
  const mixed = split.length > 1;
  const amt = (v) => (currency ? `${currency} ${money(v)}` : money(v));

  return (
    <>
      <label>{label}</label>
      {lines.map((l, i) => (
        <div className="card" key={i} style={{ background: "var(--bg)", marginBottom: 8 }}>
          <input value={l.description} placeholder="What is being charged for"
            onChange={(e) => setLine(i, { description: e.target.value })} />
          <div className="row" style={{ gap: 8 }}>
            <input style={{ flex: 1, minWidth: 0 }} value={l.unit} placeholder="unit (crate, hour…)"
              onChange={(e) => setLine(i, { unit: e.target.value })} />
            <input style={{ flex: 1, minWidth: 0 }} value={l.quantity} inputMode="decimal" placeholder="qty"
              onChange={(e) => setLine(i, { quantity: e.target.value })} />
            <input style={{ flex: 1, minWidth: 0 }} value={l.unit_price} inputMode="decimal" placeholder="price"
              onChange={(e) => setLine(i, { unit_price: e.target.value })} />
          </div>
          <div className="row">
            <select value={vatChoiceOf(l)} disabled={!vatable}
              aria-label={`VAT on line ${i + 1}`}
              onChange={(e) => setLine(i, { vat_rate: e.target.value })}
              style={{ width: "auto", minWidth: 110, marginBottom: 0, fontSize: 13 }}>
              {VAT_CHOICES(rate).map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
            <span className="muted" style={{ marginLeft: "auto" }}>
              {money((Number(l.quantity) || 0) * (Number(l.unit_price) || 0))}
            </span>
            {lines.length > 1 && (
              <button className="topbar-link" style={{ color: "var(--warn)" }}
                onClick={() => removeLine(i)}>remove</button>
            )}
          </div>
        </div>
      ))}
      <button className="btn btn-ghost" style={{ minHeight: 44 }} onClick={addLine}>
        ＋ Add a line
      </button>

      <div className="card" style={{ background: "var(--bg)", marginTop: 12 }}>
        <div className="row"><span className="muted">Subtotal</span><span>{amt(sub)}</span></div>
        {/* More than one rate on the page means the page has to say which is
            which, the way the printed document does. */}
        {mixed ? split.map((g) => (
          <div className="row" key={g.rate}>
            <span className="muted">
              {Number(g.rate) > 0
                ? `VAT ${pct(g.rate)} on ${money(g.net)}`
                : `Zero-rated ${money(g.net)}`}
            </span>
            <span>{money(g.vat)}</span>
          </div>
        )) : (
          <div className="row">
            <span className="muted">{vatable ? `VAT at ${pct(rate)}` : "VAT — zero-rated"}</span>
            <span>{money(vat)}</span>
          </div>
        )}
        <div className="row" style={{ fontWeight: 700 }}>
          <span>Total</span><span>{amt(sub + vat)}</span>
        </div>
      </div>
    </>
  );
}
