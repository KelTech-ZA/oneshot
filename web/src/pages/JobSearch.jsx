import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";

// One box across everything a job is remembered by: its number, the client's
// own reference, who sent it, who received it, the places, and the items.
// Each result says WHY it matched, because a list of refs is unreadable.

export default function JobSearch() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setRows(null); setMsg(""); return; }

    // Typing is faster than the round trip; only the newest result may land.
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true);
      const { data, error } = await supabase.rpc("search_jobs", { q: term });
      if (mine !== seq.current) return;          // a later keystroke won
      setBusy(false);
      if (error) { setMsg("Search failed: " + error.message); setRows([]); return; }
      setMsg("");
      setRows(data ?? []);
    }, 220);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <>
      <h2>Search</h2>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Job number, reference, a name, a place, an item…"
        aria-label="Search jobs"
      />

      {msg && <div className="muted" style={{ color: "var(--warn)" }}>{msg}</div>}

      {rows !== null && (
        <div style={{ marginBottom: 14 }}>
          <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>
            {busy ? "Searching…"
              : rows.length ? `${rows.length} job${rows.length === 1 ? "" : "s"}`
              : "Nothing matched. Try a surname, a street, or part of a job number."}
          </div>

          {rows.map((r) => (
            <Link className="card" key={r.id} to={`/job/${r.id}`} style={{ display: "block" }}>
              <div className="row">
                <span className="ref">{r.ref}</span>
                <span className={`stamp ${r.last_event_alert ? "bad"
                  : r.last_event_label ? "live" : "pending"}`}>
                  {(r.last_event_label ?? r.status.replace(/_/g, " ")).toUpperCase()}
                </span>
              </div>
              {/* The reason it surfaced - "sender: Wendy Fisher" is what makes
                  a long list scannable. */}
              <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
                {r.matched_on}: <b style={{ color: "var(--ink)" }}>{r.matched_value}</b>
              </div>
              <div className="muted" style={{ fontSize: 13 }}>
                {r.scheduled_date ?? "unscheduled"}
                {r.time_window ? ` · ${r.time_window}` : ""}
                {r.client_ref && r.matched_on !== "client reference" ? ` · ${r.client_ref}` : ""}
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
