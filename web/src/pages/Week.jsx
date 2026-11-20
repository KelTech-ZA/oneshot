import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useRefreshOnReturn } from "../lib/refresh";
import { Ctx } from "../main";
import { parseWindow, fmt } from "../lib/schedule";
import { localISO } from "./JobCalendar";

// The week, as a calendar.
//
// The list in Today answers "what is outstanding". This answers "what is
// happening on Thursday", which is a different question and the one ops asks
// first thing in the morning. Jobs sit in their time slot; a job with a date
// but no time sits in a band above the grid rather than being drawn at
// midnight, because an unslotted job is the one most likely to be forgotten;
// a job with no date at all waits in the rail until somebody drags it onto a
// day.
//
// Nothing here parses a time window itself. lib/schedule already does it, and
// it handles "9am-10:30am", "14h30 - 16h00" and "morning" - every shape the
// email parser has ever written into that column. A second parser living here
// would drift from it within a month.

const DONE = ["completed", "closed", "cancelled"];
const DAY_START = 7, DAY_END = 21;          // 07:00 to 21:00
const HOUR = 56;                            // px per hour, matches --wk-hour
const SNAP = 15;                            // minutes
const DEFAULT_MINUTES = 120;                // what lib/schedule assumes too

const DOW = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY",
                "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

const mondayOf = (d) => {
  const out = new Date(d);
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
  out.setHours(0, 0, 0, 0);
  return out;
};
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const short = (d) => `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
// A stored date is a plain yyyy-mm-dd. Read it as local noon rather than
// midnight UTC, or a date renders as the day before in any timezone west of
// Greenwich - and Cape Town is east of it, which is exactly the kind of bug
// that stays hidden until somebody opens this on a trip.
const asDate = (iso) => new Date(iso + "T12:00:00");
const prettyDate = (iso) => {
  const d = asDate(iso);
  return `${DOW[(d.getDay() + 6) % 7]} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
};

// Work that has started is not waiting on anybody, whatever its date says.
const STARTED = ["in_progress", "reopened"];

// The colour on the left edge of a job. The lifecycle status decides it,
// except for two cases the status cannot express: a job carrying an alert,
// and a job whose date has gone by without the work ever starting. Both need
// a decision from somebody, which is what the red edge means.
//
// The date test is deliberately narrow. An earlier version flagged anything
// dated before today, which on a Friday painted most of the week red and made
// the count on the OPEN dot worth ignoring - and a warning you have learned to
// ignore is worse than no warning.
export function stateOf(j, todayISO) {
  if (DONE.includes(j.status)) return "done";
  if (j.status === "pending_confirmation") return "new";
  if (j.last_event_alert) return "open";
  if (!j.scheduled_date) return "open";
  if (j.scheduled_date < todayISO && !STARTED.includes(j.status)) return "open";
  return "scheduled";
}

// Overlapping jobs are laid in layers, not columns.
//
// Splitting the day into equal columns is tidy and useless: three jobs at the
// same hour each get a third of a column, which is not enough width to read
// the client off, so a glance at the week tells you there is work on Thursday
// and nothing about what it is. A calendar instead lets each job keep most of
// the width and lays the next one over it, shifted right - every job stays
// readable, the one underneath keeps a visible edge to click, and the overlap
// itself is the signal that two things run at once.
export function layColumns(list) {
  const sorted = [...list].sort((a, b) => a.win.start - b.win.start || a.win.end - b.win.end);
  const out = [];
  let cluster = [], end = -1;

  const flush = () => {
    if (!cluster.length) return;
    const cols = [];                        // when the last job in each column ends
    const first = out.length;
    for (const row of cluster) {
      let c = cols.findIndex((e) => e <= row.win.start);
      if (c === -1) { c = cols.length; cols.push(0); }
      cols[c] = row.win.end;
      out.push({ ...row, col: c });
    }
    for (let i = first; i < out.length; i++) out[i].of = cols.length;
    cluster = []; end = -1;
  };

  for (const row of sorted) {
    if (cluster.length && row.win.start >= end) flush();
    cluster.push(row);
    end = Math.max(end, row.win.end);
  }
  flush();
  return out;
}

