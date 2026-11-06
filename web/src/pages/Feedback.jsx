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
// WHAT CANNOT BE DONE HERE
//
// Publishing a note whose writer did not tick the consent box. The button is
// not drawn, and if it were, set_feedback_published refuses it.

const fmt = (ts) => {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" });
};

export default function Feedback() {
  const [admin, setAdmin] = useState(null);     // null = still checking
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const load = async () => {
    const { data, error } = await supabase.rpc("site_feedback_all", { p_limit: 200 });
    if (error) { setErr(error.message); return; }
    setErr("");
    setRows(Array.isArray(data) ? data : []);
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

  const remove = async (id, name) => {
    if (!window.confirm(`Delete the note from ${name}? This cannot be undone.`)) return;
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

  const waiting = rows.filter((r) => !r.approved_at);
  const live = rows.filter((r) => r.approved_at);

  return (
    <div className="page">
      <h1>Feedback</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Everything left on the landing page. Nothing here is public until you put it there,
        and only notes whose writer agreed can be shown at all.
      </p>

      {err && <div className="card" style={{ borderColor: "var(--accent)", color: "var(--accent)" }}>{err}</div>}

      {rows.length === 0 && <div className="card"><span className="muted">Nothing yet.</span></div>}

      {waiting.length > 0 && (
        <>
          <h2>Waiting on you · {waiting.length}</h2>
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
    </div>
  );
}

function Note({ r, busy, onPublish, onDelete }) {
  const shown = !!r.approved_at;
  return (
    <div className="card">
      <div className="row" style={{ alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <b>{r.name}</b>
          {r.company && <span className="muted"> · {r.company}</span>}
        </div>
        {/* Not "PRIVATE": that reads as something the writer asked for, and it
            would sit on a note that explicitly agreed to be shown as well as on
            one that refused. This says where the note is, and the line lower
            down says what they agreed to. */}
        <span className={`stamp ${shown ? "done" : "pending"}`} style={{ flex: "none" }}>
          {shown ? "ON THE PAGE" : "NOT SHOWN"}
        </span>
      </div>

      <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
        {fmt(r.created_at)}
        {r.email
          ? <> · <a href={`mailto:${r.email}`}>{r.email}</a></>
          : <> · no email, so no way to reply</>}
      </div>

      <p style={{ margin: "10px 0 0", lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {r.message}
      </p>

      {/* .btn is width:100% everywhere else in the app, which is right on a
          form and wrong here - two actions on one note would each take a line
          of their own. They size to their text and wrap together on a phone. */}
      <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
        {r.may_publish ? (
          <button className={`btn ${shown ? "btn-ghost" : "btn-primary"}`} disabled={busy}
                  style={{ marginTop: 0, marginBottom: 0, width: "auto", flex: "0 0 auto" }}
                  onClick={() => onPublish(r.id, !shown)}>
            {busy ? "…" : shown ? "Take it off the page" : "Put it on the page"}
          </button>
        ) : (
          // Not a disabled button: there is nothing to enable. They did not
          // agree, and the only way to change that is to ask them.
          <span className="muted" style={{ fontSize: 13, flex: "1 1 220px" }}>
            They didn't agree to be shown publicly{r.email ? " — ask them if you'd like to quote it" : ""}.
          </span>
        )}
        <button className="btn btn-ghost" disabled={busy}
                style={{ marginTop: 0, marginBottom: 0, width: "auto", flex: "0 0 auto",
                         color: "var(--accent)" }}
                onClick={() => onDelete(r.id, r.name)}>
          Delete
        </button>
      </div>
    </div>
  );
}
