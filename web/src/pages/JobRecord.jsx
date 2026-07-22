import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { FUNCTIONS_URL } from "../lib/supabase";
import QRCode from "qrcode";

// Public: whole-job evidence record — the completed-job share.
export default function JobRecord() {
  const { jobId } = useParams();
  const [rec, setRec] = useState(null);
  const [err, setErr] = useState(false);
  const [qr, setQr] = useState(null);

  useEffect(() => {
    fetch(`${FUNCTIONS_URL}/job-record?id=${jobId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setRec).catch(() => setErr(true));
    QRCode.toDataURL(window.location.href, { margin: 1, width: 220 }).then(setQr);
  }, [jobId]);

  if (err) return <div className="empty">Job record not found.</div>;
  if (!rec) return <div className="empty">Loading record…</div>;

  const done = ["completed", "closed"].includes(rec.status);
  const itemName = (id) => rec.items.find((i) => i.id === id)?.description ?? "Job";

  return (
    <div className="page">
      <div className="wordmark" style={{ marginBottom: 14 }}>ONE<b>SHOT</b> · JOB RECORD</div>
      <div className="print-only muted" style={{ marginBottom: 12 }}>
        Job record snapshot · generated {new Date().toLocaleString()} · live record: {window.location.href}
      </div>

      <h1 style={{ marginBottom: 4 }}><span className="ref">{rec.ref}</span></h1>
      <div className="muted" style={{ marginBottom: 10 }}>
        {rec.tenants?.name} · {rec.type} · {rec.scheduled_date ?? "unscheduled"}{rec.time_window ? ` · ${rec.time_window}` : ""}
      </div>
      <span className={`stamp ${done ? "done" : rec.status === "cancelled" ? "bad" : "live"}`}
        style={{ transform: "rotate(-2deg)", display: "inline-block", fontSize: 12, padding: "5px 11px" }}>
        {rec.status.replace("_", " ")}
      </span>

      <h2>Route</h2>
      <div className="card">
        <div style={{ fontSize: 14 }}><b>From:</b> {rec.origin?.label || rec.origin?.address || "—"}</div>
        <div style={{ fontSize: 14, marginTop: 4 }}><b>To:</b> {rec.destination?.label || rec.destination?.address || "—"}</div>
      </div>

      <h2>Items ({rec.items.length})</h2>
      {rec.items.map((i) => (
        <Link className="card" key={i.id} to={`/i/${i.id}`} style={{ display: "block" }}>
          <div className="row">
            <div className="row" style={{ justifyContent: "flex-start" }}>
              {i.anchor_image_url
                ? <img className="thumb" src={i.anchor_image_url} alt="" />
                : <div className="thumb" aria-hidden="true" />}
              <div style={{ fontWeight: 600, fontSize: 14 }}>{i.description}</div>
            </div>
            <span className={`stamp ${i.status === "delivered" ? "done" : i.status === "exception" ? "bad" : "live"}`}>
              {i.status.replace("_", " ")}
            </span>
          </div>
        </Link>
      ))}

      <h2>Custody timeline</h2>
      {rec.events.map((e, ix) => (
        <div className="card" key={ix}>
          <div className="row">
            <span style={{ fontWeight: 600, fontSize: 14, textTransform: "capitalize" }}>
              {e.type.replace("_", " ")}{e.item_id ? ` — ${itemName(e.item_id)}` : ""}
            </span>
            <span className="muted">{new Date(e.taken_at).toLocaleString()}</span>
          </div>
          {e.notes && <div className="muted" style={{ marginTop: 4 }}>{e.notes}</div>}
          {e.lat && (
            <a className="muted" href={`https://maps.google.com/?q=${e.lat},${e.lng}`}>📍 {e.lat.toFixed(5)}, {e.lng.toFixed(5)}</a>
          )}
          {e.photo_url && <img src={e.photo_url} alt="" style={{ width: "100%", borderRadius: 8, marginTop: 8 }} />}
        </div>
      ))}
      {rec.events.length === 0 && <div className="muted">No custody events yet.</div>}

      <h2>Share this record</h2>
      <div className="card no-print" style={{ textAlign: "center" }}>
        {qr && <img src={qr} alt="QR code for this job record" />}
        <div className="muted" style={{ marginTop: 6 }}>Read-only evidence for the whole job — anyone can view, nobody can act on it.</div>
      </div>
      <button className="btn btn-primary" onClick={async () => {
        const url = window.location.href;
        if (navigator.share) { try { await navigator.share({ title: `${rec.ref} — OneShot job record`, url }); } catch {} }
        else { await navigator.clipboard.writeText(url); window.alert("Link copied"); }
      }}>↗ Share job record</button>
      <button className="btn btn-ghost" onClick={() => window.print()}>⬇ Download record (PDF snapshot)</button>
    </div>
  );
}
