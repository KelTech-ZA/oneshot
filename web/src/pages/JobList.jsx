import React, { useContext, useState } from "react";
import { Link } from "react-router-dom";
import { JobStamp } from "./Today";
import { supabase } from "../lib/supabase";
import { Ctx } from "../main";

// Shared chronological job list.
// Sort: scheduled_date ascending (undated last), tiebreak on creation time —
// so the list reads top-to-bottom as "what's next, what's running, what's done."
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
      return a.created_at < b.created_at ? -1 : 1;
    });

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
      {shown.map((j) => (
        <Link className="card" key={j.id} to={`/job/${j.id}`}>
          <div className="row">
            <span className="ref">{j.ref}</span>
            <JobStamp status={j.status} />
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
    </>
  );
}

