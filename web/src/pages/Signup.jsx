import React, { useState } from "react";
import { supabase, FUNCTIONS_URL } from "../lib/supabase";
import { toLoginEmail, isPhone } from "../lib/identity";

export default function Signup({ onBack }) {
  const [f, setF] = useState({ company: "", full_name: "", identifier: "", password: "" });
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setMsg(""); setBusy(true);
    const body = {
      company: f.company, full_name: f.full_name, password: f.password,
      ...(isPhone(f.identifier) ? { phone: f.identifier } : { email: f.identifier }),
    };
    const res = await fetch(`${FUNCTIONS_URL}/signup-workspace`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const out = await res.json();
    if (out.error) { setMsg(`⚠ ${out.error}`); setBusy(false); return; }
    // Sign straight in
    const { error } = await supabase.auth.signInWithPassword({
      email: toLoginEmail(f.identifier), password: f.password,
    });
    if (error) { setMsg(`Workspace created — now sign in. (${error.message})`); onBack(); }
    setBusy(false);
  };

  return (
    <div className="page" style={{ maxWidth: 420, paddingTop: "9vh" }}>
      <div className="wordmark" style={{ fontSize: 22, marginBottom: 6 }}>ONE<b>SHOT</b></div>
      <p className="muted" style={{ marginBottom: 20 }}>Create your workspace. You'll be its ops manager — then add your team with their fixed roles.</p>
      <label>Company / workspace name</label>
      <input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} placeholder="Gallery Movers CC" />
      <label>Your full name</label>
      <input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} />
      <label>Your email or phone number</label>
      <input value={f.identifier} onChange={(e) => setF({ ...f, identifier: e.target.value })}
        placeholder="you@company.co.za or 082 123 4567" />
      <label>Password (min 8 characters)</label>
      <input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
      {msg && <p style={{ color: "var(--warn)", fontSize: 14, marginBottom: 10 }}>{msg}</p>}
      <button className="btn btn-primary" disabled={busy} onClick={create}>
        {busy ? "Creating…" : "Create workspace"}
      </button>
      <button className="btn btn-ghost" onClick={onBack}>Back to sign in</button>
    </div>
  );
}
