import React, { useContext, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { JobStamp } from "./Today";
import { Ctx } from "../main";

const ITEM_STAMP = {
  expected: ["pending", "EXPECTED"], collected: ["live", "COLLECTED"],
  packed: ["live", "PACKED"], in_storage: ["live", "IN STORAGE"],
  in_transit: ["live", "IN TRANSIT"], delivered: ["done", "DELIVERED"],
  exception: ["bad", "EXCEPTION"],
};

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
  useEffect(() => { load(); }, [id]);

  if (!job) return <div className="empty">Loading job…</div>;
  const allDone = items.length > 0 && items.every((i) => ["delivered", "in_storage", "exception"].includes(i.status));
  const started = ["in_progress", "completed", "closed"].includes(job.status);
  const accepted = job.status === "accepted" || started;

  const fmt = (t) => new Date(t).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const acceptEv = events.find((e) => e.type === "note" && e.notes?.includes("acknowledged"));
  const startEv = events.find((e) => e.type === "note" && e.notes?.includes("started"));
  const photoCount = (itemId) => events.filter((e) => e.item_id === itemId && e.photo_path).length;

  const mark = async (status, note) => {
    await supabase.from("jobs").update({ status, updated_at: new Date().toISOString() }).eq("id", id);
    await supabase.from("custody_events").insert({
      tenant_id: job.tenant_id, job_id: id, type: "note",
      taken_at: new Date().toISOString(), notes: note, user_id: session.user.id,
    });
    load();
  };

  const closeJob = async () => {
    await supabase.from("jobs").update({ status: "completed", updated_at: new Date().toISOString() }).eq("id", id);
    nav("/");
  };

  return (
    <div className="page">
      <div className="row">
        <span className="ref" style={{ fontSize: 18 }}>{job.ref}</span>
        <div className="row" style={{ gap: 8 }}>
          {profile.role === "ops" && !["completed", "closed", "cancelled"].includes(job.status) && (
            <button className="stamp pending" style={{ background: "none", cursor: "pointer", padding: "4px 9px" }}
              onClick={() => nav(`/job/${id}/edit`)}>✎ EDIT</button>
          )}
          <JobStamp status={job.status} />
        </div>
      </div>

      <h2>Status</h2>
      <div className="card">
        <div className="row"><span className="muted">Booked for</span>
          <span style={{ fontWeight: 600 }}>{job.scheduled_date ?? "unscheduled"}{job.time_window ? ` · ${job.time_window}` : ""}</span></div>
        <div className="row" style={{ marginTop: 6 }}><span className="muted">Accepted</span>
          <span style={{ fontWeight: 600 }}>{acceptEv ? `${names[acceptEv.user_id] ?? "crew"} · ${fmt(acceptEv.taken_at)}` : "not yet"}</span></div>
        <div className="row" style={{ marginTop: 6 }}><span className="muted">Started</span>
          <span style={{ fontWeight: 600 }}>{startEv ? `${names[startEv.user_id] ?? "crew"} · ${fmt(startEv.taken_at)}` : "not yet"}</span></div>
        <div className="row" style={{ marginTop: 6 }}><span className="muted">Photos logged</span>
          <span style={{ fontWeight: 600 }}>{events.filter((e) => e.photo_path).length}</span></div>
      </div>

      <h2>Route</h2>
      <div className="card">
        <div><b>From:</b> {job.origin?.label || job.origin?.address || "—"}</div>
        <div style={{ marginTop: 4 }}><b>To:</b> {job.destination?.label || job.destination?.address || "—"}</div>
        {job.destination?.contact_name && (
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
        <Link className="card" key={it.id} to={`/i/${it.id}`}>
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
            Accept = job acknowledged. Start = work has begun; shooting unlocks.
          </p>
        </>
      )}
      {started && (
        <button className="btn btn-accent" style={{ marginTop: 12 }} onClick={() => nav(`/job/${id}/shoot`)}>
          📷 Shoot item
        </button>
      )}
      <div className="quiet-actions">
        {profile.role === "ops" && !["completed", "closed", "cancelled"].includes(job.status) && (
          <button onClick={async () => {
            const url = `${window.location.origin}/claim/${job.id}/${job.claim_token}`;
            const text = `Delivery job ${job.ref} — accept it here: ${url}`;
            if (navigator.share) { try { await navigator.share({ title: `OneShot job ${job.ref}`, text, url }); } catch {} }
            else { await navigator.clipboard.writeText(url); window.alert("Claim link copied — send it to your driver"); }
          }}>🔗 Send this job — driver or your business</button>
        )}
        <button onClick={async () => {
          const url = `${window.location.origin}/j/${job.id}`;
          if (navigator.share) { try { await navigator.share({ title: `${job.ref} — OneShot job record`, url }); } catch {} }
          else { await navigator.clipboard.writeText(url); window.alert("Job record link copied"); }
        }}>↗ Share job record</button>
      </div>
      {allDone && (
        <button className="btn btn-primary" onClick={closeJob}>Close job</button>
      )}
    </div>
  );
}
