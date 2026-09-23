import React, { useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { Ctx } from "../main";
import { CURRENCIES } from "../lib/money";

// The workspace's own billing details - the other half of an invoice.
// One row per workspace, ops only. Bank details are not something crew or
// another workspace can read; the database enforces that, not this screen.

const SECTIONS = [
  ["Who is issuing", [
    ["trading_name",  "Trading name",     "Section 9"],
    ["legal_name",    "Legal name",       "Crate Logik (Pty) Ltd"],
    ["address",       "Address",          "6 Lewin Street, Woodstock, Cape Town 7925"],
    ["vat_number",    "VAT number",       ""],
    ["reg_number",    "Company reg. no.", ""],
    ["eori_number",   "EORI number",      "For export paperwork"],
    ["billing_email", "Billing email",    "accounts@section9.co.za"],
    ["phone",         "Phone",            ""],
  ]],
  ["Where payment goes", [
    ["bank_account_holder", "Account holder", ""],
    ["bank_name",           "Bank",           "FNB, Standard Bank…"],
    ["bank_branch",         "Branch",         ""],
    ["bank_branch_code",    "Branch code",    ""],
    ["bank_account_number", "Account number", ""],
    ["bank_swift",          "SWIFT / BIC",    "For payments from abroad"],
  ]],
  ["On the invoice", [
    ["default_currency", "Default currency", ""],   // rendered as a select below
    ["payment_terms",  "Payment terms (days)", "30"],
    ["invoice_prefix", "Invoice prefix",       "S9-"],
    ["invoice_footer", "Footer / terms",       "Anything that should appear on every invoice"],
  ]],
];

export default function BillingSettings() {
  const { profile } = useContext(Ctx);
  const [draft, setDraft] = useState({});
  const [msg, setMsg] = useState("");
  const isOps = profile?.role === "ops";

  const load = async () => {
    const { data } = await supabase.from("workspace_billing").select("*").maybeSingle();
    setDraft(data ?? {});
  };
  useEffect(() => { if (isOps) load(); }, [isOps]);

  if (!isOps) return <div className="page empty">Only ops can edit billing details.</div>;

  // `override` matters for the currency select: setDraft has not committed by
  // the time onChange fires, so reading draft[key] here would save the old
  // value. Text fields save on blur, by which time draft is current.
  const save = async (key, override) => {
    const raw = override !== undefined ? override : draft[key];
    const value = key === "payment_terms"
      ? (raw === "" || raw == null ? null : Number(raw))
      : (raw ?? null);

    const { data, error } = await supabase.from("workspace_billing").upsert({
      tenant_id: profile.tenant_id,
      ...draft,
      payment_terms: draft.payment_terms === "" || draft.payment_terms == null
        ? null : Number(draft.payment_terms),
      [key]: value,
      updated_by: profile.id, updated_at: new Date().toISOString(),
    }, { onConflict: "tenant_id" }).select("tenant_id");

    if (error) { setMsg("Could not save: " + error.message); return; }
    if (!data?.length) { setMsg("That change was refused by the database."); return; }
    setMsg("");
  };

  return (
    <div className="page">
      <Link className="muted" style={{ marginBottom: 10 }} to="/dashboard">← Office</Link>
      <h1>Billing details</h1>
      <p className="muted">
        Yours, not your clients'. These print on every invoice from this workspace.
      </p>

      {msg && <div className="card" style={{ color: "var(--warn)" }}>{msg}</div>}

      {SECTIONS.map(([title, fields]) => (
        <div key={title}>
          <h2>{title}</h2>
          <div className="card">
            {fields.map(([key, label, ph]) => (
              <div key={key}>
                <label>{label}</label>
                {key === "default_currency" ? (<>
                  <select value={draft[key] ?? "ZAR"}
                    onChange={(e) => {
                      setDraft({ ...draft, [key]: e.target.value });
                      save(key, e.target.value);
                    }}>
                    {CURRENCIES.map((c) => (
                      <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
                    ))}
                  </select>
                  <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
                    What new invoices are billed in, and the currency your rate
                    card is priced in. Any single job can be switched on its own
                    charge sheet.
                  </div>
                </>) : key === "address" || key === "invoice_footer" ? (
                  <textarea rows={3} value={draft[key] ?? ""} placeholder={ph}
                    onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                    onBlur={() => save(key)} />
                ) : (
                  <input value={draft[key] ?? ""} placeholder={ph}
                    inputMode={key === "payment_terms" ? "numeric" : undefined}
                    onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                    onBlur={() => save(key)} />
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      <p className="muted" style={{ fontSize: 12 }}>
        Only ops in this workspace can see or change these. Other workspaces keep
        their own, separately.
      </p>
    </div>
  );
}
