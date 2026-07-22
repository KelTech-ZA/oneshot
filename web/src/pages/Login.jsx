import React, { useState } from "react";
import { supabase } from "../lib/supabase";
import { toLoginEmail } from "../lib/identity";
import Signup from "./Signup";

export default function Login() {
  const [showSignup, setShowSignup] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");

  const signIn = async () => {
    setErr("");
    const { error } = await supabase.auth.signInWithPassword({ email: toLoginEmail(email), password });
    if (error) setErr(error.message);
  };

  if (showSignup) return <Signup onBack={() => setShowSignup(false)} />;
  return (
    <div className="page" style={{ maxWidth: 420, paddingTop: "14vh" }}>
      <div className="wordmark" style={{ fontSize: 22, marginBottom: 6 }}>ONE<b>SHOT</b></div>
      <p className="muted" style={{ marginBottom: 24 }}>One shot. Tracked everywhere.</p>
      <label>Email or phone number</label>
      <input type="text" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)}
        placeholder="you@company.co.za or 082 123 4567" autoComplete="username" />
      <label>Password</label>
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      {err && <p style={{ color: "var(--warn)", fontSize: 14, marginBottom: 10 }}>{err}</p>}
      <button className="btn btn-primary" onClick={signIn}>Sign in</button>
      <button className="btn btn-ghost" onClick={() => setShowSignup(true)}>
        ＋ Create your own workspace
      </button>
      <p className="muted" style={{ marginTop: 14 }}>
        Joining an existing team? Your ops manager creates your account and assigns your role — just sign in above.
      </p>
    </div>
  );
}
