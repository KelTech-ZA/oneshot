import React, { useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { Ctx } from "../main";

// Ops-editable vocabulary for a workspace: what kinds of job it runs, and
// what events its crew log. An event is a status - "built" ends a fabrication
// job the way "delivered" ends a transport job.

const slug = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

export default function TypeSettings() {
  const { profile } = useContext(Ctx);
  const [jobTypes, setJobTypes] = useState([]);
  const [eventTypes, setEventTypes] = useState([]);
  const [newJob, setNewJob] = useState("");
  const [newEvent, setNewEvent] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const isOps = profile?.role === "ops";

  const load = async () => {
    const [{ data: jt }, { data: et }] = await Promise.all([
      supabase.from("job_types").select("*").order("sort"),
      supabase.from("event_types").select("*").order("sort"),
    ]);
    setJobTypes(jt ?? []);
    setEventTypes(et ?? []);
  };

  useEffect(() => { load(); }, []);

  const addType = async (table, label, extra = {}) => {
    const clean = label.trim();
    if (!clean) return;
    const key = slug(clean);
    if (!key) { setMsg("⚠ Give it a name using letters or numbers."); return; }
    setBusy(true); setMsg("");
    const rows = table === "job_types" ? jobTypes : eventTypes;
    const { error } = await supabase.from(table).insert({
      tenant_id: profile.tenant_id,
      key, label: clean,
      sort: (rows.at(-1)?.sort ?? 0) + 10,
      ...extra,
    });
    setBusy(false);
    if (error) {
      setMsg(error.code === "23505" ? `⚠ "${clean}" already exists.` : "⚠ " + error.message);
      return;
    }
    if (table === "job_types") setNewJob(""); else setNewEvent("");
    await load();
  };

  const rename = async (table, row, label) => {
    if (!label.trim() || label === row.label) return;
    const { error } = await supabase.from(table).update({ label: label.trim() }).eq("id", row.id);
    if (error) { setMsg("⚠ " + error.message); return; }
    await load();
  };

  const toggle = async (table, row, field) => {
    const { error } = await supabase.from(table).update({ [field]: !row[field] }).eq("id", row.id);
    if (error) { setMsg("⚠ " + error.message); return; }
    await load();
  };

  // Retire rather than delete: existing jobs and events still reference the key.
  const retire = async (table, row) => {
    const verb = row.active ? "Retire" : "Restore";
    if (!window.confirm(`${verb} "${row.label}"?\n\nExisting records keep it either way — retiring only removes it from the pickers.`))
      return;
    const { error } = await supabase.from(table).update({ active: !row.active }).eq("id", row.id);
    if (error) { setMsg("⚠ " + error.message); return; }
    await load();
  };

  if (!isOps) return <div className="page empty">Only ops can edit job types and events.</div>;

  const Row = ({ table, row, children }) => (
    <div className="card" style={{ opacity: row.active ? 1 : 0.5 }}>
      <input defaultValue={row.label}
        onBlur={(e) => rename(table, row, e.target.value)} />
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>saved as {row.key}</div>
      {children}
      <button className="muted" style={{ background: "none", border: "none", color: "var(--warn)", cursor: "pointer", padding: 0, font: "inherit" }}
        onClick={() => retire(table, row)}>
        {row.active ? "retire" : "restore"}
      </button>
    </div>
  );

  const Check = ({ row, table, field, label, hint }) => (
    <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 6, fontWeight: 400 }}>
      <input type="checkbox" checked={!!row[field]} onChange={() => toggle(table, row, field)}
        style={{ width: 18, height: 18, marginTop: 2 }} />
      <span>{label}<br /><span className="muted" style={{ fontSize: 12 }}>{hint}</span></span>
    </label>
  );

  return (
    <div className="page">
      <Link className="muted" style={{ marginBottom: 10 }} to="/dashboard">← Office</Link>
      <h1>Job types &amp; events</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Your workspace's own vocabulary. Rename anything freely — the saved key
        stays fixed so existing jobs keep working.
      </p>
      {msg && <div className="card" style={{ color: "var(--warn)" }}>{msg}</div>}

      <h2>Job types</h2>
      {jobTypes.map((t) => <Row key={t.id} table="job_types" row={t} />)}
      <div className="card">
        <label>Add a job type</label>
        <input value={newJob} placeholder="Fabrication, Installation, Crate build…"
          onChange={(e) => setNewJob(e.target.value)} />
        <button className="btn btn-primary" disabled={busy || !newJob.trim()}
          onClick={() => addType("job_types", newJob)}>Add job type</button>
      </div>

      <h2 style={{ marginTop: 24 }}>Events</h2>
      <p className="muted" style={{ marginBottom: 10 }}>
        An event is a status. Whichever completing event fires first finishes the job.
      </p>
      {eventTypes.map((t) => (
        <Row key={t.id} table="event_types" row={t}>
          <Check row={t} table="event_types" field="quick" label="Quick button"
            hint="One tap on the job screen instead of hidden in the dropdown." />
          <Check row={t} table="event_types" field="starts_job" label="Starts the job"
            hint="Moves the job to in progress when first logged." />
          <Check row={t} table="event_types" field="completes_job" label="Completes the job"
            hint="Marks the job complete — e.g. Built, Installed, Delivered." />
          <Check row={t} table="event_types" field="alerts" label="Reports a problem"
            hint="Delayed, under clearance, damaged. Shows red on the job and does not move it forward." />
        </Row>
      ))}
      <div className="card">
        <label>Add an event</label>
        <input value={newEvent} placeholder="Built, Installed, Framed, Condition checked…"
          onChange={(e) => setNewEvent(e.target.value)} />
        <button className="btn btn-primary" disabled={busy || !newEvent.trim()}
          onClick={() => addType("event_types", newEvent)}>Add event</button>
        <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          A new event shows on the job card and marks it as underway. Tick
          "Completes the job" if it should finish the work, or "Reports a problem"
          if it is a hold like Delayed or Under clearance.
        </p>
      </div>
    </div>
  );
}
