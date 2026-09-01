import React, { useContext, useEffect, useRef, useState } from "react";
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
  // Pointer-based so it works with a finger as well as a mouse. HTML5 drag
  // events never fire on touch screens, so they are not used at all.
  const [dragId, setDragId] = useState(null);
  const [overKey, setOverKey] = useState(null);
  const [ghost, setGhost] = useState(null);   // { x, y, ref }
  const [drop, setDrop] = useState(null);     // { job, date, label }
  const [dropBusy, setDropBusy] = useState(false);
  const lift = useRef({ timer: null, startX: 0, startY: 0, job: null, active: false });
  // Held in a ref because the drag effect is declared above where sections are
  // built; referencing them directly threw before initialisation.
  const sectionsRef = useRef([]);
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

  // A press-and-hold lifts the card. The drag itself is tracked on the WINDOW,
  // not the card: an <a> is natively draggable, so a mouse drag would otherwise
  // become the browser's own link drag, and on touch the browser claims any
  // vertical movement for scrolling. A non-passive listener takes both back.
  const HOLD_MS = 280;
  const SLOP = 10;

  const dayKeyAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el?.closest("[data-daykey]")?.getAttribute("data-daykey") ?? null;
  };

  const endLift = () => {
    clearTimeout(lift.current.timer);
    lift.current = { timer: null, startX: 0, startY: 0, job: null, active: false };
    setDragId(null);
    setOverKey(null);
    setGhost(null);
  };

  // Everything that happens once a card is in the air.
  useEffect(() => {
    if (!dragId) return;

    const onMove = (e) => {
      e.preventDefault();                       // stops scrolling and text selection
      const x = e.clientX, y = e.clientY;
      setGhost((g) => (g ? { ...g, x, y } : g));
      setOverKey(dayKeyAt(x, y));
      const edge = 90;
      if (y < edge) window.scrollBy({ top: -16 });
      else if (window.innerHeight - y < edge) window.scrollBy({ top: 16 });
    };

    const onUp = (e) => {
      const job = lift.current.job;
      const key = dayKeyAt(e.clientX, e.clientY);
      endLift();
      if (!job || !key || key === "none" || job.scheduled_date === key) return;
      const section = sectionsRef.current.find((sc) => sc.key === key);
      setDrop({ job, date: key, label: section?.label ?? key });
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", endLift);
    // Belt and braces for older mobile Safari, which can still scroll on
    // touchmove even when the pointer event is cancelled.
    const block = (e) => e.preventDefault();
    window.addEventListener("touchmove", block, { passive: false });
    const prevSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", endLift);
      window.removeEventListener("touchmove", block);
      document.body.style.userSelect = prevSelect;
    };
  }, [dragId]);

  const onPointerDown = (e, j) => {
    if (!isOps || e.button === 2) return;
    lift.current.startX = e.clientX;
    lift.current.startY = e.clientY;
    lift.current.job = j;
    lift.current.active = false;
    lift.current.timer = setTimeout(() => {
      lift.current.active = true;
      setDragId(j.id);
      setGhost({ x: lift.current.startX, y: lift.current.startY, ref: j.ref });
      if (navigator.vibrate) navigator.vibrate(12);
    }, HOLD_MS);
  };

  // Before the hold completes, any real movement means they are scrolling.
  const onPointerMoveCard = (e) => {
    if (!lift.current.job || lift.current.active) return;
    if (Math.abs(e.clientX - lift.current.startX) > SLOP
     || Math.abs(e.clientY - lift.current.startY) > SLOP) {
      clearTimeout(lift.current.timer);
      lift.current.job = null;
    }
  };

  const onPointerUpCard = () => {
    if (lift.current.active) return;    // the window handler deals with a drop
    clearTimeout(lift.current.timer);
    lift.current.job = null;
  };

  const moveJob = async (job, date) => {
    setDropBusy(true);
    try {
      const { data, error } = await supabase.from("jobs")
        .update({ scheduled_date: date, updated_at: new Date().toISOString() })
        .eq("id", job.id).select("id");
      if (error) { window.alert("Could not move: " + error.message); return; }
      if (!data?.length) { window.alert("That job was not moved — the database refused the change."); return; }
      setDrop(null);
      window.dispatchEvent(new Event("queue-updated"));
      window.location.reload();
    } finally { setDropBusy(false); }
  };

  const copyJobTo = async (job, date) => {
    setDropBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${FUNCTIONS_URL}/duplicate-job`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ job_id: job.id, scheduled_date: date }),
      });
      const result = await res.json();
      if (result.error) { window.alert("Could not duplicate: " + result.error); return; }
      setDrop(null);
      window.location.href = `/job/${result.id}`;
    } finally { setDropBusy(false); }
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
  sectionsRef.current = sections;

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
      {isOps && shown.length > 1 && (
        <div className="muted no-print" style={{ fontSize: 12, marginTop: 4 }}>
          Press and hold a job to move it to another day.
        </div>
      )}
      {ghost && (
        <div style={{ position: "fixed", left: ghost.x, top: ghost.y, zIndex: 60,
          transform: "translate(-50%, -140%)", pointerEvents: "none",
          background: "var(--ink)", color: "#fff", padding: "8px 14px",
          borderRadius: 10, fontSize: 13, fontWeight: 600,
          boxShadow: "0 6px 20px rgba(16,19,20,.3)" }}>
          {ghost.ref}
        </div>
      )}

      {drop && (
        <div role="dialog" aria-modal="true"
          style={{ position: "fixed", inset: 0, background: "rgba(16,19,20,.45)", zIndex: 50,
            display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
          onClick={() => !dropBusy && setDrop(null)}>
          <div className="card" style={{ maxWidth: 380, width: "100%", marginBottom: 0 }}
            onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {drop.job.ref} → {drop.label}
            </div>
            <div className="muted" style={{ fontSize: 13, marginBottom: 14 }}>
              Move it to this day, or leave the original where it is and put a copy here?
            </div>
            <button className="btn btn-primary" disabled={dropBusy}
              onClick={() => moveJob(drop.job, drop.date)}>
              Move it here
            </button>
            <button className="btn btn-ghost" disabled={dropBusy}
              onClick={() => copyJobTo(drop.job, drop.date)}>
              Duplicate it here
            </button>
            <button className="btn btn-ghost" disabled={dropBusy}
              onClick={() => setDrop(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {sections.map((sec) => (
        <div key={sec.key} data-daykey={sec.key}
          style={overKey === sec.key && dragId && sec.key !== "none"
            ? { outline: "2px dashed var(--accent)", outlineOffset: 6, borderRadius: 12 }
            : undefined}>
          <div style={{ margin: "14px 0 6px", fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: sec.label.startsWith("Overdue") ? "var(--warn)" : "var(--muted, #8b9498)" }}>
            {sec.label}{sec.key !== "none" && !["Today", "Tomorrow"].includes(sec.label) ? "" : sec.key !== "none" ? ` \u00b7 ${sec.key}` : ""}
          </div>
          {sec.jobs.map((j) => (
        <Link className="card" key={j.id} to={`/job/${j.id}`}
          draggable={false}
          onPointerDown={(e) => onPointerDown(e, j)}
          onPointerMove={onPointerMoveCard}
          onPointerUp={onPointerUpCard}
          onPointerCancel={onPointerUpCard}
          onDragStart={(e) => e.preventDefault()}
          onContextMenu={(e) => { if (isOps) e.preventDefault(); }}
          onClick={(e) => { if (dragId || lift.current.active) e.preventDefault(); }}
          style={dragId === j.id
            ? { opacity: 0.4, WebkitTouchCallout: "none" }
            : isOps ? { WebkitTouchCallout: "none" } : undefined}>
          <div className="row">
            <span className="ref">{j.ref}</span>
            <JobStamp status={j.status} lastEvent={j.last_event_label} alert={j.last_event_alert} />
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

