import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { pendingCount } from "../lib/queue";

function browserNotify(title, body) {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") new Notification(title, { body, icon: "/icon-192.png" });
}

// In-app banner stack + browser notifications.
// 1. Realtime: new jobs (inbound requests / assignments) pop a "New job" notice.
// 2. Reminder: any in-progress job with unfinished items, or unsynced events,
//    pops a persistent "Job still open" notice on app open.
export default function Notices({ profile }) {
  const [notices, setNotices] = useState([]);

  const push = (n) => setNotices((cur) =>
    cur.some((x) => x.key === n.key) ? cur : [...cur, n]);
  const dismiss = (key) => setNotices((cur) => cur.filter((x) => x.key !== key));

  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default")
      Notification.requestPermission();

    // Realtime: new jobs
    const ch = supabase.channel("jobs-feed")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "jobs" }, ({ new: j }) => {
        const isPending = j.status === "pending_confirmation";
        if (isPending && profile.role !== "ops") return; // pending requests are office business
        const title = isPending ? "New request — confirm it" : "New job";
        push({ key: `job-${j.id}`, tone: "accent", title, jobId: j.id,
          body: `${j.ref} · ${j.scheduled_date ?? "no date"}` });
        browserNotify(title, j.ref);
      })
      .subscribe();

    // Open-job reminder
    (async () => {
      const { data: openJobs } = await supabase.from("jobs")
        .select("id, ref, line_items(status)").eq("status", "in_progress");
      const unsynced = await pendingCount();
      for (const j of openJobs ?? []) {
        const unfinished = (j.line_items ?? []).filter(
          (i) => !["delivered", "in_storage", "exception"].includes(i.status)).length;
        if (unfinished > 0 || unsynced > 0) {
          const parts = [];
          if (unfinished) parts.push(`${unfinished} item(s) not yet shot`);
          if (unsynced) parts.push(`${unsynced} event(s) waiting to sync`);
          push({ key: `open-${j.id}`, tone: "warn", title: "Job still open",
            jobId: j.id, body: `${j.ref} · ${parts.join(" · ")}. Open to finish.` });
        }
      }
    })();

    return () => supabase.removeChannel(ch);
  }, [profile.id]);

  if (!notices.length) return null;
  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "10px 16px 0" }}>
      {notices.map((n) => (
        <div key={n.key} className="card" style={{
          background: "var(--ink)", color: "#fff", border: "none",
          display: "flex", alignItems: "flex-start", gap: 10 }}>
          <span aria-hidden="true" style={{
            width: 32, height: 32, borderRadius: 8, flexShrink: 0, display: "flex",
            alignItems: "center", justifyContent: "center",
            background: n.tone === "warn" ? "var(--warn)" : "var(--accent)" }}>
            {n.tone === "warn" ? "⏰" : "🔔"}
          </span>
          <Link to={`/job/${n.jobId}`} onClick={() => dismiss(n.key)}
            style={{ color: "#fff", textDecoration: "none", flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{n.title}</div>
            <div style={{ fontSize: 13, opacity: 0.75, marginTop: 2 }}>{n.body}</div>
          </Link>
          <button onClick={() => dismiss(n.key)} aria-label="Dismiss"
            style={{ background: "none", border: "none", color: "#fff", fontSize: 18, cursor: "pointer" }}>×</button>
        </div>
      ))}
    </div>
  );
}
