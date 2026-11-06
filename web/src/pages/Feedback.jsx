import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

// The moderation queue for what people leave on the landing page.
//
// WHY THIS SCREEN EXISTS AT ALL
//
// Everything that arrives through the landing page's box is invisible until
// somebody reads it. Without a screen, "somebody reads it" means opening the
// Supabase SQL editor and running a select, which is a thing that happens
// twice and then never again - and feedback nobody reads is worse than no box
// at all, because a stranger took the trouble to write it.
//
// WHO SEES IT
//
// Only accounts in site_admins (sql/65). That is not the same as being an ops
// manager: a customer's ops manager runs their own workspace and has no
// business reading what other companies said about the product, nor deciding
// what appears on the front page. The check is enforced in the database; this
// screen only decides whether to bother rendering.
//
// WHY THERE IS NOBODY'S NAME ON ANY OF THIS
//
// The landing page box asks for nothing but the words, so there is nothing
// here to attribute, reply to, or look up. That is the point: it is what makes
// people willing to write "the invoicing is a mess", and it is what lets any
// note go on the page without asking anybody first. If a note needs a reply,
// it cannot have one - which is the trade.

const fmt = (ts) => {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" });
};

// The same ten lines as the one on the landing page, deliberately copied
// rather than shared. It is presentation with no logic in it, and a shared
// component would have to live somewhere both pages can reach - a decision
// about this repository's layout that a star drawing does not earn.
function Stars({ value, size = 15 }) {
  const pct = Math.max(0, Math.min(100, (Number(value) / 5) * 100));
  return (
    <span className="lp-stars-out" style={{ fontSize: size }}
          role="img" aria-label={`${value} out of 5`}>
      <span className="lp-stars-bg" aria-hidden="true">★★★★★</span>
      <span className="lp-stars-fg" aria-hidden="true" style={{ width: `${pct}%` }}>★★★★★</span>
    </span>
  );
}

