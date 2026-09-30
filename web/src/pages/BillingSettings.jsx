import React, { useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { Ctx } from "../main";
import { CURRENCIES } from "../lib/money";
import { clearLetterheadCache, logoUrl } from "./Letterhead";

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
  const [busy, setBusy] = useState(false);
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


  // ---- The logo -----------------------------------------------------------
  // Written to the public "branding" bucket under this workspace's own folder;
  // the storage policy refuses anything else. The filename carries a timestamp
  // so a replacement never has to fight a cached copy of the old one - the URL
  // simply changes.
  const uploadLogo = async (file) => {
    if (!file) return;
    if (!/^image\//.test(file.type)) { setMsg("That is not an image."); return; }
    if (file.size > 2 * 1024 * 1024) { setMsg("Keep the logo under 2MB."); return; }

    setBusy(true); setMsg("");
    const ext = (file.name.split(".").pop() || "png").toLowerCase().slice(0, 5);
    const path = `${profile.tenant_id}/logo-${Date.now()}.${ext}`;
    const previous = draft.logo_path;

    const { error: upErr } = await supabase.storage.from("branding")
      .upload(path, file, { upsert: true, contentType: file.type });
    if (upErr) { setBusy(false); setMsg("Could not upload: " + upErr.message); return; }

    setDraft((d) => ({ ...d, logo_path: path }));
    await save("logo_path", path);
    if (previous && previous !== path) {
      await supabase.storage.from("branding").remove([previous]);   // no orphans
    }
    clearLetterheadCache();
    setBusy(false);
  };

  const removeLogo = async () => {
    const previous = draft.logo_path;
    setBusy(true);
    setDraft((d) => ({ ...d, logo_path: null }));
    await save("logo_path", null);
    if (previous) await supabase.storage.from("branding").remove([previous]);
    clearLetterheadCache();
    setBusy(false);
  };

  return (
    <div className="page">
      <Link className="muted" style={{ marginBottom: 10 }} to="/dashboard">← Office</Link>
      <h1>Billing details</h1>
      <p className="muted">
        Yours, not your clients'. These print on every invoice from this workspace.
      </p>

      {msg && <div className="card" style={{ color: "var(--warn)" }}>{msg}</div>}

      <h2>Letterhead</h2>
      <div className="card">
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          Printed at the top of every document this workspace produces - job
          cards, charge sheets and invoices alike. The name, address and
          numbers come from the details below, so there is only ever one copy
          of them to keep right.
        </p>

        {draft.logo_path ? (
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <img src={logoUrl(draft.logo_path)} alt="Logo"
              style={{ maxHeight: 72, maxWidth: 220, objectFit: "contain",
                       border: "1px solid var(--line)", borderRadius: 6, padding: 6 }} />
            <button className="btn btn-ghost" style={{ marginTop: 0 }}
              disabled={busy} onClick={removeLogo}>Remove logo</button>
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 13 }}>No logo yet.</div>
        )}

        <label style={{ marginTop: 12 }}>{draft.logo_path ? "Replace logo" : "Upload logo"}</label>
        <input type="file" accept="image/*" disabled={busy}
          onChange={(e) => { uploadLogo(e.target.files?.[0]); e.target.value = ""; }} />
        <div className="muted" style={{ fontSize: 12 }}>
          PNG or SVG on a transparent background prints best. Wider than tall,
          under 2MB. It sits about 18mm tall on the page.
        </div>
      </div>

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
