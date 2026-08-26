import React, { useContext, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import ClashWarning from "./ClashWarning";
import ItemDocuments from "./ItemDocuments";
import JobStops, { KINDS, stopName } from "./JobStops";
import { Ctx } from "../main";

// Ops-only tap-to-edit fallback (spec 2.4): conversation is the front door,
// this is the back office. Every save is logged as an append-only amendment event.
export default function EditJob() {
  const { id } = useParams();
  const nav = useNavigate();
  const { session, profile } = useContext(Ctx);
  const [f, setF] = useState(null);
  const [items, setItems] = useState([]);
  const [newItem, setNewItem] = useState("");
  const [edits, setEdits] = useState({});
  const [uploading, setUploading] = useState(null);
  const [jobTypes, setJobTypes] = useState([]);
  const [photos, setPhotos] = useState({});   // item_id -> [{id,path,url}]
  const [msg, setMsg] = useState("");
  const [loadErr, setLoadErr] = useState("");
  const [eventCounts, setEventCounts] = useState({});  // item_id -> custody events
  const [stops, setStops] = useState([]);

  useEffect(() => {
    (async () => {
      // The form must be populated before anything optional runs - `f` gates
      // the whole render, so a later failure would hang on "Loading job..."
      const { data: j, error: jErr } = await supabase.from("jobs").select("*").eq("id", id).single();
      if (jErr || !j) { setLoadErr(jErr?.message ?? "Job not found, or you do not have access to it."); return; }

      const { data: it } = await supabase.from("line_items")
        .select("*").eq("job_id", id).order("created_at");

      const { data: st } = await supabase.from("job_stops")
        .select("*").eq("job_id", id).order("kind").order("seq");
      setStops(st ?? []);

      setF({
        type: j.type, client_ref: j.client_ref ?? "",
        scheduled_date: j.scheduled_date ?? "", time_window: j.time_window ?? "",
        o_addr: j.origin?.address ?? "", o_name: j.origin?.contact_name ?? "", o_phone: j.origin?.contact_phone ?? "",
        d_addr: j.destination?.address ?? "", d_name: j.destination?.contact_name ?? "", d_phone: j.destination?.contact_phone ?? "",
        _job: j,
      });
      setItems(it ?? []);

      // Anything below here is optional - never let it block the form.
      try {
        const { data: jt } = await supabase.from("job_types")
          .select("key,label").eq("active", true).order("sort");
        setJobTypes(jt ?? []);
      } catch (e) { console.warn("job types unavailable", e); }

      try {
        await loadPhotos(it ?? []);
      } catch (e) { console.warn("item photos unavailable", e); }

      try {
        const { data: ev } = await supabase.from("custody_events")
          .select("item_id").eq("job_id", id).not("item_id", "is", null);
        const counts = {};
        (ev ?? []).forEach((e) => { counts[e.item_id] = (counts[e.item_id] ?? 0) + 1; });
        setEventCounts(counts);
      } catch (e) { console.warn("custody counts unavailable", e); }
    })().catch((e) => setLoadErr(String(e?.message ?? e)));
  }, [id]);


  if (loadErr) return (
    <div className="page">
      <div className="card" style={{ color: "var(--warn)" }}>Could not open this job: {loadErr}</div>
      <button className="btn btn-ghost" onClick={() => nav(`/job/${id}`)}>← Back to job</button>
    </div>
  );
  if (!f) return <div className="empty">Loading job…</div>;

  const save = async () => {
    const patch = {
      type: f.type,
      client_ref: f.client_ref || null,
      scheduled_date: f.scheduled_date || null,
      time_window: f.time_window || null,
      // origin/destination are maintained by the job_stops trigger.
      updated_at: new Date().toISOString(),
    };
    await supabase.from("jobs").update(patch).eq("id", id);
    for (const [itemId, e] of Object.entries(edits)) {
      const it = items.find((x) => x.id === itemId);
      if (!it) continue;
      const description = (e.description ?? it.description ?? "").trim();
      if (!description) continue;
      await supabase.from("line_items").update({
        description,
        attributes: {
          ...(it.attributes ?? {}),
          dimensions: (e.dimensions ?? it.attributes?.dimensions ?? "") || null,
          special_handling: (e.special_handling ?? it.attributes?.special_handling ?? "") || null,
          needs_details: false,
        },
      }).eq("id", itemId);
    }
    await supabase.from("custody_events").insert({
      tenant_id: profile.tenant_id, job_id: id, type: "amendment",
      taken_at: new Date().toISOString(), user_id: session.user.id,
      notes: "Edited in Office", payload: { changes: patch },
    });
    nav(`/job/${id}`);
  };

  const addItem = async () => {
    if (!newItem.trim()) return;
    await supabase.from("line_items").insert({
      tenant_id: profile.tenant_id, job_id: id, description: newItem.trim(),
    });
    setNewItem("");
    const { data: it } = await supabase.from("line_items").select("*").eq("job_id", id).order("created_at");
    setItems(it ?? []);
  };

  const reloadStops = async () => {
    const { data } = await supabase.from("job_stops")
      .select("*").eq("job_id", id).order("kind").order("seq");
    setStops(data ?? []);
    const { data: fresh } = await supabase.from("line_items")
      .select("*").eq("job_id", id).order("created_at");
    setItems(fresh ?? []);
  };

  const setItemStop = async (it, field, stopId) => {
    const { error } = await supabase.from("line_items")
      .update({ [field]: stopId || null }).eq("id", it.id);
    if (error) { setMsg(error.message); return; }
    setItems((cur) => cur.map((x) => (x.id === it.id ? { ...x, [field]: stopId || null } : x)));
  };

  const loadPhotos = async (list) => {
    const ids = list.map((x) => x.id);
    if (!ids.length) { setPhotos({}); return; }
    const { data, error } = await supabase.from("item_photos")
      .select("id,item_id,path").in("item_id", ids).order("created_at");
    if (error) { console.warn("item_photos not available:", error.message); setPhotos({}); return; }
    const rows = data ?? [];
    const map = {};
    if (rows.length) {
      const { data: signed } = await supabase.storage.from("photos")
        .createSignedUrls(rows.map((r) => r.path), 3600);
      rows.forEach((r, i) => {
        (map[r.item_id] ||= []).push({ ...r, url: signed?.[i]?.signedUrl });
      });
    }
    setPhotos(map);
  };

  const removeItemPhoto = async (it, photo) => {
    if (!window.confirm("Remove this photo?")) return;
    const { error } = await supabase.from("item_photos").delete().eq("id", photo.id);
    if (error) { setMsg("Could not remove photo: " + error.message); return; }
    await supabase.storage.from("photos").remove([photo.path]);
    const { data: fresh } = await supabase.from("line_items")
      .select("*").eq("job_id", id).order("created_at");
    setItems(fresh ?? []);
    await loadPhotos(fresh ?? []);
  };

  const uploadItemPhoto = async (it, file) => {
    if (!file) return;
    setUploading(it.id);
    setMsg("");
    try {
      if ((photos[it.id]?.length ?? 0) >= 3) { setMsg("Up to 3 photos per item."); return; }
      const path = `${it.tenant_id}/${id}/${it.id}/ref-${Date.now()}.jpg`;
      const { error: upErr } = await supabase.storage
        .from("photos").upload(path, file, { contentType: file.type || "image/jpeg", upsert: true });
      if (upErr) { setMsg("Photo upload failed: " + upErr.message); return; }
      const { error: dbErr } = await supabase.from("item_photos").insert({
        tenant_id: it.tenant_id, job_id: id, item_id: it.id, path,
      });
      if (dbErr) { setMsg("Could not save photo: " + dbErr.message); return; }
      const { data: fresh } = await supabase.from("line_items")
        .select("*").eq("job_id", id).order("created_at");
      setItems(fresh ?? []);
      await loadPhotos(fresh ?? []);
    } finally {
      setUploading(null);
    }
  };

  // An item may be removed until it has custody history. Reference photos
  // added in this screen are descriptive, not evidence, so they don't lock it.
  const canRemove = (it) => (eventCounts[it.id] ?? 0) === 0;

  const removeItem = async (it) => {
    if (!canRemove(it)) {
      setMsg("This item has custody events and can't be removed — log an exception instead.");
      return;
    }
    if (!window.confirm(`Remove "${it.description}"? This cannot be undone.`)) return;

    // Clear its reference photos first: they hold a foreign key to the item.
    const mine = photos[it.id] ?? [];
    if (mine.length) {
      await supabase.from("item_photos").delete().eq("item_id", it.id);
      await supabase.storage.from("photos").remove(mine.map((p) => p.path));
    }
    await supabase.from("job_documents").delete().eq("item_id", it.id);

    const { error } = await supabase.from("line_items").delete().eq("id", it.id);
    if (error) { setMsg("Could not remove item: " + error.message); return; }
    setItems(items.filter((x) => x.id !== it.id));
    setPhotos((prev) => { const n = { ...prev }; delete n[it.id]; return n; });
  };

  const inp = (k, label, ph = "") => (
    <>
      <label>{label}</label>
      <input value={f[k]} placeholder={ph} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </>
  );

  return (
    <div className="page">
      <button className="btn btn-ghost" style={{ minHeight: 40, width: "auto", padding: "0 14px", marginBottom: 10 }}
        onClick={() => nav(`/job/${id}`)}>‹ Back — discard changes</button>
      <h1 style={{ marginBottom: 4 }}>Edit {f._job.ref}</h1>
      <p className="muted" style={{ marginBottom: 14 }}>Every save is logged as an amendment on the job's audit trail.</p>

      <h2>Schedule</h2>
      <div className="card">
        <label>Type</label>
        <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
          {jobTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          {/* keep the job's existing type selectable even if since retired */}
          {f.type && !jobTypes.some((t) => t.key === f.type) &&
            <option value={f.type}>{f.type} (retired)</option>}
        </select>
        {inp("client_ref", "Client reference", "Stevenson Gallery / Wendy, PO-4471")}
        <label>Booked date</label>
        <input type="date" value={f.scheduled_date} onChange={(e) => setF({ ...f, scheduled_date: e.target.value })} />
        {inp("time_window", "Time window", "09:00–12:00")}
        <ClashWarning date={f.scheduled_date} timeWindow={f.time_window} excludeId={id} />
      </div>

      <JobStops jobId={id} tenantId={f._job.tenant_id} stops={stops}
        onChange={reloadStops} setMsg={setMsg} />

      {!stops.some((x) => x.kind === "delivery" || x.kind === "site") && (
        <div className="card" style={{ borderLeft: "3px solid var(--warn)" }}>
          <div style={{ fontWeight: 600, color: "var(--warn)" }}>No destination yet</div>
          <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>
            Add a delivery address, or a site if the work happens in one place.
            Without it the crew has nowhere to take this.
          </div>
        </div>
      )}

      <h2>Items</h2>
      <div className="card">
        {items.map((it) => (
          <div key={it.id} style={{ padding: "10px 0", borderBottom: "1px solid var(--line)" }}>
            <label>Description</label>
            <input style={{ marginBottom: 6 }}
              value={edits[it.id]?.description ?? it.description ?? ""}
              placeholder="What is this item?"
              onChange={(ev) => setEdits({ ...edits, [it.id]: { ...edits[it.id], description: ev.target.value } })} />

            <label>Dimensions</label>
            <input style={{ marginBottom: 6 }}
              value={edits[it.id]?.dimensions ?? it.attributes?.dimensions ?? ""}
              placeholder="120 x 90 x 45 cm"
              onChange={(ev) => setEdits({ ...edits, [it.id]: { ...edits[it.id], dimensions: ev.target.value } })} />

            <label>Special handling</label>
            <input style={{ marginBottom: 6 }}
              value={edits[it.id]?.special_handling ?? it.attributes?.special_handling ?? ""}
              placeholder="Pack on arrival, glass side up…"
              onChange={(ev) => setEdits({ ...edits, [it.id]: { ...edits[it.id], special_handling: ev.target.value } })} />

            {stops.length > 1 && (
              <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                <div style={{ flex: 1 }}>
                  <label>Collected from</label>
                  <select value={it.from_stop_id ?? ""}
                    onChange={(e) => setItemStop(it, "from_stop_id", e.target.value)}>
                    <option value="">—</option>
                    {stops.filter((x) => x.kind === "collection").map((x) => (
                      <option key={x.id} value={x.id}>{stopName(x)}</option>
                    ))}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label>Going to</label>
                  <select value={it.to_stop_id ?? ""}
                    onChange={(e) => setItemStop(it, "to_stop_id", e.target.value)}>
                    <option value="">—</option>
                    {stops.filter((x) => x.kind === "delivery" || x.kind === "site").map((x) => (
                      <option key={x.id} value={x.id}>{stopName(x)}{x.kind === "site" ? " (site)" : ""}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <label>Reference photos ({photos[it.id]?.length ?? 0}/3)</label>
            {!!photos[it.id]?.length && (
              <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
                {photos[it.id].map((ph) => (
                  <div key={ph.id} style={{ position: "relative" }}>
                    {ph.url && <img src={ph.url} alt="" style={{ width: 84, height: 84, objectFit: "cover", borderRadius: 8 }} />}
                    <button onClick={() => removeItemPhoto(it, ph)} aria-label="Remove photo"
                      style={{ position: "absolute", top: -6, right: -6, width: 22, height: 22, borderRadius: "50%",
                        border: "none", background: "var(--warn)", color: "#fff", cursor: "pointer", lineHeight: 1 }}>×</button>
                  </div>
                ))}
              </div>
            )}
            {(photos[it.id]?.length ?? 0) < 3 && (
              <input type="file" accept="image/*" style={{ marginBottom: 6 }}
                disabled={uploading === it.id}
                onChange={(ev) => uploadItemPhoto(it, ev.target.files?.[0])} />
            )}
            {uploading === it.id && <div className="muted">Uploading…</div>}

            <ItemDocuments item={it} jobId={id} />

            <div className="row" style={{ marginTop: 4 }}>
              <span className="muted">{it.status.replace("_", " ")}</span>
              {canRemove(it) ? (
                <button className="muted" style={{ background: "none", border: "none", color: "var(--warn)", cursor: "pointer" }}
                  onClick={() => removeItem(it)}>remove</button>
              ) : (
                <span className="muted" style={{ fontSize: 12 }}>
                  {eventCounts[it.id]} event{eventCounts[it.id] > 1 ? "s" : ""} logged
                </span>
              )}
            </div>
          </div>
        ))}
        <label style={{ marginTop: 10 }}>Add item</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input style={{ marginBottom: 0 }} value={newItem} placeholder="Crated oil painting 120×90"
            onChange={(e) => setNewItem(e.target.value)} />
          <button className="btn btn-primary" style={{ width: "auto", minHeight: 46, padding: "0 16px", marginTop: 0 }}
            onClick={addItem}>Add</button>
        </div>
        {msg && <p className="muted" style={{ marginTop: 8, color: "var(--warn)" }}>{msg}</p>}
      </div>

      <button className="btn btn-primary" onClick={save}>✓ Save changes</button>
    </div>
  );
}
