import React, { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { useRefreshOnReturn } from "../lib/refresh";
import {
  pad, dateKey, shiftKey, instant, nextWeekday, readTime, soon, spell, away,
} from "../lib/when";

// Reminders, on the job card and nowhere else.
//
// The app could already reach a phone, but only ever about something that had
// just happened. Most of what ops need telling is the opposite: a collection
// that cannot be confirmed until the gallery opens, a crate to chase before the
// airline cut-off, a client who said they would call back Thursday. None of
// those are events. They are times.
//
// Two ways in, because both get used. The wheel is for a thumb on a phone -
// flick, land, done, no keyboard. The typed field is for a hand already on a
// keyboard, where "0930" beats two flicks. They are the same two numbers, so
// whichever you touch, the other follows.
//
// Whatever is picked, the line underneath spells the instant out in words and
// says how far off it is. A reminder set for the wrong day is worse than no
// reminder at all, and the only defence against that is being able to read it
// back before pressing save.
//
// Who hears about it: the person who set it, and only them. Everyone on the job
// can SEE what has been set, so two people do not set the same one, but nobody
// else's phone goes off. Telling a colleague to do something at ten is a
// different thing with different manners.

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);
const CELL = 36;   // must match --rem-cell in index.html

// ---------------------------------------------------------------------------
// One column of a digital clock
// ---------------------------------------------------------------------------
// A scroll container with two blank cells above and below, so the first and
// last value can reach the middle. Snapping means a released flick always
// settles exactly on a cell, which is what makes reading the value back a
// rounding of scrollTop rather than a guess.
//
// The awkward part is that this has two inputs - the finger, and the value
// arriving from somewhere else (typing, a preset) - and each must move the other
// without the two chasing each other round.
//
// The first attempt muted scroll events for a fixed 420ms after a programmatic
// scroll. That is a bug, and a nasty one: a smooth scroll from minute 30 to
// minute 15 takes longer than that, so the mute expired mid-animation, the
// handler read a position the wheel was only passing through, and reported it.
// Typing 09:30 saved a reminder for 09:10. Found by driving it in a browser;
// nothing short of that would have shown it.
//
// So there is no timer standing in for "is it still moving". Instead:
//   - the handler is debounced, so it only ever reads a wheel that has STOPPED
//   - `mine` holds whatever this wheel last settled on, and a resting position
//     that already matches it is simply not reported
// A programmatic scroll ends exactly on `mine`, so it reports nothing, however
// long the animation takes. The loop is closed by the comparison, not the clock.

