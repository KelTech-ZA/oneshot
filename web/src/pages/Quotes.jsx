import React, { useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { Ctx } from "../main";
import { VAT_CHOICES, pct, subtotalOf, vatBreakdown, vatChoiceOf, vatValueOf } from "../lib/vat";

// Quotes, and the two things a quote becomes.
//
// The table and its functions have existed since sql/55 - lines, a bill-to
// snapshot, a validity date, accept and decline - and nothing in the app ever
// showed them, so not one quote has ever been raised. sql/64 added the two
// conversions the table was always shaped for: converted_invoice_id and
// converted_job_id.
//
// VAT is per line (sql/66, and sql/69 for this screen's own function). Whether
// the quote charges VAT at all is not this form's decision - the server works
// it out from the job, then the client, then whether the workspace has a VAT
// number - so the preview below resolves it the same way rather than assuming
// 15%, which is what it used to do.
//
// A quote may become both a job and an invoice. That is deliberate: a deposit
// invoiced up front and the balance billed off the job is ordinary. It also
// means nothing stops the same work being billed twice, so a quote holding
// both says so on its face rather than looking like any other accepted quote.

const today = () => new Date().toISOString().slice(0, 10);
const money = (v) => (Number(v) || 0).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const blankLine = () => ({ description: "", unit: "", quantity: "1", unit_price: "", vat_rate: "" });

// The standard rate. create_quote resolves the document's rate from the job
// first, and this screen never quotes against a job, so 15 is what the server
// will use for anything raised here.
const DRAFT_RATE = 15;

export default function Quotes() {
  const { profile } = useContext(Ctx);
  const [rows, setRows] = useState([]);
  const [clients, setClients] = useState([]);
  const [jobTypes, setJobTypes] = useState([]);
  const [issuer, setIssuer] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState(false);
  const [jobFor, setJobFor] = useState(null);     // quote id whose job form is open

  const [f, setF] = useState({
    client_id: "", their_reference: "", notes: "", lines: [blankLine()],
  });
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const setLine = (i, p) => setF((x) => ({ ...x, lines: x.lines.map((l, n) => n === i ? { ...l, ...p } : l) }));

  // The job being built from a quote. Prefilled from the quote's job_draft
  // where the parser left one, and from the quote itself where it did not —
  // a quote typed out by hand still knows the customer and the reference.
  const [job, setJob] = useState(null);

  const load = async () => {
    const [{ data: q }, { data: cl }, { data: jt }, { data: wb }] = await Promise.all([
      supabase.from("quote_ledger").select("*").order("created_at", { ascending: false }).limit(200),
      supabase.from("clients").select("id,name,legal_name,vat_applicable").order("name"),
      supabase.from("job_types").select("key,label").eq("active", true).order("sort"),
      supabase.from("workspace_billing").select("vat_number").maybeSingle(),
    ]);
    setRows(q ?? []); setClients(cl ?? []); setJobTypes(jt ?? []); setIssuer(wb ?? null);
  };
  useEffect(() => { load(); }, []);

  // The same order create_quote uses: the client first - an export client is
  // zero-rated whatever the workspace does - then whether this workspace is
  // registered for VAT at all.
  const vatable = useMemo(() => {
    const c = clients.find((x) => x.id === f.client_id);
    if (c && c.vat_applicable !== null && c.vat_applicable !== undefined) return !!c.vat_applicable;
    return !!String(issuer?.vat_number ?? "").trim();
  }, [clients, f.client_id, issuer]);

  const totals = useMemo(() => {
    const split = vatBreakdown(f.lines, vatable, DRAFT_RATE);
    const sub = subtotalOf(f.lines);
    const vat = split.reduce((t, g) => t + Number(g.vat), 0);
    return { sub, vat, total: sub + vat, split, mixed: split.length > 1 };
  }, [f.lines, vatable]);

  const create = async () => {
    const lines = f.lines.filter((l) => l.description.trim()).map((l) => ({
      description: l.description.trim(),
      unit: l.unit.trim() || null,
      quantity: Number(l.quantity) || 1,
      unit_price: Number(l.unit_price) || 0,
      // null means "at whatever rate this quote is at", which is what the
      // database stores for every line that has no opinion.
      vat_rate: vatValueOf(l.vat_rate),
    }));
    if (!lines.length) { setMsg("A quote needs at least one line with a description."); return; }
    setBusy(true); setMsg("");
    const { data, error } = await supabase.rpc("create_quote", {
      p_lines: lines,
      p_client_id: f.client_id || null,
      p_job_id: null,
      p_job_draft: null,
      p_their_ref: f.their_reference || null,
      p_notes: f.notes || null,
    });
    setBusy(false);
    if (error) { setMsg(error.message); return; }
    const q = Array.isArray(data) ? data[0] : data;
    setMsg(`Quote ${q?.number ?? ""} raised.`);
    setOpen(false);
    setF({ client_id: "", their_reference: "", notes: "", lines: [blankLine()] });
    await load();
  };

  const call = async (fn, args, done) => {
    setBusy(true); setMsg("");
    const { data, error } = await supabase.rpc(fn, args);
    setBusy(false);
    if (error) { setMsg(error.message); return null; }
    const r = Array.isArray(data) ? data[0] : data;
    if (done) setMsg(done(r));
    await load();
    return r;
  };

  const openJobForm = (q) => {
    const d = q.job_draft || {};
    setJobFor(q.id);
    setMsg("");
    setJob({
      type: d.type || jobTypes[0]?.key || "delivery",
      client_ref: q.their_reference || "",
      origin: d.origin?.address || "",
      destination: d.destination?.address || "",
      date: d.scheduled_date || "",
      time: d.time_window || "",
      items: Array.isArray(d.items)
        ? d.items.map((i) => (typeof i === "string" ? i : i?.description || "")).filter(Boolean).join("\n")
        : "",
    });
  };

  // Built the same way the Office page builds one, so there is one shape of
  // job on the board rather than two.
  const makeJob = async (q) => {
    setBusy(true); setMsg("");
    const { data: created, error } = await supabase.from("jobs").insert({
      tenant_id: profile.tenant_id,
      type: job.type,
      origin: job.origin ? { address: job.origin } : null,
      destination: job.destination ? { address: job.destination } : null,
      client_ref: job.client_ref || null,
      client_id: q.client_id || null,
      scheduled_date: job.date || null,
      time_window: job.time || null,
      status: "confirmed",
      created_by: profile.id,
    }).select().single();
    if (error || !created) { setBusy(false); setMsg("Could not create the job: " + (error?.message ?? "unknown")); return; }

    const items = job.items.split("\n").map((s) => s.trim()).filter(Boolean)
      .map((description) => ({ tenant_id: profile.tenant_id, job_id: created.id, description }));
    if (items.length) await supabase.from("line_items").insert(items);

    const { error: linkErr } = await supabase.rpc("convert_quote_to_job", {
      p_quote: q.id, p_job: created.id,
    });
    setBusy(false);
    // The job exists either way. Saying so matters: otherwise somebody makes
    // it a second time and the board carries two.
    setMsg(linkErr
      ? `Job ${created.ref || ""} was created but could not be tied to ${q.number}: ${linkErr.message}`
      : `${q.number} is now job ${created.ref || ""}.`);
    setJobFor(null); setJob(null);
    await load();
  };

  const stamp = (q) =>
    q.status === "declined" ? "bad" : q.status === "accepted" ? "done" : q.status === "sent" ? "live" : "";

  return (
    <div className="page">
      <h1>Quotes</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Price the work before it is booked. An accepted quote becomes a job, an
        invoice, or both.
      </p>

      {msg && <div className="card" style={{ borderColor: "var(--accent)" }}>{msg}</div>}

      {!open ? (
        <button className="btn btn-accent" onClick={() => setOpen(true)}>＋ New quote</button>
      ) : (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>New quote</h2>
          <label>For</label>
          <select value={f.client_id} onChange={(e) => set({ client_id: e.target.value })}>
            <option value="">Someone not saved as a client…</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.legal_name || c.name}</option>)}
          </select>
          <label>Their reference</label>
          <input value={f.their_reference} placeholder="PO number or what they called it"
            onChange={(e) => set({ their_reference: e.target.value })} />

          <label>Lines</label>
          {f.lines.map((l, i) => (
            <div className="card" key={i} style={{ background: "var(--bg)", marginBottom: 8 }}>
              <input value={l.description} placeholder="What is being quoted for"
                onChange={(e) => setLine(i, { description: e.target.value })} />
              <div className="row" style={{ gap: 8 }}>
                <input style={{ flex: 1, minWidth: 0 }} value={l.unit} placeholder="unit"
                  onChange={(e) => setLine(i, { unit: e.target.value })} />
                <input style={{ flex: 1, minWidth: 0 }} value={l.quantity} inputMode="decimal" placeholder="qty"
                  onChange={(e) => setLine(i, { quantity: e.target.value })} />
                <input style={{ flex: 1, minWidth: 0 }} value={l.unit_price} inputMode="decimal" placeholder="price"
                  onChange={(e) => setLine(i, { unit_price: e.target.value })} />
              </div>
              <div className="row">
                <select value={vatChoiceOf(l)} disabled={!vatable}
                  aria-label={`VAT on line ${i + 1}`}
                  onChange={(e) => setLine(i, { vat_rate: e.target.value })}
                  style={{ width: "auto", minWidth: 110, marginBottom: 0, fontSize: 13 }}>
                  {VAT_CHOICES(DRAFT_RATE).map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
                <span className="muted" style={{ marginLeft: "auto" }}>
                  {money((Number(l.quantity) || 0) * (Number(l.unit_price) || 0))}
                </span>
                {f.lines.length > 1 && (
                  <button className="topbar-link" style={{ color: "var(--warn)" }}
                    onClick={() => setF((x) => ({ ...x, lines: x.lines.filter((_, n) => n !== i) }))}>remove</button>
                )}
              </div>
            </div>
          ))}
          <button className="btn btn-ghost" style={{ minHeight: 44 }}
            onClick={() => setF((x) => ({ ...x, lines: [...x.lines, blankLine()] }))}>＋ Add a line</button>

          <label>Notes</label>
          <textarea rows={2} value={f.notes} placeholder="Anything that should appear on the quote"
            onChange={(e) => set({ notes: e.target.value })} />

          <div className="card" style={{ background: "var(--bg)", marginTop: 12 }}>
            <div className="row"><span className="muted">Subtotal</span><span>{money(totals.sub)}</span></div>
            {/* A quote covering supplies at more than one rate says what was
                taxed and what was not, the way the invoice it becomes will. */}
            {totals.mixed ? totals.split.map((g) => (
              <div className="row" key={g.rate}>
                <span className="muted">
                  {Number(g.rate) > 0
                    ? `VAT ${pct(g.rate)} on ${money(g.net)}`
                    : `Zero-rated ${money(g.net)}`}
                </span>
                <span>{money(g.vat)}</span>
              </div>
            )) : (
              <div className="row">
                <span className="muted">
                  {vatable ? `VAT at ${pct(DRAFT_RATE)}` : "VAT — zero-rated"}
                </span>
                <span>{money(totals.vat)}</span>
              </div>
            )}
            <div className="row" style={{ fontWeight: 700 }}><span>Total</span><span>{money(totals.total)}</span></div>
            {!vatable && (
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                {f.client_id
                  ? "This client is billed outside South Africa, so the quote is zero-rated."
                  : "This workspace has no VAT number in Billing settings, so nothing is quoted with VAT."}
              </div>
            )}
          </div>

          <button className="btn btn-accent" disabled={busy} onClick={create}>
            {busy ? "Raising…" : "Raise quote"}
          </button>
          <button className="btn btn-ghost" onClick={() => { setOpen(false); setMsg(""); }}>Cancel</button>
        </div>
      )}

      {rows.length === 0 && <div className="empty">No quotes yet.</div>}

      {rows.map((q) => (
        <div className="card" key={q.id}>
          <div className="row">
            <span className="ref">{q.number}</span>
            <span className={`stamp ${stamp(q)}`}>{(q.status || "draft").toUpperCase()}</span>
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <span className="muted">
              {q.quote_date} · {q.bill_to_name || "—"}
              {q.valid_until ? ` · valid to ${q.valid_until}` : ""}
            </span>
            <span>{q.currency} {money(q.total)}</span>
          </div>

          {(q.converted_job_id || q.converted_invoice_id) && (
            <div className="row" style={{ marginTop: 4 }}>
              <span className="muted">
                Became {q.converted_job_id ? (q.job_ref || "a job") : ""}
                {q.converted_job_id && q.converted_invoice_id ? " and " : ""}
                {q.converted_invoice_id ? "an invoice" : ""}
              </span>
            </div>
          )}
          {q.converted_job_id && q.converted_invoice_id && (
            <div className="card" style={{ background: "var(--bg)", borderColor: "var(--warn)", marginTop: 8 }}>
              <span className="muted">
                This quote has both a job and an invoice. If the job is invoiced as
                well, the same work is billed twice — nothing here checks that for you.
              </span>
            </div>
          )}

          {q.status !== "declined" && (
            <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              {q.status === "draft" && (
                <button className="btn btn-ghost" style={{ flex: "1 1 140px", marginTop: 0, minHeight: 44 }}
                  disabled={busy}
                  onClick={() => call("send_quote", { p_quote: q.id }, (r) => `${r?.number ?? "Quote"} marked as sent.`)}>
                  Mark as sent
                </button>
              )}
              {!q.converted_job_id && (
                <button className="btn btn-ghost" style={{ flex: "1 1 140px", marginTop: 0, minHeight: 44 }}
                  disabled={busy} onClick={() => openJobForm(q)}>
                  Make it a job
                </button>
              )}
              {!q.converted_invoice_id && (
                <button className="btn btn-primary" style={{ flex: "1 1 140px", marginTop: 0, minHeight: 44 }}
                  disabled={busy}
                  onClick={() => call("convert_quote_to_invoice", { p_quote: q.id },
                    (r) => `Invoice ${r?.number ?? ""} raised from ${q.number}.`)}>
                  Invoice it
                </button>
              )}
              {q.status !== "accepted" && (
                <button className="topbar-link" style={{ color: "var(--warn)", flex: "0 0 auto" }}
                  disabled={busy}
                  onClick={() => {
                    const why = window.prompt(`Why was ${q.number} declined?`);
                    if (why !== null) call("decline_quote", { p_quote: q.id, p_reason: why || null },
                      () => `${q.number} marked as declined.`);
                  }}>decline</button>
              )}
            </div>
          )}

          {jobFor === q.id && job && (
            <div className="card" style={{ background: "var(--bg)", marginTop: 10 }}>
              <h3 style={{ marginTop: 0 }}>The job for {q.number}</h3>
              <p className="muted" style={{ marginTop: -4 }}>
                {q.job_draft ? "Filled in from the message this was quoted from."
                             : "This quote was written by hand, so there are no addresses to carry over."}
              </p>
              <label>Type</label>
              <select value={job.type} onChange={(e) => setJob({ ...job, type: e.target.value })}>
                {jobTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
              <label>Client reference</label>
              <input value={job.client_ref} onChange={(e) => setJob({ ...job, client_ref: e.target.value })} />
              <label>Origin address</label>
              <input value={job.origin} onChange={(e) => setJob({ ...job, origin: e.target.value })} />
              <label>Destination address</label>
              <input value={job.destination} onChange={(e) => setJob({ ...job, destination: e.target.value })} />
              <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <label>Date</label>
                  <input type="date" value={job.date} onChange={(e) => setJob({ ...job, date: e.target.value })} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <label>Time window</label>
                  <input value={job.time} placeholder="09:00-12:00"
                    onChange={(e) => setJob({ ...job, time: e.target.value })} />
                </div>
              </div>
              <label>Items — one per line</label>
              <textarea rows={3} value={job.items}
                onChange={(e) => setJob({ ...job, items: e.target.value })} />
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-accent" style={{ flex: 1, marginTop: 0 }}
                  disabled={busy} onClick={() => makeJob(q)}>Create the job</button>
                <button className="btn btn-ghost" style={{ flex: 1, marginTop: 0 }}
                  onClick={() => { setJobFor(null); setJob(null); }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
