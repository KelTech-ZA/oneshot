import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Link, useNavigate } from "react-router-dom";
import { supabase, FUNCTIONS_URL } from "./lib/supabase";
import { pendingCount, syncNow, getLastSyncError, clearLastSyncError } from "./lib/queue";
import Login from "./pages/Login";
import ChangePassword from "./pages/ChangePassword";
import Today from "./pages/Today";
import Job from "./pages/Job";
import Capture from "./pages/Capture";
import Item from "./pages/Item";
import Dashboard from "./pages/Dashboard";
import Notices from "./pages/Notices";
import EmailSetup from "./pages/EmailSetup";
import WhatsAppSetup from "./pages/WhatsAppSetup";
import EditJob from "./pages/EditJob";
import TypeSettings from "./pages/TypeSettings";
import ClaimJob from "./pages/ClaimJob";
import JobRecord from "./pages/JobRecord";

export const Ctx = React.createContext(null);

function Welcome({ profile, onDone }) {
  const nav = useNavigate();
  const choose = (path) => { sessionStorage.setItem("oneshot_welcomed", "1"); onDone(); nav(path); };
  return (
    <div className="page" style={{ maxWidth: 420, paddingTop: "12vh", textAlign: "center" }}>
      <div className="wordmark" style={{ fontSize: 22, marginBottom: 6 }}>ONE<b>SHOT</b></div>
      <p className="muted" style={{ marginBottom: 28 }}>
        Welcome{profile.full_name ? `, ${profile.full_name.split(" ")[0]}` : ""}. Where to?
      </p>
      <button className="btn btn-primary" onClick={() => choose("/")}>
        📋 Jobs — Today
      </button>
      <button className="btn btn-ghost" onClick={() => choose("/dashboard")}>
        👥 Office — team &amp; setup
      </button>
      <p className="muted" style={{ marginTop: 18 }}>
        You can switch anytime from the top bar.
      </p>
    </div>
  );
}

