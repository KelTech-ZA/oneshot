import React, { useState } from "react";
import { supabase } from "../lib/supabase";

export default function ChangePassword({ onCancel }) {
  const [newPass, setNewPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const change = async () => {
    setMsg("");
    if (newPass !== confirm) {
      setMsg("⚠ New passwords don't match");
      return;
    }
    if (newPass.length < 8) {
      setMsg("⚠ Password must be at least 8 characters");
      return;
    }

    setBusy(true);
    try {
      // Use updateUser which works for recovery sessions
      const { error } = await supabase.auth.updateUser({ password: newPass });
      if (error) {
        // If error, might be old password mismatch — just try again
        setMsg("⚠ " + (error.message || "Failed to change password. Please try again."));
        setBusy(false);
        return;
      }
      setMsg("✓ Password changed! Signing in...");
      // Force a sign-in refresh
      setTimeout(async () => {
        await supabase.auth.refreshSession();
        onCancel?.();
      }, 1000);
    } catch (e) {
      setMsg("⚠ " + (e.message || "Unknown error"));
      setBusy(false);
    }
  };

  return (
    <div className="page" style={{ maxWidth: 420, paddingTop: "10vh" }}>
      <div className="wordmark" style={{ fontSize: 22, marginBottom: 6 }}>ONE<b>SHOT</b></div>
      <h2 style={{ marginTop: 0 }}>Change Password</h2>
      <p className="muted">Your password has been reset. Please set a new one.</p>
      
      <label>New password (min 8 characters)</label>
      <input type="password" value={newPass} onChange={(e) => setNewPass(e.target.value)} 
        placeholder="New password" autoComplete="new-password" disabled={busy} />
      
      <label>Confirm new password</label>
      <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} 
        placeholder="Confirm new password" autoComplete="new-password" disabled={busy} />
      
      {msg && <p style={{ color: msg.startsWith("✓") ? "var(--ok)" : "var(--warn)", fontSize: 14, marginBottom: 10 }}>{msg}</p>}
      
      <button className="btn btn-primary" disabled={busy} onClick={change}>
        {busy ? "Changing…" : "Change password"}
      </button>
    </div>
  );
}
