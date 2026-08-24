import React, { useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { Ctx } from "../main";
import JobList from "./JobList";

const STAMP = {
  pending_confirmation: ["pending", "PENDING"], confirmed: ["pending", "CONFIRMED"],
  assigned: ["live", "ASSIGNED"], accepted: ["live", "ACCEPTED"], in_progress: ["live", "IN PROGRESS"],
  completed: ["done", "COMPLETED"], closed: ["done", "CLOSED"], cancelled: ["bad", "CANCELLED"],
};

// The colour comes from the lifecycle status; the WORD comes from the last
// event logged, so a finished job reads DELIVERED or BUILT rather than the
// uninformative COMPLETED. Statuses that describe the contract rather than
// the work - awaiting confirmation, closed, cancelled - keep their own word.
const CONTRACT_STATES = ["pending_confirmation", "closed", "cancelled"];

export function JobStamp({ status, lastEvent }) {
  const [cls, statusLabel] = STAMP[status] ?? ["pending", status];
  const label = lastEvent && !CONTRACT_STATES.includes(status) ? lastEvent.toUpperCase() : statusLabel;
  return <span className={`stamp ${cls}`} title={statusLabel}>{label}</span>;
}

export default function Today() {
  const { profile } = useContext(Ctx);
  const [jobs, setJobs] = useState(null);

  useEffect(() => {
    supabase.from("jobs")
      .select("*, line_items(count)")
      .neq("status", "pending_confirmation")
      .then(({ data }) => setJobs(data ?? []));
  }, []);

  if (!jobs) return <div className="empty">Loading jobs…</div>;
  return (
    <div className="page">
      <h1>Today</h1>
      <JobList jobs={jobs} />
      {profile.role === "ops" && (
        <Link to="/dashboard" className="btn btn-ghost" style={{ marginTop: 16, textDecoration: "none" }}>
          Office view: pending &amp; all jobs
        </Link>
      )}
    </div>
  );
}
