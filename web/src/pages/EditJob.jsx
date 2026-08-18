import React, { useContext, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
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
  const [msg, setMsg] = useState("");

  useEffect(() => {
    (async () => {
      const { data: j } = await supabase.from("jobs").select("*").eq("id", id).single();
      const { data: it } = await supabase.from("line_items").select("*").eq("job_id", id).order("created_at");
      setF({
        type: j.type, scheduled_date: j.scheduled_date ?? "", time_window: j.time_window ?? "",
        o_addr: j.origin?.address ?? "", o_name: j.origin?.contact_name ?? "", o_phone: j.origin?.contact_phone ?? "",
        d_addr: j.destination?.address ?? "", d_name: j.destination?.contact_name ?? "", d_phone: j.destination?.contact_phone ?? "",
        _job: j,
      });
      setItems(it ?? []);
    })();
  }, [id]);


  if (!f) return <div className="empty">Loading job…</div>;

  const save = async () => {
    const patch = {
      type: f.type,
      scheduled_date: f.scheduled_date || null,
      time_window: f.time_window || null,
      origin: { ...(f._job.origin ?? {}), address: f.o_addr || null, contact_name: f.o_name || null, contact_phone: f.o_phone || null },
      destination: { ...(f._job.destination ?? {}), address: f.d_addr || null, contact_name: f.d_name || null, contact_phone: f.d_phone || null },
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

  const uploadItemPhoto = async (it, file) => {
    if (!file) return;
    setUploading(it.id);
    setMsg("");
    try {
      const path = `${it.tenant_id}/${id}/${it.id}/anchor-${Date.now()}.jpg`;
      const { error: upErr } = await supabase.storage
        .from("photos").upload(path, file, { contentType: file.type || "image/jpeg", upsert: true });
      if (upErr) { setMsg("Photo upload failed: " + upErr.message); return; }
      const { error: dbErr } = await supabase.from("line_items")
        .update({ anchor_image_path: path }).eq("id", it.id);
      if (dbErr) { setMsg("Could not save photo: " + dbErr.message); return; }
      const { data: fresh } = await supabase.from("line_items")
        .select("*").eq("job_id", id).order("created_at");
      setItems(fresh ?? []);
    } finally {
      setUploading(null);
    }
  };

  const removeItem = async (it) => {
    // Only items untouched by custody can be removed — evidence is never deleted.
    if (it.status !== "expected" || it.anchor_image_path) {
      setMsg("⚠ Items with custody history can't be removed — mark an exception instead.");
      return;
    }
    await supabase.from("line_items").delete().eq("id", it.id);
    setItems(items.filter((x) => x.id !== it.id));
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
          {["pickup", "delivery", "move", "storage_in", "storage_out"].map((t) => <option key={t}>{t}</option>)}
        </select>
        <label>Booked date</label>
        <input type="date" value={f.scheduled_date} onChange={(e) => setF({ ...f, scheduled_date: e.target.value })} />
        {inp("time_window", "Time window", "09:00–12:00")}
      </div>

      <h2>Origin</h2>
      <div className="card">
        {inp("o_addr", "Address")}
        {inp("o_name", "Contact name")}
        {inp("o_phone", "Contact phone")}
      </div>

      <h2>Destination</h2>
      <div className="card">
        {inp("d_addr", "Address")}
        {inp("d_name", "Contact name")}
        {inp("d_phone", "Contact phone")}
      </div>

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

            <label>Reference photo</label>
            <input type="file" accept="image/*" style={{ marginBottom: 6 }}
              disabled={uploading === it.id}
              onChange={(ev) => uploadItemPhoto(it, ev.target.files?.[0])} />
            {uploading === it.id && <div className="muted">Uploading…</div>}
            {it.anchor_image_path && <div className="muted">Photo on file ✓</div>}

            <div className="row" style={{ marginTop: 4 }}>
              <span className="muted">{it.status.replace("_", " ")}</span>
              {it.status === "expected" && !it.anchor_image_path && (
                <button className="muted" style={{ background: "none", border: "none", color: "var(--warn)", cursor: "pointer" }}
                  onClick={() => removeItem(it)}>remove</button>
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
