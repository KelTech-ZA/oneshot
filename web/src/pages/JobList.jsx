import React, { useState } from "react";
import { Link } from "react-router-dom";
import { JobStamp } from "./Today";

// Shared chronological job list.
// Sort: scheduled_date ascending (undated last), tiebreak on creation time —
// so the list reads top-to-bottom as "what's next, what's running, what's done."
const GROUPS = {
  "To do": ["pending_confirmation", "confirmed", "assigned", "accepted"],
  "In progress": ["in_progress"],
  "Done": ["completed", "closed", "cancelled"],
};

export default function JobList({ jobs }) {
  const [filter, setFilter] = useState("All");

  const shown = jobs
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
        </Link>
      ))}
    </>
  );
}
