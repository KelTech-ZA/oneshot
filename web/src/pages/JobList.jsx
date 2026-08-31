import React, { useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { JobStamp } from "./Today";
import { supabase, FUNCTIONS_URL } from "../lib/supabase";
import { Ctx } from "../main";

// Shared chronological job list.
// Sort: scheduled_date ascending (undated last), tiebreak on creation time —
// so the list reads top-to-bottom as "what's next, what's running, what's done."
// Minutes-from-midnight for a free-text time window ("9:00am", "14:30",
// "morning"). Unparseable or absent sorts to the end of its day.
function timeRank(tw) {
  if (!tw) return 9999;
  const t = String(tw).toLowerCase();
  const m = t.match(/(\d{1,2})[:h.]?(\d{2})?\s*(am|pm)?/);
  if (!m) return t.includes("morning") ? 540 : t.includes("afternoon") ? 840 : 9999;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  return h * 60 + min;
}

const localISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function dayLabel(dateStr, outstanding = true) {
  if (!dateStr) return "Unscheduled";
  const today = new Date();
  const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
  if (dateStr === localISO(today)) return "Today";
  if (dateStr === localISO(tomorrow)) return "Tomorrow";
  const d = new Date(`${dateStr}T00:00:00`);
  const pretty = d.toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "short" });
  return outstanding && dateStr < localISO(today) ? `Overdue \u00b7 ${pretty}` : pretty;
}

const GROUPS = {
  "To do": ["pending_confirmation", "confirmed", "assigned", "accepted"],
  "In progress": ["in_progress"],
  "Done": ["completed", "closed", "cancelled"],
};

