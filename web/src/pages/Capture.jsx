import React, { useContext, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { enqueue } from "../lib/queue";
import { Ctx } from "../main";

const SUGGEST = {
  expected: "collected", collected: "packed", packed: "loaded",
  in_storage: "loaded", in_transit: "delivered",
};
const TAGS = [
  ["collected", "Collected"], ["packed", "Packed"],
  ["loaded", "Loaded"], ["delivered", "Delivered"],
];
const EXCEPTIONS = ["Item not here", "Damaged", "Wrong item", "Access refused", "Other"];

export default function Capture() {
  const { id: jobId } = useParams();
  const nav = useNavigate();
  const { session, profile } = useContext(Ctx);
  const fileRef = useRef();
  const gpsRef = useRef({ lat: null, lng: null, acc: null });
  const [items, setItems] = useState([]);
  const [photo, setPhoto] = useState(null);
  const [selected, setSelected] = useState(null);
  const [exceptionMode, setExceptionMode] = useState(false);

  // Capture GPS on mount
  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (p) => {
          gpsRef.current = {
            lat: p.coords.latitude,
            lng: p.coords.longitude,
            acc: p.coords.accuracy,
          };
        },
        () => {
          gpsRef.current = { lat: null, lng: null, acc: null };
        }
      );
    }
  }, []);

  useEffect(() => {
    supabase.from("line_items").select("*").eq("job_id", jobId).order("created_at")
      .then(({ data }) => setItems(data ?? []));
    setTimeout(() => fileRef.current?.click(), 250);
  }, [jobId]);

  const onShot = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    
    // Update GPS if available
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (p) => {
          gpsRef.current = {
            lat: p.coords.latitude,
            lng: p.coords.longitude,
            acc: p.coords.accuracy,
          };
        },
        () => {}
      );
    }
    
    setPhoto({ blob: f, url: URL.createObjectURL(f), takenAt: new Date().toISOString() });
  };

  const commit = async (item, type, notes = null) => {
    try {
      await enqueue({
        tenant_id: profile.tenant_id,
        item_id: item?.id ?? null,
        job_id: jobId,
        type,
        photoBlob: photo?.blob ?? null,
        lat: gpsRef.current.lat,
        lng: gpsRef.current.lng,
        gps_accuracy: gpsRef.current.acc,
        taken_at: photo?.takenAt ?? new Date().toISOString(),
        user_id: session.user.id,
        match_method: "manual_tap",
        notes,
        isAnchor: item && !item.anchor_image_path,
      });
      nav(`/job/${jobId}`);
    } catch (err) {
      console.error("Enqueue error:", err);
      window.alert("Failed to queue event: " + err.message);
    }
  };

  const open = items.filter((i) => !["delivered", "exception"].includes(i.status));

  return (
    <div className="page">
      <input ref={fileRef} type="file" accept="image/*" capture="environment"
        style={{ display: "none" }} onChange={onShot} />

      {!photo && (
        <div className="empty">
          <p>Camera opening…</p>
          <button className="btn btn-accent" style={{ marginTop: 16 }} onClick={() => fileRef.current?.click()}>
            📷 Open camera
          </button>
        </div>
      )}

      {photo && !selected && !exceptionMode && (
        <>
          <img src={photo.url} alt="Captured item"
            style={{ width: "100%", borderRadius: 10, marginBottom: 14, maxHeight: "38vh", objectFit: "cover" }} />
          <h2>Which item is this?</h2>
          {open.map((it) => (
            <button className="card" key={it.id} onClick={() => setSelected(it)}>
              <div className="row">
                <span style={{ fontWeight: 600 }}>{it.description}</span>
                <span className="muted">{it.status.replace("_", " ")}</span>
              </div>
            </button>
          ))}
          <button className="btn btn-ghost" onClick={async () => {
            const { data, error } = await supabase.from("line_items").insert({
              tenant_id: profile.tenant_id, job_id: jobId,
              description: "Unlisted item — needs details",
              attributes: { needs_details: true },
            }).select().single();
            if (error) { window.alert("Adding the item needs signal — log it as an exception for now."); return; }
            setItems([...items, data]); setSelected(data);
          }}>
            ＋ New item — not on the list
          </button>
          <button className="btn btn-ghost" onClick={() => { setPhoto(null); fileRef.current?.click(); }}>
            Retake photo
          </button>
          <button className="btn btn-warn" onClick={() => setExceptionMode(true)}>⚠ Problem</button>
        </>
      )}

      {photo && selected && !exceptionMode && (() => {
        const suggested = SUGGEST[selected.status] ?? "collected";
        return (
          <>
            <img src={photo.url} alt="Captured item"
              style={{ width: "100%", borderRadius: 10, marginBottom: 12, maxHeight: "34vh", objectFit: "cover" }} />
            <div className="card">
              <div style={{ fontWeight: 700 }}>{selected.description}</div>
              <div className="muted" style={{ marginTop: 2 }}>Item selected · now tag why you shot it</div>
            </div>
            <h2>Tag this shot</h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
              {TAGS.map(([tag, label]) => (
                <button key={tag}
                  className={tag === suggested ? "btn btn-primary" : "btn btn-ghost"}
                  style={{ minHeight: 48, marginTop: 0 }}
                  onClick={() => commit(selected, tag)}>
                  {label}{tag === suggested ? " ✓" : ""}
                </button>
              ))}
            </div>
            <button className="btn btn-warn" style={{ marginTop: 0 }} onClick={() => setExceptionMode(true)}>
              ⚠ Problem
            </button>
            <button className="btn btn-ghost" onClick={() => setSelected(null)}>Back</button>
          </>
        );
      })()}

      {exceptionMode && (
        <>
          <h2>What's the problem?</h2>
          {EXCEPTIONS.map((r) => (
            <button className="card" key={r} style={{ color: "var(--warn)", fontWeight: 600 }}
              onClick={() => commit(selected, "exception", r)}>
              {r}
            </button>
          ))}
          <button className="btn btn-ghost" onClick={() => setExceptionMode(false)}>Back</button>
        </>
      )}
    </div>
  );
}
