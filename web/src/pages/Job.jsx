import React, { useContext, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase, FUNCTIONS_URL } from "../lib/supabase";
import { JobStamp } from "./Today";
import { Ctx } from "../main";

const ITEM_STAMP = {
  expected: ["pending", "EXPECTED"], collected: ["live", "COLLECTED"],
  packed: ["live", "PACKED"], in_storage: ["live", "IN STORAGE"],
  in_transit: ["live", "IN TRANSIT"], delivered: ["done", "DELIVERED"],
  exception: ["bad", "EXCEPTION"],
};

const TAGS = ["collected", "packed", "loaded", "delivered"];

export function ItemStamp({ status }) {
  const [cls, label] = ITEM_STAMP[status] ?? ["pending", status];
  return <span className={`stamp ${cls}`}>{label}</span>;
}

export default function Job() {
  const { id } = useParams();
  const { session, profile } = useContext(Ctx);
  const nav = useNavigate();
  const [job, setJob] = useState(null);
  const [items, setItems] = useState([]);
  const [thumbs, setThumbs] = useState({});
  const [events, setEvents] = useState([]);
  const [names, setNames] = useState({});
  const [loggingEventItemId, setLoggingEventItemId] = useState(null);
  const [busy, setBusy] = useState(false);

  const photoCount = (itemId) => events.filter((e) => e.item_id === itemId && e.photo_path).length;

  const load = async () => {
    const { data: j } = await supabase.from("jobs").select("*").eq("id", id).single();
    const { data: it } = await supabase.from("line_items").select("*").eq("job_id", id).order("created_at");
    const { data: ev } = await supabase.from("custody_events").select("*").eq("job_id", id).order("taken_at");
    const { data: ppl } = await supabase.from("profiles").select("id, full_name");
    setJob(j); setItems(it ?? []); setEvents(ev ?? []);
    setNames(Object.fromEntries((ppl ?? []).map((p) => [p.id, p.full_name || "team member"])));
    const paths = (it ?? []).filter((x) => x.anchor_image_path);
    if (paths.length) {
      const { data } = await supabase.storage.from("photos")
        .createSignedUrls(paths.map((x) => x.anchor_image_path), 3600);
      const map = {};
      paths.forEach((x, i) => { map[x.id] = data?.[i]?.signedUrl; });
      setThumbs(map);
    }
  };

  const mark = async (s, msg) => {
    const { error } = await supabase.from("jobs").update({ status: s }).eq("id", id);
    if (!error) { load(); }
  };

  const logEvent = async (itemId, type) => {
    setBusy(true);
    try {
      const { data: { session: s } } = await supabase.auth.getSession();
      const res = await fetch(`${FUNCTIONS_URL}/log-event`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${s.access_token}` },
        body: JSON.stringify({ job_id: id, item_id: itemId, type }),
      });
      const out = await res.json();
      if (out.error) { window.alert("Could not log event: " + out.error); return; }
      await load();
      setLoggingEventItemId(null);
      window.dispatchEvent(new Event("queue-updated"));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { load(); sessionStorage.setItem("oneshot_app", "1"); }, [id]);

  useEffect(() => {
    let timeout;
    const handleQueueUpdate = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => load(), 500);
    };
    window.addEventListener("queue-updated", handleQueueUpdate);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener("queue-updated", handleQueueUpdate);
    };
  }, []);

  if (!job) return <div className="page empty">Loading job…</div>;
  const accepted = job.status !== "pending_confirmation" && job.status !== "cancelled";
  const started = job.status === "in_progress";

  return (
    <div className="page">
      <Link className="muted" style={{ marginBottom: 10 }} to="/">← Today</Link>
      <div className="row">
        <span className="ref" style={{ fontSize: 18 }}>{job.ref}</span>
        <div style={{ display: "flex", gap: 8 }}>
          {job.status !== "cancelled" && (
            <button className="btn btn-ghost" style={{ marginTop: 0, padding: "4px 8px" }}
              onClick={() => nav(`/edit/${id}`)}>
              ✎ Edit
            </button>
          )}
          <JobStamp status={job.status} />
        </div>
      </div>

      <div className="card">
        <div className="row">
          <span className="muted">Booked for</span>
          <span style={{ fontWeight: 600 }}>{job.scheduled_date ? new Date(job.scheduled_date).toLocaleDateString("en-ZA") : "unscheduled"}</span>
        </div>
        {job.accepted_by && (
          <div className="row" style={{ marginTop: 4 }}>
            <span className="muted">Accepted</span>
            <span style={{ fontWeight: 600 }}>{names[job.accepted_by] ?? "crew"} · {new Date(job.accepted_at).toLocaleDateString()}</span>
          </div>
        )}
        {job.started_at && (
          <div className="row" style={{ marginTop: 4 }}>
            <span className="muted">Started</span>
            <span style={{ fontWeight: 600 }}>{new Date(job.started_at).toLocaleDateString()}</span>
          </div>
        )}
        <div className="row" style={{ marginTop: 4 }}>
          <span className="muted">Photos logged</span>
          <span style={{ fontWeight: 600 }}>{events.filter((e) => e.photo_path).length}</span>
        </div>
      </div>

      <div className="card">
        {job.origin && (
          <div className="muted" style={{ marginBottom: 6 }}>
            <strong>From:</strong> {job.origin.address}{job.origin.contact_name && ` · ${job.origin.contact_name}`}
          </div>
        )}
        {job.destination && (
          <div className="muted" style={{ marginBottom: 6 }}>
            <strong>To:</strong> {job.destination.address}{job.destination.contact_name && ` · ${job.destination.contact_name}`}
          </div>
        )}
        {job.origin?.contact_name && (
          <div className="muted" style={{ marginTop: 6 }}>
            Delivery contact: {job.destination.contact_name}{" "}
            {job.destination.contact_phone && <a href={`tel:${job.destination.contact_phone}`}>{job.destination.contact_phone}</a>}
          </div>
        )}
        {job.origin?.contact_name && (
          <div className="muted" style={{ marginTop: 6 }}>
            Contact: {job.origin.contact_name}{" "}
            {job.origin.contact_phone && <a href={`tel:${job.origin.contact_phone}`}>{job.origin.contact_phone}</a>}
          </div>
        )}
        <div className="muted" style={{ marginTop: 6 }}>
          {job.scheduled_date ?? "unscheduled"}{job.time_window ? ` · ${job.time_window}` : ""}{job.hard_deadline ? " · HARD DEADLINE" : ""}
        </div>
      </div>

      <h2>Items ({items.length})</h2>
      {items.map((it) => (
        <div key={it.id}>
          <Link className="card" to={`/i/${it.id}`}>
            <div className="row">
              <div className="row" style={{ justifyContent: "flex-start" }}>
                {thumbs[it.id]
                  ? <img className="thumb" src={thumbs[it.id]} alt="" />
                  : <div className="thumb" aria-hidden="true" />}
                <div>
                  <div style={{ fontWeight: 600 }}>{it.description}</div>
                  <div className="muted">
                    {it.attributes?.needs_details && <span style={{ color: "var(--warn)" }}>⚠ needs details · </span>}
                    Tier {it.identity_tier} · {photoCount(it.id) > 0
                      ? `📷 ${photoCount(it.id)} photo${photoCount(it.id) > 1 ? "s" : ""}`
                      : "no photos yet"}
                  </div>
                </div>
              </div>
              <ItemStamp status={it.status} />
            </div>
          </Link>
          {started && loggingEventItemId === it.id && (
            <div style={{ padding: 8, background: "var(--card)", borderRadius: 6, marginBottom: 8 }}>
              <div style={{ marginBottom: 8, fontWeight: 600 }}>Log event:</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                {TAGS.map((tag) => (
                  <button
                    key={tag}
                    className="btn btn-ghost"
                    style={{ marginTop: 0, textTransform: "capitalize" }}
                    onClick={() => logEvent(it.id, tag)}
                    disabled={busy}>
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          )}
          {started && (
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              <button className="btn btn-accent" style={{ flex: 1 }} onClick={() => nav(`/job/${id}/shoot`)}>
                📷 Shoot
              </button>
              <button className="btn btn-ghost" style={{ flex: 1 }}
                onClick={() => setLoggingEventItemId(loggingEventItemId === it.id ? null : it.id)}>
                📝 Log event
              </button>
            </div>
          )}
        </div>
      ))}

      {!started && job.status !== "cancelled" && (
        <>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className={accepted ? "btn btn-ghost" : "btn btn-primary"}
              style={{ flex: 1, marginTop: 0 }} disabled={accepted}
              onClick={() => mark("accepted", "Job acknowledged by crew")}>
              {accepted ? "✓ Accepted" : "Accept"}
            </button>
            <button className="btn btn-accent" style={{ flex: 1, marginTop: 0 }} disabled={!accepted}
              onClick={() => mark("in_progress", "Job started by crew")}>
              ▶ Start job
            </button>
          </div>
          <p className="muted" style={{ textAlign: "center", marginTop: 8 }}>
            Accept = job acknowledged. Start = work has begun; logging unlocks.
          </p>
        </>
      )}
    </div>
  );
}
