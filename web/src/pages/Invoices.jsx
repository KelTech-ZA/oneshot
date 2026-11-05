import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";

// Invoices that do not come from a job.
//
// Billing has only ever run one way round: do the work, then bill it. A
// deposit asked for before anyone is booked, a storage month against no
// particular movement, or a client who wants the invoice on Friday for work
// that gets scheduled on Monday all have the invoice first and the job - if
// there is ever a job - after.
//
// So this does two things the rest of the app cannot: issue an invoice with
// nothing behind it, and put a job onto one later. Everything else about the
// invoice is unchanged - same number series, same printouts, same statement.

const today = () => new Date().toISOString().slice(0, 10);
const money = (v) => (Number(v) || 0).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const blankLine = () => ({ description: "", unit: "", quantity: "1", unit_price: "" });

export default function Invoices() {
  const [rows, setRows] = useState([]);
  const [clients, setClients] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState(false);
  const [attaching, setAttaching] = useState(null);   // invoice id being attached
  const [pickJob, setPickJob] = useState("");

  const [f, setF] = useState({
    client_id: "", invoice_date: today(), their_reference: "",
    payment_terms: "", due_date: "", vat_applicable: true, notes: "",
    bill_to_name: "", lines: [blankLine()],
  });
  const set = (p) => setF((x) => ({ ...x, ...p }));
  const setLine = (i, p) => setF((x) => ({ ...x, lines: x.lines.map((l, n) => n === i ? { ...l, ...p } : l) }));

  const load = async () => {
    const [{ data: inv }, { data: cl }, { data: jb }] = await Promise.all([
      supabase.from("invoice_ledger").select("*").order("invoice_date", { ascending: false }).limit(200),
      supabase.from("clients").select("id,name,legal_name").order("name"),
      supabase.from("jobs").select("id,ref,scheduled_date").order("created_at", { ascending: false }).limit(300),
    ]);
    setRows(inv ?? []); setClients(cl ?? []); setJobs(jb ?? []);
  };
  useEffect(() => { load(); }, []);

  // Shown while typing. The server works the real figures out again from the
  // lines it is sent — this is only so nobody has to total it in their head.
  const totals = useMemo(() => {
    const sub = f.lines.reduce((t, l) =>
      t + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0);
    const vat = f.vat_applicable ? sub * 0.15 : 0;
    return { sub, vat, total: sub + vat };
  }, [f.lines, f.vat_applicable]);

  const create = async () => {
    const lines = f.lines
      .filter((l) => l.description.trim())
      .map((l) => ({
        description: l.description.trim(),
        unit: l.unit.trim() || null,
        quantity: Number(l.quantity) || 1,
        unit_price: Number(l.unit_price) || 0,
      }));
    if (!lines.length) { setMsg("An invoice needs at least one line with a description."); return; }

    setBusy(true); setMsg("");
    const { data, error } = await supabase.rpc("create_invoice", {
      p_lines: lines,
      p_client_id: f.client_id || null,
      p_invoice_date: f.invoice_date || today(),
      p_their_reference: f.their_reference || null,
      p_notes: f.notes || null,
      p_payment_terms: f.payment_terms || null,
      p_due_date: f.due_date || null,
      p_vat_applicable: f.vat_applicable,
      p_bill_to_name: f.client_id ? null : (f.bill_to_name || null),
    });
    setBusy(false);
    if (error) { setMsg(error.message); return; }
    setMsg(`Invoice ${data?.number ?? ""} issued.`);
    setOpen(false);
    setF({ client_id: "", invoice_date: today(), their_reference: "", payment_terms: "",
           due_date: "", vat_applicable: true, notes: "", bill_to_name: "", lines: [blankLine()] });
    await load();
  };

  const attach = async (invoiceId) => {
    if (!pickJob) { setMsg("Pick a job first."); return; }
    setBusy(true); setMsg("");
    const { data, error } = await supabase.rpc("attach_invoice_to_job", {
      p_invoice: invoiceId, p_job: pickJob,
    });
    setBusy(false);
    if (error) { setMsg(error.message); return; }
    setMsg(`${data?.number ?? "Invoice"} is now on ${data?.job_ref ?? "the job"}.`);
    setAttaching(null); setPickJob("");
    await load();
  };

  // Changing it afterwards, for the invoice that was raised on ordinary terms
  // and then agreed as cash on the day.
  const [dueFor, setDueFor] = useState(null);
  const [dueDate, setDueDate] = useState("");
  const [dueTerms, setDueTerms] = useState("");
  const changeDue = async (id) => {
    setBusy(true); setMsg("");
    const { data, error } = await supabase.rpc("change_invoice_due_date", {
      p_invoice: id,
      p_due_date: dueDate || null,
      p_payment_terms: dueTerms || null,
    });
    setBusy(false);
    if (error) { setMsg(error.message); return; }
    setMsg(`${data?.number ?? "Invoice"} is now due ${String(data?.due_date ?? "").slice(0, 10)}.`);
    setDueFor(null); setDueDate(""); setDueTerms("");
    await load();
  };

  const unattached = rows.filter((r) => !r.job_id && r.status !== "void");

  return (
    <div className="page">
      <h1>Invoices</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Invoices raised from a job appear here too. These are the ones that did not
        come from a job — a deposit, storage, anything billed before the work is booked.
      </p>

      {msg && <div className="card" style={{ borderColor: "var(--accent)" }}>{msg}</div>}

      {!open ? (
        <button className="btn btn-accent" onClick={() => setOpen(true)}>＋ New invoice</button>
      ) : (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>New invoice</h2>

          <label>Bill to</label>
          <select value={f.client_id} onChange={(e) => set({ client_id: e.target.value })}>
            <option value="">Someone not saved as a client…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.legal_name || c.name}</option>
            ))}
          </select>
          {!f.client_id && (
            <>
              <label>Their name, as it should print</label>
              <input value={f.bill_to_name} placeholder="Verso Gallery (Pty) Ltd"
                onChange={(e) => set({ bill_to_name: e.target.value })} />
            </>
          )}

          <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <label>Invoice date</label>
              <input type="date" value={f.invoice_date}
                onChange={(e) => set({ invoice_date: e.target.value })} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <label>Their reference</label>
              <input value={f.their_reference} placeholder="PO number, if they use one"
                onChange={(e) => set({ their_reference: e.target.value })} />
            </div>
          </div>

          <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <label>Payment terms</label>
              <input value={f.payment_terms} placeholder="30 days, COD, prepaid…"
                onChange={(e) => set({ payment_terms: e.target.value })} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <label>Due date</label>
              <input type="date" value={f.due_date}
                onChange={(e) => set({ due_date: e.target.value })} />
            </div>
          </div>
          <p className="muted" style={{ marginTop: -6, marginBottom: 12 }}>
            Leave the date blank and it is worked out from the terms. COD, prepaid and
            "on receipt" mean due the same day.
          </p>

          <label>Lines</label>
          {f.lines.map((l, i) => (
            <div className="card" key={i} style={{ background: "var(--bg)", marginBottom: 8 }}>
              <input value={l.description} placeholder="What is being charged for"
                onChange={(e) => setLine(i, { description: e.target.value })} />
              <div className="row" style={{ gap: 8 }}>
                <input style={{ flex: 1, minWidth: 0 }} value={l.unit} placeholder="unit (crate, hour…)"
                  onChange={(e) => setLine(i, { unit: e.target.value })} />
                <input style={{ flex: 1, minWidth: 0 }} value={l.quantity} inputMode="decimal" placeholder="qty"
                  onChange={(e) => setLine(i, { quantity: e.target.value })} />
                <input style={{ flex: 1, minWidth: 0 }} value={l.unit_price} inputMode="decimal" placeholder="price"
                  onChange={(e) => setLine(i, { unit_price: e.target.value })} />
              </div>
              <div className="row">
                <span className="muted">
                  {money((Number(l.quantity) || 0) * (Number(l.unit_price) || 0))}
                </span>
                {f.lines.length > 1 && (
                  <button className="topbar-link" style={{ color: "var(--warn)" }}
                    onClick={() => setF((x) => ({ ...x, lines: x.lines.filter((_, n) => n !== i) }))}>
                    remove
                  </button>
                )}
              </div>
            </div>
          ))}
          <button className="btn btn-ghost" style={{ minHeight: 44 }}
            onClick={() => setF((x) => ({ ...x, lines: [...x.lines, blankLine()] }))}>
            ＋ Add a line
          </button>

          <div className="card" style={{ background: "var(--bg)", marginTop: 12 }}>
            <div className="row"><span className="muted">Subtotal</span><span>{money(totals.sub)}</span></div>
            <div className="row">
              <label style={{ margin: 0, display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" style={{ width: "auto", margin: 0 }}
                  checked={f.vat_applicable}
                  onChange={(e) => set({ vat_applicable: e.target.checked })} />
                VAT at 15%
              </label>
              <span>{money(totals.vat)}</span>
            </div>
            <div className="row" style={{ fontWeight: 700 }}>
              <span>Total</span><span>{money(totals.total)}</span>
            </div>
          </div>

          <button className="btn btn-accent" disabled={busy} onClick={create}>
            {busy ? "Issuing…" : "Issue invoice"}
          </button>
          <button className="btn btn-ghost" onClick={() => { setOpen(false); setMsg(""); }}>Cancel</button>
          <p className="muted" style={{ marginTop: 10 }}>
            It takes the next number in your series the moment you issue it, exactly as
            an invoice raised from a job does. There is no draft to come back to.
          </p>
        </div>
      )}

      {unattached.length > 0 && (
        <>
          <h2>Waiting for a job</h2>
          {unattached.map((r) => (
            <div className="card" key={r.id}>
              <div className="row">
                <span className="ref">{r.number}</span>
                <span>{r.currency} {money(r.total)}</span>
              </div>
              <div className="muted" style={{ marginTop: 2 }}>
                {r.invoice_date} · {r.bill_to_name || "no customer on it"}
              </div>
              {attaching === r.id ? (
                <div style={{ marginTop: 10 }}>
                  <label>Which job?</label>
                  <select value={pickJob} onChange={(e) => setPickJob(e.target.value)}>
                    <option value="">Choose a job…</option>
                    {jobs.map((j) => (
                      <option key={j.id} value={j.id}>
                        {j.ref}{j.scheduled_date ? ` · ${j.scheduled_date}` : ""}
                      </option>
                    ))}
                  </select>
                  <div className="row" style={{ gap: 8 }}>
                    <button className="btn btn-primary" style={{ flex: 1, marginTop: 0 }}
                      disabled={busy} onClick={() => attach(r.id)}>Attach</button>
                    <button className="btn btn-ghost" style={{ flex: 1, marginTop: 0 }}
                      onClick={() => { setAttaching(null); setPickJob(""); }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button className="btn btn-ghost" style={{ minHeight: 44 }}
                  onClick={() => { setAttaching(r.id); setPickJob(""); setMsg(""); }}>
                  🔗 Attach a job to this invoice
                </button>
              )}
            </div>
          ))}
        </>
      )}

      <h2>All invoices</h2>
      {rows.length === 0 && <div className="empty">Nothing invoiced yet.</div>}
      {rows.map((r) => (
        <div className="card" key={r.id}>
          <div className="row">
            <span className="ref">{r.number}</span>
            <span className={`stamp ${r.status === "void" ? "bad" : r.state === "paid" ? "done" : "live"}`}>
              {r.status === "void" ? "VOID" : (r.state || "issued").toUpperCase()}
            </span>
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <span className="muted">
              {r.invoice_date} · {r.bill_to_name || "—"}
              {r.job_ref ? ` · ${r.job_ref}` : " · no job"}
            </span>
            <span>{r.currency} {money(r.total)}</span>
          </div>
          {r.status !== "void" && (
            <div className="row" style={{ marginTop: 4 }}>
              <span className="muted">
                Due {r.due_date || "—"}{r.payment_terms ? ` · ${r.payment_terms}` : ""}
              </span>
              {dueFor !== r.id && (
                <button className="topbar-link" onClick={() => {
                  setDueFor(r.id); setDueDate(r.due_date || ""); setDueTerms(r.payment_terms || ""); setMsg("");
                }}>change</button>
              )}
            </div>
          )}
          {dueFor === r.id && (
            <div style={{ marginTop: 8 }}>
              <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <label>Due date</label>
                  <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <label>Terms</label>
                  <input value={dueTerms} placeholder="COD, 30 days…"
                    onChange={(e) => setDueTerms(e.target.value)} />
                </div>
              </div>
              <p className="muted" style={{ marginTop: -6, marginBottom: 8 }}>
                Clear the date to go back to whatever the terms say.
              </p>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-primary" style={{ flex: 1, marginTop: 0 }}
                  disabled={busy} onClick={() => changeDue(r.id)}>Save</button>
                <button className="btn btn-ghost" style={{ flex: 1, marginTop: 0 }}
                  onClick={() => setDueFor(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
