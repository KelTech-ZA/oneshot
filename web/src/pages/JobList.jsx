import React, { useContext, useState } from "react";
import { Link } from "react-router-dom";
import { JobStamp } from "./Today";
import { supabase } from "../lib/supabase";
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
  const isOps = profile?.role === "ops";

  // Ops may delete a job only while it carries no custody evidence.
  // Once events exist the record is permanent - that is the whole point.
  const deleteJob = async (e, j) => {
    e.preventDefault();
    e.stopPropagation();
    setBusyId(j.id);
    try {
      const { count, error: cErr } = await supabase
        .from("custody_events")
        .select("id", { count: "exact", head: true })
        .eq("job_id", j.id);
      if (cErr) { window.alert("Could not check job history: " + cErr.message); return; }
      if (count && count > 0) {
        window.alert(
          `${j.ref} has ${count} custody event(s) and cannot be deleted.\n\n` +
          "Cancel it instead - the photographic record is your proof of custody."
        );
        return;
      }
      if (!window.confirm(`Delete ${j.ref} permanently? This cannot be undone.`)) return;

      const { error: liErr } = await supabase.from("line_items").delete().eq("job_id", j.id);
      if (liErr) { window.alert("Could not delete items: " + liErr.message); return; }
      const { error: jErr } = await supabase.from("jobs").delete().eq("id", j.id);
      if (jErr) { window.alert("Could not delete job: " + jErr.message); return; }

      setRemoved((prev) => new Set(prev).add(j.id));
      window.dispatchEvent(new Event("queue-updated"));
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
          <div className="muted">
            {j.line_items?.[0]?.count ?? 0} item(s) · {j.scheduled_date ?? "unscheduled"}
            {j.time_window ? ` · ${j.time_window}` : ""}
          </div>
          {isOps && canDelete && (
            <button className="muted no-print" disabled={busyId === j.id}
              style={{ background: "none", border: "none", color: "var(--warn)", cursor: "pointer", padding: 0, marginTop: 6, font: "inherit" }}
              onClick={(e) => deleteJob(e, j)}>
              {busyId === j.id ? "deleting…" : "delete"}
            </button>
          )}
        </Link>
          ))}
        </div>
      ))}
    </>
  );
}