function Shell() {
  const [session, setSession] = useState(undefined);
  const [profile, setProfile] = useState(null);
  const [pending, setPending] = useState(0);
  const [syncError, setSyncError] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [forcePasswordChange, setForcePasswordChange] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      // Detect recovery session (password reset required)
      if (data.session?.user?.user_metadata?.recovery_session) {
        setForcePasswordChange(true);
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      // Two routes into a reset: an ops-initiated one (custom metadata flag)
      // and Supabase's own reset email, which fires PASSWORD_RECOVERY.
      if (event === "PASSWORD_RECOVERY" || s?.user?.user_metadata?.recovery_session) {
        setForcePasswordChange(true);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const [memberships, setMemberships] = useState(null);
  const [picking, setPicking] = useState(false);

  const loadIdentity = async () => {
    const { data: prof } = await supabase.from("profiles").select("*").eq("id", session.user.id).single();
    const { data: mems } = await supabase.from("memberships")
      .select("tenant_id, role, tenants(name)").eq("user_id", session.user.id);
    setMemberships(mems ?? []);
    if (!prof || !mems?.length) { setProfile(null); return; }
    let active = mems.find((x) => x.tenant_id === prof.active_tenant_id);
    if (!active) {
      active = mems[0];
      await supabase.from("profiles").update({ active_tenant_id: active.tenant_id }).eq("id", session.user.id);
    }
    setProfile({ ...prof, role: active.role, tenant_id: active.tenant_id, workspace: active.tenants?.name });
  };

  useEffect(() => {
    if (!session) { setProfile(null); setMemberships(null); return; }
    loadIdentity();
  }, [session]);

  const switchWorkspace = async (tenantId) => {
    await supabase.from("profiles").update({ active_tenant_id: tenantId }).eq("id", session.user.id);
    sessionStorage.setItem("oneshot_ws", "1");
    sessionStorage.removeItem("oneshot_welcomed");
    setWelcomed(false);
    await loadIdentity();
    setPicking(false);
  };

  const [wsForm, setWsForm] = useState(null);

  const createWorkspace = async (name) => {
    if (!name?.trim()) return;
    const { data: { session: s } } = await supabase.auth.getSession();
    const res = await fetch(`${FUNCTIONS_URL}/new-workspace`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${s.access_token}` },
      body: JSON.stringify({ company: name.trim() }),
    });
    const out = await res.json();
    if (out.error) { window.alert(out.error); return; }
    setWsForm(null);
    sessionStorage.setItem("oneshot_ws", "1");
    sessionStorage.removeItem("oneshot_welcomed");
    setWelcomed(false);
    await loadIdentity();
    setPicking(false);
  };

  // Update pending count when queue changes
  useEffect(() => {
    const upd = async () => {
      const count = await pendingCount();
      setPending(count);
      const error = getLastSyncError();
      setSyncError(error);
    };
    
    upd();
    window.addEventListener("queue-updated", upd);
    return () => window.removeEventListener("queue-updated", upd);
  }, []);

  // Handle sync button click
  const handleSync = async () => {
    setSyncing(true);
    clearLastSyncError();
    setSyncError(null);
    
    try {
      await syncNow();
      
      // Update state after sync
      const count = await pendingCount();
      setPending(count);
      const error = getLastSyncError();
      setSyncError(error);
    } catch (err) {
      setSyncError(err.message);
    } finally {
      setSyncing(false);
    }
  };

  const [welcomed, setWelcomed] = useState(() => sessionStorage.getItem("oneshot_welcomed") === "1");

  if (session === undefined) return null;
  if (!session) return <Login />;
  if (forcePasswordChange) return <ChangePassword onCancel={() => { setForcePasswordChange(false); supabase.auth.signOut(); }} />;
  if (memberships && memberships.length === 0)
    return <div className="empty">This account isn't a member of any workspace yet.<br/>
      <span className="muted">Ask your ops manager to add you — or sign out and create your own workspace.</span></div>;
  if (!profile) return <div className="empty">Loading profile… <br/><span className="muted">If this hangs, your user has no profile row yet — see README step 3.</span></div>;

  if (picking)
    return (
      <div className="page" style={{ maxWidth: 420, paddingTop: "10vh" }}>
        <div className="wordmark" style={{ fontSize: 22, marginBottom: 6 }}>ONE<b>SHOT</b></div>
        <p className="muted" style={{ marginBottom: 20 }}>You belong to more than one workspace. Pick where to work:</p>
        {memberships.map((mm) => (
          <button key={mm.tenant_id} className="card" onClick={() => switchWorkspace(mm.tenant_id)}>
            <div className="row">
              <span style={{ fontWeight: 700 }}>{mm.tenants?.name ?? "Workspace"}</span>
              <span className={`stamp ${mm.role === "ops" ? "live" : "pending"}`}>{mm.role.toUpperCase()}</span>
            </div>
          </button>
        ))}
        {wsForm === null ? (
          <button className="btn btn-ghost" onClick={() => setWsForm("")}>＋ Create a new workspace</button>
        ) : (
          <div className="card">
            <label>New workspace name (company)</label>
            <input value={wsForm} autoFocus placeholder="Gallery Movers CC"
              onChange={(e) => setWsForm(e.target.value)} />
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary" style={{ flex: 1, marginTop: 0 }}
                onClick={() => createWorkspace(wsForm)}>Create — you'll be its ops</button>
              <button className="btn btn-ghost" style={{ flex: 1, marginTop: 0 }}
                onClick={() => setWsForm(null)}>Cancel</button>
            </div>
          </div>
        )}
        <p className="muted" style={{ marginTop: 12 }}>Your role in each workspace is fixed by whoever runs it. A workspace you create is yours — you're its ops.</p>
      </div>
    );

  if (profile.role === "ops" && !welcomed)
    return <Welcome profile={profile} onDone={() => setWelcomed(true)} />;

  return (
    <Ctx.Provider value={{ session, profile }}>
      <div className="topbar">
        <Link to="/" className="wordmark" style={{ color: "inherit", textDecoration: "none" }}>
          ONE<b>SHOT</b>
        </Link>
        <div className="row" style={{ gap: 14 }}>
          {memberships?.length > 1 && (
            <button className="muted" style={{ background: "none", border: "none", cursor: "pointer", font: "inherit" }}
              onClick={() => { sessionStorage.removeItem("oneshot_ws"); setPicking(true); }}>
              ⇄ {profile.workspace ?? "Workspace"}
            </button>
          )}
          {profile.role === "ops" && <Link to="/dashboard" className="muted">Office</Link>}
          <button className="muted" style={{ background: "none", border: "none", cursor: "pointer", font: "inherit" }}
            onClick={async () => {
              const p = window.prompt("New password (min 8 characters):");
              if (!p) return;
              if (p.length < 8) { window.alert("Too short — 8 characters minimum."); return; }
              const { error } = await supabase.auth.updateUser({ password: p });
              window.alert(error ? `Failed: ${error.message}` : "Password changed ✓");
            }}>
            Password
          </button>
          <button className="muted" style={{ background: "none", border: "none", cursor: "pointer", font: "inherit" }}
            onClick={async () => { await supabase.auth.signOut(); nav("/"); }}>
            Sign out
          </button>
        </div>
      </div>
      <Notices profile={profile} />
      <Routes>
        <Route path="/" element={<Today />} />
        <Route path="/job/:id" element={<Job />} />
        <Route path="/job/:id/shoot" element={<Capture />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/setup/email" element={<EmailSetup />} />
        <Route path="/setup/whatsapp" element={<WhatsAppSetup />} />
        <Route path="/job/:id/edit" element={<EditJob />} />
        <Route path="/settings/types" element={<TypeSettings />} />
      </Routes>

      {/* Sync badge with error display */}
      {pending > 0 && (
        <div style={{ position: "fixed", bottom: 20, left: 20, right: 20, zIndex: 1000 }}>
          <button 
            className="syncbadge" 
            style={{ border: "none", cursor: syncing ? "wait" : "pointer", width: "100%" }}
            onClick={handleSync}
            disabled={syncing}
          >
            {syncing ? "Syncing..." : `${pending} event${pending > 1 ? "s" : ""} pending sync — tap to retry`}
          </button>
          {syncError && (
            <div style={{ 
              background: "var(--warn)", 
              color: "white", 
              padding: "8px 12px",
              marginTop: "6px",
              borderRadius: "6px",
              fontSize: "12px",
              wordWrap: "break-word"
            }}>
              ⚠ {syncError}
            </div>
          )}
        </div>
      )}
    </Ctx.Provider>
  );
}

createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <Routes>
      <Route path="/i/:id" element={<Item />} />
      <Route path="/claim/:jobId/:token" element={<ClaimJob />} />
      <Route path="/j/:jobId" element={<JobRecord />} />
      <Route path="*" element={<Shell />} />
    </Routes>
  </BrowserRouter>
);
