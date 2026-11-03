import React, { useContext, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { Ctx } from "../main";
import ClientAliases from "./ClientAliases";

// The workspace's clients. Ops only, and scoped by RLS - Section 9's clients
// are invisible to every other workspace.

const FIELDS = [
  ["legal_name",      "Legal name",       "Blank Projects (Pty) Ltd"],
  ["billing_address", "Billing address",  "10 Lewin Street, Woodstock, Cape Town 7925"],
  ["vat_number",      "VAT number",       ""],
  ["eori_number",     "EORI number",      "For EU/UK consignees"],
  ["reg_number",      "Company reg. no.", ""],
  ["billing_email",   "Billing email",    "accounts@…"],
  ["country",         "Country",          "ZA"],
];

// --- the billing run --------------------------------------------------------
// When a customer's pack goes out, and to whom.
//
// Three settings underneath, one question on screen. billing_direct and
// billing_to are not independent in practice - "send it to the client" and
// "send it to this address instead" are two answers to the same question -
// so they are asked as one choice and written as whichever pair that means.
//
// The line at the bottom spells the arrangement back out: the date it next
// falls on, the address it reaches, and whether a person sees it first. A
// billing day set to the wrong number is not visible until the wrong month,
// and by then an invoice pack has gone somewhere.

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const ordinal = (d) => {
  const s = ["th", "st", "nd", "rd"][d % 100 >= 11 && d % 100 <= 13 ? 0 : Math.min(d % 10, 4)] ?? "th";
  return `${d}${s}`;
};

/** The next date a given billing day falls on, clamped to month end the same
 *  way due_billing_runs does it in the database. */
export function nextBillingDate(day, from = new Date()) {
  if (!day) return null;
  for (let i = 0; i < 2; i++) {
    const y = from.getFullYear(), m = from.getMonth() + i;
    const last = new Date(y, m + 1, 0).getDate();
    const d = new Date(y, m, Math.min(day, last));
    if (d >= new Date(from.getFullYear(), from.getMonth(), from.getDate())) return d;
  }
  return null;
}

function BillingRun({ row, draft, set, save, workspaceEmail }) {
  const day = draft.billing_day ?? null;
  const to = (draft.billing_to ?? "").trim();
  const direct = !!draft.billing_direct;

  // Held, not derived.
  //
  // Reading the mode back out of the data looks tidier and does not work:
  // "another address" with nothing typed into it yet is indistinguishable
  // from "to the office", so picking it snapped the dropdown straight back
  // and the field never appeared. The data says where the pack goes; this
  // says what the person is in the middle of telling it.
  const [mode, setMode] = useState(to ? "other" : direct ? "client" : "office");
  useEffect(() => {
    setMode(to ? "other" : direct ? "client" : "office");
    // Only when the card changes to a different client, not on every keystroke.
  }, [row.id]);

  const choose = (next) => {
    setMode(next);
    const patch = next === "office" ? { billing_direct: false, billing_to: null }
      : next === "client" ? { billing_direct: true, billing_to: null }
      : { billing_direct: false, billing_to: "" };
    set(patch);
    // "Another address" is not written until something is typed into it:
    // storing a blank would quietly mean "the office" while the screen said
    // otherwise.
    if (next !== "other") save(row, patch);
  };

  const when = nextBillingDate(day);
  const lands = mode === "other" ? to
    : mode === "client" ? (draft.billing_email || "")
    : workspaceEmail;

  return (
    <div style={{ borderTop: "1px solid var(--line)", marginTop: 14, paddingTop: 12 }}>
      <label>Billing run</label>
      <div className="muted" style={{ fontSize: 12, marginTop: -4, marginBottom: 8 }}>
        Each month, this client's invoices and their statement are gathered into
        one PDF and emailed automatically.
      </div>

      <label style={{ fontWeight: 400, fontSize: 13 }}>Send on the</label>
      <select value={day ?? ""}
        onChange={(e) => {
          const v = e.target.value === "" ? null : Number(e.target.value);
          set({ billing_day: v });
          save(row, { billing_day: v });
        }}>
        <option value="">Not automatic — I'll send it myself</option>
        {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
          <option key={d} value={d}>{ordinal(d)} of the month</option>
        ))}
      </select>

      {day != null && (
        <>
          <label style={{ fontWeight: 400, fontSize: 13, marginTop: 10 }}>Send it to</label>
          <select value={mode} onChange={(e) => choose(e.target.value)}>
            <option value="office">Us, to check and forward</option>
            <option value="client">The client, directly</option>
            <option value="other">Another address</option>
          </select>

          {mode === "other" && (
            <input style={{ marginTop: 8 }} type="email" placeholder="bookkeeper@…"
              value={draft.billing_to ?? ""}
              onChange={(e) => set({ billing_to: e.target.value })}
              onBlur={() => save(row, { billing_to: (draft.billing_to ?? "").trim() || null })} />
          )}

          {mode === "client" && !draft.billing_email && (
            <div className="muted" style={{ fontSize: 12, marginTop: 6, color: "var(--warn)" }}>
              This client has no billing email, so nothing can be sent. Fill one in above.
            </div>
          )}

          <div className="card" style={{ marginTop: 10, background: "var(--bg)" }}>
            {when && lands ? (
              <>
                <div style={{ fontSize: 13 }}>
                  Next on <b>{when.getDate()} {MONTHS[when.getMonth()]} {when.getFullYear()}</b>, to <b>{lands}</b>
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                  {mode === "client"
                    ? "It goes straight to the client. Nobody sees it first."
                    : "You get a reminder with it, to check and forward."}
                </div>
              </>
            ) : (
              <div className="muted" style={{ fontSize: 13 }}>
                Nothing will be sent until there is an address for it to go to.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function Clients() {
  const { profile } = useContext(Ctx);
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({});
  const [adding, setAdding] = useState("");
  const [msg, setMsg] = useState("");
  // Where a pack goes when it stops at the office. Read once, so the line
  // under the billing settings can name the actual address rather than
  // saying "us" and leaving somebody to wonder which inbox.
  const [workspaceEmail, setWorkspaceEmail] = useState("");

  const isOps = profile?.role === "ops";

  const load = async () => {
    const { data } = await supabase.from("clients").select("*").order("name");
    setRows(data ?? []);
  };
  useEffect(() => { if (isOps) load(); }, [isOps]);
  useEffect(() => {
    if (!isOps) return;
    supabase.from("workspace_billing").select("billing_email").maybeSingle()
      .then(({ data }) => setWorkspaceEmail(data?.billing_email || ""));
  }, [isOps]);

  if (!isOps) return <div className="page empty">Only ops can manage clients.</div>;

  const shown = rows.filter((r) => {
    const t = q.trim().toLowerCase();
    if (!t) return true;
    return [r.name, r.legal_name, ...(r.aliases ?? []),
            r.vat_number, r.billing_email, r.billing_address]
      .filter(Boolean).some((v) => v.toLowerCase().includes(t));
  });

  const save = async (row, patch) => {
    const { data, error } = await supabase.from("clients")
      .update(patch).eq("id", row.id).select("id");
    if (error) { setMsg("Could not save: " + error.message); return; }
    if (!data?.length) { setMsg("That change was refused by the database."); return; }
    setMsg("");
    await load();
  };

  const add = async () => {
    const name = adding.trim();
    if (!name) return;
    const { data, error } = await supabase.from("clients")
      .insert({ tenant_id: profile.tenant_id, name, legal_name: name })
      .select().single();
    if (error) {
      setMsg(error.code === "23505" ? `"${name}" is already a client.` : error.message);
      return;
    }
    setAdding(""); setMsg("");
    await load();
    setEditing(data.id); setDraft(data);
  };

  return (
    <div className="page">
      <Link className="muted" style={{ marginBottom: 10 }} to="/dashboard">← Office</Link>
      <h1>Clients</h1>
      <p className="muted">
        Billing details kept once and copied onto a job when you invoice it.
      </p>

      {msg && <div className="card" style={{ color: "var(--warn)" }}>{msg}</div>}

      <input value={q} onChange={(e) => setQ(e.target.value)}
        placeholder="Search by name, VAT number, email…" aria-label="Search clients" />

      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
        {shown.length} of {rows.length}
      </div>

      {shown.map((r) => (
        <div className="card" key={r.id}>
          {editing === r.id ? (
            <>
              <label>Name</label>
              <input value={draft.name ?? ""}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                onBlur={() => save(r, { name: draft.name })} />
              <ClientAliases
                client={{ ...r, ...draft }}
                others={rows}
                onChange={(aliases) => {
                  setDraft({ ...draft, aliases });
                  save(r, { aliases });
                }}
              />
              {FIELDS.map(([key, label, ph]) => (
                <div key={key}>
                  <label>{label}</label>
                  {key === "billing_address" ? (
                    <textarea rows={3} value={draft[key] ?? ""} placeholder={ph}
                      onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                      onBlur={() => save(r, { [key]: draft[key] })} />
                  ) : (
                    <input value={draft[key] ?? ""} placeholder={ph}
                      onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                      onBlur={() => save(r, { [key]: draft[key] })} />
                  )}
                </div>
              ))}
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 400 }}>
                <input type="checkbox" style={{ width: 18, height: 18 }}
                  checked={draft.vat_applicable !== false}
                  onChange={(e) => {
                    setDraft({ ...draft, vat_applicable: e.target.checked });
                    save(r, { vat_applicable: e.target.checked });
                  }} />
                <span>Charge VAT
                  <br /><span className="muted" style={{ fontSize: 12 }}>
                    Turn off for entities billed outside South Africa.
                  </span>
                </span>
              </label>
              <BillingRun
                row={r}
                draft={draft}
                set={(patch) => setDraft((d) => ({ ...d, ...patch }))}
                save={save}
                workspaceEmail={workspaceEmail}
              />
              <button className="btn btn-ghost" onClick={() => setEditing(null)}>Done</button>
            </>
          ) : (
            <div className="row" style={{ alignItems: "baseline", cursor: "pointer" }}
              onClick={() => { setEditing(r.id); setDraft(r); }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{r.legal_name || r.name}</div>
                {(r.aliases?.length > 0) && (
                  <div className="muted" style={{ fontSize: 13 }}>
                    also called {r.aliases.join(", ")}
                  </div>
                )}
                <div className="muted" style={{ fontSize: 13 }}>
                  {[r.vat_number && `VAT ${r.vat_number}`,
                    r.eori_number && `EORI ${r.eori_number}`,
                    r.country,
                    r.vat_applicable === false && "zero-rated"].filter(Boolean).join(" · ")
                    || "no billing details yet"}
                </div>
                {/* Said on the row as well as in the panel: whether a client
                    is billed automatically is the kind of thing you want to
                    see down a list, not by opening fifteen of them. */}
                {r.billing_day != null && (
                  <div className="muted" style={{ fontSize: 13 }}>
                    billed {ordinal(r.billing_day)} monthly
                    {r.billing_direct && !r.billing_to ? " · straight to the client" : ""}
                    {r.billing_to ? ` · to ${r.billing_to}` : ""}
                  </div>
                )}
              </div>
              <span className="muted" style={{ fontSize: 13, flexShrink: 0 }}>edit</span>
            </div>
          )}
        </div>
      ))}

      {rows.length === 0 && (
        <div className="empty">No clients yet. Add one below, or save one from a job.</div>
      )}

      <div className="card">
        <label>Add a client</label>
        <input value={adding} placeholder="Gallery or company name"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="btn btn-primary" disabled={!adding.trim()} onClick={add}>
          Add client
        </button>
      </div>
    </div>
  );
}