function Wheel({ values, value, onChange, label, pick }) {
  const box = useRef(null);
  const mine = useRef(value);
  const timer = useRef(null);

  const centre = (v, smooth) => {
    const el = box.current;
    if (!el) return;
    // Any read still waiting to happen is now about a position this wheel is
    // leaving, so it must not be allowed to report. Snapping nudges scrollTop
    // by a pixel when the wheel first lays out, which arms exactly such a read;
    // without this line, a value arriving in the next tenth of a second - a
    // preset chip tapped the moment the card opens, a time typed fast - was
    // overwritten by it and silently put back.
    clearTimeout(timer.current);
    const i = Math.max(0, values.indexOf(v));
    el.scrollTo({ top: i * CELL, behavior: smooth ? "smooth" : "auto" });
  };

  useEffect(() => { centre(value, false); /* on open */ }, []);

  useEffect(() => {
    if (value === mine.current) return;      // this wheel caused it
    mine.current = value;
    centre(value, true);
  }, [value]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const onScroll = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const el = box.current;
      if (!el) return;
      const i = Math.min(values.length - 1, Math.max(0, Math.round(el.scrollTop / CELL)));
      const v = values[i];
      if (v === mine.current) return;        // where we already think we are
      mine.current = v;
      onChange(v);
    }, 140);
  };

  return (
    <div className="rem-wheel-wrap">
      <div className="rem-wheel-label">{label}</div>
      <div className="rem-wheel" ref={box} onScroll={onScroll}
        role="listbox" aria-label={label} tabIndex={-1}>
        <div className="rem-pad" aria-hidden="true" />
        {values.map((v) => (
          <button type="button" key={v} className="rem-cell"
            role="option" aria-selected={v === value}
            data-on={v === value ? "1" : undefined}
            onClick={() => { mine.current = v; onChange(v); centre(v, true); }}>
            {pick(v)}
          </button>
        ))}
        <div className="rem-pad" aria-hidden="true" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function JobReminders({ jobId, tenantId, jobRef, jobType, scheduledDate, profile, names }) {
  const [list, setList] = useState([]);
  // What this workspace has learned about chasing jobs of this kind. Asked
  // once, and only used to OFFER - see the block further down.
  const [hint, setHint] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Opens on an hour from now, which is both the commonest answer and never a
  // time that cannot be saved.
  const [start] = useState(() => soon());
  const [day, setDay] = useState(() => dateKey(start));
  const [hh, setHH] = useState(() => start.getHours());
  const [mm, setMM] = useState(() => start.getMinutes());
  const [note, setNote] = useState("");
  const [typed, setTyped] = useState(() => `${pad(start.getHours())}:${pad(start.getMinutes())}`);
  const fromTyping = useRef(false);

  const load = async () => {
    const { data } = await supabase.from("job_reminders")
      .select("id, user_id, due_at, note, sent_at, acked_at, last_error")
      .eq("job_id", jobId)
      .order("due_at");
    setList(data ?? []);
  };

  useEffect(() => { load(); }, [jobId]);

  // Jobs like this one: how many got chased, and how far ahead. Derived from
  // the reminders the workspace has already set, so it costs nothing to keep
  // up to date and cannot disagree with them.
  useEffect(() => {
    let stop = false;
    (async () => {
      const { data, error } = await supabase.rpc("reminder_hint", { p_type: jobType ?? "" });
      if (stop || error) return;
      setHint(Array.isArray(data) ? data[0] ?? null : data ?? null);
    })();
    return () => { stop = true; };
  }, [jobType]);

  // Asking again when the tab is returned to, and on a slow clock while it is
  // being looked at. Two jobs at once: a reminder a colleague set on another
  // device appears, and "in 20 minutes" stops saying 20 minutes an hour later.
  useRefreshOnReturn(load, 60_000);

  // The wheel moved, or a preset did: keep the typed field showing the same
  // time. Skipped when the numbers came FROM the typed field, so a half-typed
  // "9:3" is not rewritten under the cursor.
  useEffect(() => {
    if (fromTyping.current) { fromTyping.current = false; return; }
    setTyped(`${pad(hh)}:${pad(mm)}`);
  }, [hh, mm]);

  const onTyped = (s) => {
    setTyped(s);
    const t = readTime(s);
    if (!t) return;
    // If the numbers are not actually changing, the effect below will not run,
    // and a flag left raised would make the NEXT wheel movement look like
    // typing - so it is only raised when there is something to move.
    if (t[0] === hh && t[1] === mm) return;
    fromTyping.current = true;
    setHH(t[0]);
    setMM(t[1]);
  };

  // Leaving the field tidies whatever was left in it, rather than holding on to
  // something unparseable that disagrees with the wheel.
  const tidy = () => setTyped(`${pad(hh)}:${pad(mm)}`);

  const preset = (d, h, m) => { setDay(d); setHH(h); setMM(m); setErr(""); };
  const at = (d) => preset(dateKey(d), d.getHours(), d.getMinutes());

  // Opening it fresh re-reads the clock. Without this, a card left open since
  // this morning offers a default from this morning.
  const toggle = () => {
    setErr("");
    if (open) { setOpen(false); return; }
    at(soon());
    setOpen(true);
  };

  const due = instant(day, hh, mm);
  const past = due <= new Date();

  // The instant the hint points at for THIS job: its scheduled day, less the
  // lead the workspace usually leaves, at the hour it usually picks. Null when
  // the job has no date to count back from, or when that moment has gone -
  // offering a time in the past is worse than offering nothing.
  const suggestedAt = (() => {
    if (!hint?.suggest || !scheduledDate) return null;
    const when = instant(shiftKey(scheduledDate, -Number(hint.lead_days || 0)),
                         Number(hint.at_hour || 8), 0);
    return when > new Date() ? when : null;
  })();

  const takeSuggestion = async () => {
    if (!suggestedAt) return;
    setBusy(true);
    try {
      const { error } = await supabase.from("job_reminders").insert({
        tenant_id: tenantId, job_id: jobId,
        user_id: profile.id, created_by: profile.id,
        due_at: suggestedAt.toISOString(),
        note: null,
        // Kept apart from one somebody typed out, so the console can tell an
        // offer that was taken from a decision made from scratch - and so a
        // suggestion accepted does not look like independent evidence for
        // making the same suggestion again.
        source: "suggested",
      });
      if (error) { setErr(error.message); return; }
      await load();
    } finally { setBusy(false); }
  };

  const save = async () => {
    setErr("");
    if (past) { setErr("That time has already gone. Pick a later one."); return; }
    setBusy(true);
    try {
      const { error } = await supabase.from("job_reminders").insert({
        tenant_id: tenantId,
        job_id: jobId,
        user_id: profile.id,
        created_by: profile.id,
        due_at: due.toISOString(),
        note: note.trim() || null,
      });
      if (error) { setErr(error.message); return; }
      setNote("");
      setOpen(false);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const ack = async (id) => {
    setBusy(true);
    try {
      await supabase.from("job_reminders")
        .update({ acked_at: new Date().toISOString() }).eq("id", id);
      await load();
    } finally { setBusy(false); }
  };

  const drop = async (id) => {
    setBusy(true);
    try {
      await supabase.from("job_reminders").delete().eq("id", id);
      await load();
    } finally { setBusy(false); }
  };

  const now = new Date();
  const waiting = list.filter((r) => !r.acked_at);
  const settled = list.filter((r) => r.acked_at);

  return (
    <div className="no-print rem">
      <div className="row">
        <h2 style={{ margin: 0 }}>
          Reminders{waiting.length ? ` (${waiting.length})` : ""}
        </h2>
        <button className="btn btn-ghost rem-add" onClick={toggle}>
          {open ? "Cancel" : "⏰ Remind me"}
        </button>
      </div>

      {open && (
        <div className="card rem-set">
          <div className="rem-chips">
            <button type="button" className="rem-chip" onClick={() => at(soon())}>In an hour</button>
            <button type="button" className="rem-chip"
              onClick={() => preset(shiftKey(dateKey(), 1), 8, 0)}>Tomorrow 08:00</button>
            <button type="button" className="rem-chip"
              onClick={() => preset(dateKey(), 17, 0)}>Today 17:00</button>
            <button type="button" className="rem-chip"
              onClick={() => preset(nextWeekday(1), 8, 0)}>Monday 08:00</button>
          </div>

          <label className="rem-label" htmlFor="rem-day">Day</label>
          <input id="rem-day" type="date" value={day}
            min={dateKey()}
            onChange={(e) => { setDay(e.target.value || dateKey()); setErr(""); }} />

          <label className="rem-label" htmlFor="rem-time">Time</label>
          <div className="rem-time">
            <input id="rem-time" type="text" inputMode="numeric" autoComplete="off"
              className="rem-typed" value={typed} aria-label="Time, typed"
              onChange={(e) => onTyped(e.target.value)} onBlur={tidy} />
            <span className="muted rem-or">or scroll</span>
            <div className="rem-wheels">
              <Wheel values={HOURS} value={hh} onChange={(v) => { setHH(v); setErr(""); }}
                label="Hour" pick={pad} />
              <div className="rem-colon" aria-hidden="true">:</div>
              <Wheel values={MINUTES} value={mm} onChange={(v) => { setMM(v); setErr(""); }}
                label="Minute" pick={pad} />
            </div>
          </div>

          <label className="rem-label" htmlFor="rem-note">What for (optional)</label>
          <input id="rem-note" type="text" value={note} maxLength={500}
            placeholder="Chase Blank Projects for the collection address"
            onChange={(e) => setNote(e.target.value)} />

          {/* The whole point of this block: read the instant back before saving. */}
          <div className={`rem-says${past ? " bad" : ""}`}>
            {past
              ? `${spell(due)} has already gone.`
              : `${spell(due)} — ${away(due, now)}.`}
          </div>
          <div className="muted rem-who">Only you will be told.</div>

          {err && <div className="rem-err">{err}</div>}

          <button className="btn btn-primary" disabled={busy || past} onClick={save}>
            {busy ? "Saving…" : "Set reminder"}
          </button>
        </div>
      )}

      {/* What the workspace does with jobs like this one.
          Offered, never set. An app that books its own notifications is one
          people turn off, and the moment that happens the reminders somebody
          DID ask for stop arriving too. */}
      {!open && !waiting.length && hint?.suggest && suggestedAt && (
        <div className="card rem-learned">
          <div className="rem-learned-say">
            Jobs of this kind usually get a reminder — {hint.reminded} of the last {hint.jobs}.
          </div>
          <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
            Usually {hint.lead_days === 0 ? "on the day" : hint.lead_days === 1
              ? "the day before" : `${hint.lead_days} days before`}, around {pad(hint.at_hour)}:00.
          </div>
          <button className="btn btn-ghost rem-take" disabled={busy}
            onClick={takeSuggestion}>
            Set it for {spell(suggestedAt)}
          </button>
        </div>
      )}

      {!waiting.length && !open && (
        <div className="muted" style={{ marginBottom: 12 }}>
          Nothing set for {jobRef}.
        </div>
      )}

      {waiting.map((r) => {
        const at = new Date(r.due_at);
        const ripe = at <= now;
        const mineToo = r.user_id === profile.id;
        return (
          <div key={r.id} className={`card rem-row${ripe ? " ripe" : ""}`}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="rem-when">
                {spell(at)}
                <span className="muted rem-away"> · {ripe ? "due now" : away(at, now)}</span>
              </div>
              {r.note && <div className="rem-note">{r.note}</div>}
              <div className="muted rem-for">
                {mineToo ? "yours" : `for ${names?.[r.user_id] ?? "a colleague"}`}
                {r.last_error && mineToo ? ` · ${r.last_error}` : ""}
              </div>
            </div>
            <div className="rem-acts">
              {ripe && mineToo && (
                <button className="rem-chip" disabled={busy} onClick={() => ack(r.id)}>Done</button>
              )}
              <button className="rem-x" aria-label="Delete reminder"
                disabled={busy} onClick={() => drop(r.id)}>×</button>
            </div>
          </div>
        );
      })}

      {settled.length > 0 && (
        <details className="rem-past">
          <summary className="muted">{settled.length} already dealt with</summary>
          {settled.map((r) => (
            <div key={r.id} className="muted rem-done">
              {spell(new Date(r.due_at))}{r.note ? ` · ${r.note}` : ""}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
