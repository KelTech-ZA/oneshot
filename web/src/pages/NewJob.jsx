import React, { useContext, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { Ctx } from "../main";
import ClashWarning from "./ClashWarning";

// Making a job, with everything a job actually has on it.
//
// The form in Office asks for a type, two addresses, a date and a block of
// item descriptions, and leaves out the two things that cost the most to fix
// afterwards: who the customer is, and the paperwork. A job with no client_id
// never reaches that customer's statement - which is why some invoices here
// have no client on them - and documents that live in somebody's inbox are
// documents the crew cannot see.
//
// So this asks for all of it in one pass: the job, its items with dimensions
// and special handling, reference photos per item, and the files. Nothing is
// compulsory except a type - a request taken over the phone with half the
// detail missing should still become a job rather than a note on a hand.

const MAX_ITEM_PHOTOS = 3;     // the cap EditJob enforces too

const blankItem = () => ({
  key: Math.random().toString(36).slice(2, 8),
  description: "", dimensions: "", special_handling: "", photos: [],
});

export default function NewJob() {
  const { profile, session } = useContext(Ctx);
  const nav = useNavigate();
  const [params] = useSearchParams();

  const [types, setTypes] = useState([]);
  const [clients, setClients] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const [f, setF] = useState({
    type: "collection",
    client_id: "",
    client_ref: "",
    notify: "",
    // A date can be handed in by the week view: drop onto Thursday, land
    // here with Thursday already filled in.
    scheduled_date: params.get("date") ?? "",
    time_window: params.get("time") ?? "",
    origin: "",
    destination: "",
    crew: "",
  });
  const set = (patch) => setF((prev) => ({ ...prev, ...patch }));

  // Dropping a file did nothing, because every one of these zones is a
  // <label> wrapped around a hidden <input type="file">. That handles a click
  // and ignores a drag: the browser's default for a dropped file is to open
  // it, so a miss replaced a half-filled form with a PDF and lost the lot.
  //
  // One piece of state rather than one hook per zone, because the item zones
  // are inside a loop and hooks are not.
  const [dragOver, setDragOver] = useState(null);
  const dropZone = (key, take) => ({
    onDragEnter: (e) => { e.preventDefault(); e.stopPropagation(); setDragOver(key); },
    onDragOver:  (e) => { e.preventDefault(); e.stopPropagation(); setDragOver(key); },
    onDragLeave: (e) => {
      e.preventDefault(); e.stopPropagation();
      // Moving over a child fires leave on the parent; only let go when the
      // pointer has actually left the zone.
      if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(null);
    },
    onDrop: (e) => {
      e.preventDefault(); e.stopPropagation(); setDragOver(null);
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) take(files);
    },
  });

  // A file dropped anywhere else on the page. Without this the browser
  // navigates away to show it and the form is gone.
  useEffect(() => {
    const swallow = (e) => { e.preventDefault(); };
    addEventListener("dragover", swallow);
    addEventListener("drop", swallow);
    return () => { removeEventListener("dragover", swallow); removeEventListener("drop", swallow); };
  }, []);

  const [items, setItems] = useState([blankItem()]);
  const [docs, setDocs] = useState([]);          // {file, name, size}
  const [sitePhotos, setSitePhotos] = useState([]);

  useEffect(() => {
    supabase.from("job_types").select("key,label").eq("active", true).order("sort")
      .then(({ data }) => {
        setTypes(data ?? []);
        if (data?.length && !data.some((t) => t.key === f.type)) set({ type: data[0].key });
      });
    supabase.from("clients").select("id,name").order("name")
      .then(({ data }) => setClients(data ?? []));
  }, []);

  if (profile.role !== "ops")
    return <div className="page"><div className="empty">Only ops can create jobs.</div></div>;

  const patchItem = (key, patch) =>
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));

  const addPhotos = (key, files) => {
    const pics = [...files].filter((x) => x.type.startsWith("image/"))
      .map((file) => ({ file, url: URL.createObjectURL(file) }));
    setItems((prev) => prev.map((it) => it.key === key
      ? { ...it, photos: [...it.photos, ...pics].slice(0, MAX_ITEM_PHOTOS) } : it));
  };

  const create = async () => {
    setBusy(true); setMsg("");
    try {
      const { data: job, error } = await supabase.from("jobs").insert({
        tenant_id: profile.tenant_id,
        type: f.type,
        // The one field the old form never asked for. Without it the job's
        // invoice has no customer and the statement misses it.
        client_id: f.client_id || null,
        client_ref: f.client_ref || null,
        notify_emails: f.notify.split(/[,;\s]+/).filter((e) => e.includes("@")).slice(0, 3),
        origin: f.origin ? { address: f.origin } : null,
        destination: f.destination ? { address: f.destination } : null,
        scheduled_date: f.scheduled_date || null,
        time_window: f.time_window || null,
        crew: f.crew ? f.crew.split(/\s*,\s*/).filter(Boolean) : null,
        status: "confirmed",
        created_by: profile.id,
      }).select().single();

      if (error || !job) { setMsg("Could not create the job: " + (error?.message ?? "unknown error")); return; }

      // Items, then their photos - a photo needs the item's id, so the rows
      // have to exist first.
      const wanted = items.filter((it) => it.description.trim() || it.photos.length);
      let saved = [];
      if (wanted.length) {
        const { data: rows, error: itemErr } = await supabase.from("line_items").insert(
          wanted.map((it) => ({
            tenant_id: profile.tenant_id, job_id: job.id,
            description: it.description.trim() || "Item",
            attributes: {
              dimensions: it.dimensions.trim() || null,
              special_handling: it.special_handling.trim() || null,
            },
          }))).select();
        if (itemErr) { setMsg(`Job ${job.ref} was created, but its items were refused: ${itemErr.message}`); }
        saved = rows ?? [];
      }

      for (let i = 0; i < saved.length; i++) {
        for (const p of wanted[i].photos) {
          const path = `${profile.tenant_id}/${job.id}/${saved[i].id}/ref-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`;
          const { error: upErr } = await supabase.storage.from("photos")
            .upload(path, p.file, { contentType: p.file.type || "image/jpeg", upsert: true });
          if (upErr) { setMsg("A reference photo would not upload: " + upErr.message); continue; }
          await supabase.from("item_photos").insert({
            tenant_id: profile.tenant_id, job_id: job.id, item_id: saved[i].id, path,
          });
        }
      }

      // Documents and site photos both land in job_documents - that is the
      // only store on a job that takes arbitrary files, and it is the one the
      // job page already reads. Photos of a site are documents about the job;
      // photographs of the WORK are custody evidence and belong to the crew's
      // capture flow, which is a different thing and deliberately not here.
      for (const d of [...docs, ...sitePhotos]) {
        const safe = d.file.name.replace(/[^\w.\-]+/g, "_").slice(-80);
        const path = `${profile.tenant_id}/${job.id}/${Date.now()}-${safe}`;
        const { error: upErr } = await supabase.storage.from("documents")
          .upload(path, d.file, { contentType: d.file.type || "application/octet-stream", upsert: false });
        if (upErr) { setMsg("A file would not upload: " + upErr.message); continue; }
        await supabase.from("job_documents").insert({
          tenant_id: profile.tenant_id, job_id: job.id, name: d.file.name, path,
          mime: d.file.type || null, size_bytes: d.file.size ?? null,
          uploaded_by: profile.id ?? null,
        });
      }

      await supabase.from("custody_events").insert({
        tenant_id: profile.tenant_id, job_id: job.id, type: "amendment",
        taken_at: new Date().toISOString(), user_id: session.user.id,
        notes: "Created in the week view",
        payload: { items: saved.length, documents: docs.length + sitePhotos.length },
      });

      nav(`/job/${job.id}`);
    } finally {
      setBusy(false);
    }
  };

  const sizeOf = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

  return (
    <div className="page wk-form">
      <button className="btn btn-ghost" style={{ minHeight: 40, width: "auto", padding: "0 14px", marginBottom: 10 }}
        onClick={() => nav(-1)}>‹ Back — discard</button>
      <h1 style={{ marginBottom: 4 }}>New job</h1>
      <p className="muted" style={{ marginBottom: 14 }}>
        Only the type is required. Everything else can be filled in later from the job page.
      </p>

      <h2>The job</h2>
      <div className="card">
        <label>Type</label>
        <select value={f.type} onChange={(e) => set({ type: e.target.value })}>
          {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>

        <label>Client</label>
        <select value={f.client_id} onChange={(e) => set({ client_id: e.target.value })}>
          <option value="">— not matched to a customer —</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <div className="muted" style={{ fontSize: 12, marginTop: -6, marginBottom: 10 }}>
          Picking the customer here is what puts this job's invoice on their statement.
        </div>

        <label>Client reference</label>
        <input value={f.client_ref} placeholder="Stevenson Gallery / Wendy, PO-4471"
          onChange={(e) => set({ client_ref: e.target.value })} />

        <label>Notify by email (up to 3)</label>
        <input value={f.notify} placeholder="wendy@gallery.co.za, ops@gallery.com"
          onChange={(e) => set({ notify: e.target.value })} />

        <label>Collect from</label>
        <input value={f.origin} onChange={(e) => set({ origin: e.target.value })}
          placeholder="95 Sir Lowry Rd, Woodstock" />

        <label>Deliver to</label>
        <input value={f.destination} onChange={(e) => set({ destination: e.target.value })}
          placeholder="Gallery, Loop St" />

        <label>Booked date</label>
        <input type="date" value={f.scheduled_date}
          onChange={(e) => set({ scheduled_date: e.target.value })} />

        <label>Time window — optional</label>
        <input value={f.time_window} placeholder="09:00–12:00"
          onChange={(e) => set({ time_window: e.target.value })} />
        <div className="muted" style={{ fontSize: 12, marginTop: -6, marginBottom: 10 }}>
          Leave it blank and the job sits at the top of its day in the week view
          until you drag it onto a slot.
        </div>
        <ClashWarning date={f.scheduled_date} timeWindow={f.time_window} />

        <label>Crew — optional</label>
        <input value={f.crew} placeholder="Pieter, Thabo"
          onChange={(e) => set({ crew: e.target.value })} />
      </div>

      <h2>Items ({items.length})</h2>
      <div className="card">
        {items.map((it, n) => (
          <div key={it.key} style={{ padding: "10px 0", borderBottom: "1px solid var(--line)" }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <span className="muted" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
                {String(n + 1).padStart(2, "0")}
              </span>
              {items.length > 1 && (
                <button className="muted" style={{ background: "none", border: "none", cursor: "pointer" }}
                  onClick={() => setItems(items.filter((x) => x.key !== it.key))}>remove</button>
              )}
            </div>
            <label>Description</label>
            <input style={{ marginBottom: 6 }} value={it.description}
              placeholder="Crated oil painting 120×90"
              onChange={(e) => patchItem(it.key, { description: e.target.value })} />
            <label>Dimensions</label>
            <input style={{ marginBottom: 6 }} value={it.dimensions} placeholder="120 x 90 x 45 cm"
              onChange={(e) => patchItem(it.key, { dimensions: e.target.value })} />
            <label>Special handling</label>
            <input style={{ marginBottom: 6 }} value={it.special_handling}
              placeholder="Pack on arrival, glass side up…"
              onChange={(e) => patchItem(it.key, { special_handling: e.target.value })} />

            <label>Reference photos ({it.photos.length}/{MAX_ITEM_PHOTOS})</label>
            <div className={`wk-shots wk-droppable${dragOver === it.key ? " over" : ""}`}
              {...dropZone(it.key, (files) => addPhotos(it.key, files))}>
              {it.photos.map((p, i) => (
                <div key={i} className="wk-shot" style={{ backgroundImage: `url(${p.url})` }}>
                  <button className="wk-x" title="Remove"
                    onClick={() => patchItem(it.key, { photos: it.photos.filter((_, k) => k !== i) })}>✕</button>
                </div>
              ))}
              {it.photos.length < MAX_ITEM_PHOTOS && (
                <label className="wk-shot add">+ PHOTO
                  <input type="file" accept="image/*" multiple hidden
                    onChange={(e) => addPhotos(it.key, e.target.files)} />
                </label>
              )}
            </div>
          </div>
        ))}
        <button className="btn btn-ghost" onClick={() => setItems([...items, blankItem()])}>
          ＋ Add item
        </button>
      </div>

      <h2>Documents ({docs.length})</h2>
      <div className="card">
        {docs.map((d, i) => (
          <div className="row" key={i} style={{ padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {d.file.name}
            </span>
            <span className="muted" style={{ fontSize: 12 }}>{sizeOf(d.file.size)}</span>
            <button className="muted" style={{ background: "none", border: "none", cursor: "pointer", color: "var(--warn)" }}
              onClick={() => setDocs(docs.filter((_, k) => k !== i))}>remove</button>
          </div>
        ))}
        <label className={`wk-drop-file${dragOver === "docs" ? " over" : ""}`}
          {...dropZone("docs", (files) => setDocs((cur) => [...cur, ...files.map((file) => ({ file }))]))}>
          <strong>＋ Attach documents</strong>
          <span>Drop them here, or click to choose. Quote, packing list, insurance,
            the client's PO. PDF, Word, Excel, images — up to 25 MB each.</span>
          <input type="file" multiple hidden
            onChange={(e) => setDocs([...docs, ...[...e.target.files].map((file) => ({ file }))])} />
        </label>
      </div>

      <h2>Photos ({sitePhotos.length})</h2>
      <div className="card">
        <div className={`wk-shots wk-droppable${dragOver === "site" ? " over" : ""}`}
          {...dropZone("site", (files) => setSitePhotos((cur) => [
            ...cur,
            ...files.filter((x) => x.type.startsWith("image/"))
              .map((file) => ({ file, url: URL.createObjectURL(file) })),
          ]))}>
          {sitePhotos.map((p, i) => (
            <div key={i} className="wk-shot" style={{ backgroundImage: `url(${p.url})` }}>
              <button className="wk-x" title="Remove"
                onClick={() => setSitePhotos(sitePhotos.filter((_, k) => k !== i))}>✕</button>
            </div>
          ))}
          <label className="wk-shot add">+ PHOTO
            <input type="file" accept="image/*" multiple hidden
              onChange={(e) => setSitePhotos([...sitePhotos,
                ...[...e.target.files].filter((x) => x.type.startsWith("image/"))
                  .map((file) => ({ file, url: URL.createObjectURL(file) }))])} />
          </label>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Drop photos here or click a tile. Site, access or parking shots for the
          job as a whole — they attach as documents. Photographs of the work itself are custody evidence and the
          crew shoots those on the job.
        </div>
      </div>

      {msg && <p className="muted" style={{ color: "var(--warn)" }}>{msg}</p>}
      <button className="btn btn-primary" disabled={busy} onClick={create}>
        {busy ? "Creating…" : "✓ Create job"}
      </button>
    </div>
  );
}
