import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase, FUNCTIONS_URL } from "../lib/supabase";
import QRCode from "qrcode";

// Public: anyone with the link (the QR) sees this. UUID = capability token.
export default function Item() {
  const { id } = useParams();
  const nav = useNavigate();
  // Crew navigating from inside the app leave this flag; QR/direct visitors don't.
  const cameFromApp = sessionStorage.getItem("oneshot_app") === "1";
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rec, setRec] = useState(null);
  const [err, setErr] = useState(false);
  const [qr, setQr] = useState(null);

  const loadRecord = () =>
    fetch(`${FUNCTIONS_URL}/item-record?id=${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setRec).catch(() => setErr(true));

  useEffect(() => {
    loadRecord();
    QRCode.toDataURL(window.location.href, { margin: 1, width: 220 }).then(setQr);
    // If navigating from inside the app, get the current authenticated session
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
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
    } finally {
      setBusy(false);
    }
  };

  if (err) return <div className="empty">Item not found.</div>;
  if (!rec) return <div className="empty">Loading record…</div>;
  const last = rec.events?.[0];

  return (
    <div className="page">
      {cameFromApp && (
        <button className="muted no-print" style={{ background: "none", border: "none", cursor: "pointer", font: "inherit", padding: 0, marginBottom: 10 }}
          onClick={() => nav(-1)}>
          ← Back to job
        </button>
      )}
      <div className="wordmark" style={{ marginBottom: 14 }}>ONE<b>SHOT</b> · RECORD</div>
      <div className="print-only muted" style={{ marginBottom: 12 }}>
        Custody record snapshot · generated {new Date().toLocaleString()} · live record: {window.location.href}
      </div>
      {rec.anchor_image_url && (
        <img src={rec.anchor_image_url} alt={rec.description}
          style={{ width: "100%", borderRadius: 10, marginBottom: 12, maxHeight: "40vh", objectFit: "cover" }} />
      )}
      <h1 style={{ marginBottom: 4 }}>{rec.description}</h1>
      <div className="muted" style={{ marginBottom: 12 }}>
        {rec.jobs?.ref} · {rec.jobs?.type} · Tier {rec.identity_tier}
      </div>
      <span className={`stamp ${rec.status === "delivered" ? "done" : rec.status === "exception" ? "bad" : "live"}`}
        style={{ transform: "rotate(-2deg)", display: "inline-block", fontSize: 13, padding: "6px 12px" }}>
        {rec.status.replace("_", " ")}
      </span>

      {last && (
        <>
          <h2>Last seen</h2>
          <div className="card">
            <div style={{ fontWeight: 600 }}>{last.type.replace("_", " ")} · {new Date(last.taken_at).toLocaleString()}</div>
            {last.lat && (
              <a className="muted" href={`https://maps.google.com/?q=${last.lat},${last.lng}`}>
                📍 {last.lat.toFixed(5)}, {last.lng.toFixed(5)}
              </a>
            )}
          </div>
        </>
      )}

      <h2>Custody history</h2>
      {(rec.events ?? []).map((e, i) => (
        <div className="card" key={i}>
          <div className="row">
            <span style={{ fontWeight: 600, textTransform: "capitalize" }}>{e.type.replace("_", " ")}</span>
            <span className="muted">{new Date(e.taken_at).toLocaleString()}</span>
          </div>
          {e.notes && <div className="muted" style={{ marginTop: 4 }}>{e.notes}</div>}
          {e.photo_url && <img src={e.photo_url} alt="" style={{ width: "100%", borderRadius: 8, marginTop: 8 }} />}
          {e.photo_url && cameFromApp && (
            <button className="btn btn-warn no-print" disabled={busy}
              style={{ marginTop: 8 }}
              onClick={() => removePhoto(e.photo_path)}>
              🗑 Remove photo — wrong item
            </button>
          )}
        </div>
      ))}
      {(!rec.events || rec.events.length === 0) && <div className="muted">No custody events yet.</div>}

      {qr && (
        <>
          <h2>Share this record</h2>
          <div className="card" style={{ textAlign: "center" }}>
            <img src={qr} alt="QR code for this record" />
            <div className="muted" style={{ marginTop: 6 }}>Read-only evidence link — anyone can view, nobody can act on it.</div>
          </div>
          <button className="btn btn-primary" onClick={async () => {
            const url = window.location.href;
            const title = `${rec.description} — OneShot record`;
            if (navigator.share) {
              try { await navigator.share({ title, url }); } catch { /* user cancelled */ }
            } else {
              await navigator.clipboard.writeText(url);
              alert("Link copied");
            }
          }}>
            ↗ Share custody record
          </button>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <a className="btn btn-ghost" style={{ flex: 1, marginTop: 0, textDecoration: "none" }}
              href={`https://wa.me/?text=${encodeURIComponent(`${rec.description} — live record: ${window.location.href}`)}`}
              target="_blank" rel="noreferrer">WhatsApp</a>
            <a className="btn btn-ghost" style={{ flex: 1, marginTop: 0, textDecoration: "none" }}
              href={`mailto:?subject=${encodeURIComponent(`OneShot record: ${rec.description}`)}&body=${encodeURIComponent(`Live custody record: ${window.location.href}`)}`}>Email</a>
            <button className="btn btn-ghost" style={{ flex: 1, marginTop: 0 }} onClick={async () => {
              await navigator.clipboard.writeText(window.location.href);
            }}>Copy</button>
          </div>
          <button className="btn btn-ghost" onClick={() => window.print()}>
            ⬇ Download record (PDF snapshot)
          </button>
          <p className="muted no-print" style={{ marginTop: 8, textAlign: "center" }}>
            The link stays live and keeps growing; the download freezes this moment — photos included — for insurers, claims, and filing.
          </p>
        </>
      )}
    </div>
  );
}
