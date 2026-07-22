import React, { useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import { Ctx } from "../main";

// Ops: configure how this tenant's WhatsApp requests are routed.
export default function WhatsAppSetup() {
  const { profile } = useContext(Ctx);
  const [route, setRoute] = useState(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState("");
  const [plan, setPlan] = useState("standard");

  useEffect(() => {
    supabase.from("wa_routes").select("*").eq("tenant_id", profile.tenant_id).maybeSingle()
      .then(({ data }) => { setRoute(data); setCode(data?.intake_code ?? ""); });
    supabase.from("tenants").select("plan").eq("id", profile.tenant_id).single()
      .then(({ data }) => setPlan(data?.plan ?? "standard"));
  }, [profile.tenant_id]);

  if (profile.role !== "ops") return <div className="empty">Only ops can set up intake.</div>;

  const saveCode = async () => {
    setMsg("");
    const clean = code.trim().replace(/[^A-Za-z0-9]/g, "");
    if (clean.length < 2) { setMsg("⚠ Code must be at least 2 letters/numbers."); return; }
    const { error } = await supabase.from("wa_routes")
      .upsert({ tenant_id: profile.tenant_id, intake_code: clean }, { onConflict: "tenant_id" });
    setMsg(error ? `⚠ ${error.message}` : `✓ Saved. Clients can prefix requests with "${clean}: …"`);
  };

  return (
    <div className="page">
      <h1>WhatsApp intake setup</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Requests sent to the OneShot bot become jobs in your pending list. Here's how the bot knows a message is yours.
      </p>

      <h2>Your job group (recommended)</h2>
      <div className="card">
        {route?.group_id ? (
          <div>Connected ✓ — messages in your OneShot job group route here automatically.</div>
        ) : (
          <div className="muted">
            Not set up yet. When the platform bot is live, request your job group from OneShot — the bot creates it, adds your team, and every request posted there becomes a job. Zero codes to remember.
          </div>
        )}
      </div>

      <h2>Intake code (fallback)</h2>
      <div className="card">
        <label>Short code clients put before a request (e.g. "S9: pickup 2 works…")</label>
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="S9" maxLength={8} />
        <button className="btn btn-primary" onClick={saveCode}>Save code</button>
        {msg && <p className="muted" style={{ marginTop: 8 }}>{msg}</p>}
        <p className="muted" style={{ marginTop: 6 }}>
          Useful for one-off senders not in your group. Messages starting with this code route to you.
        </p>
      </div>

      <h2>Own-number bot (premium)</h2>
      <div className="card">
        <div className="row">
          <span style={{ fontWeight: 600 }}>Run the bot on your own branded number</span>
          <span className={`stamp ${plan === "premium_bot" ? "done" : "pending"}`}>
            {plan === "premium_bot" ? "ACTIVE" : "PREMIUM"}
          </span>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          On the premium tier, requests come to your own WhatsApp business number instead of the shared OneShot bot — your brand, your number. Requires your own Meta business verification. Contact OneShot to upgrade.
        </p>
      </div>
    </div>
  );
}
