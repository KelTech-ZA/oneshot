import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { useRefreshOnReturn } from "../lib/refresh";
import { Ctx } from "../main";
import { parseWindow, fmt } from "../lib/schedule";
import { localISO } from "./JobCalendar";
import { isRepeat, withoutTag, refsIn } from "./Dashboard";
import { dismiss as remember, keepUndismissed } from "../lib/dismissed";
import { subscribeNotices } from "./Notices";

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
const HOUR = 75;                            // px per hour, matches --wk-hour
const SNAP = 15;                            // minutes
const DEFAULT_MINUTES = 120;                // what lib/schedule assumes too

// A workspace's own work - the jobs with no customer on them - carries the
// workspace's own colour, so you can tell at a glance which of these are
// yours and which belong to somebody who is paying for them. Derived from
// the workspace id, so every workspace has a stable colour of its own
// without anyone having to choose one, and Section 9's is not Southern
// Guild's. Subtle on purpose: the loud colours belong to the states that
// need a decision.
const WS_COLOURS = [
  ["#3d6b8f", "#edf2f6"], ["#6b4fa8", "#f1eef7"], ["#2f7d62", "#ebf4f0"],
  ["#8f6a2a", "#f7f1e7"], ["#8f3d5c", "#f8edf1"], ["#4a6b2f", "#eff4e9"],
];
export function wsColour(id) {
  let h = 0;
  for (const ch of String(id ?? "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return WS_COLOURS[h % WS_COLOURS.length];
}

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

// office: the same calendar with the ops controls on it. Crew get the week
// and nothing else; ops get the three dots and the rail of office work. It is
// deliberately one component - the moment Office is "the calendar, but
// rebuilt", the two drift and only one of them gets fixed.
// The week fills whatever is left below whatever happens to be above it -
// the ribbon, and the notices strip when there is one. Measuring beats
// guessing: a hard-coded 56px for the top bar is right until somebody adds a
// line to it, and then the grid hangs off the bottom of the screen and the
// page scrolls the header away.
export function useFitViewport() {
  const el = useRef(null);
  useEffect(() => {
    const fit = () => {
      if (!el.current) return;
      const top = el.current.getBoundingClientRect().top + window.scrollY;
      // flex-grow beats height on a flex item, so the shell has to stop
      // growing before a height means anything to it. Without this line the
      // box reports the height you asked for and lays out at the height of
      // its contents, which is a confusing half-hour to debug.
      el.current.style.flex = "0 0 auto";
      el.current.style.height = `${Math.max(320, window.innerHeight - top)}px`;
    };
    fit();
    addEventListener("resize", fit);
    const t = setTimeout(fit, 150);        // after fonts settle
    return () => { removeEventListener("resize", fit); clearTimeout(t); };
  });
  return el;
}

export default function Week({ office = false }) {
  const shell = useFitViewport();
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
  const [flag, setFlag] = useState(null);     // "open" | "new" | "errors" list
  const [bad, setBad] = useState([]);         // intake that produced no job
  // Notifications you have seen. Per browser, never a database write: these
  // are nudges, and one person clearing their own view must not clear
  // everybody's. The key carries the job's status and date, so a job that
  // changes - rescheduled, reopened, left to go stale again - raises its hand
  // a second time rather than staying quiet forever on one dismissal.
  const [hushed, setHushed] = useState(() => new Set());
  const keyOf = (j, kind) => `wk-${kind}-${j.id}-${j.status}-${j.scheduled_date ?? "nodate"}`;
  const [note, setNote] = useState("Drag a job onto any day or time. Filter by client on the left.");
  const [railOpen, setRailOpen] = useState(false);
  const [notices, setNotices] = useState({ list: [], dismiss: () => {}, dismissAll: () => {} });
  const [busyDays, setBusyDays] = useState(new Set());   // days with work, for the month
  const [ink, tint] = wsColour(profile.tenant_id);

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

  // Mail that arrived and produced nothing: unreadable, or the same request
  // for a second time. Ops only, because it is ops who fix it.
  const loadBad = async () => {
    if (!office || !isOps) return;
    const since = new Date(Date.now() - 14 * 864e5).toISOString();
    const { data } = await supabase.from("messages")
      .select("id,sender,subject,body,created_at,parse_error,kind")
      .is("job_id", null).gte("created_at", since)
      .order("created_at", { ascending: false }).limit(20);
    const noted = (data ?? []).filter((m) => m.parse_error || m.kind === "unknown");
    // Dismissing is per-browser and deliberately not a database write: the
    // message is evidence, and one person clearing their own view should not
    // erase it for a colleague.
    setBad(keepUndismissed(noted, (m) => (isRepeat(m) ? `rep-${m.id}` : `msg-${m.id}`)));
  };
  useEffect(() => { loadBad(); }, [office]);

  // The notice stack lives in the shell; this is where it gets shown.
  useEffect(() => subscribeNotices(setNotices), []);

  // Which days in the month on the left have work on them. The dots are how
  // you find the week you are looking for without opening four of them.
  useEffect(() => {
    const first = mondayOf(new Date(miniMonth.getFullYear(), miniMonth.getMonth(), 1));
    const last = addDays(first, 41);
    supabase.from("jobs").select("scheduled_date")
      .gte("scheduled_date", localISO(first)).lte("scheduled_date", localISO(last))
      .then(({ data }) => setBusyDays(new Set((data ?? []).map((r) => r.scheduled_date))));
  }, [miniMonth]);

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

  // What each dot is counting: everything in that state that has not been
  // waved off. The calendar still draws all of it - dismissing a notification
  // silences the nudge, it does not hide the work.
  const noticed = (kind) => keepUndismissed(
    (jobs ?? []).filter((j) => stateOf(j, todayISO) === kind),
    (j) => keyOf(j, kind)).filter((j) => !hushed.has(keyOf(j, kind)));

  const counts = useMemo(() => ({
    // Reminders are things waiting on a decision too, so they are counted
    // where a person would look for them rather than in a fourth dot.
    open: noticed("open").length + notices.list.length,
    new: noticed("new").length,
  }), [jobs, hushed, notices]);

  const hush = (j, kind) => {
    const k = keyOf(j, kind);
    remember(k);
    setHushed((cur) => new Set(cur).add(k));
  };
  const hushAll = (kind) => {
    const keys = noticed(kind).map((j) => keyOf(j, kind));
    remember(keys);
    setHushed((cur) => { const next = new Set(cur); keys.forEach((k) => next.add(k)); return next; });
    setNote(`${keys.length} ${kind} ${keys.length === 1 ? "notice" : "notices"} dismissed. The work is still on the calendar.`);
  };

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

  const decide = async (j, status) => {
    const { error } = await supabase.from("jobs")
      .update({ status, updated_at: new Date().toISOString() }).eq("id", j.id);
    if (error) { setNote("Could not change it: " + error.message); return; }
    setNote(`${j.ref} ${status === "confirmed" ? "confirmed" : "cancelled"}.`);
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

  const list = (flag === "open" || flag === "new") ? noticed(flag) : [];

  return (
    <div className="wk" ref={shell}>
      <div className="wk-bar">
        <button className="wk-railtog" onClick={() => setRailOpen(!railOpen)}>▪ FILTERS</button>
        <h1 className="wk-h1">WEEK {weekNo}</h1>
        <span className="wk-range">
          {short(anchor)} — {short(addDays(anchor, 6))} {addDays(anchor, 6).getFullYear()}
          {office ? " · OFFICE" : ""}
        </span>
        <div className="wk-step">
          <button onClick={() => setAnchor(addDays(anchor, -7))} aria-label="Previous week">‹</button>
          <button onClick={() => { setAnchor(mondayOf(new Date())); const n = new Date(); setMiniMonth(new Date(n.getFullYear(), n.getMonth(), 1)); }}>TODAY</button>
          <button onClick={() => setAnchor(addDays(anchor, 7))} aria-label="Next week">›</button>
        </div>
        {/* Everything that wants you is a dot up here, and nothing else.
            A screen that opens with a stack of banners is a screen you learn
            to scroll past before you have read it. */}
        <div className="wk-flags">
          <Flag kind="open" n={counts.open} />
          <Flag kind="new" n={counts.new} />
          {office && isOps && <Flag kind="errors" n={bad.length} />}
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
                  {busyDays.has(iso) && <i className="wk-busy" aria-label="has work" />}
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
                    <span className="u">NO DATE</span> · {j.ref}
                    <span className="what">{titleOf(j)}</span>
                  </button>
                ))}
              </div>
              {isOps && <p className="wk-hint">Drag one onto a day to schedule it.</p>}
            </>
          )}

          <h2 className="wk-h2big">Filters</h2>
          <p className="wk-hint" style={{ margin: "-4px 0 10px" }}>
            Click one to show or hide its jobs on the calendar.
          </p>

          <h3 className="wk-h3">Clients</h3>
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
                  <span className="swatch"
                    style={c.id === "none" ? { borderColor: ink, background: hidden.has(c.id) ? "transparent" : ink } : undefined} />
                  <span className="name">{c.id === "none" ? `${profile.workspace ?? "Our"} own work` : c.name}</span>
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

          <h3 className="wk-h3">Job types</h3>
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

          {/* Not a filter, so it does not sit among them. */}
          {office && isOps && (
            <div className="wk-officeblock">
              <h2 className="wk-h2big">Office</h2>
              <div className="wk-filters">
                <Link className="wk-frow" to="/office/setup"><span className="cursor">▸</span><span className="name">Team &amp; setup</span></Link>
                <Link className="wk-frow" to="/settings/clients"><span className="cursor">▸</span><span className="name">Clients</span></Link>
                <Link className="wk-frow" to="/settings/types"><span className="cursor">▸</span><span className="name">Job types &amp; rates</span></Link>
                <Link className="wk-frow" to="/settings/billing"><span className="cursor">▸</span><span className="name">Billing &amp; letterhead</span></Link>
                <Link className="wk-frow" to="/statements"><span className="cursor">▸</span><span className="name">Statements</span></Link>
              </div>
            </div>
          )}
        </aside>

        <main className="wk-week">
          {/* One horizontal scroller around the day headings, the band and
              the grid, so all three slide together. Below about 1040px the
              days would otherwise squeeze until a job is a stripe with no
              words on it; now the week keeps readable columns and you pan
              across it. */}
          <div className="wk-hscroll">
            <div className="wk-inner">
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
                    style={clientOf(j) == null && stateOf(j, todayISO) === "scheduled"
                      ? { borderLeftColor: ink, background: tint } : undefined}
                    onPointerDown={(e) => startLift(e, j)}
                    onPointerUp={() => { if (lift.current && !lift.current.moved) openPeek(j); }}>
                    <span className="u">UNASSIGNED</span> · {j.ref}
                    <span className="what">{titleOf(j)}</span>
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
                            // Ours, not a customer's: the workspace's colour.
                            // The states that need a decision keep their own
                            // tint - those matter more than whose job it is.
                            ...(clientOf(j) == null && stateOf(j, todayISO) === "scheduled"
                              ? { borderLeftColor: ink, background: tint } : {}),
                          }}
                          onPointerDown={(e) => startLift(e, j)}
                          onPointerUp={() => { if (lift.current && !lift.current.moved) openPeek(j); }}>
                          <div className="t">
                            {win.exact ? fmt(win.start) : `${fmt(win.start)}?`} · {j.ref}
                          </div>
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
            </div>
          </div>
        </main>
      </div>

      <div className="wk-foot">
        <div className="say">{note}</div>
        <div className="keys">
          {/* These looked like hints and read as controls, so they are
              controls. */}
          <button className="wk-key" onClick={() => setAnchor(addDays(anchor, -7))}
            title="Previous week">←</button>
          <button className="wk-key" onClick={() => setAnchor(addDays(anchor, 7))}
            title="Next week">→</button>
          <span style={{ marginRight: 6 }}>Week</span>
          <button className="wk-key" onClick={() => { setPeek(null); setFlag(null); }}
            title="Close the panel">Esc</button>
          <span>Close</span>
        </div>
      </div>

      {ghost && <div className="wk-ghost" style={{ left: ghost.x, top: ghost.y }}>{ghost.text}</div>}

      {(peek || flag) && <div className="wk-scrim" onClick={() => { setPeek(null); setFlag(null); }} />}

      {flag === "errors" && (
        <aside className="wk-panel" role="dialog" aria-label="intake problems">
          <header>
            <h3>ERRORS</h3>
            <button className="x" onClick={() => setFlag(null)}>ESC ✕</button>
          </header>
          <div className="inner">
            <div className="wk-panelhead">
              <p className="wk-note">
                Mail that reached intake in the last two weeks and produced no job —
                unreadable, or the same request arriving twice. An intake pipeline
                that loses work quietly is worse than none, because you stop checking.
              </p>
              {bad.length > 0 && (
                <button className="wk-dismissall" onClick={() => {
                  remember(bad.map((m) => (isRepeat(m) ? `rep-${m.id}` : `msg-${m.id}`)));
                  setNote(`${bad.length} intake notices dismissed. The messages are still on record.`);
                  setBad([]);
                }}>DISMISS ALL</button>
              )}
            </div>
            <div className="wk-plist">
              {bad.map((m) => {
                const repeat = isRepeat(m);
                return (
                  <div className={`wk-pitem s-${repeat ? "new" : "open"}`} key={m.id}
                    style={{ display: "block" }}>
                    <div className="row" style={{ alignItems: "flex-start" }}>
                      <span className="body" style={{ flex: 1 }}>
                        <span className="n">{m.subject || "(no subject)"}</span>
                        <span className="c">{m.sender} · {new Date(m.created_at).toLocaleDateString("en-ZA")}</span>
                      </span>
                      <span className={`tag ${repeat ? "new" : "open"}`}
                        style={{ fontFamily: "var(--mono)", fontSize: 9, border: "1px solid currentColor",
                                 padding: "2px 6px", color: repeat ? "var(--accent)" : "var(--warn)" }}>
                        {repeat ? "ARRIVED TWICE" : "COULD NOT READ"}
                      </span>
                    </div>
                    {m.parse_error && (
                      <p className="wk-note" style={{ marginTop: 6 }}>{withoutTag(m.parse_error)}</p>
                    )}
                    {repeat && refsIn(m.parse_error).length > 0 && (
                      <p className="wk-note" style={{ marginTop: 4 }}>
                        Already became {refsIn(m.parse_error).join(", ")} — making it again would
                        double the job.
                      </p>
                    )}
                    <div className="wk-act" style={{ marginTop: 8 }}>
                      {!repeat && (
                        <button className="go" onClick={() => nav("/job/new")}>MAKE THE JOB</button>
                      )}
                      <button onClick={() => {
                        remember(repeat ? `rep-${m.id}` : `msg-${m.id}`);
                        setBad((cur) => cur.filter((x) => x.id !== m.id));
                      }}>DISMISS</button>
                    </div>
                  </div>
                );
              })}
              {bad.length === 0 && <p className="wk-note">Nothing has gone wrong. Everything that
                arrived became a job.</p>}
            </div>
          </div>
        </aside>
      )}

      {(flag === "open" || flag === "new") && (
        <aside className="wk-panel" role="dialog" aria-label={`${flag} jobs`}>
          <header>
            <h3>{flag.toUpperCase()}</h3>
            <button className="x" onClick={() => setFlag(null)}>ESC ✕</button>
          </header>
          <div className="inner">
            <div className="wk-panelhead">
              <p className="wk-note">
                {flag === "open"
                  ? "Waiting on a decision — flagged, past its date, or with no date at all."
                  : "Arrived and not confirmed yet. Confirm them, or cancel what should not have come."}
              </p>
              {(list.length > 0 || (flag === "open" && notices.list.length > 0)) && (
                <button className="wk-dismissall" onClick={() => {
                  if (flag === "open") notices.dismissAll();
                  hushAll(flag);
                }}>DISMISS ALL</button>
              )}
            </div>

            {/* Reminders and alerts, in the dot rather than in a stack over
                the calendar. */}
            {flag === "open" && notices.list.length > 0 && (
              <div className="wk-plist">
                {notices.list.map((n) => (
                  <div className="wk-pitem s-open" key={n.key} style={{ display: "block" }}>
                    <span className="body">
                      <span className="n">{n.title}</span>
                      <span className="c">{n.body}</span>
                    </span>
                    <div className="wk-act" style={{ marginTop: 8 }}>
                      {n.action && (
                        <button className="go" onClick={n.action.run}>{n.action.label}</button>
                      )}
                      {n.href && <button onClick={() => nav(n.href)}>OPEN</button>}
                      <button onClick={() => notices.dismiss(n.key)}>DISMISS</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="wk-plist">
              {list.map((j) => (
                <div key={j.id} className={`wk-pitem s-${stateOf(j, todayISO)}`} style={{ display: "block" }}>
                  <button onClick={() => openPeek(j)}
                    style={{ display: "flex", gap: 10, width: "100%", textAlign: "left", padding: 0 }}>
                    <span className="when">{j.scheduled_date ? prettyDate(j.scheduled_date) : "no date"}</span>
                    <span className="body">
                      <span className="n">{titleOf(j)}</span>
                      <span className="c">{clientName(clientOf(j)) ?? j.client_ref ?? "—"} · {j.ref}</span>
                    </span>
                  </button>
                  {/* Confirming is the whole reason this list exists, so it
                      happens here rather than two pages away. */}
                  <div className="wk-act" style={{ marginTop: 8 }}>
                    {office && isOps && flag === "new" && (<>
                      <button className="go" onClick={() => decide(j, "confirmed")}>CONFIRM</button>
                      <button onClick={() => decide(j, "cancelled")}>CANCEL</button>
                    </>)}
                    <button onClick={() => hush(j, flag)}>DISMISS</button>
                  </div>
                </div>
              ))}
              {list.length === 0 && (
                <p className="wk-note">
                  {flag === "open" ? "Nothing waiting on a decision." : "Nothing new to confirm."}
                  {" "}Anything dismissed comes back if the job changes.
                </p>
              )}
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
