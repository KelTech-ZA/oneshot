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
  const [renames, setRenames] = useState({});
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

  if (profile.role !== "ops") return <div className="empty">Only ops can edit jobs.</div>;
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
    for (const [itemId, desc] of Object.entries(renames)) {
      const it = items.find((x) => x.id === itemId);
      if (!it || !desc.trim() || desc === it.description) continue;
      await supabase.from("line_items").update({
        description: desc.trim(),
        attributes: { ...(it.attributes ?? {}), needs_details: false },
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
          <div className="row" key={it.id} style={{ padding: "7px 0", borderBottom: "1px solid var(--line)" }}>
            {it.attributes?.needs_details ? (
              <input style={{ marginBottom: 0, flex: 1, borderColor: "var(--warn)" }}
                placeholder="What is this item? (added by crew in the field)"
                value={renames[it.id] ?? it.description}
                onChange={(ev) => setRenames({ ...renames, [it.id]: ev.target.value })} />
            ) : (
              <span style={{ fontSize: 14 }}>{it.description}</span>
            )}
            {it.status === "expected" && !it.anchor_image_path
              ? <button className="muted" style={{ background: "none", border: "none", color: "var(--warn)", cursor: "pointer" }}
                  onClick={() => removeItem(it)}>remove</button>
              : <span className="muted">{it.status.replace("_", " ")}</span>}
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
