import React from "react";
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

  const patch = async (stop, field, value) => {
    const { error } = await supabase.from("job_stops")
      .update({ [field]: value || null }).eq("id", stop.id);
    if (error) { setMsg(error.message); return; }
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
    <>
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
                    {list.length > 1 ? `${i + 1} of ${list.length}` : "\u00a0"}
                  </span>
                  <button onClick={() => removeStop(s)}
                    style={{ background: "none", border: "none", color: "var(--warn)",
                      cursor: "pointer", font: "inherit", fontSize: 13, padding: 0 }}>
                    remove
                  </button>
                </div>
                <label>Name (optional)</label>
                <input defaultValue={s.label ?? ""} placeholder="Workshop, Blank Projects"
                  onBlur={(e) => patch(s, "label", e.target.value)} />
                <label>Address</label>
                <input defaultValue={s.address ?? ""}
                  onBlur={(e) => patch(s, "address", e.target.value)} />
                <label>Contact name</label>
                <input defaultValue={s.contact_name ?? ""}
                  onBlur={(e) => patch(s, "contact_name", e.target.value)} />
                <label>Contact phone</label>
                <input defaultValue={s.contact_phone ?? ""}
                  onBlur={(e) => patch(s, "contact_phone", e.target.value)} />
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
    </>
  );
}
