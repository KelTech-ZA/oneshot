import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase, FUNCTIONS_URL } from "../lib/supabase";
import { toLoginEmail, isPhone } from "../lib/identity";

// Shared job link: /claim/{jobId}/{token}
// One question first — "which profile are you acting as?" — then role decides:
//   CREW profile  → job goes to that workspace's ops (pending); you don't auto-take.
//   OPS profile   → choose: route to pending, or take it yourself now.
export default function ClaimJob() {
  const { jobId, token } = useParams();
  const [session, setSession] = useState(undefined);
  const [memberships, setMemberships] = useState([]);
  const [chosen, setChosen] = useState(null); // a membership row, once picked
  const [mode, setMode] = useState("signin");
  const [f, setF] = useState({ full_name: "", identifier: "", password: "" });
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [jobInfo, setJobInfo] = useState(null);
  const [wsForm, setWsForm] = useState(null);

  const loadMemberships = async (uid) => {
    const { data } = await supabase.from("memberships")
      .select("tenant_id, role, tenants(name)").eq("user_id", uid);
    setMemberships(data ?? []);
  };

  useEffect(() => {
    fetch(`${FUNCTIONS_URL}/job-record?id=${jobId}`)
      .then((r) => r.json()).then((d) => { if (!d.error) setJobInfo(d); }).catch(() => {});
  }, [jobId]);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      if (data.session) await loadMemberships(data.session.user.id);
    });
  }, []);

  // Original design: take the job on behalf of the workspace that sent it.
  // claim-job adds crew membership there if absent, assigns the caller, and
  // rotates the token so the link cannot be reused.
  const acceptAsCrew = async () => {
    setBusy(true); setMsg("");
    const res = await fetch(`${FUNCTIONS_URL}/claim-job`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ job_id: jobId, token }),
    });
    const out = await res.json(); setBusy(false);
    if (out.error) { setMsg(`\u26a0 ${out.error}`); return; }
    setResult({ kind: "claimed", workspace: out.workspace, ...out });
  };

  // Third path: signed in but belongs to no workspace at all. Create one here
  // so they can bring the job in as its ops, rather than dead-ending.
  const createWorkspace = async (name) => {
    if (!name?.trim()) return;
    setBusy(true); setMsg("");
    const res = await fetch(`${FUNCTIONS_URL}/new-workspace`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ company: name.trim() }),
    });
    const out = await res.json(); setBusy(false);
    if (out.error) { setMsg(`\u26a0 ${out.error}`); return; }
    setWsForm(null);
    await loadMemberships(session.user.id);
  };

  const routeToPending = async (m) => {
    setBusy(true); setMsg("");
    const res = await fetch(`${FUNCTIONS_URL}/route-job`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ job_id: jobId, token, dest_tenant_id: m.tenant_id }),
    });
    const out = await res.json(); setBusy(false);
    if (out.error) { setMsg(`⚠ ${out.error}`); return; }
    setResult({ kind: "routed", workspace: m.tenants?.name, ...out });
  };

  const takeAsOps = async (m) => {
    setBusy(true); setMsg("");
    // Route in, then the ops is assigning themselves — claim-job assigns caller as crew on it.
    const r1 = await fetch(`${FUNCTIONS_URL}/route-job`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ job_id: jobId, token, dest_tenant_id: m.tenant_id, take: true }),
    });
    const out = await r1.json(); setBusy(false);
    if (out.error) { setMsg(`⚠ ${out.error}`); return; }
    setResult({ kind: "took", workspace: m.tenants?.name, ...out });
  };

  const authenticate = async () => {
    setMsg(""); setBusy(true);
    if (mode === "signup") {
      const body = { full_name: f.full_name, password: f.password,
        ...(isPhone(f.identifier) ? { phone: f.identifier } : { email: f.identifier }) };
      const r = await fetch(`${FUNCTIONS_URL}/signup-driver`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const out = await r.json();
      if (out.error) { setMsg(`⚠ ${out.error}`); setBusy(false); return; }
    }
    const { data, error } = await supabase.auth.signInWithPassword({
      email: toLoginEmail(f.identifier), password: f.password });
    if (error) { setMsg(`⚠ ${error.message}`); setBusy(false); return; }
    setSession(data.session);
    await loadMemberships(data.session.user.id);
    setBusy(false);
  };

  if (session === undefined) return <div className="empty">Loading…</div>;

  // ---- result ----
  if (result) return (
    <div className="page" style={{ maxWidth: 420, paddingTop: "12vh", textAlign: "center" }}>
      <div style={{ fontSize: 40, marginBottom: 8 }}>✓</div>
      {result.kind === "claimed" ? (<>
        <h1 style={{ marginBottom: 6 }}>{result.job_ref} accepted</h1>
        <p className="muted" style={{ marginBottom: 20 }}>
          You're assigned as crew on <b>{result.workspace}</b> and it's on your Today list.
        </p>
        <button className="btn btn-primary" onClick={() => { window.location.href = `/`; }}>Open Today</button>
      </>) : result.kind === "took" ? (<>
        <h1 style={{ marginBottom: 6 }}>{result.job_ref} is yours</h1>
        <p className="muted" style={{ marginBottom: 20 }}>
          Taken under <b>{result.workspace}</b> and on your Today list. The original sender stays on the record.
        </p>
        <button className="btn btn-primary" onClick={() => { window.location.href = `/`; }}>Open Today</button>
      </>) : (<>
        <h1 style={{ marginBottom: 6 }}>Sent to {result.workspace}</h1>
        <p className="muted" style={{ marginBottom: 20 }}>
          {result.job_ref} is in <b>{result.workspace}</b>'s pending list. Their ops will vet and assign it before crew see it. The original sender stays on the record.
        </p>
        <button className="btn btn-primary" onClick={() => { window.location.href = `/dashboard`; }}>Go to Office</button>
      </>)}
    </div>
  );

  // ---- not signed in ----
  if (!session) return (
    <div className="page" style={{ maxWidth: 420, paddingTop: "8vh" }}>
      <div className="wordmark" style={{ fontSize: 22, marginBottom: 6 }}>ONE<b>SHOT</b></div>
      <p className="muted" style={{ marginBottom: 18 }}>
        You've been sent a job. Sign in — or create a driver account in 30 seconds — to handle it.
      </p>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button className={mode === "signin" ? "btn btn-primary" : "btn btn-ghost"}
          style={{ flex: 1, minHeight: 42, marginTop: 0 }} onClick={() => setMode("signin")}>I have an account</button>
        <button className={mode === "signup" ? "btn btn-primary" : "btn btn-ghost"}
          style={{ flex: 1, minHeight: 42, marginTop: 0 }} onClick={() => setMode("signup")}>I'm new</button>
      </div>
      {mode === "signup" && (<>
        <label>Your full name</label>
        <input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} />
      </>)}
      <label>Email or phone number</label>
      <input value={f.identifier} placeholder="you@mail.com or 082 123 4567"
        onChange={(e) => setF({ ...f, identifier: e.target.value })} />
      <label>Password{mode === "signup" ? " (min 8 characters)" : ""}</label>
      <input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
      <button className="btn btn-primary" disabled={busy} onClick={authenticate}>
        {busy ? "Working…" : mode === "signup" ? "Create account & continue" : "Sign in & continue"}
      </button>
      {msg && <p style={{ color: "var(--warn)", fontSize: 14, marginTop: 10 }}>{msg}</p>}
    </div>
  );

  // ---- signed in, ops profile chosen → route or take ----
  if (chosen) return (
    <div className="page" style={{ maxWidth: 420, paddingTop: "10vh" }}>
      <div className="wordmark" style={{ fontSize: 22, marginBottom: 6 }}>ONE<b>SHOT</b></div>
      <p className="muted" style={{ marginBottom: 4 }}>
        Acting as <b>{chosen.tenants?.name}</b> <span className="stamp live" style={{ fontSize: 10 }}>OPS</span>
      </p>
      <p className="muted" style={{ marginBottom: 16 }}>You have ops authority here. What do you want to do with this job?</p>
      <button className="btn btn-primary" disabled={busy} onClick={() => takeAsOps(chosen)}>
        ✓ Take it now — I'm doing this delivery
      </button>
      <button className="btn btn-ghost" disabled={busy} onClick={() => routeToPending(chosen)}>
        📥 Route to pending — vet & assign later
      </button>
      <button className="btn btn-ghost" onClick={() => setChosen(null)}>‹ Back to profiles</button>
      {msg && <p style={{ color: "var(--warn)", fontSize: 14, marginTop: 10 }}>{msg}</p>}
    </div>
  );

  // ---- signed in → pick a profile ----
  return (
    <div className="page" style={{ maxWidth: 420, paddingTop: "9vh" }}>
      <div className="wordmark" style={{ fontSize: 22, marginBottom: 6 }}>ONE<b>SHOT</b></div>
      <p className="muted" style={{ marginBottom: 4 }}>
        You've been sent {jobInfo?.ref ? <b>{jobInfo.ref}</b> : "a job"}
        {jobInfo?.tenants?.name ? <> by <b>{jobInfo.tenants.name}</b></> : null}.
      </p>

      <button className="btn btn-primary" disabled={busy} onClick={acceptAsCrew}>
        {busy ? "Working\u2026" : "\u2713 Accept and drive this job"}
      </button>
      <p className="muted" style={{ marginTop: 6, marginBottom: 18 }}>
        You'll be added as crew on {jobInfo?.tenants?.name ?? "the sender's workspace"} for this job only.
      </p>

      <h2>Or bring it into your own workspace</h2>
      {memberships.map((m) => (
        <button key={m.tenant_id} className="card" disabled={busy}
          onClick={() => (m.role === "ops" ? setChosen(m) : routeToPending(m))}>
          <div className="row">
            <span style={{ fontWeight: 600 }}>{m.tenants?.name ?? "Workspace"}</span>
            <span className={`stamp ${m.role === "ops" ? "live" : "pending"}`}>{m.role.toUpperCase()}</span>
          </div>
          <div className="muted" style={{ marginTop: 4 }}>
            {m.role === "ops"
              ? "You decide: take it yourself or route it to pending."
              : "Sends it to this workspace's ops to vet & assign — crew can't self-assign."}
          </div>
        </button>
      ))}
      {memberships.length === 0 && (
        <div className="card">
          <div style={{ fontWeight: 600, marginBottom: 4 }}>This account isn't a member of any workspace yet.</div>
          <p className="muted" style={{ marginBottom: 10 }}>
            Accept above to drive this job for the sender \u2014 or start your own workspace and bring the job in as its ops.
          </p>
          {wsForm === null ? (
            <button className="btn btn-ghost" style={{ marginTop: 0 }} onClick={() => setWsForm("")}>
              \uff0b Create my own workspace
            </button>
          ) : (<>
            <label>Workspace name (your company)</label>
            <input value={wsForm} autoFocus placeholder="Gallery Movers CC"
              onChange={(e) => setWsForm(e.target.value)} />
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary" style={{ flex: 1, marginTop: 0 }} disabled={busy}
                onClick={() => createWorkspace(wsForm)}>Create \u2014 you'll be its ops</button>
              <button className="btn btn-ghost" style={{ flex: 1, marginTop: 0 }}
                onClick={() => setWsForm(null)}>Cancel</button>
            </div>
          </>)}
        </div>
      )}
      <p className="muted" style={{ marginTop: 14 }}>
        You can only act within workspaces you belong to. To pass this to another business, ask their manager to add you first — that's what keeps ownership tracked.
      </p>
      {msg && <p style={{ color: "var(--warn)", fontSize: 14, marginTop: 10 }}>{msg}</p>}
    </div>
  );
}
