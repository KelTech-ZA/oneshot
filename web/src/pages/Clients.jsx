import React, { useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { Ctx } from "../main";

// The workspace's clients. Ops only, and scoped by RLS - Section 9's clients
// are invisible to every other workspace.

const FIELDS = [
  ["legal_name",      "Legal name",       "Blank Projects (Pty) Ltd"],
  ["billing_address", "Billing address",  "10 Lewin Street, Woodstock, Cape Town 7925"],
  ["vat_number",      "VAT number",       ""],
  ["eori_number",     "EORI number",      "For EU/UK consignees"],
  ["reg_number",      "Company reg. no.", ""],
  ["billing_email",   "Billing email",    "accounts@…"],
  ["country",         "Country",          "ZA"],
];

export default function Clients() {
  const { profile } = useContext(Ctx);
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({});
  const [adding, setAdding] = useState("");
  const [msg, setMsg] = useState("");

  const isOps = profile?.role === "ops";

  const load = async () => {
    const { data } = await supabase.from("clients").select("*").order("name");
    setRows(data ?? []);
  };
  useEffect(() => { if (isOps) load(); }, [isOps]);

  if (!isOps) return <div className="page empty">Only ops can manage clients.</div>;

  const shown = rows.filter((r) => {
    const t = q.trim().toLowerCase();
    if (!t) return true;
    return [r.name, r.legal_name, r.vat_number, r.billing_email, r.billing_address]
      .filter(Boolean).some((v) => v.toLowerCase().includes(t));
  });

  const save = async (row, patch) => {
    const { data, error } = await supabase.from("clients")
      .update(patch).eq("id", row.id).select("id");
    if (error) { setMsg("Could not save: " + error.message); return; }
    if (!data?.length) { setMsg("That change was refused by the database."); return; }
    setMsg("");
    await load();
  };

  const add = async () => {
    const name = adding.trim();
    if (!name) return;
    const { data, error } = await supabase.from("clients")
      .insert({ tenant_id: profile.tenant_id, name, legal_name: name })
      .select().single();
    if (error) {
      setMsg(error.code === "23505" ? `"${name}" is already a client.` : error.message);
      return;
    }
    setAdding(""); setMsg("");
    await load();
    setEditing(data.id); setDraft(data);
  };

  return (
    <div className="page">
      <Link className="muted" style={{ marginBottom: 10 }} to="/dashboard">← Office</Link>
      <h1>Clients</h1>
      <p className="muted">
        Billing details kept once and copied onto a job when you invoice it.
      </p>

      {msg && <div className="card" style={{ color: "var(--warn)" }}>{msg}</div>}

      <input value={q} onChange={(e) => setQ(e.target.value)}
        placeholder="Search by name, VAT number, email…" aria-label="Search clients" />

      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        {shown.length} of {rows.length}
      </div>

      {shown.map((r) => (
        <div className="card" key={r.id}>
          {editing === r.id ? (
            <>
              <label>Name</label>
              <input value={draft.name ?? ""}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                onBlur={() => save(r, { name: draft.name })} />
              {FIELDS.map(([key, label, ph]) => (
                <div key={key}>
                  <label>{label}</label>
                  {key === "billing_address" ? (
                    <textarea rows={3} value={draft[key] ?? ""} placeholder={ph}
                      onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                      onBlur={() => save(r, { [key]: draft[key] })} />
                  ) : (
                    <input value={draft[key] ?? ""} placeholder={ph}
                      onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                      onBlur={() => save(r, { [key]: draft[key] })} />
                  )}
                </div>
              ))}
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 400 }}>
                <input type="checkbox" style={{ width: 18, height: 18 }}
                  checked={draft.vat_applicable !== false}
                  onChange={(e) => {
                    setDraft({ ...draft, vat_applicable: e.target.checked });
                    save(r, { vat_applicable: e.target.checked });
                  }} />
                <span>Charge VAT
                  <br /><span className="muted" style={{ fontSize: 12 }}>
                    Turn off for entities billed outside South Africa.
                  </span>
                </span>
              </label>
              <button className="btn btn-ghost" onClick={() => setEditing(null)}>Done</button>
            </>
          ) : (
            <div className="row" style={{ alignItems: "baseline", cursor: "pointer" }}
              onClick={() => { setEditing(r.id); setDraft(r); }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{r.legal_name || r.name}</div>
                <div className="muted" style={{ fontSize: 13 }}>
                  {[r.vat_number && `VAT ${r.vat_number}`,
                    r.eori_number && `EORI ${r.eori_number}`,
                    r.country,
                    r.vat_applicable === false && "zero-rated"].filter(Boolean).join(" · ")
                    || "no billing details yet"}
                </div>
              </div>
              <span className="muted" style={{ fontSize: 13, flexShrink: 0 }}>edit</span>
            </div>
          )}
        </div>
      ))}

      {rows.length === 0 && (
        <div className="empty">No clients yet. Add one below, or save one from a job.</div>
      )}

      <div className="card">
        <label>Add a client</label>
        <input value={adding} placeholder="Gallery or company name"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="btn btn-primary" disabled={!adding.trim()} onClick={add}>
          Add client
        </button>
      </div>
    </div>
  );
}