export default function Week() {
  const { profile, session } = useContext(Ctx);
  const nav = useNavigate();
  const isOps = profile.role === "ops";

  const [anchor, setAnchor] = useState(() => mondayOf(new Date()));
  const [miniMonth, setMiniMonth] = useState(() => {
    const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const [jobs, setJobs] = useState(null);
  const [clients, setClients] = useState([]);
  const [types, setTypes] = useState([]);
  const [hidden, setHidden] = useState(() => new Set());
  const [states, setStates] = useState({ scheduled: true, open: true, new: true, done: false });
  const [peek, setPeek] = useState(null);     // the job in the side panel
  const [docs, setDocs] = useState(null);     // its documents
  const [flag, setFlag] = useState(null);     // "open" | "new" list
  const [note, setNote] = useState("Drag a job onto any day or time. Filter by client on the left.");
  const [railOpen, setRailOpen] = useState(false);

  // Customers pinned to the filter list by hand. The list offers whoever has
  // work this week, which is the useful default and no help at all when the
  // client you want to watch has nothing on yet - so these are added on top
  // and kept. Per workspace, because Section 9's customers are not the
  // gallery's and the two share this browser.
  const PINS = `oneshot_week_clients_${profile.tenant_id}`;
  const [pinned, setPinned] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(PINS) ?? "[]")); }
    catch { return new Set(); }
  });
  const savePins = (next) => {
    setPinned(next);
    try { localStorage.setItem(PINS, JSON.stringify([...next])); } catch { /* private mode */ }
  };

  const todayISO = localISO(new Date());
  const from = localISO(anchor), to = localISO(addDays(anchor, 6));

  const COLUMNS = "id, ref, type, status, client_id, crew, contact_name, client_ref, " +
                  "origin, destination, scheduled_date, time_window, " +
                  "last_event_label, last_event_alert, line_items(count)";

  const load = async () => {
    // The week, plus everything with no date at all - those are the ones
    // waiting in the rail to be dragged onto it.
    const range = `and(scheduled_date.gte.${from},scheduled_date.lte.${to}),scheduled_date.is.null`;

    const run = (cols) => supabase.from("jobs").select(cols)
      .or(range).order("scheduled_date", { ascending: true });

    // The customer a job belongs to can sit on either row, so the billing
    // one is asked for too. If that embed is not available - a workspace
    // whose schema cache has not caught up, an older database - the week
    // still has to draw. Losing the client filter is a bad afternoon;
    // losing the calendar is a bad day.
    let { data, error } = await run(`${COLUMNS}, job_billing(client_id)`);
    if (error) {
      const retry = await run(COLUMNS);
      if (retry.error) { setNote("Could not load the week: " + retry.error.message); setJobs([]); return; }
      data = retry.data;
      setNote("Loaded, but customers could not be read - the client filter will be thin.");
    }
    setJobs(data ?? []);
  };

  useEffect(() => { load(); }, [from, to]);
  useRefreshOnReturn(load);

  useEffect(() => {
    supabase.from("clients").select("id,name").order("name")
      .then(({ data }) => setClients(data ?? []));
    supabase.from("job_types").select("key,label").eq("active", true).order("sort")
      .then(({ data }) => setTypes(data ?? []));
  }, []);

  // A job's customer is on the job; for anything the email parser created it
  // is on the billing row instead, because that is where the matcher writes
  // it. Reading both is the difference between a filter that works and a
  // rail of "no client set".
  const clientOf = (j) => j.client_id ?? j.job_billing?.[0]?.client_id ?? j.job_billing?.client_id ?? null;
  const clientName = (id) => clients.find((c) => c.id === id)?.name ?? null;
  const typeLabel = (k) => types.find((t) => t.key === k)?.label ?? k ?? "Job";
  const titleOf = (j) => {
    const items = j.line_items?.[0]?.count ?? 0;
    return `${typeLabel(j.type)}${items ? ` — ${items} item${items > 1 ? "s" : ""}` : ""}`;
  };
  const placeOf = (j) => j.destination?.address ?? j.origin?.address ?? j.client_ref ?? "—";

  const visible = (j) => {
    const cid = clientOf(j);
    if (hidden.has(cid ?? "none")) return false;
    return states[stateOf(j, todayISO)];
  };

  // Which clients to offer as filters: the ones with work in this week, plus
  // a row for jobs nobody has matched to a customer yet.
  const railClients = useMemo(() => {
    const tally = new Map();
    for (const j of jobs ?? []) {
      const id = clientOf(j) ?? "none";
      tally.set(id, (tally.get(id) ?? 0) + 1);
    }
    // A pinned customer stays on the list through a quiet week, reading 0,
    // which is itself worth seeing.
    for (const id of pinned) if (!tally.has(id)) tally.set(id, 0);

    return [...tally.entries()]
      .map(([id, n]) => ({
        id, n, pinned: pinned.has(id),
        name: id === "none" ? "No client set" : (clientName(id) ?? "Unknown client"),
      }))
      .sort((a, b) => (a.id === "none" ? 1 : b.id === "none" ? -1 : a.name.localeCompare(b.name)));
  }, [jobs, clients, hidden, pinned]);

  // Everyone not already on the list, for the picker.
  const addable = useMemo(
    () => clients.filter((c) => !railClients.some((r) => r.id === c.id)),
    [clients, railClients]);

  // Both sides at local noon, then floor: a difference of 23 or 25 hours is
  // still one day, and rounding a half-day lands a Monday job on Tuesday.
  const dayIndexOf = (iso) => {
    if (!iso) return -1;
    const base = new Date(anchor); base.setHours(12, 0, 0, 0);
    const i = Math.floor((asDate(iso) - base) / 86400000 + 0.5);
    return i >= 0 && i < 7 ? i : -1;
  };

  const placed = useMemo(() => {
    const grid = Array.from({ length: 7 }, () => []);
    const band = Array.from({ length: 7 }, () => []);
    const loose = [];
    for (const j of jobs ?? []) {
      if (!visible(j)) continue;
      if (!j.scheduled_date) { loose.push(j); continue; }
      const i = dayIndexOf(j.scheduled_date);
      if (i < 0) continue;
      const win = parseWindow(j.time_window);
      if (win) grid[i].push({ j, win });
      else band[i].push(j);
    }
    return { grid: grid.map(layColumns), band, loose };
  }, [jobs, hidden, states, anchor, clients]);

  const counts = useMemo(() => {
    const all = jobs ?? [];
    return {
      open: all.filter((j) => stateOf(j, todayISO) === "open").length,
      new: all.filter((j) => stateOf(j, todayISO) === "new").length,
    };
  }, [jobs]);

  /* ── rescheduling by dragging ──────────────────────────────────────────
     Pointer events, not HTML5 drag-and-drop, which does not exist on a
     touch screen - and this gets used on a phone in a loading bay. A press
     that does not move is still a tap, so opening a job and moving one do
     not fight each other. Crew cannot reschedule: the database would refuse
     it anyway, and a drag that silently snaps back is worse than one that
     never starts. */
  const lift = useRef(null);
  const [ghost, setGhost] = useState(null);
  const [drop, setDrop] = useState(null);     // {day, start, len} or {day, band:true}

  const startLift = (e, j) => {
    if (!isOps) return;
    if (e.button !== undefined && e.button !== 0) return;
    lift.current = { j, x0: e.clientX, y0: e.clientY, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  useEffect(() => {
    const move = (e) => {
      const L = lift.current;
      if (!L) return;
      if (!L.moved) {
        if (Math.abs(e.clientX - L.x0) < 5 && Math.abs(e.clientY - L.y0) < 5) return;
        L.moved = true;
        setNote(`Moving ${L.j.ref}. Let go on a day to set the time.`);
      }
      setGhost({ x: e.clientX + 12, y: e.clientY + 12, text: `${L.j.ref} · ${titleOf(L.j)}` });

      const under = document.elementFromPoint(e.clientX, e.clientY);
      const col = under?.closest?.("[data-wkday]");
      if (col) {
        const day = Number(col.dataset.wkday);
        if (col.dataset.wkband === "1") { L.target = { day, band: true }; setDrop({ day, band: true }); return; }
        const r = col.getBoundingClientRect();
        const raw = (e.clientY - r.top) / HOUR * 60 + DAY_START * 60;
        const start = Math.max(DAY_START * 60,
          Math.min(DAY_END * 60 - SNAP, Math.round(raw / SNAP) * SNAP));
        const win = parseWindow(L.j.time_window);
        const len = win ? win.end - win.start : DEFAULT_MINUTES;
        L.target = { day, start, len };
        setDrop({ day, start, len });
        return;
      }
      L.target = null; setDrop(null);
    };

    const up = async () => {
      const L = lift.current;
      lift.current = null;
      setGhost(null); setDrop(null);
      if (!L || !L.moved) return;
      if (!L.target) { setNote("Dropped nowhere, so nothing moved."); return; }
      await reschedule(L.j, L.target);
    };

    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
    return () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
    };
  });

  // The keys the bar at the bottom advertises. Not while somebody is typing
  // into a field, and not while a drag is in flight.
  useEffect(() => {
    const onKey = (e) => {
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "")) return;
      if (e.key === "Escape") { setPeek(null); setFlag(null); return; }
      if (lift.current) return;
      if (e.key === "ArrowLeft") setAnchor((a) => addDays(a, -7));
      if (e.key === "ArrowRight") setAnchor((a) => addDays(a, 7));
      if (e.key.toLowerCase() === "t") setAnchor(mondayOf(new Date()));
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const reschedule = async (j, target) => {
    const date = localISO(addDays(anchor, target.day));
    const window_ = target.band ? null
      : `${hhmm(target.start)}–${hhmm(Math.min(target.start + target.len, DAY_END * 60))}`;

    // Optimistic, then reconciled by the reload below: a van on a bad
    // connection should still see the job move where it was dropped.
    setJobs((prev) => prev.map((x) =>
      x.id === j.id ? { ...x, scheduled_date: date, time_window: window_ } : x));

    const { error } = await supabase.from("jobs")
      .update({ scheduled_date: date, time_window: window_, updated_at: new Date().toISOString() })
      .eq("id", j.id);
    if (error) { setNote("Could not move it: " + error.message); load(); return; }

    // Every other change to a job writes an amendment. A reschedule that
    // left no trace would be the one gap in the audit trail, and this is the
    // easiest change in the whole app to make by accident.
    await supabase.from("custody_events").insert({
      tenant_id: profile.tenant_id, job_id: j.id, type: "amendment",
      taken_at: new Date().toISOString(), user_id: session.user.id,
      notes: "Rescheduled from the week view",
      payload: { changes: { scheduled_date: date, time_window: window_ } },
    });
    setNote(`${j.ref} → ${DOW[target.day]} ${short(addDays(anchor, target.day))}` +
            (window_ ? ` ${window_}.` : ", no time set."));
    load();
  };

  /* ── the side panel ────────────────────────────────────────────────── */
  const openPeek = async (j) => {
    setFlag(null); setPeek(j); setDocs(null);
    setNote(`${j.ref} — ${clientName(clientOf(j)) ?? j.client_ref ?? "no client set"}.`);
    const { data } = await supabase.from("job_documents")
      .select("id,name,path,mime,size_bytes,client_visible,created_at")
      .eq("job_id", j.id).order("created_at");
    setDocs(data ?? []);
  };

  const openDoc = async (d, download) => {
    const { data, error } = await supabase.storage.from("documents")
      .createSignedUrl(d.path, 3600, download ? { download: d.name } : undefined);
    if (error || !data?.signedUrl) { window.alert("Could not open that file: " + (error?.message ?? "unknown")); return; }
    window.open(data.signedUrl, "_blank", "noopener");
  };

  if (!jobs) return <div className="empty">Loading the week…</div>;

  const weekNo = (() => {
    const d = new Date(anchor); d.setDate(d.getDate() + 3);           // ISO: Thursday decides
    const first = new Date(d.getFullYear(), 0, 4);
    return 1 + Math.round(((d - first) / 86400000 - 3 + ((first.getDay() + 6) % 7)) / 7);
  })();

  /* ── mini month ────────────────────────────────────────────────────── */
  const miniDays = (() => {
    const first = new Date(miniMonth.getFullYear(), miniMonth.getMonth(), 1);
    const start = mondayOf(first);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  })();

  const Flag = ({ kind, n }) => (
    <button className={`wk-flag${flag === kind ? " on" : ""}`}
      aria-expanded={flag === kind}
      onClick={() => { setPeek(null); setFlag(flag === kind ? null : kind); }}>
      <span className={`wk-dot ${kind}`} />{n} {kind.toUpperCase()}
    </button>
  );

  const list = flag
    ? jobs.filter((j) => stateOf(j, todayISO) === flag)
    : [];

  return (
    <div className="wk">
      <div className="wk-bar">
        <button className="wk-railtog" onClick={() => setRailOpen(!railOpen)}>▪ FILTERS</button>
        <h1 className="wk-h1">WEEK {weekNo}</h1>
        <span className="wk-range">{short(anchor)} — {short(addDays(anchor, 6))} {addDays(anchor, 6).getFullYear()}</span>
        <div className="wk-step">
          <button onClick={() => setAnchor(addDays(anchor, -7))} aria-label="Previous week">‹</button>
          <button onClick={() => { setAnchor(mondayOf(new Date())); const n = new Date(); setMiniMonth(new Date(n.getFullYear(), n.getMonth(), 1)); }}>TODAY</button>
          <button onClick={() => setAnchor(addDays(anchor, 7))} aria-label="Next week">›</button>
        </div>
        <div className="wk-flags">
          <Flag kind="open" n={counts.open} />
          <Flag kind="new" n={counts.new} />
        </div>
      </div>

      <div className="wk-body">
        <aside className={`wk-rail${railOpen ? " on" : ""}`}>
          {isOps && (
            <button className="wk-new" onClick={() => nav("/job/new")}>
              <b>+</b> NEW JOB
            </button>
          )}

          <div className="wk-minihead">
            <button onClick={() => setMiniMonth(new Date(miniMonth.getFullYear(), miniMonth.getMonth() - 1, 1))} aria-label="Previous month">‹</button>
            <span>{MONTHS[miniMonth.getMonth()]} {miniMonth.getFullYear()}</span>
            <button onClick={() => setMiniMonth(new Date(miniMonth.getFullYear(), miniMonth.getMonth() + 1, 1))} aria-label="Next month">›</button>
          </div>
          <div className="wk-mini">
            {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <i key={i}>{d}</i>)}
            {miniDays.map((d) => {
              const iso = localISO(d);
              const inWeek = iso >= from && iso <= to;
              const cls = [
                d.getMonth() !== miniMonth.getMonth() ? "out" : "",
                inWeek ? "inweek" : "",
                iso === todayISO ? "today" : "",
              ].filter(Boolean).join(" ");
              return (
                <button key={iso} className={cls} onClick={() => setAnchor(mondayOf(d))}>
                  {d.getDate()}
                </button>
              );
            })}
          </div>

          {placed.loose.length > 0 && (
            <>
              <h2>Unscheduled — {placed.loose.length}</h2>
              <div className="wk-loose">
                {placed.loose.map((j) => (
                  <button key={j.id} className={`wk-chip s-${stateOf(j, todayISO)}`}
                    onPointerDown={(e) => startLift(e, j)}
                    onPointerUp={() => { if (lift.current && !lift.current.moved) openPeek(j); }}>
                    <span className="u">NO DATE</span> · {j.ref} {titleOf(j)}
                  </button>
                ))}
              </div>
              {isOps && <p className="wk-hint">Drag one onto a day to schedule it.</p>}
            </>
          )}

          <h2>Clients</h2>
          <div className="wk-filters scrolls">
            {railClients.map((c) => (
              <div key={c.id} className="wk-frowwrap">
                <button className="wk-frow" aria-pressed={!hidden.has(c.id)}
                  onClick={() => {
                    const next = new Set(hidden);
                    next.has(c.id) ? next.delete(c.id) : next.add(c.id);
                    setHidden(next);
                  }}>
                  <span className="cursor">▸</span>
                  <span className="swatch" />
                  <span className="name">{c.name}</span>
                  <span className="count">{c.n}</span>
                </button>
                {/* Only a pinned customer can be taken off: the ones with work
                    this week are here because the week put them here, and
                    removing one would just hide jobs with no way back. */}
                {c.pinned && (
                  <button className="wk-unpin" title={`Take ${c.name} off the list`}
                    onClick={() => {
                      const next = new Set(pinned); next.delete(c.id); savePins(next);
                      const show = new Set(hidden); show.delete(c.id); setHidden(show);
                    }}>✕</button>
                )}
              </div>
            ))}
            {railClients.length === 0 && <p className="wk-hint">No jobs this week.</p>}
          </div>

          {addable.length > 0 && (
            <select className="wk-add" value=""
              onChange={(e) => {
                if (!e.target.value) return;
                const next = new Set(pinned); next.add(e.target.value); savePins(next);
                setNote(`${clientName(e.target.value)} added to the filters.`);
              }}>
              <option value="">＋ ADD A CLIENT…</option>
              {addable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}

          <button className="wk-railbtn"
            onClick={() => setHidden(hidden.size ? new Set() : new Set(railClients.map((c) => c.id)))}>
            ▪ ALL / NONE
          </button>

          <h2>Job types</h2>
          <div className="wk-filters">
            {[["scheduled", "Scheduled"], ["open", "Open — needs a decision"],
              ["new", "New — not confirmed"], ["done", "Finished"]].map(([k, label]) => (
              <button key={k} className="wk-frow" aria-pressed={states[k]}
                onClick={() => setStates({ ...states, [k]: !states[k] })}>
                <span className="cursor">▸</span>
                <span className={`swatch s-${k}`} />
                <span className="name">{label}</span>
              </button>
            ))}
          </div>
        </aside>

        <main className="wk-week">
          <div className="wk-cols">
            <div />
            {DOW.map((d, i) => {
              const day = addDays(anchor, i);
              const isToday = localISO(day) === todayISO;
              return (
                <div key={i} className={`wk-dayhead${isToday ? " istoday" : ""}`}>
                  <div className="dow">{d}</div>
                  <div className="num">{day.getDate()}</div>
                </div>
              );
            })}
          </div>

          <div className="wk-band">
            <div className="label">NO TIME<br />SET</div>
            {placed.band.map((day, i) => (
              <div key={i} className={`cell${drop?.band && drop.day === i ? " over" : ""}`}
                data-wkday={i} data-wkband="1">
                {day.map((j) => (
                  <button key={j.id} className={`wk-chip s-${stateOf(j, todayISO)}`}
                    onPointerDown={(e) => startLift(e, j)}
                    onPointerUp={() => { if (lift.current && !lift.current.moved) openPeek(j); }}>
                    <span className="u">UNASSIGNED</span> · {titleOf(j)}
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div className="wk-scroll">
            <div className="wk-grid">
              <div className="wk-gutter">
                {Array.from({ length: DAY_END - DAY_START }, (_, i) => (
                  <div className="hr" key={i}>{String(DAY_START + i).padStart(2, "0")}:00</div>
                ))}
              </div>
              {placed.grid.map((day, i) => {
                const isToday = localISO(addDays(anchor, i)) === todayISO;
                const now = new Date();
                const nowTop = (now.getHours() + now.getMinutes() / 60 - DAY_START) * HOUR;
                return (
                  <div key={i} className={`wk-col${drop && !drop.band && drop.day === i ? " over" : ""}`}
                    data-wkday={i}>
                    {Array.from({ length: DAY_END - DAY_START }, (_, h) => <div className="slot" key={h} />)}
                    {isToday && nowTop > 0 && nowTop < (DAY_END - DAY_START) * HOUR &&
                      <div className="wk-now" style={{ top: nowTop }} />}
                    {drop && !drop.band && drop.day === i && (
                      <div className="wk-drop" style={{
                        top: (drop.start / 60 - DAY_START) * HOUR,
                        height: Math.max(drop.len / 60 * HOUR, 20),
                      }}>
                        <span>{hhmm(drop.start)}</span>
                      </div>
                    )}
                    {day.map(({ j, win, col, of }) => {
                      const top = (win.start / 60 - DAY_START) * HOUR;
                      const h = Math.max((win.end - win.start) / 60 * HOUR - 2, 22);
                      // How far each layer is shifted right. Wide enough that
                      // the job underneath shows its colour, its time and the
                      // first word or two; never so wide that the top one is
                      // a sliver.
                      const step = of > 1 ? Math.min(24, 60 / (of - 1)) : 0;
                      const indent = col * step;
                      return (
                        <button key={j.id}
                          className={`wk-job s-${stateOf(j, todayISO)}${peek?.id === j.id ? " sel" : ""}${col > 0 ? " layered" : ""}`}
                          style={{
                            top, height: h, zIndex: 2 + col,
                            left: `calc(${indent.toFixed(2)}% + 2px)`,
                            width: `calc(${(100 - indent).toFixed(2)}% - 4px)`,
                          }}
                          onPointerDown={(e) => startLift(e, j)}
                          onPointerUp={() => { if (lift.current && !lift.current.moved) openPeek(j); }}>
                          <div className="t">{win.exact ? fmt(win.start) : `${fmt(win.start)}?`}</div>
                          <div className="n">{titleOf(j)}</div>
                          {h > 44 &&
                            <div className="c">{clientName(clientOf(j)) ?? j.client_ref ?? j.ref}</div>}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </main>
      </div>

      <div className="wk-foot">
        <div className="say">{note}</div>
        <div className="keys">
          <span><kbd>← →</kbd>Week</span>
          <span><kbd>Esc</kbd>Close</span>
        </div>
      </div>

      {ghost && <div className="wk-ghost" style={{ left: ghost.x, top: ghost.y }}>{ghost.text}</div>}

      {(peek || flag) && <div className="wk-scrim" onClick={() => { setPeek(null); setFlag(null); }} />}

      {flag && (
        <aside className="wk-panel" role="dialog" aria-label={`${flag} jobs`}>
          <header>
            <h3>{flag.toUpperCase()}</h3>
            <button className="x" onClick={() => setFlag(null)}>ESC ✕</button>
          </header>
          <div className="inner">
            <p className="wk-note">
              {flag === "open"
                ? "Waiting on a decision — flagged, past its date, or with no date at all."
                : "Arrived and not confirmed yet. Confirm them or turn them into quotes."}
            </p>
            <div className="wk-plist">
              {list.map((j) => (
                <button key={j.id} className={`wk-pitem s-${stateOf(j, todayISO)}`} onClick={() => openPeek(j)}>
                  <span className="when">{j.scheduled_date ? prettyDate(j.scheduled_date) : "no date"}</span>
                  <span className="body">
                    <span className="n">{titleOf(j)}</span>
                    <span className="c">{clientName(clientOf(j)) ?? j.client_ref ?? "—"} · {j.ref}</span>
                  </span>
                </button>
              ))}
              {list.length === 0 && <p className="wk-note">Nothing here. </p>}
            </div>
          </div>
        </aside>
      )}

      {peek && (
        <aside className="wk-panel" role="dialog" aria-label={peek.ref}>
          <header>
            <h3>{peek.ref}</h3>
            <button className="x" onClick={() => setPeek(null)}>ESC ✕</button>
          </header>
          <div className="inner">
            <div className="wk-ptitle">
              <strong>{titleOf(peek)}</strong>
              <span className={`stamp ${stateOf(peek, todayISO) === "done" ? "done"
                : stateOf(peek, todayISO) === "open" ? "bad"
                : stateOf(peek, todayISO) === "new" ? "pending" : "live"}`}>
                {peek.last_event_label?.toUpperCase() ?? peek.status.replace(/_/g, " ").toUpperCase()}
              </span>
            </div>
            <dl className="wk-kv">
              <dt>CLIENT</dt><dd>{clientName(clientOf(peek)) ?? peek.client_ref ?? "Not matched to a customer"}</dd>
              <dt>WHEN</dt><dd>{peek.scheduled_date
                ? `${prettyDate(peek.scheduled_date)}${peek.time_window ? ` · ${peek.time_window}` : " · no time set"}`
                : "Not scheduled"}</dd>
              <dt>FROM</dt><dd>{peek.origin?.address ?? "—"}</dd>
              <dt>TO</dt><dd>{peek.destination?.address ?? "—"}</dd>
              <dt>CREW</dt><dd>{peek.crew?.length ? peek.crew.join(", ") : "Nobody assigned"}</dd>
              <dt>ITEMS</dt><dd>{peek.line_items?.[0]?.count ?? 0}</dd>
            </dl>

            <div>
              <h4 className="wk-h4">DOCUMENTS</h4>
              {docs === null && <p className="wk-note">Looking…</p>}
              {docs?.length === 0 && <p className="wk-note">Nothing attached yet.</p>}
              {docs?.length > 0 && (
                <div className="wk-docs">
                  {docs.map((d) => (
                    <div className="wk-doc" key={d.id}>
                      <span className="kind">{(d.name.split(".").pop() ?? "file").toUpperCase().slice(0, 5)}</span>
                      <span className="ref">{d.name}</span>
                      <span className="meta">{d.client_visible ? "shared" : "internal"}</span>
                      <span className="ops">
                        <button onClick={() => openDoc(d, false)}>VIEW</button>
                        <button onClick={() => openDoc(d, true)}>↓</button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="wk-act">
              <button className="go" onClick={() => nav(`/job/${peek.id}`)}>OPEN JOB</button>
              {isOps && <button onClick={() => nav(`/job/${peek.id}/edit`)}>EDIT</button>}
            </div>
            <p className="wk-note">OPEN JOB is the job card in full — items, custody,
              charges and documents.</p>
          </div>
        </aside>
      )}
    </div>
  );
}
