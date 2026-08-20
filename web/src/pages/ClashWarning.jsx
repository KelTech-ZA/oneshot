import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { findClashes, parseWindow, fmt } from "../lib/schedule";

// Advisory only: tells ops that a proposed slot overlaps existing work.
// Never blocks saving - double bookings are sometimes deliberate.
export default function ClashWarning({ date, timeWindow, excludeId }) {
  const [clashes, setClashes] = useState([]);

  useEffect(() => {
    let cancelled = false;
    const win = parseWindow(timeWindow);
    if (!date || !win) { setClashes([]); return; }

    supabase.from("jobs")
      .select("id, ref, time_window, status")
      .eq("scheduled_date", date)
      .not("status", "in", '("completed","closed","cancelled")')
      .then(({ data }) => {
        if (cancelled) return;
        setClashes(findClashes(timeWindow, data ?? [], { excludeId }));
      });

    return () => { cancelled = true; };
  }, [date, timeWindow, excludeId]);

  if (!clashes.length) return null;
  const anyAssumed = clashes.some((c) => !c.certain);

  return (
    <div className="card" style={{ borderLeft: "3px solid var(--warn)" }}>
      <div style={{ fontWeight: 600, color: "var(--warn)", marginBottom: 4 }}>
        Double booking — {clashes.length} job{clashes.length > 1 ? "s" : ""} already in this slot
      </div>
      {clashes.map(({ job, win, certain }) => (
        <div key={job.id} className="muted" style={{ fontSize: 13 }}>
          <Link to={`/job/${job.id}`}>{job.ref}</Link>{" · "}
          {job.time_window || `${fmt(win.start)}–${fmt(win.end)}`}
          {!certain && " (time approximate)"}
        </div>
      ))}
      {anyAssumed && (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Jobs without an end time are assumed to run 2 hours.
        </div>
      )}
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        You can still save — this is a heads-up, not a block.
      </div>
    </div>
  );
}
