import React, { useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase, FUNCTIONS_URL } from "../lib/supabase";
import { Ctx } from "../main";
import { JobStamp } from "./Today";
import JobList from "./JobList";
import ClashWarning from "./ClashWarning";
import JobSearch from "./JobSearch";

export default function Dashboard() {
  const { profile } = useContext(Ctx);
  const [jobs, setJobs] = useState([]);
  const [jobTypes, setJobTypes] = useState([]);
  const [unread, setUnread] = useState([]);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({ type: "move", client_ref: "", origin: "", destination: "", date: "", time: "", items: "" });

  const load = () =>
    supabase.from("jobs").select("*, line_items(count), messages!jobs_source_message_id_fkey(sender, channel)")
      .order("created_at", { ascending: false }).limit(50)
      .then(({ data }) => setJobs(data ?? []));
  useEffect(() => {
    load();
    supabase.from("job_types").select("key,label").eq("active", true).order("sort")
      .then(({ data }) => setJobTypes(data ?? []));
    loadUnread();
  }, []);

  // Mail that arrived and produced nothing. Until now this was invisible:
  // the message was saved, no job was made, and the only trace was a line in
  // the edge function log. An intake pipeline that loses work silently is
  // worse than one that has no pipeline, because you stop checking.
  const loadUnread = async () => {
    const since = new Date(Date.now() - 14 * 864e5).toISOString();
    const { data } = await supabase.from("messages")
      .select("id,sender,subject,body,created_at,parse_error,kind")
      .is("job_id", null).gte("created_at", since)
      .order("created_at", { ascending: false }).limit(10);
    setUnread((data ?? []).filter((m) => m.parse_error || m.kind === "unknown"));
  };

  // Dismissing is per-browser and deliberately not a database write: the
  // message is evidence, and ops clearing their own view should not erase it
  // for a colleague.
  const dismissUnread = (id) => setUnread((cur) => cur.filter((m) => m.id !== id));

  const confirm = async (job) => {
    await supabase.from("jobs").update({ status: "confirmed", updated_at: new Date().toISOString() }).eq("id", job.id);
    load();
  };
  const cancel = async (job) => {
    await supabase.from("jobs").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", job.id);
    load();
  };

  const createJob = async () => {
    const { data: job, error } = await supabase.from("jobs").insert({
      tenant_id: profile.tenant_id, type: form.type,
      origin: form.origin ? { address: form.origin } : null,
      destination: form.destination ? { address: form.destination } : null,
      client_ref: form.client_ref || null,
      scheduled_date: form.date || null, time_window: form.time || null,
      status: "confirmed", created_by: profile.id,
    }).select().single();
    if (error || !job) {
      window.alert("Could not create job: " + (error?.message ?? "unknown error"));
      return;
    }
    const items = form.items.split("\n").map((s) => s.trim()).filter(Boolean)
      .map((description) => ({ tenant_id: profile.tenant_id, job_id: job.id, description }));
    if (items.length) await supabase.from("line_items").insert(items);
    setShowNew(false); setForm({ type: "move", origin: "", destination: "", date: "", items: "" });
    load();
  };

  const [team, setTeam] = useState([]);
  const [showTeam, setShowTeam] = useState(false);
  const [member, setMember] = useState({ full_name: "", email: "", phone: "", idType: "email", password: "", role: "crew" });
  const [teamMsg, setTeamMsg] = useState("");
  const loadTeam = async () => {
    const { data } = await supabase.from("memberships")
      .select("role, created_at, profiles(full_name)")
      .eq("tenant_id", profile.tenant_id).order("created_at");
    setTeam((data ?? []).map((m) => ({ full_name: m.profiles?.full_name, role: m.role }))); setShowTeam(true);
  };
  const addMember = async () => {
    setTeamMsg("");
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(`${FUNCTIONS_URL}/invite-user`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({
        full_name: member.full_name, password: member.password, role: member.role,
        email: member.idType === "email" ? member.email : undefined,
        phone: member.idType === "phone" ? member.phone : undefined,
      }),
    });
    const out = await res.json();
    if (out.error) { setTeamMsg(`⚠ ${out.error}`); return; }
    const idShown = member.idType === "email" ? member.email : member.phone;
    setTeamMsg(`✓ ${member.full_name || idShown} added as ${member.role}. They sign in with ${member.idType === "email" ? "that email" : "that phone number"} + the password.`);
    setMember({ full_name: "", email: "", phone: "", idType: "email", password: "", role: "crew" });
    loadTeam();
  };

  const pending = jobs.filter((j) => j.status === "pending_confirmation");
  const rest = jobs.filter((j) => j.status !== "pending_confirmation");

  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState([]);
  const loadLog = async () => {
    const { data } = await supabase.from("messages")
      .select("channel,kind,sender,subject,body,created_at")
      .order("created_at", { ascending: false }).limit(15);
    setLog(data ?? []); setShowLog(true);
  };

  return (
    <div className="page">
      <h1>Office</h1>
      <Link to="/settings/types" className="btn btn-ghost" style={{ textDecoration: "none", marginTop: 0, marginBottom: 12 }}>
        Edit job types &amp; events
      </Link>
      <Link to="/settings/clients" className="btn btn-ghost" style={{ textDecoration: "none", marginTop: 0, marginBottom: 12 }}>
        Clients
      </Link>
      <Link to="/settings/billing" className="btn btn-ghost" style={{ textDecoration: "none", marginTop: 0, marginBottom: 12 }}>
        Billing details
      </Link>

      <button className="btn btn-primary" onClick={() => setShowNew(!showNew)}>
        {showNew ? "Cancel" : "+ New job"}
      </button>
      {showNew && (
        <div className="card" style={{ marginTop: 10 }}>
          <label>Type</label>
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {jobTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          <label>Client reference</label>
          <input value={form.client_ref} placeholder="Stevenson Gallery / Wendy, PO-4471"
            onChange={(e) => setForm({ ...form, client_ref: e.target.value })} />
          <label>Origin address</label>
          <input value={form.origin} onChange={(e) => setForm({ ...form, origin: e.target.value })} />
          <label>Destination address</label>
          <input value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} />
          <label>Date</label>
          <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          <label>Time window</label>
          <input value={form.time} placeholder="09:00-12:00"
            onChange={(e) => setForm({ ...form, time: e.target.value })} />
          <ClashWarning date={form.date} timeWindow={form.time} />
          <label>Items — one per line</label>
          <textarea rows={3} value={form.items} onChange={(e) => setForm({ ...form, items: e.target.value })}
            placeholder={"Kentridge charcoal drawing 80×60\nCrated bronze, 40kg"} />
          <button className="btn btn-accent" onClick={createJob}>Create job</button>
        </div>
      )}

      <JobSearch />

      <h2>Pending confirmation ({pending.length})</h2>
      {pending.length === 0 && <div className="muted">Nothing waiting. Inbound requests land here.</div>}
      {pending.map((j) => (
        <div className="card" key={j.id}>
          <div className="row">
            <Link to={`/job/${j.id}`} className="ref" style={{ color: "inherit" }}>{j.ref}</Link>
            <JobStamp status={j.status} lastEvent={j.last_event_label} alert={j.last_event_alert} />
          </div>
          <div style={{ margin: "6px 0", fontWeight: 600 }}>
            {j.origin?.address || j.origin?.label || "—"} → {j.destination?.address || j.destination?.label || "—"}
          </div>
          <div className="muted">
            {j.line_items?.[0]?.count ?? 0} item(s) · {j.scheduled_date ?? "no date"}
            {j.messages ? ` · via ${j.messages.channel} from ${j.messages.sender}` : ""}
          </div>
          {j.flags?.length > 0 && (
            <div style={{ color: "var(--warn)", fontSize: 13, marginTop: 4 }}>
              ⚠ {j.flags.map((f) => f.replace("missing_info:", "missing ")).join(", ")}
            </div>
          )}
          <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => confirm(j)}>✓ Confirm job</button>
          <div className="quiet-actions">
            <Link to={`/job/${j.id}/edit`}>✎ Edit</Link>
            <button onClick={async () => {
              const url = `${window.location.origin}/claim/${j.id}/${j.claim_token}`;
              if (navigator.share) { try { await navigator.share({ title: `OneShot job ${j.ref}`, url }); } catch {} }
              else { await navigator.clipboard.writeText(url); window.alert("Claim link copied"); }
            }}>🔗 Share link</button>
            <button className="danger" onClick={() => cancel(j)}>Cancel</button>
          </div>
        </div>
      ))}

      <h2>Team</h2>
      <button className="card" onClick={showTeam ? () => setShowTeam(false) : loadTeam} style={{ fontWeight: 600 }}>
        {showTeam ? "Hide team" : "Manage team — add crew and office accounts"}
      </button>
      {showTeam && (
        <div className="card">
          {team.map((t, i) => (
            <div className="row" key={i} style={{ padding: "6px 0", borderBottom: i < team.length - 1 ? "1px solid var(--line)" : "none" }}>
              <span style={{ fontWeight: 600 }}>{t.full_name || "—"}</span>
              <span className={`stamp ${t.role === "ops" ? "live" : "pending"}`}>{t.role.toUpperCase()}</span>
            </div>
          ))}
          <div style={{ marginTop: 12 }}>
            <label>Full name</label>
            <input value={member.full_name} onChange={(e) => setMember({ ...member, full_name: e.target.value })} />
            <label>Sign-in method</label>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <button className={member.idType === "email" ? "btn btn-primary" : "btn btn-ghost"}
                style={{ flex: 1, minHeight: 42, marginTop: 0 }}
                onClick={() => setMember({ ...member, idType: "email" })}>Email</button>
              <button className={member.idType === "phone" ? "btn btn-primary" : "btn btn-ghost"}
                style={{ flex: 1, minHeight: 42, marginTop: 0 }}
                onClick={() => setMember({ ...member, idType: "phone" })}>Phone number</button>
            </div>
            {member.idType === "email" ? (<>
              <label>Email</label>
              <input type="email" value={member.email} onChange={(e) => setMember({ ...member, email: e.target.value })} />
            </>) : (<>
              <label>Cellphone number (they sign in with this + the password)</label>
              <input type="tel" placeholder="082 123 4567" value={member.phone}
                onChange={(e) => setMember({ ...member, phone: e.target.value })} />
            </>)}
            <label>Temporary password</label>
            <input value={member.password} onChange={(e) => setMember({ ...member, password: e.target.value })} />
            <label>Role — crew: field app only · ops: office + field · client: read access (future)</label>
            <select value={member.role} onChange={(e) => setMember({ ...member, role: e.target.value })}>
              <option value="crew">crew</option>
              <option value="ops">ops</option>
              <option value="client">client</option>
            </select>
            <button className="btn btn-primary" onClick={addMember}>Add member</button>
            {teamMsg && <p className="muted" style={{ marginTop: 8 }}>{teamMsg}</p>}
          </div>
        </div>
      )}

      {unread.length > 0 && (
        <>
          <h2>Couldn't be read</h2>
          <p className="muted" style={{ marginBottom: 10 }}>
            {unread.length === 1 ? "An email" : `${unread.length} emails`} reached intake in
            the last two weeks and produced no job. Create {unread.length === 1 ? "it" : "them"} by
            hand, or forward again once the sender has been asked for what is missing.
          </p>
          {unread.map((m) => (
            <div className="card" key={m.id} style={{ borderLeft: "3px solid var(--warn)" }}>
              <div className="row">
                <span className="muted" style={{ fontSize: 12 }}>
                  {m.sender} · {new Date(m.created_at).toLocaleString()}
                </span>
                <button onClick={() => dismissUnread(m.id)} aria-label="Dismiss"
                  style={{ background: "none", border: "none", color: "var(--muted, #8b9498)",
                    cursor: "pointer", font: "inherit" }}>×</button>
              </div>
              {m.subject && <div style={{ fontWeight: 600, marginTop: 4 }}>{m.subject}</div>}
              {m.parse_error && (
                <div className="muted" style={{ fontSize: 12, color: "var(--warn)", marginTop: 4 }}>
                  {m.parse_error}
                </div>
              )}
              <div style={{ fontSize: 13, marginTop: 6, whiteSpace: "pre-wrap",
                maxHeight: 140, overflow: "auto" }}>{m.body}</div>
            </div>
          ))}
        </>
      )}

      <h2>Intake</h2>
      <Link className="card" to="/setup/email" style={{ fontWeight: 600 }}>
        ✉ Email intake setup — Outlook, Gmail, Yahoo, iCloud &amp; more
      </Link>
      <Link className="card" to="/setup/whatsapp" style={{ fontWeight: 600 }}>
        💬 WhatsApp intake setup — group routing &amp; codes
      </Link>
      <button className="card" onClick={showLog ? () => setShowLog(false) : loadLog} style={{ fontWeight: 600 }}>
        {showLog ? "Hide intake log" : "Intake log — last 15 inbound messages"}
      </button>
      {showLog && log.map((m, i) => (
        <div className="card" key={i}>
          <div className="row">
            <span className="muted">{m.channel} · {m.kind} · {m.sender}</span>
            <span className="muted">{new Date(m.created_at).toLocaleString()}</span>
          </div>
          {m.subject && <div style={{ fontWeight: 600, marginTop: 4 }}>{m.subject}</div>}
          <div style={{ fontSize: 13, marginTop: 4, whiteSpace: "pre-wrap", maxHeight: 120, overflow: "auto" }}>{m.body}</div>
        </div>
      ))}
      {showLog && log.length === 0 && <div className="muted">No inbound messages yet.</div>}

      <h2>All jobs</h2>
      <JobList jobs={rest} canDelete />
    </div>
  );
}
