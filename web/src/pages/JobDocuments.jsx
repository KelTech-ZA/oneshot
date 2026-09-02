import React, { useContext, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { Ctx } from "../main";
import FileDrop from "./FileDrop";

// Supporting paperwork for a job: delivery notes, condition reports,
// insurance certificates, packing lists. Any file type.
// Photos remain separate - those are custody evidence, these are documents.

const ICON = { pdf: "PDF", doc: "DOC", docx: "DOC", xls: "XLS", xlsx: "XLS",
  png: "IMG", jpg: "IMG", jpeg: "IMG", csv: "CSV", txt: "TXT", zip: "ZIP" };

const prettySize = (b) => {
  if (!b && b !== 0) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
};

export default function JobDocuments({ jobId, tenantId, canEdit = true }) {
  const { profile } = useContext(Ctx);
  const [docs, setDocs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const fileRef = useRef(null);

  const isOps = profile?.role === "ops";

  const load = async () => {
    const { data } = await supabase.from("job_documents")
      .select("*").eq("job_id", jobId).order("created_at", { ascending: false });
    setDocs(data ?? []);
  };

  useEffect(() => { load(); }, [jobId]);

  const uploadMany = async (files) => {
    for (const f of files) await upload(f);
  };

  const upload = async (file) => {
    if (!file) return;
    setBusy(true); setMsg("");
    try {
      const safe = file.name.replace(/[^\w.\-]+/g, "_").slice(-80);
      const path = `${tenantId}/${jobId}/${Date.now()}-${safe}`;
      const { error: upErr } = await supabase.storage.from("documents")
        .upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
      if (upErr) { setMsg("Upload failed: " + upErr.message); return; }

      const { error: dbErr } = await supabase.from("job_documents").insert({
        tenant_id: tenantId, job_id: jobId, name: file.name, path,
        mime: file.type || null, size_bytes: file.size ?? null, uploaded_by: profile?.id ?? null,
      });
      if (dbErr) { setMsg("Saved the file but could not record it: " + dbErr.message); return; }

      if (fileRef.current) fileRef.current.value = "";
      await load();
    } finally {
      setBusy(false);
    }
  };

  const open = async (doc) => {
    const { data, error } = await supabase.storage.from("documents")
      .createSignedUrl(doc.path, 3600);
    if (error || !data?.signedUrl) { setMsg("Could not open: " + (error?.message ?? "unknown")); return; }
    window.open(data.signedUrl, "_blank", "noopener");
  };

  const remove = async (doc) => {
    if (!window.confirm(`Remove "${doc.name}"?`)) return;
    setBusy(true);
    try {
      const { error } = await supabase.from("job_documents").delete().eq("id", doc.id);
      if (error) { setMsg("Could not remove: " + error.message); return; }
      await supabase.storage.from("documents").remove([doc.path]);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2>Documents{docs.length ? ` (${docs.length})` : ""}</h2>
      {msg && <div className="card" style={{ color: "var(--warn)" }}>{msg}</div>}

      {docs.map((d) => {
        const ext = (d.name.split(".").pop() || "").toLowerCase();
        return (
          <div className="card" key={d.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="stamp pending" style={{ flexShrink: 0 }}>{ICON[ext] ?? "FILE"}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <button onClick={() => open(d)}
                style={{ background: "none", border: "none", padding: 0, font: "inherit", fontWeight: 600,
                  color: "var(--accent)", cursor: "pointer", textAlign: "left", wordBreak: "break-word" }}>
                {d.name}
              </button>
              <div className="muted" style={{ fontSize: 12 }}>
                {prettySize(d.size_bytes)}{d.size_bytes ? " · " : ""}
                {new Date(d.created_at).toLocaleDateString("en-ZA")}
              </div>
            </div>
            {isOps && (
              <button className="muted" disabled={busy} onClick={() => remove(d)}
                style={{ background: "none", border: "none", color: "var(--warn)", cursor: "pointer", font: "inherit" }}>
                remove
              </button>
            )}
          </div>
        );
      })}

      {canEdit && (
        <FileDrop onFiles={uploadMany} disabled={busy} paste label="Drop files to attach">
          <div className="card">
            <label>Add document</label>
            <input ref={fileRef} type="file" multiple disabled={busy}
              onChange={(e) => uploadMany([...(e.target.files ?? [])])} />
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Drag files here, paste with Ctrl+V, or browse. PDF, Word, Excel,
              images — up to 25 MB each.
            </div>
            {busy && <div className="muted">Uploading…</div>}
          </div>
        </FileDrop>
      )}
    </>
  );
}
