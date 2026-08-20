import React, { useContext, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { Ctx } from "../main";

// Up to 5 supporting documents per item - condition reports, certificates,
// valuations. Job-level paperwork lives on the job page instead.
const MAX = 5;

export default function ItemDocuments({ item, jobId }) {
  const { profile } = useContext(Ctx);
  const [docs, setDocs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const fileRef = useRef(null);

  const load = async () => {
    const { data } = await supabase.from("job_documents")
      .select("id,name,path,size_bytes").eq("item_id", item.id).order("created_at");
    setDocs(data ?? []);
  };

  useEffect(() => { load(); }, [item.id]);

  const upload = async (file) => {
    if (!file) return;
    if (docs.length >= MAX) { setMsg(`Up to ${MAX} documents per item.`); return; }
    setBusy(true); setMsg("");
    try {
      const safe = file.name.replace(/[^\w.\-]+/g, "_").slice(-80);
      const path = `${item.tenant_id}/${jobId}/${item.id}/${Date.now()}-${safe}`;
      const { error: upErr } = await supabase.storage.from("documents")
        .upload(path, file, { contentType: file.type || "application/octet-stream" });
      if (upErr) { setMsg("Upload failed: " + upErr.message); return; }
      const { error: dbErr } = await supabase.from("job_documents").insert({
        tenant_id: item.tenant_id, job_id: jobId, item_id: item.id, name: file.name,
        path, mime: file.type || null, size_bytes: file.size ?? null,
        uploaded_by: profile?.id ?? null,
      });
      if (dbErr) { setMsg(dbErr.message); return; }
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } finally { setBusy(false); }
  };

  const open = async (d) => {
    const { data } = await supabase.storage.from("documents").createSignedUrl(d.path, 3600);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank", "noopener");
  };

  const remove = async (d) => {
    if (!window.confirm(`Remove "${d.name}"?`)) return;
    const { error } = await supabase.from("job_documents").delete().eq("id", d.id);
    if (error) { setMsg("Could not remove: " + error.message); return; }
    await supabase.storage.from("documents").remove([d.path]);
    await load();
  };

  return (
    <>
      <label>Documents ({docs.length}/{MAX})</label>
      {msg && <div className="muted" style={{ color: "var(--warn)", fontSize: 12 }}>{msg}</div>}
      {docs.map((d) => (
        <div key={d.id} className="row" style={{ marginBottom: 4 }}>
          <button onClick={() => open(d)}
            style={{ background: "none", border: "none", padding: 0, font: "inherit", fontSize: 13,
              color: "var(--accent)", cursor: "pointer", textAlign: "left", wordBreak: "break-word" }}>
            {d.name}
          </button>
          <button onClick={() => remove(d)}
            style={{ background: "none", border: "none", color: "var(--warn)", cursor: "pointer", fontSize: 13 }}>
            remove
          </button>
        </div>
      ))}
      {docs.length < MAX && (
        <input ref={fileRef} type="file" disabled={busy} style={{ marginBottom: 6 }}
          onChange={(e) => upload(e.target.files?.[0])} />
      )}
      {busy && <div className="muted">Uploading…</div>}
    </>
  );
}