export default function Feedback() {
  const [admin, setAdmin] = useState(null);     // null = still checking
  const [rows, setRows] = useState([]);
  const [score, setScore] = useState(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const load = async () => {
    const { data, error } = await supabase.rpc("site_feedback_all", { p_limit: 200 });
    if (error) { setErr(error.message); return; }
    setErr("");
    setRows(Array.isArray(data) ? data : []);
    // The score comes from the database rather than from averaging the rows
    // above, so that this screen shows the same number the public page does
    // even once there are more than 200 reviews.
    const { data: s } = await supabase.rpc("public_rating");
    if (s) setScore(s);
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await supabase.rpc("is_site_admin");
      if (!alive) return;
      if (error || !data) { setAdmin(false); return; }
      setAdmin(true);
      await load();
    })();
    return () => { alive = false; };
  }, []);

  const publish = async (id, on) => {
    setBusy(id); setErr("");
    const { error } = await supabase.rpc("set_feedback_published", { p_id: id, p_publish: on });
    if (error) setErr(error.message); else await load();
    setBusy("");
  };

  const remove = async (id) => {
    if (!window.confirm("Delete this note? It cannot be undone, and there is no way to ask for it again.")) return;
    setBusy(id); setErr("");
    const { error } = await supabase.rpc("delete_feedback", { p_id: id });
    if (error) setErr(error.message); else await load();
    setBusy("");
  };

  if (admin === null) return <div className="page"><p className="muted">One moment…</p></div>;
  if (admin === false)
    return (
      <div className="page">
        <h1>Feedback</h1>
        <p className="muted">This is the site owner's inbox. Your account isn't on it.</p>
      </div>
    );

  const withWords = rows.filter((r) => r.message);
  const waiting = withWords.filter((r) => !r.approved_at);
  const live = withWords.filter((r) => r.approved_at);
  const bare = rows.filter((r) => !r.message);

  const avg = score && Number(score.count) > 0 ? Number(score.average) : null;

  // The spread matters more than the average when there are few reviews: four
  // fives and a one is a different thing from five fours, and they average the
  // same. Counted from the rows on this screen, which is every review until
  // there are more than 200 of them.
  const spread = [5, 4, 3, 2, 1].map((n) => [n, rows.filter((r) => r.rating === n).length]);

  return (
    <div className="page">
      <h1>Feedback</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Everything left on the landing page, anonymously. Every rating counts towards
        the score whether or not you show it; comments are public only once you put
        them there.
      </p>

      {err && <div className="card" style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>{err}</div>}

      {avg !== null && (
        <div className="card">
          {/* .row spreads its children apart, which leaves the number marooned
              in the middle of the card away from the stars it belongs to. */}
          <div className="row" style={{ alignItems: "center", gap: 10, flexWrap: "wrap",
                                        justifyContent: "flex-start" }}>
            <Stars value={avg} size={22} />
            <b style={{ fontSize: 20 }}>{avg.toFixed(1)}</b>
            <span className="muted">
              out of 5 · {score.count} {Number(score.count) === 1 ? "rating" : "ratings"}
              {Number(score.count) < 5 && " · the page shows nothing until there are five"}
            </span>
          </div>
          <div style={{ marginTop: 12, display: "grid", gap: 4 }}>
            {spread.map(([n, c]) => (
              <div key={n} className="row" style={{ alignItems: "center", gap: 8 }}>
                <span className="muted" style={{ fontSize: 12.5, width: 42, flex: "none" }}>{n} star</span>
                <span style={{ flex: 1, height: 7, background: "var(--line)", borderRadius: 4, minWidth: 40 }}>
                  <span style={{ display: "block", height: "100%", borderRadius: 4,
                    background: "var(--accent)",
                    width: `${rows.length ? (c / rows.length) * 100 : 0}%` }} />
                </span>
                <span className="muted" style={{ fontSize: 12.5, width: 24, textAlign: "right", flex: "none" }}>{c}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {rows.length === 0 && <div className="card"><span className="muted">Nothing yet.</span></div>}

      {waiting.length > 0 && (
        <>
          <h2>Comments waiting on you · {waiting.length}</h2>
          {waiting.map((r) => (
            <Note key={r.id} r={r} busy={busy === r.id} onPublish={publish} onDelete={remove} />
          ))}
        </>
      )}

      {live.length > 0 && (
        <>
          <h2>On the landing page · {live.length}</h2>
          {live.map((r) => (
            <Note key={r.id} r={r} busy={busy === r.id} onPublish={publish} onDelete={remove} />
          ))}
        </>
      )}

      {bare.length > 0 && (
        <>
          {/* Nothing to approve and nothing to read, so they get a line each
              rather than a card. The only thing worth doing to one is deleting
              it, and the only reason to do that is that it was a bot. */}
          <h2>Ratings with no comment · {bare.length}</h2>
          <div className="card" style={{ display: "grid", gap: 2 }}>
            {bare.map((r) => (
              <div className="row" key={r.id}
                   style={{ alignItems: "center", gap: 10, justifyContent: "space-between",
                            padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
                <Stars value={r.rating} size={14} />
                <span className="muted" style={{ fontSize: 12.5, flex: 1 }}>{fmt(r.created_at)}</span>
                <button className="btn btn-ghost" disabled={busy === r.id}
                        style={{ marginTop: 0, marginBottom: 0, width: "auto", flex: "0 0 auto",
                                 minHeight: 34, padding: "6px 12px", fontSize: 13,
                                 color: "var(--accent)" }}
                        onClick={() => remove(r.id)}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Note({ r, busy, onPublish, onDelete }) {
  const shown = !!r.approved_at;
  return (
    <div className="card">
      <div className="row" style={{ alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span className="row" style={{ alignItems: "center", gap: 9, minWidth: 0 }}>
          <Stars value={r.rating} size={15} />
          <span className="muted" style={{ fontSize: 12.5 }}>{fmt(r.created_at)}</span>
        </span>
        <span className={`stamp ${shown ? "done" : "pending"}`} style={{ flex: "none" }}>
          {shown ? "ON THE PAGE" : "NOT SHOWN"}
        </span>
      </div>

      <p style={{ margin: "8px 0 0", lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {r.message}
      </p>

      {/* .btn is width:100% everywhere else in the app, which is right on a
          form and wrong here - two actions on one note would each take a line
          of their own. They size to their text and wrap together on a phone. */}
      <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
        <button className={`btn ${shown ? "btn-ghost" : "btn-primary"}`} disabled={busy}
                style={{ marginTop: 0, marginBottom: 0, width: "auto", flex: "0 0 auto" }}
                onClick={() => onPublish(r.id, !shown)}>
          {busy ? "…" : shown ? "Take it off the page" : "Put it on the page"}
        </button>
        <button className="btn btn-ghost" disabled={busy}
                style={{ marginTop: 0, marginBottom: 0, width: "auto", flex: "0 0 auto",
                         color: "var(--accent)" }}
                onClick={() => onDelete(r.id)}>
          Delete
        </button>
      </div>
    </div>
  );
}
