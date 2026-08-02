import React, { useContext, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase, FUNCTIONS_URL } from "../lib/supabase";
import { Ctx } from "../main";
import QRCode from "qrcode";

const TAGS = ["collected", "packed", "loaded", "delivered"];

export default function Item() {
  const { id } = useParams();
  const nav = useNavigate();
  const cameFromApp = sessionStorage.getItem("oneshot_app") === "1";
  const { session, profile } = useContext(Ctx);

  const [rec, setRec] = useState(null);
  const [err, setErr] = useState(false);
  const [qr, setQr] = useState(null);
  const [editingEventId, setEditingEventId] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadRecord = () =>
    fetch(`${FUNCTIONS_URL}/item-record?id=${id}&t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setRec).catch(() => setErr(true));

  useEffect(() => {
    loadRecord();
    QRCode.toDataURL(window.location.href, { margin: 1, width: 220 }).then(setQr);
    supabase.auth.getSession().then(({ data }) => {
      // Session is set for remove-photo auth
    });
  }, [id]);

  const removePhoto = async (photo_path) => {
    if (!window.confirm("Remove this photo from the record? This cannot be undone.")) return;
    setBusy(true);
    try {
      const { data: { session: s } } = await supabase.auth.getSession();
      const res = await fetch(`${FUNCTIONS_URL}/remove-photo`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${s.access_token}` },
        body: JSON.stringify({ photo_path }),
      });
      const out = await res.json();
      if (out.error) { window.alert("Could not remove photo: " + out.error); return; }
      await loadRecord();
      if (out.ok) {
        window.dispatchEvent(new Event("queue-updated"));
      }
    } finally {
      setBusy(false);
    }
  };

  const editEvent = async (eventId, newType) => {
    setBusy(true);
    try {
      const { data: { session: s } } = await supabase.auth.getSession();
      const res = await fetch(`${FUNCTIONS_URL}/edit-event`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${s.access_token}` },
        body: JSON.stringify({ event_id: eventId, new_type: newType }),
      });
      const out = await res.json();
      if (out.error) { window.alert("Could not edit event: " + out.error); return; }
      await loadRecord();
      setEditingEventId(null);
      window.dispatchEvent(new Event("queue-updated"));
    } finally {
      setBusy(false);
    }
  };

  if (err) return <div className="empty">Item not found.</div>;
  if (!rec) return <div className="empty">Loading record…</div>;

  const isOps = session && profile?.role === "ops";
  const jobClosed = rec.jobs?.status === "closed" || rec.jobs?.status === "completed";
  const showEditButton = cameFromApp && isOps && jobClosed;

  return (
    <div className="page">
      {cameFromApp && (
        <button className="muted no-print" style={{ background: "none", border: "none", cursor: "pointer", font: "inherit", padding: 0, marginBottom: 10 }}
          onClick={() => nav(-1)}>
          ← Back to job
        </button>
      )}
      <div className="wordmark" style={{ marginBottom: 14 }}>ONE<b>SHOT</b> · RECORD</div>
      <h1 style={{ marginTop: 0 }}>{rec.description}</h1>
      <div className="muted" style={{ marginBottom: 16 }}>{rec.jobs?.ref} · {rec.identity_tier ? `Tier ${rec.identity_tier}` : "Untiered"}</div>

      {rec.anchor_image_url && (
        <img src={rec.anchor_image_url} alt="" style={{ width: "100%", borderRadius: 10, marginBottom: 16, maxHeight: "50vh", objectFit: "cover" }} />
      )}

      <h2>Custody History</h2>
      {(!rec.events || rec.events.length === 0) ? (
        <p className="empty">No custody events yet.</p>
      ) : (
        rec.events.map((e) => (
          <div key={e.id} className="card" style={{ marginBottom: 12 }}>
            <div className="row">
              <span style={{ fontWeight: 600, textTransform: "capitalize" }}>{e.type}</span>
              <span className="muted" style={{ fontSize: 12 }}>{new Date(e.taken_at).toLocaleString()}</span>
            </div>
            {e.notes && <div className="muted" style={{ marginTop: 4 }}>{e.notes}</div>}
            {e.edited_at && (
              <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                Edited by {e.profiles?.full_name || "unknown"} · {new Date(e.edited_at).toLocaleString()}
              </div>
            )}
            {e.photo_url && <img src={e.photo_url} alt="" style={{ width: "100%", borderRadius: 8, marginTop: 8 }} />}
            {e.photo_url && cameFromApp && (
              <button className="btn btn-warn no-print" disabled={busy}
                style={{ marginTop: 8 }}
                onClick={() => removePhoto(e.photo_path)}>
                🗑 Remove photo — wrong item
              </button>
            )}
            {showEditButton && (
              <button className="btn btn-ghost no-print" disabled={busy}
                style={{ marginTop: 8 }}
                onClick={() => setEditingEventId(editingEventId === e.id ? null : e.id)}>
                ✎ Edit event
              </button>
            )}
            {editingEventId === e.id && showEditButton && (
              <div style={{ marginTop: 8, padding: 8, background: "var(--card)", borderRadius: 6 }}>
                <div style={{ marginBottom: 8, fontWeight: 600 }}>Change to:</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                  {TAGS.map((tag) => (
                    <button
                      key={tag}
                      className="btn btn-ghost"
                      style={{ marginTop: 0, textTransform: "capitalize" }}
                      onClick={() => editEvent(e.id, tag)}
                      disabled={busy}>
                      {tag}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))
      )}

      {qr && !cameFromApp && (
        <>
          <h2>Share This Record</h2>
          <div style={{ textAlign: "center", padding: 12, background: "var(--card)", borderRadius: 10, marginBottom: 16 }}>
            <img src={qr} alt="QR code" style={{ width: 200 }} />
            <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
              Read-only evidence link — anyone can view, nobody can act on it.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