export default function JobList({ jobs, canDelete = false }) {
  const [filter, setFilter] = useState("All");
  const { profile } = useContext(Ctx);
  const [removed, setRemoved] = useState(new Set());
  const [busyId, setBusyId] = useState(null);
  const [typeLabels, setTypeLabels] = useState({});
  const isOps = profile?.role === "ops";

  useEffect(() => {
    supabase.from("job_types").select("key,label")
      .then(({ data }) => setTypeLabels(Object.fromEntries((data ?? []).map((r) => [r.key, r.label]))));
  }, []);

  // Ops may delete any job, including one that carries custody evidence -
  // duplicates from a mis-parsed date are common and leaving them undeletable
  // makes a mess of the dashboard. The deletion is never silent: delete-job
  // records what was removed, by whom, in deleted_jobs.
  const deleteJob = async (e, j) => {
    e.preventDefault();
    e.stopPropagation();
    setBusyId(j.id);
    try {
      const { count } = await supabase
        .from("custody_events")
        .select("id", { count: "exact", head: true })
        .eq("job_id", j.id);

      const evidence = count ?? 0;
      if (evidence > 0) {
        const typed = window.prompt(
          `${j.ref} has ${evidence} custody event(s) — photos and timestamps that may be your proof of handling.\n\n` +
          `Deleting is permanent. The record of the deletion is kept, the evidence is not.\n\n` +
          `Type ${j.ref} to confirm:`);
        if (typed?.trim().toUpperCase() !== j.ref.toUpperCase()) return;
      } else if (!window.confirm(`Delete ${j.ref}? This cannot be undone.`)) {
        return;
      }

      const reason = window.prompt("Why is it being deleted? (optional, kept on record)") ?? null;

      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${FUNCTIONS_URL}/delete-job`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ job_id: j.id, reason }),
      });
      const result = await res.json();
      if (result.error) { window.alert("Could not delete: " + result.error); return; }

      setRemoved((prev) => new Set(prev).add(j.id));
      window.dispatchEvent(new Event("queue-updated"));
    } finally {
      setBusyId(null);
    }
  };

  // Long jobs run over several days - collect Monday, pack Tuesday, deliver
  // Thursday. Duplicating carries the addresses and items, never the evidence.
  const duplicateJob = async (e, j) => {
    e.preventDefault();
    e.stopPropagation();
    const when = window.prompt(
      `Duplicate ${j.ref}?\n\nAddresses and items are copied. Photos, events and documents are not.\n\n` +
      `Date for the copy (YYYY-MM-DD), or leave blank:`, j.scheduled_date ?? "");
    if (when === null) return;

    setBusyId(j.id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${FUNCTIONS_URL}/duplicate-job`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ job_id: j.id, scheduled_date: when.trim() || null }),
      });
      const result = await res.json();
      if (result.error) { window.alert("Could not duplicate: " + result.error); return; }
      window.dispatchEvent(new Event("queue-updated"));
      window.location.href = `/job/${result.id}`;
    } finally {
      setBusyId(null);
    }
  };

  const shown = jobs
    .filter((j) => !removed.has(j.id))
    .filter((j) => filter === "All" || GROUPS[filter].includes(j.status))
    .sort((a, b) => {
      if (a.scheduled_date && b.scheduled_date && a.scheduled_date !== b.scheduled_date)
        return a.scheduled_date < b.scheduled_date ? -1 : 1;
      if (!!a.scheduled_date !== !!b.scheduled_date) return a.scheduled_date ? -1 : 1;
      const ta = timeRank(a.time_window), tb = timeRank(b.time_window);
      if (ta !== tb) return ta - tb;
      return a.created_at < b.created_at ? -1 : 1;
    });

  // Consecutive runs of the same date become labelled sections.
  const sections = [];
  for (const j of shown) {
    const key = j.scheduled_date ?? "none";
    if (!sections.length || sections[sections.length - 1].key !== key)
      sections.push({ key, date: j.scheduled_date, jobs: [] });
    sections[sections.length - 1].jobs.push(j);
  }
  for (const sec of sections)
    sec.label = dayLabel(sec.date, sec.jobs.some((j) => !GROUPS.Done.includes(j.status)));

  return (
    <>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, overflowX: "auto", paddingBottom: 2 }}>
        {["All", "To do", "In progress", "Done"].map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={filter === f ? "stamp live" : "stamp pending"}
            style={{ background: "none", cursor: "pointer", padding: "7px 12px", whiteSpace: "nowrap" }}>
            {f}
          </button>
        ))}
      </div>
      {shown.length === 0 && <div className="empty">Nothing here.</div>}
      {sections.map((sec) => (
        <div key={sec.key}>
          <div style={{ margin: "14px 0 6px", fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: sec.label.startsWith("Overdue") ? "var(--warn)" : "var(--muted, #8b9498)" }}>
            {sec.label}{sec.key !== "none" && !["Today", "Tomorrow"].includes(sec.label) ? "" : sec.key !== "none" ? ` \u00b7 ${sec.key}` : ""}
          </div>
          {sec.jobs.map((j) => (
        <Link className="card" key={j.id} to={`/job/${j.id}`}>
          <div className="row">
            <span className="ref">{j.ref}</span>
            <JobStamp status={j.status} lastEvent={j.last_event_label} />
          </div>
          <div style={{ margin: "6px 0 4px", fontWeight: 600 }}>
            {j.origin?.label || j.origin?.address || "—"} → {j.destination?.label || j.destination?.address || "—"}
          </div>
          {j.client_ref && <div className="muted" style={{ fontSize: 13 }}>Ref: {j.client_ref}</div>}
          <div className="muted">
            {typeLabels[j.type] ?? j.type} · {j.line_items?.[0]?.count ?? 0} item(s) · {j.scheduled_date ?? "unscheduled"}
            {j.time_window ? ` · ${j.time_window}` : ""}
          </div>
          {isOps && canDelete && (
            <div className="no-print" style={{ display: "flex", gap: 16, marginTop: 6 }}>
              <button className="muted" disabled={busyId === j.id}
                style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", padding: 0, font: "inherit" }}
                onClick={(e) => duplicateJob(e, j)}>
                duplicate
              </button>
              <button className="muted" disabled={busyId === j.id}
                style={{ background: "none", border: "none", color: "var(--warn)", cursor: "pointer", padding: 0, font: "inherit" }}
                onClick={(e) => deleteJob(e, j)}>
                {busyId === j.id ? "working…" : "delete"}
              </button>
            </div>
          )}
        </Link>
          ))}
        </div>
      ))}
    </>
  );
}

