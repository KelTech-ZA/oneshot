import React, { useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { Ctx } from "../main";

// What the job costs. Ops only - the database enforces that too, so this is
// not merely a hidden panel.
//
// The rate card fills a line in; it never locks it. One crate is not the same
// price as another, so description, quantity and price all stay editable.

const money = (n) =>
  (Number(n) || 0).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function JobCharges({ jobId, tenantId, job, onJobChange }) {
  const { profile } = useContext(Ctx);
  const [rates, setRates] = useState([]);
  const [lines, setLines] = useState([]);
  const [draft, setDraft] = useState({});
  const [picked, setPicked] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const isOps = profile?.role === "ops";

  const load = async () => {
    const [{ data: r }, { data: l }] = await Promise.all([
      supabase.from("charge_types").select("*").eq("active", true).order("sort"),
      supabase.from("job_charges").select("*").eq("job_id", jobId).order("sort").order("created_at"),
    ]);
    setRates(r ?? []);
    setLines(l ?? []);
    setDraft(Object.fromEntries((l ?? []).map((x) => [x.id, {
      description: x.description, quantity: x.quantity, unit_price: x.unit_price,
    }])));
  };
  useEffect(() => { if (isOps) load(); }, [jobId, isOps]);

  if (!isOps) return null;

  const addLine = async (typeId) => {
    const t = rates.find((x) => x.id === typeId);
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

  const subtotal = lines.reduce((n, l) => n + Number(l.line_total ?? 0), 0);
  const rate = Number(job?.vat_rate ?? 15);
  const vat = job?.vat_applicable ? subtotal * (rate / 100) : 0;

  const cell = { border: "none", borderBottom: "1px solid var(--line)", background: "transparent",
    font: "inherit", padding: "4px 2px", width: "100%", marginBottom: 0 };

  return (
    <>
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
              R {money(l.line_total)}
            </span>
            <button onClick={() => removeLine(l)} aria-label="Remove charge" className="no-print"
              style={{ background: "none", border: "none", color: "var(--warn)",
                cursor: "pointer", font: "inherit" }}>×</button>
          </div>
        </div>
      ))}

      <div className="no-print" style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        <select style={{ flex: 1, marginBottom: 0 }} value={picked}
          onChange={(e) => setPicked(e.target.value)}>
          <option value="">Add from rate card…</option>
          {rates.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}{Number(r.default_rate) ? ` — R ${money(r.default_rate)}/${r.unit}` : ""}
            </option>
          ))}
        </select>
        <button className="btn btn-ghost" style={{ marginTop: 0 }}
          disabled={busy || !picked} onClick={() => addLine(picked)}>Add</button>
      </div>

      <div className="card">
        <div className="row"><span className="muted">Subtotal</span>
          <span style={{ fontWeight: 600 }}>R {money(subtotal)}</span></div>

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
          <span style={{ fontWeight: 600 }}>R {money(vat)}</span>
        </div>
        <div className="row" style={{ marginTop: 6, paddingTop: 8, borderTop: "1px solid var(--line)" }}>
          <span style={{ fontWeight: 700 }}>Total</span>
          <span style={{ fontWeight: 700, fontSize: 18 }}>R {money(subtotal + vat)}</span>
        </div>
      </div>
    </>
  );
}
