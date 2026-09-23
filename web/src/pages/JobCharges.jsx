import React, { useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { Ctx } from "../main";
import BillTo from "./BillTo";
import { CURRENCIES, amount, amountWithCode, jobCurrency, money } from "../lib/money";

// What the job costs. Ops only - the database enforces that too, so this is
// not merely a hidden panel.
//
// The rate card fills a line in; it never locks it. One crate is not the same
// price as another, so description, quantity and price all stay editable.
//
// Currency is chosen per invoice and NOTHING is converted. Switching to USD
// relabels the sheet; it does not restate a rand rate card in dollars. The
// warning below exists because that distinction is easy to miss at a glance.

export default function JobCharges({ jobId, tenantId, job, onJobChange }) {
  const { profile } = useContext(Ctx);
  const [rates, setRates] = useState([]);
  const [lines, setLines] = useState([]);
  const [draft, setDraft] = useState({});
  const [picked, setPicked] = useState("");
  const [creating, setCreating] = useState(null);   // { label, unit, rate }
  const [vatHint, setVatHint] = useState(null);
  const [ccyVatOffer, setCcyVatOffer] = useState(null);
  // The issuing party. Read from workspace_billing for whoever is signed in -
  // RLS scopes that row to their own tenant, so each workspace prints its own
  // details and its own bank account from this same code.
  const [issuer, setIssuer] = useState(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const isOps = profile?.role === "ops";

  const load = async () => {
    const [{ data: r }, { data: l }, { data: wb }] = await Promise.all([
      supabase.from("charge_types").select("*").eq("active", true).order("sort"),
      supabase.from("job_charges").select("*").eq("job_id", jobId).order("sort").order("created_at"),
      supabase.from("workspace_billing").select("*").maybeSingle(),
    ]);
    setRates(r ?? []);
    setLines(l ?? []);
    setIssuer(wb ?? null);
    setDraft(Object.fromEntries((l ?? []).map((x) => [x.id, {
      description: x.description, quantity: x.quantity, unit_price: x.unit_price,
    }])));
  };
  useEffect(() => { if (isOps) load(); }, [jobId, isOps]);

  if (!isOps) return null;

  const addLine = async (typeId, known) => {
    const t = known ?? rates.find((x) => x.id === typeId);
    setBusy(true);
    const { error } = await supabase.from("job_charges").insert({
      tenant_id: tenantId, job_id: jobId,
      charge_type_id: t?.id ?? null,
      description: t?.label ?? "Charge",
      unit: t?.unit ?? "job",
      quantity: 1,
      unit_price: t?.default_rate ?? 0,
      sort: lines.length * 10,
      created_by: profile?.id ?? null,
    });
    setBusy(false);
    setPicked("");
    if (error) { setMsg(error.message); return; }
    await load();
  };

  // A new kind of charge usually announces itself mid-job - "clearance" on the
  // first export - so it can be created here and added straight to the sheet.
  // It joins the rate card, so the next job simply picks it from the list.
  const createType = async () => {
    const label = (creating?.label ?? "").trim();
    if (!label) { setMsg("Give the charge a name."); return; }
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    if (!key) { setMsg("Use letters or numbers in the name."); return; }

    setBusy(true);
    const { data, error } = await supabase.from("charge_types").insert({
      tenant_id: tenantId,
      key, label,
      unit: creating.unit || "job",
      default_rate: Number(creating.rate) || 0,
      sort: (rates.at(-1)?.sort ?? 0) + 10,
    }).select().single();
    setBusy(false);

    if (error) {
      setMsg(error.code === "23505"
        ? `"${label}" is already on your rate card.`
        : "Could not create it: " + error.message);
      return;
    }
    setCreating(null);
    setMsg("");
    await load();
    await addLine(data.id, data);          // straight onto this job
  };

  const patch = async (line, field) => {
    const value = draft[line.id]?.[field];
    if (value === undefined || String(value) === String(line[field])) return;
    const payload = field === "description" ? { description: value } : { [field]: Number(value) || 0 };
    const { data, error } = await supabase.from("job_charges")
      .update(payload).eq("id", line.id).select("id");
    if (error) { setMsg("Could not save: " + error.message); return; }
    if (!data?.length) { setMsg("That change was refused by the database."); return; }
    setMsg("");
    await load();
  };

  const removeLine = async (line) => {
    if (!window.confirm(`Remove "${line.description}"?`)) return;
    const { error } = await supabase.from("job_charges").delete().eq("id", line.id);
    if (error) { setMsg("Could not remove: " + error.message); return; }
    await load();
  };

  const setVat = async (applicable) => {
    const { data, error } = await supabase.from("jobs")
      .update({ vat_applicable: applicable }).eq("id", jobId).select("id");
    if (error) { setMsg("Could not change VAT: " + error.message); return; }
    if (!data?.length) { setMsg("That change was refused by the database."); return; }
    await onJobChange?.();
  };

  // The job's own currency, else what this workspace bills in, else rand.
  const ccy = jobCurrency(job, issuer);
  const homeCcy = issuer?.default_currency ?? "ZAR";

  const setCurrency = async (code) => {
    if (code === ccy) return;
    // The rate card is priced in the workspace's own currency. Moving a sheet
    // that already has lines on it leaves those numbers untouched - which is
    // correct, and worth saying out loud before it goes to a client.
    if (lines.length && !window.confirm(
      `Bill this job in ${code}?\n\n`
      + `The ${lines.length} line${lines.length > 1 ? "s" : ""} already on the sheet keep their `
      + `numbers exactly as they are — nothing is converted. Re-enter the prices `
      + `in ${code} yourself.`)) return;

    const { data, error } = await supabase.from("jobs")
      .update({ currency: code }).eq("id", jobId).select("id");
    if (error) { setMsg("Could not change currency: " + error.message); return; }
    if (!data?.length) { setMsg("That change was refused by the database."); return; }
    setMsg("");
    // Billing in a foreign currency is nearly always billing outside South
    // Africa. Offered, never applied - same rule as the Bill-to hint.
    setCcyVatOffer(code !== "ZAR" && job?.vat_applicable ? code : null);
    await onJobChange?.();
  };

  const subtotal = lines.reduce((n, l) => n + Number(l.line_total ?? 0), 0);
  const rate = Number(job?.vat_rate ?? 15);
  const vat = job?.vat_applicable ? subtotal * (rate / 100) : 0;

  const cell = { border: "none", borderBottom: "1px solid var(--line)", background: "transparent",
    font: "inherit", padding: "4px 2px", width: "100%", marginBottom: 0 };

  return (
    <>
      {/* Printed only. Whose invoice this is - never on screen, where it would
          just repeat what the user already knows about their own company. */}
      {issuer && (
        <div className="only-print" style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>
            {issuer.trading_name || issuer.legal_name}
          </div>
          {issuer.legal_name && issuer.trading_name
            && issuer.legal_name !== issuer.trading_name && <div>{issuer.legal_name}</div>}
          {issuer.address && <div style={{ whiteSpace: "pre-line" }}>{issuer.address}</div>}
          <div>
            {[issuer.vat_number && `VAT ${issuer.vat_number}`,
              issuer.reg_number && `Reg. ${issuer.reg_number}`,
              issuer.eori_number && `EORI ${issuer.eori_number}`].filter(Boolean).join(" · ")}
          </div>
          {(issuer.billing_email || issuer.phone) && (
            <div>{[issuer.billing_email, issuer.phone].filter(Boolean).join(" · ")}</div>
          )}
        </div>
      )}

      <BillTo jobId={jobId} tenantId={tenantId} onVatHint={setVatHint} />

      {/* Offered, never applied silently: the total is the thing nobody wants
          changed behind their back. */}
      {vatHint && job?.vat_applicable && (
        <div className="card no-print" style={{ borderLeft: "3px solid var(--accent)" }}>
          <div style={{ fontSize: 14, marginBottom: 8 }}>
            {vatHint} is marked as billed outside South Africa. Zero-rate this job?
          </div>
          <button className="btn btn-ghost" style={{ marginTop: 0 }}
            onClick={async () => { await setVat(false); setVatHint(null); }}>
            Turn VAT off
          </button>
          <button className="btn btn-ghost" onClick={() => setVatHint(null)}>Leave it on</button>
        </div>
      )}

      {ccyVatOffer && job?.vat_applicable && (
        <div className="card no-print" style={{ borderLeft: "3px solid var(--accent)" }}>
          <div style={{ fontSize: 14, marginBottom: 8 }}>
            Billing in {ccyVatOffer} usually means billing outside South Africa.
            Zero-rate this job?
          </div>
          <button className="btn btn-ghost" style={{ marginTop: 0 }}
            onClick={async () => { await setVat(false); setCcyVatOffer(null); }}>
            Turn VAT off
          </button>
          <button className="btn btn-ghost" onClick={() => setCcyVatOffer(null)}>Leave it on</button>
        </div>
      )}

      <h2>Charges</h2>
      {msg && <div className="muted" style={{ color: "var(--warn)", fontSize: 13 }}>{msg}</div>}

      {lines.length === 0 && (
        <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
          Nothing charged yet. Add a line from your rate card below.
        </div>
      )}

      {lines.map((l) => (
        <div className="card" key={l.id} style={{ marginBottom: 8 }}>
          <input style={{ ...cell, fontWeight: 600 }}
            value={draft[l.id]?.description ?? ""}
            onChange={(e) => setDraft({ ...draft, [l.id]: { ...draft[l.id], description: e.target.value } })}
            onBlur={() => patch(l, "description")} />
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
            <input type="number" step="0.25" inputMode="decimal" style={{ ...cell, width: 66 }}
              value={draft[l.id]?.quantity ?? ""}
              onChange={(e) => setDraft({ ...draft, [l.id]: { ...draft[l.id], quantity: e.target.value } })}
              onBlur={() => patch(l, "quantity")} />
            <span className="muted" style={{ fontSize: 13, whiteSpace: "nowrap" }}>{l.unit} ×</span>
            <input type="number" step="0.01" inputMode="decimal" style={{ ...cell, width: 92 }}
              value={draft[l.id]?.unit_price ?? ""}
              onChange={(e) => setDraft({ ...draft, [l.id]: { ...draft[l.id], unit_price: e.target.value } })}
              onBlur={() => patch(l, "unit_price")} />
            <span style={{ marginLeft: "auto", fontWeight: 600, whiteSpace: "nowrap" }}>
              {amount(l.line_total, ccy)}
            </span>
            <button onClick={() => removeLine(l)} aria-label="Remove charge" className="no-print"
              style={{ background: "none", border: "none", color: "var(--warn)",
                cursor: "pointer", font: "inherit" }}>×</button>
          </div>
        </div>
      ))}

      <div className="no-print" style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        <select style={{ flex: 1, marginBottom: 0 }} value={picked}
          onChange={(e) => {
            if (e.target.value === "__new") {
              setPicked("");
              setCreating({ label: "", unit: "job", rate: "" });
            } else setPicked(e.target.value);
          }}>
          <option value="">Add from rate card…</option>
          {rates.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}{Number(r.default_rate) ? ` — ${amount(r.default_rate, homeCcy)}/${r.unit}` : ""}
            </option>
          ))}
          <option value="__new">＋ New charge type…</option>
        </select>
        <button className="btn btn-ghost" style={{ marginTop: 0 }}
          disabled={busy || !picked} onClick={() => addLine(picked)}>Add</button>
      </div>

      {creating && (
        <div className="card no-print">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>New charge type</div>
          <label>Name</label>
          <input autoFocus value={creating.label}
            placeholder="Clearance, crane hire, export packing…"
            onChange={(e) => setCreating({ ...creating, label: e.target.value })} />
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}>
              <label>Rate</label>
              <input type="number" step="0.01" inputMode="decimal" value={creating.rate}
                placeholder="0.00"
                onChange={(e) => setCreating({ ...creating, rate: e.target.value })} />
            </div>
            <div style={{ flex: 1 }}>
              <label>Per</label>
              <select value={creating.unit}
                onChange={(e) => setCreating({ ...creating, unit: e.target.value })}>
                {["job", "hour", "crate", "item", "day", "km"].map((u) => <option key={u}>{u}</option>)}
              </select>
            </div>
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            This is saved to your rate card and available on every job. The price
            stays editable per job.
          </div>
          <button className="btn btn-primary" disabled={busy} onClick={createType}>
            {busy ? "Saving…" : "Create and add"}
          </button>
          <button className="btn btn-ghost" onClick={() => setCreating(null)}>Cancel</button>
        </div>
      )}

      <div className="card">
        {/* Chosen per invoice, above the money it applies to. */}
        <div className="row no-print" style={{ alignItems: "center", marginBottom: 8 }}>
          <span className="muted">Invoice in</span>
          <select value={ccy} onChange={(e) => setCurrency(e.target.value)}
            style={{ width: 210, marginBottom: 0 }}>
            {CURRENCIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {c.name}{c.code === homeCcy ? " (your default)" : ""}
              </option>
            ))}
          </select>
        </div>
        {ccy !== homeCcy && (
          <div className="muted no-print" style={{ fontSize: 12, marginBottom: 8 }}>
            Your rate card is priced in {homeCcy}. Prices pulled from it are not
            converted — type the {ccy} figure on each line.
          </div>
        )}

        <div className="row"><span className="muted">Subtotal</span>
          <span style={{ fontWeight: 600 }}>{amount(subtotal, ccy)}</span></div>

        <label className="no-print" style={{ display: "flex", gap: 8, alignItems: "flex-start",
          margin: "8px 0", fontWeight: 400 }}>
          <input type="checkbox" checked={!!job?.vat_applicable}
            onChange={(e) => setVat(e.target.checked)} style={{ width: 18, height: 18, marginTop: 2 }} />
          <span>Charge VAT at {rate}%
            <br /><span className="muted" style={{ fontSize: 12 }}>
              Turn off for billing outside South Africa.
            </span></span>
        </label>

        <div className="row">
          <span className="muted">VAT{job?.vat_applicable ? ` (${rate}%)` : " — zero-rated"}</span>
          <span style={{ fontWeight: 600 }}>{amount(vat, ccy)}</span>
        </div>
        <div className="row" style={{ marginTop: 6, paddingTop: 8, borderTop: "1px solid var(--line)" }}>
          <span style={{ fontWeight: 700 }}>Total</span>
          <span style={{ fontWeight: 700, fontSize: 18 }}>{amountWithCode(subtotal + vat, ccy)}</span>
        </div>
      </div>

      {/* Payment details, printed. Again from this workspace's own row. */}
      {issuer && (issuer.bank_account_number || issuer.invoice_footer) && (
        <div className="only-print" style={{ marginTop: 14, paddingTop: 10,
          borderTop: "1px solid var(--line)", fontSize: 13 }}>
          {issuer.bank_account_number && (<>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>Payment</div>
            {issuer.bank_account_holder && <div>{issuer.bank_account_holder}</div>}
            <div>
              {[issuer.bank_name, issuer.bank_branch,
                issuer.bank_branch_code && `Branch ${issuer.bank_branch_code}`].filter(Boolean).join(" · ")}
            </div>
            <div>Account {issuer.bank_account_number}</div>
            {issuer.bank_swift && <div>SWIFT {issuer.bank_swift}</div>}
          </>)}
          {issuer.payment_terms != null && (
            <div style={{ marginTop: 4 }}>Payment due within {issuer.payment_terms} days.</div>
          )}
          {issuer.invoice_footer && (
            <div style={{ marginTop: 6, whiteSpace: "pre-line" }}>{issuer.invoice_footer}</div>
          )}
        </div>
      )}
    </>
  );
}
