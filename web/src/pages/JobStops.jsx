import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

// A stop is a place where work happens. Three roles:
//   collection  things are taken from here
//   delivery    things are left here
//   site        work happens here and nothing moves (fabrication, install)
// Up to 3 of each; the database enforces the same limit.

export const KINDS = [
  { kind: "collection", title: "Collect from", one: "collection address" },
  { kind: "delivery",   title: "Deliver to",   one: "delivery address" },
  { kind: "site",       title: "On site at",   one: "site address" },
];

export const stopName = (s) =>
  s?.label || s?.address || (s ? "Unnamed stop" : "—");

export default function JobStops({ jobId, tenantId, stops, onChange, setMsg }) {
  // Controlled drafts: typing stays put even when the list reloads underneath,
  // and each field reports that it saved instead of committing invisibly.
  const [draft, setDraft] = useState({});
  const [saved, setSaved] = useState({});

  useEffect(() => {
    setDraft((cur) => {
      const next = { ...cur };
      for (const s of stops) if (!next[s.id]) next[s.id] = {
        label: s.label ?? "", address: s.address ?? "",
        contact_name: s.contact_name ?? "", contact_phone: s.contact_phone ?? "",
      };
      return next;
    });
  }, [stops]);

  const edit = (id, field, value) =>
    setDraft((cur) => ({ ...cur, [id]: { ...cur[id], [field]: value } }));

  const flash = (id) => {
    setSaved((cur) => ({ ...cur, [id]: true }));
    setTimeout(() => setSaved((cur) => ({ ...cur, [id]: false })), 1800);
  };
  const of = (kind) => stops.filter((s) => s.kind === kind)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  const addStop = async (kind) => {
    const existing = of(kind);
    if (existing.length >= 3) { setMsg(`Up to 3 ${kind} addresses.`); return; }
    const { error } = await supabase.from("job_stops").insert({
      tenant_id: tenantId, job_id: jobId, kind,
      seq: (existing.at(-1)?.seq ?? -1) + 1,
    });
    if (error) { setMsg(error.message); return; }
    await onChange();
  };

  const patch = async (stop, field) => {
    const value = draft[stop.id]?.[field] ?? "";
    if ((stop[field] ?? "") === value) return;          // nothing changed

    // .select() matters: without it a row blocked by RLS returns success with
    // nothing changed, and the save fails silently.
    const { data, error } = await supabase.from("job_stops")
      .update({ [field]: value || null })
      .eq("id", stop.id)
      .select("id");

    if (error) { setMsg(`Could not save ${field}: ${error.message}`); return; }
    if (!data || data.length === 0) {
      setMsg("That address was not saved — the database refused the change. "
        + "You may not have permission to edit this job's addresses.");
      return;
    }
    flash(stop.id);
    await onChange();
  };

  const removeStop = async (stop) => {
    if (!window.confirm(`Remove ${stopName(stop)}?\n\nItems pointing here keep their details but lose this address.`))
      return;
    const { error } = await supabase.from("job_stops").delete().eq("id", stop.id);
    if (error) { setMsg(error.message); return; }
    await onChange();
  };

  return (
    <div className="stops">
      {KINDS.map(({ kind, title, one }) => {
        const list = of(kind);
        // Sites are uncommon, so only show that section once one exists.
        if (kind === "site" && list.length === 0) return null;
        return (
          <React.Fragment key={kind}>
            <h2>{title}{list.length > 1 ? ` (${list.length})` : ""}</h2>
            {list.map((s, i) => (
              <div className="card" key={s.id}>
                <div className="row" style={{ marginBottom: 8 }}>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {saved[s.id]
                      ? <span style={{ color: "var(--ok)" }}>saved ✓</span>
                      : list.length > 1 ? `${i + 1} of ${list.length}` : "\u00a0"}
                  </span>
                  <button onClick={() => removeStop(s)}
                    style={{ background: "none", border: "none", color: "var(--warn)",
                      cursor: "pointer", font: "inherit", fontSize: 13, padding: 0 }}>
                    remove
                  </button>
                </div>
                <label>Name (optional)</label>
                <input value={draft[s.id]?.label ?? ""} placeholder="Workshop, Blank Projects"
                  onChange={(e) => edit(s.id, "label", e.target.value)}
                  onBlur={() => patch(s, "label")} />
                <label>Address</label>
                <input value={draft[s.id]?.address ?? ""} placeholder="Street, suburb, city"
                  onChange={(e) => edit(s.id, "address", e.target.value)}
                  onBlur={() => patch(s, "address")} />
                <label>Contact name</label>
                <input value={draft[s.id]?.contact_name ?? ""}
                  onChange={(e) => edit(s.id, "contact_name", e.target.value)}
                  onBlur={() => patch(s, "contact_name")} />
                <label>Contact phone</label>
                <input value={draft[s.id]?.contact_phone ?? ""}
                  onChange={(e) => edit(s.id, "contact_phone", e.target.value)}
                  onBlur={() => patch(s, "contact_phone")} />
              </div>
            ))}
            {list.length < 3 && (
              <button className="btn btn-ghost" style={{ marginTop: 0, marginBottom: 12 }}
                onClick={() => addStop(kind)}>
                ＋ Add {list.length ? "another " : ""}{one}
              </button>
            )}
          </React.Fragment>
        );
      })}

      {/* A site is unusual enough to hide until asked for. */}
      {of("site").length === 0 && (
        <button className="btn btn-ghost" style={{ marginTop: 0, marginBottom: 12 }}
          onClick={() => addStop("site")}>
          ＋ Add a site address (work happens here, nothing moves)
        </button>
      )}
    </div>
  );
}
