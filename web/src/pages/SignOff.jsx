import React, { useContext, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { Ctx } from "../main";

// Capturing a handover: who released the goods, or who received them.
//
// The typed name is what matters and is required. The drawn signature is
// optional - plenty of registrars will give you a name but not sign a phone,
// and a name with a timestamp and a location is still worth having.
//
// Nothing here can be edited afterwards. Correcting a sign-off means capturing
// another one, and the record shows both.

export default function SignOff({ jobId, tenantId, stop, kind, existing, onSaved }) {
  const { profile } = useContext(Ctx);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [drawn, setDrawn] = useState(false);
  const canvasRef = useRef(null);
  const drawing = useRef(false);

  // Site work is accepted, not received - nothing changes hands at an
  // installation or a measure-up.
  const VERB = {
    released: "Released by",
    received: "Received by",
    accepted: "Work accepted by",
  };
  const verb = VERB[kind] ?? "Signed by";

  const placeholder = kind === "accepted"
    ? "Who is signing the work off"
    : "Who is handing over / receiving";

  const notesHint = kind === "accepted"
    ? "Anything agreed on site (optional)"
    : "Anything noted at handover (optional)";

  const notesExample = kind === "accepted"
    ? "Two brackets still to be painted, client aware"
    : "Two crates already marked, corner scuffed";

  // Prefill the contact we already hold for this stop - usually the right person.
  useEffect(() => {
    if (open && !name && stop?.contact_name) setName(stop.contact_name);
  }, [open]);

  // ---- signature pad: pointer events, so a finger and a mouse both work ----
  const pos = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const start = (e) => {
    e.preventDefault();
    drawing.current = true;
    const ctx = canvasRef.current.getContext("2d");
    ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.strokeStyle = "#101314";
    ctx.beginPath();
    ctx.moveTo(...pos(e));
    canvasRef.current.setPointerCapture?.(e.pointerId);
  };
  const move = (e) => {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext("2d");
    ctx.lineTo(...pos(e));
    ctx.stroke();
    setDrawn(true);
  };
  const end = () => { drawing.current = false; };
  const clear = () => {
    const c = canvasRef.current;
    c.getContext("2d").clearRect(0, 0, c.width, c.height);
    setDrawn(false);
  };

  const save = async () => {
    if (!name.trim()) { setMsg("A name is required."); return; }
    setBusy(true); setMsg("");
    try {
      let signature_path = null;

      if (drawn) {
        const blob = await new Promise((res) => canvasRef.current.toBlob(res, "image/png"));
        if (blob) {
          const path = `${tenantId}/${jobId}/signatures/${stop.id}-${kind}.png`;
          const { error } = await supabase.storage.from("photos")
            .upload(path, blob, { contentType: "image/png", upsert: true });
          if (error) console.warn("signature upload failed:", error.message);
          else signature_path = path;
        }
      }

      // Position is worth having and never worth waiting for.
      let lat = null, lng = null;
      try {
        const p = await new Promise((res, rej) =>
          navigator.geolocation.getCurrentPosition(res, rej, { timeout: 4000 }));
        lat = p.coords.latitude; lng = p.coords.longitude;
      } catch { /* no fix, carry on */ }

      const { error } = await supabase.from("stop_signoffs").insert({
        tenant_id: tenantId, job_id: jobId, stop_id: stop.id, kind,
        signer_name: name.trim(), signer_role: role.trim() || null,
        notes: notes.trim() || null, captured_by: profile?.id ?? null, lat, lng,
      });
      if (error) {
        setMsg(error.code === "23505"
          ? "This stop has already been signed for."
          : "Could not save: " + error.message);
        return;
      }
      setOpen(false); setName(""); setRole(""); setNotes(""); setDrawn(false);
      await onSaved?.();
    } finally { setBusy(false); }
  };

  if (existing) {
    return (
      <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
        ✓ {verb} <b style={{ color: "var(--ink)" }}>{existing.signer_name}</b>
        {existing.signer_role && `, ${existing.signer_role}`}
        {" · "}
        {new Date(existing.signed_at).toLocaleString("en-ZA",
          { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
        {existing.signature_path && " · signed"}
        {existing.notes && <div style={{ marginTop: 2 }}>"{existing.notes}"</div>}
      </div>
    );
  }

  if (!open) {
    return (
      <button className="btn btn-ghost" style={{ marginTop: 6 }} onClick={() => setOpen(true)}>
        ✎ {verb}…
      </button>
    );
  }

  return (
    <div className="card" style={{ marginTop: 6 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{verb}</div>
      {msg && <div className="muted" style={{ color: "var(--warn)", fontSize: 13 }}>{msg}</div>}

      <label>Name</label>
      <input value={name} autoFocus placeholder={placeholder}
        onChange={(e) => setName(e.target.value)} />

      <label>Their role (optional)</label>
      <input value={role} placeholder={kind === "accepted"
        ? "Curator, architect, homeowner" : "Registrar, studio manager, security"}
        onChange={(e) => setRole(e.target.value)} />

      <label>Signature (optional)</label>
      <canvas ref={canvasRef} width={520} height={160}
        onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerLeave={end}
        style={{ width: "100%", height: 160, background: "#fff", touchAction: "none",
          border: "1.5px solid var(--line)", borderRadius: 12, marginBottom: 6 }} />
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>
          {drawn ? "Signed" : "Sign with a finger or the mouse"}
        </span>
        <button onClick={clear} style={{ background: "none", border: "none",
          color: "var(--ink-soft)", cursor: "pointer", font: "inherit", fontSize: 13 }}>
          clear
        </button>
      </div>

      <label>{notesHint}</label>
      <input value={notes} placeholder={notesExample}
        onChange={(e) => setNotes(e.target.value)} />

      <button className="btn btn-primary" disabled={busy} onClick={save}>
        {busy ? "Saving…" : "Save sign-off"}
      </button>
      <button className="btn btn-ghost" disabled={busy} onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}
