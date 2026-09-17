import React, { useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { Ctx } from "../main";

// Who the job is billed to.
//
// Picking a saved client COPIES their details onto the job rather than linking
// to them. An invoice must not change because someone corrects the client's
// address a year later - what was billed is what was billed.

const FIELDS = [
  ["bill_to_name",    "Billed to",        "Blank Projects (Pty) Ltd"],
  ["bill_to_address", "Address",          "10 Lewin Street, Woodstock, Cape Town 7925"],
  ["vat_number",      "VAT number",       "4180123456"],
  ["eori_number",     "EORI number",      "Exports to the EU/UK"],
  ["reg_number",      "Company reg. no.", ""],
  ["billing_email",   "Billing email",    "accounts@…"],
  ["reference",       "Their reference",  "PO number, order number"],
  ["invoice_number",  "Invoice number",   "Left blank if your accounts package assigns it"],
];

export default function BillTo({ jobId, tenantId, onVatHint }) {
  const { profile } = useContext(Ctx);
  const [row, setRow] = useState(null);
  const [draft, setDraft] = useState({});
  const [clients, setClients] = useState([]);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState("");

  const isOps = profile?.role === "ops";

  const load = async () => {
    const [{ data: b }, { data: cs }] = await Promise.all([
      supabase.from("job_billing").select("*").eq("job_id", jobId).maybeSingle(),
      supabase.from("clients").select("*").order("name"),
    ]);
    setRow(b ?? null);
    setDraft(b ?? {});
    setClients(cs ?? []);
  };
  useEffect(() => { if (isOps) load(); }, [jobId, isOps]);

  if (!isOps) return null;

  const save = async (patch) => {
    const payload = {
      job_id: jobId, tenant_id: tenantId,
      ...draft, ...patch,
      updated_by: profile?.id ?? null, updated_at: new Date().toISOString(),
    };
    delete payload.created_at;
    const { data, error } = await supabase.from("job_billing")
      .upsert(payload, { onConflict: "job_id" }).select("job_id");
    if (error) { setMsg("Could not save: " + error.message); return; }
    if (!data?.length) { setMsg("That change was refused by the database."); return; }
    setMsg("");
    await load();
  };

  // Copying, not linking - see the note at the top of this file.
  const useClient = async (id) => {
    const c = clients.find((x) => x.id === id);
    if (!c) return;
    const copied = {
      client_id: c.id,
      bill_to_name: c.legal_name || c.name,
      bill_to_address: c.billing_address ?? null,
      vat_number: c.vat_number ?? null,
      eori_number: c.eori_number ?? null,
      reg_number: c.reg_number ?? null,
      billing_email: c.billing_email ?? null,
      country: c.country ?? null,
      payment_terms: c.payment_terms ?? null,
    };
    setDraft({ ...draft, ...copied });
    await save(copied);
    setOpen(true);
    // An out-of-country client is normally zero-rated; offer it rather than
    // silently changing the total.
    if (c.vat_applicable === false) onVatHint?.(c.legal_name || c.name);
  };

  const saveAsClient = async () => {
    if (!draft.bill_to_name) { setMsg("Add a name first."); return; }
    const { error } = await supabase.from("clients").insert({
      tenant_id: tenantId,
      name: draft.bill_to_name,
      legal_name: draft.bill_to_name,
      billing_address: draft.bill_to_address ?? null,
      vat_number: draft.vat_number ?? null,
      eori_number: draft.eori_number ?? null,
      reg_number: draft.reg_number ?? null,
      billing_email: draft.billing_email ?? null,
      country: draft.country ?? null,
    });
    if (error) { setMsg("Could not save the client: " + error.message); return; }
    setMsg("Saved to your clients.");
    await load();
  };

  return (
    <>
      <h2>Bill to</h2>
      {msg && <div className="muted" style={{ fontSize: 13, color: "var(--warn)" }}>{msg}</div>}

      {/* Filled in and closed: one line, and a way back in. Ops open this page
          for the charges, not to scroll past a billing form every time. */}
      {row?.bill_to_name && !open && (
        <div className="card" style={{ cursor: "pointer" }} onClick={() => setOpen(true)}>
          <div className="row" style={{ alignItems: "baseline" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis",
                whiteSpace: "nowrap" }}>{row.bill_to_name}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {[row.vat_number && `VAT ${row.vat_number}`,
                  row.eori_number && `EORI ${row.eori_number}`,
                  row.reference].filter(Boolean).join(" · ") || "tap to edit"}
              </div>
            </div>
            <span className="muted no-print" style={{ fontSize: 13, flexShrink: 0 }}>edit</span>
          </div>
          <div className="only-print" style={{ whiteSpace: "pre-line", marginTop: 6 }}>
            {row.bill_to_address}
            {row.reg_number && <div>Reg. {row.reg_number}</div>}
            {row.invoice_number && <div>Invoice {row.invoice_number}</div>}
          </div>
        </div>
      )}

      {!open && !row?.bill_to_name ? (
        <div className="card no-print">
          {clients.length > 0 && (
            <>
              <label>Use a saved client</label>
              <select defaultValue="" onChange={(e) => e.target.value && useClient(e.target.value)}>
                <option value="">Choose…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.legal_name || c.name}</option>
                ))}
              </select>
            </>
          )}
          <button className="btn btn-ghost" style={{ marginTop: 0 }} onClick={() => setOpen(true)}>
            ✎ Enter billing details
          </button>
        </div>
      ) : open ? (
        <div className="card">
          {/* Printed as the invoice header, so it reads as a block rather than
              a form once filled in. */}
          <div className="only-print" style={{ whiteSpace: "pre-line", marginBottom: 6 }}>
            <div style={{ fontWeight: 700 }}>{row?.bill_to_name}</div>
            {row?.bill_to_address}
            {row?.vat_number && <div>VAT {row.vat_number}</div>}
            {row?.eori_number && <div>EORI {row.eori_number}</div>}
            {row?.reg_number && <div>Reg. {row.reg_number}</div>}
            {row?.reference && <div>Ref {row.reference}</div>}
            {row?.invoice_number && <div>Invoice {row.invoice_number}</div>}
          </div>

          <div className="no-print">
            {clients.length > 0 && (
              <select defaultValue="" style={{ marginBottom: 10 }}
                onChange={(e) => e.target.value && useClient(e.target.value)}>
                <option value="">Copy from a saved client…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>{c.legal_name || c.name}</option>
                ))}
              </select>
            )}

            {FIELDS.map(([key, label, placeholder]) => (
              <div key={key}>
                <label>{label}</label>
                {key === "bill_to_address" ? (
                  <textarea rows={3} value={draft[key] ?? ""} placeholder={placeholder}
                    onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                    onBlur={() => save({})} />
                ) : (
                  <input value={draft[key] ?? ""} placeholder={placeholder}
                    onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                    onBlur={() => save({})} />
                )}
              </div>
            ))}

            <button className="btn btn-ghost" onClick={saveAsClient}>
              ＋ Save these details as a client
            </button>
            <button className="btn btn-ghost" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      ) : null}
    </>
  );
}
