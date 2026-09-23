import React, { useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { Ctx } from "../main";

// Teams intake, and the addresses that make it work.
//
// A Teams channel has an email address of its own. It receives EMAIL only -
// nothing anyone types in the channel ever reaches it. So pointing intake at
// this pattern cannot manufacture a job out of "what time on Thursday?", which
// is the whole reason not to put a bot in a channel people chat in.
//
// The pattern: forward a client's request to the Teams channel AND to this
// workspace's OneShot address, in one action. The team sees the thread, OneShot
// gets a real email with its attachments, and the job lands here as usual.

const INTAKE = import.meta.env.VITE_INTAKE_EMAIL || "jobs@in.section9.co.za";
const DOMAIN = INTAKE.split("@")[1] ?? "in.section9.co.za";

const localPart = (s) =>
  s.toLowerCase().trim().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "");

export default function TeamsSetup() {
  const { profile } = useContext(Ctx);
  const [routes, setRoutes] = useState([]);
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState("");

  const isOps = profile?.role === "ops";

  const load = async () => {
    // RLS scopes this to the signed-in workspace, so another workspace's
    // addresses are not merely hidden here - they are unreadable.
    const { data } = await supabase.from("intake_routes")
      .select("*").eq("active", true).order("channel").order("created_at");
    setRoutes(data ?? []);
  };
  useEffect(() => { if (isOps) load(); }, [isOps]);

  if (!isOps) return <div className="page empty">Only ops can set up intake.</div>;

  const add = async (channel) => {
    const lp = localPart(name);
    if (!lp) { setMsg("Give the address a name — letters or numbers."); return; }
    setBusy(true);
    const { error } = await supabase.from("intake_routes").insert({
      tenant_id: profile.tenant_id,
      channel,
      address: `${lp}@${DOMAIN}`,
      label: label.trim() || null,
    });
    setBusy(false);
    if (error) {
      setMsg(error.code === "23505"
        ? `${lp}@${DOMAIN} is already in use — pick another name.`
        : "Could not add it: " + error.message);
      return;
    }
    setName(""); setLabel(""); setMsg("");
    await load();
  };

  const retire = async (r) => {
    if (!window.confirm(
      `Stop using ${r.address}?\n\nMail sent there will stop creating jobs here. `
      + `Anything already created is untouched.`)) return;
    const { error } = await supabase.from("intake_routes")
      .update({ active: false }).eq("id", r.id);
    if (error) { setMsg("Could not remove it: " + error.message); return; }
    await load();
  };

  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); setCopied(text);
          setTimeout(() => setCopied(""), 1600); }
    catch { window.prompt("Copy this address:", text); }
  };

  const teamsRoutes = routes.filter((r) => r.channel === "teams");
  const emailRoutes = routes.filter((r) => r.channel === "email" && r.address);

  const Row = ({ r }) => (
    <div className="card" key={r.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, wordBreak: "break-all" }}>{r.address}</div>
        {r.label && <div className="muted" style={{ fontSize: 12 }}>{r.label}</div>}
      </div>
      <button className="btn btn-ghost" style={{ marginTop: 0, padding: "4px 10px", fontSize: 13 }}
        onClick={() => copy(r.address)}>
        {copied === r.address ? "copied ✓" : "copy"}
      </button>
      <button onClick={() => retire(r)}
        style={{ background: "none", border: "none", color: "var(--warn)",
          cursor: "pointer", font: "inherit", fontSize: 13 }}>remove</button>
    </div>
  );

  return (
    <div className="page">
      <Link className="muted" style={{ marginBottom: 10 }} to="/dashboard">← Office</Link>
      <h1>Teams intake</h1>
      <p className="muted">
        A Teams channel has an email address of its own, and it only ever
        receives email — nothing anyone <em>types</em> in the channel reaches it.
        So this cannot turn chatter into jobs.
      </p>

      {msg && <div className="card" style={{ color: "var(--warn)" }}>{msg}</div>}

      <h2>1. Get your channel's address</h2>
      <div className="card">
        <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li>In Teams, hover the channel → <strong>⋯ More options</strong> → <strong>Get email address</strong>.</li>
          <li>Copy it. It looks like <code>ops.yourteam@amer.teams.ms</code>.</li>
          <li>Under <strong>Advanced settings</strong> there, restrict who may send to it —
            "anyone" invites spam into the channel.</li>
        </ol>
      </div>

      <h2>2. Your OneShot address</h2>
      <p className="muted" style={{ marginBottom: 10 }}>
        One per channel is worth it: the address tells OneShot which workspace
        the job belongs to, so nothing depends on the subject line.
      </p>
      {teamsRoutes.length === 0 && (
        <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
          None yet. Add one below.
        </div>
      )}
      {teamsRoutes.map((r) => <Row key={r.id} r={r} />)}

      <div className="card">
        <label>Address name</label>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input value={name} placeholder="ops-channel" style={{ marginBottom: 0 }}
            onChange={(e) => setName(e.target.value)} />
          <span className="muted" style={{ whiteSpace: "nowrap" }}>@{DOMAIN}</span>
        </div>
        <label style={{ marginTop: 8 }}>What is it for? (optional)</label>
        <input value={label} placeholder="Teams — Ops channel"
          onChange={(e) => setLabel(e.target.value)} />
        <button className="btn btn-primary" disabled={busy || !name.trim()}
          onClick={() => add("teams")}>
          {busy ? "Adding…" : "Add address"}
        </button>
        <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Any name at {DOMAIN} works — the mail domain accepts all of them and
          OneShot routes on which one was used.
        </p>
      </div>

      <h2>3. Forward to both</h2>
      <div className="card">
        <p style={{ marginTop: 0 }}>
          When a client's request arrives, forward it once with <strong>both</strong> addresses
          on the To line — the Teams channel and your OneShot address.
        </p>
        <ul style={{ margin: "0 0 10px", paddingLeft: 18, lineHeight: 1.7 }}>
          <li>The channel gets the thread, so the team can talk about it.</li>
          <li>OneShot gets a real email, so photographs, PDFs and Word documents
            all parse exactly as they do today.</li>
          <li>The job appears in Pending confirmation within about half a minute.</li>
        </ul>
        <p className="muted" style={{ marginBottom: 0 }}>
          Better still, set a mail rule to do the forwarding — see{" "}
          <Link to="/setup/email">Email intake setup</Link> for per-provider steps.
          A rule runs on the server, so it works when nobody is at a desk.
        </p>
      </div>

      {emailRoutes.length > 0 && (<>
        <h2>Your other intake addresses</h2>
        {emailRoutes.map((r) => <Row key={r.id} r={r} />)}
      </>)}

      <p className="muted" style={{ fontSize: 12, marginTop: 16 }}>
        Addresses belong to this workspace alone. No two workspaces can claim
        the same one — the database refuses it, because a clash would file a
        client's job with a stranger.
      </p>
    </div>
  );
}
