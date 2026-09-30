import React, { useContext, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { Ctx } from "../main";
import Letterhead from "./Letterhead";
import { amount, amountWithCode } from "../lib/money";

// What a customer owes, and how long they have owed it.
//
// This reads invoice_ledger, which derives paid / part paid / overdue from the
// payments actually recorded. Nothing here stores a status, so a statement can
// never disagree with the money.
//
// An invoice keeps the currency it was issued in and NOTHING is converted, so
// a customer billed in two currencies gets two totals rather than one
// meaningless one. Mixing them would be the sort of number nobody notices is
// wrong until it is on a customer's desk.

const today = () => new Date().toISOString().slice(0, 10);
const monthsAgo = (n) => {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
};

// Aging buckets, measured from the invoice date, which is what an accountant
// ages by.
const BUCKETS = [
  ["Current", (d) => d <= 30],
  ["30 days", (d) => d > 30 && d <= 60],
  ["60 days", (d) => d > 60 && d <= 90],
  ["90+ days", (d) => d > 90],
];

const STATE_LABEL = {
  paid: "Paid", part_paid: "Part paid", unpaid: "Unpaid", void: "Void",
};

export default function Statements() {
  const { profile } = useContext(Ctx);
  const isOps = profile?.role === "ops";

  const [clients, setClients] = useState([]);
  const [clientId, setClientId] = useState("");
  const [from, setFrom] = useState(monthsAgo(3));
  const [to, setTo] = useState(today());
  const [openOnly, setOpenOnly] = useState(true);
  const [rows, setRows] = useState(null);
  const [orphans, setOrphans] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [sent, setSent] = useState("");
  // Settling up from the statement, which is where you are when the bank
  // statement is open beside you - not on each job in turn.
  const [paying, setPaying] = useState(null);   // { id, amount, paid_on, method, reference }
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!isOps) return;
    (async () => {
      const [{ data: c }, { data: o }] = await Promise.all([
        supabase.from("clients").select("id,name,legal_name,billing_email").order("name"),
        // Invoices with no customer to group under. Told about rather than
        // hidden: an invoice missing from a statement is money nobody chases.
        supabase.from("invoices").select("id", { count: "exact", head: true })
          .is("client_id", null).eq("status", "issued"),
      ]);
      setClients(c ?? []);
      setOrphans(o?.length ?? 0);
    })();
  }, [isOps]);

  // The count above comes back on the response, not the body.
  useEffect(() => {
    if (!isOps) return;
    supabase.from("invoices").select("*", { count: "exact", head: true })
      .is("client_id", null).eq("status", "issued")
      .then(({ count }) => setOrphans(count ?? 0));
  }, [isOps]);

  const client = clients.find((c) => c.id === clientId) || null;

  const load = async () => {
    if (!clientId) { setRows(null); return; }
    setBusy(true); setMsg(""); setSent("");
    let q = supabase.from("invoice_ledger").select("*")
      .eq("client_id", clientId)
      .gte("invoice_date", from).lte("invoice_date", to)
      .order("invoice_date").order("number");
    const { data, error } = await q;
    setBusy(false);
    if (error) { setMsg(error.message); setRows([]); return; }
    setRows(data ?? []);
  };

  useEffect(() => { if (clientId) load(); /* eslint-disable-next-line */ }, [clientId, from, to]);

  const shown = useMemo(
    () => (rows ?? []).filter((r) => (openOnly ? r.state !== "paid" && r.state !== "void" : true)),
    [rows, openOnly],
  );

  // One set of totals per currency. See the note at the top of this file.
  const byCurrency = useMemo(() => {
    const m = new Map();
    for (const r of shown) {
      if (r.state === "void") continue;
      const c = r.currency || "ZAR";
      if (!m.has(c)) m.set(c, { invoiced: 0, paid: 0, balance: 0, buckets: [0, 0, 0, 0] });
      const t = m.get(c);
      t.invoiced += Number(r.total || 0);
      t.paid += Number(r.paid || 0);
      t.balance += Number(r.balance || 0);
      const age = Number(r.age_days || 0);
      const i = BUCKETS.findIndex(([, test]) => test(age));
      if (i >= 0) t.buckets[i] += Number(r.balance || 0);
    }
    return [...m.entries()];
  }, [shown]);

  const record = async (row, amount) => {
    const amt = Number(amount);
    if (!amt) { setMsg("Enter an amount."); return; }
    setBusy(true); setMsg(""); setNote("");
    const { error } = await supabase.from("invoice_payments").insert({
      tenant_id: profile.tenant_id, invoice_id: row.id,
      paid_on: paying?.paid_on || today(),
      amount: amt,
      method: paying?.method || null,
      reference: paying?.reference || null,
      created_by: profile?.id ?? null,
    });
    setBusy(false);
    if (error) { setMsg(error.message); return; }
    setPaying(null);
    setNote(`${row.number}: ${amount} recorded.`);
    await load();
  };

  if (!isOps) {
    return <div className="page"><h1>Statements</h1>
      <p className="muted">The office keeps these.</p></div>;
  }

  const emailStatement = async () => {
    if (!client?.billing_email) {
      setMsg("That client has no billing email. Add one under Office → Clients.");
      return;
    }
    setBusy(true); setMsg(""); setSent("");
    const { data, error } = await supabase.functions.invoke("send-statement", {
      body: { client_id: clientId, from, to, open_only: openOnly },
    });
    setBusy(false);
    if (error || data?.error) { setMsg(error?.message || data.error); return; }
    setSent(`Sent to ${client.billing_email}.`);
  };

  return (
    <div className="page statement">
      <Letterhead
        screen
        title="Statement of account"
        meta={[
          ["Date", today()],
          ["Period", `${from} to ${to}`],
          ["Account", client?.legal_name || client?.name || "—"],
        ]}
      />

      <h1 className="no-print">Statements</h1>

      <div className="card no-print">
        <label className="oneshot-f">Customer</label>
        <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">Choose a customer…</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.legal_name || c.name}</option>
          ))}
        </select>

        <div className="row" style={{ gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 140px" }}>
            <label className="muted" style={{ fontSize: 12 }}>From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div style={{ flex: "1 1 140px" }}>
            <label className="muted" style={{ fontSize: 12 }}>To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>

        <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 400, marginTop: 8 }}>
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)}
            style={{ width: 18, height: 18 }} />
          <span>Only what is still owed
            <br /><span className="muted" style={{ fontSize: 12 }}>
              Turn off to show everything in the period, settled invoices included.
            </span>
          </span>
        </label>

        {clientId && (
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <button className="btn btn-ghost" onClick={() => window.print()}>Print</button>
            <button className="btn btn-primary" disabled={busy || !client?.billing_email}
              onClick={emailStatement}>
              {busy ? "Sending…" : "Email to customer"}
            </button>
          </div>
        )}
        {clientId && !client?.billing_email && (
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            No billing email on file for this customer, so it can only be printed.{" "}
            <Link to="/settings/clients">Add one</Link>.
          </div>
        )}
        {msg && <div style={{ color: "var(--warn)", marginTop: 8 }}>{msg}</div>}
        {sent && <div style={{ color: "var(--ok, #4ea373)", marginTop: 8 }}>{sent}</div>}

        {orphans > 0 && (
          <div className="muted" style={{ fontSize: 12, marginTop: 10, color: "var(--warn)" }}>
            {orphans} invoice{orphans === 1 ? " is" : "s are"} not attached to a customer and
            will not appear on any statement. Open the job and pick the client under
            “Billed to” to fix that.
          </div>
        )}
      </div>

      {rows === null && <p className="muted no-print">Choose a customer to see their account.</p>}

      {rows !== null && shown.length === 0 && (
        <p className="muted">
          {openOnly ? "Nothing outstanding in this period." : "No invoices in this period."}
        </p>
      )}

      {shown.length > 0 && (
        <>
          <table className="statement-table">
            <thead>
              <tr>
                <th>Invoice</th><th>Date</th><th>Job</th><th>Reference</th>
                <th className="num">Invoiced</th><th className="num">Paid</th>
                <th className="num">Outstanding</th><th>Status</th>
                <th className="no-print" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const open = paying?.id === r.id;
                const settled = r.state === "paid" || r.state === "void";
                return (
                <React.Fragment key={r.id}>
                <tr className={r.state === "void" ? "muted" : undefined}>
                  <td>{r.number}</td>
                  <td>{r.invoice_date}</td>
                  <td>{r.job_ref || "—"}</td>
                  <td>{r.their_reference || "—"}</td>
                  <td className="num">{amount(r.total, r.currency)}</td>
                  <td className="num">{amount(r.paid, r.currency)}</td>
                  <td className="num">{r.state === "void" ? "—" : amount(r.balance, r.currency)}</td>
                  <td>
                    {STATE_LABEL[r.state] || r.state}
                    {r.days_overdue > 0 && (
                      <span style={{ color: "var(--warn)" }}> · {r.days_overdue}d late</span>
                    )}
                  </td>
                  <td className="no-print num">
                    {!settled && (
                      <button className="btn btn-ghost" style={{ marginTop: 0, padding: "2px 8px" }}
                        onClick={() => setPaying(open ? null : {
                          id: r.id, paid_on: today(), amount: "", method: "", reference: "",
                        })}>
                        {open ? "Cancel" : "Payment"}
                      </button>
                    )}
                  </td>
                </tr>

                {/* Settling up, in the row it belongs to. "Paid in full" fills
                    the balance rather than setting a flag: the state is
                    derived from what was received, so recording the money IS
                    marking it paid, and the two can never disagree. */}
                {open && (
                  <tr className="no-print">
                    <td colSpan={9} style={{ background: "var(--bg-soft, rgba(0,0,0,.03))" }}>
                      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
                        <div style={{ flex: "0 0 auto" }}>
                          <label className="muted" style={{ fontSize: 12 }}>Date</label>
                          <input type="date" value={paying.paid_on}
                            onChange={(e) => setPaying({ ...paying, paid_on: e.target.value })} />
                        </div>
                        <div style={{ flex: "0 0 130px" }}>
                          <label className="muted" style={{ fontSize: 12 }}>Amount</label>
                          <input type="number" step="0.01" value={paying.amount}
                            placeholder={String(r.balance)}
                            onChange={(e) => setPaying({ ...paying, amount: e.target.value })} />
                        </div>
                        <div style={{ flex: "0 0 110px" }}>
                          <label className="muted" style={{ fontSize: 12 }}>Method</label>
                          <input type="text" value={paying.method} placeholder="EFT"
                            onChange={(e) => setPaying({ ...paying, method: e.target.value })} />
                        </div>
                        <div style={{ flex: "1 1 140px" }}>
                          <label className="muted" style={{ fontSize: 12 }}>Reference</label>
                          <input type="text" value={paying.reference}
                            onChange={(e) => setPaying({ ...paying, reference: e.target.value })} />
                        </div>
                      </div>
                      <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                        <button className="btn btn-primary" style={{ marginTop: 0 }} disabled={busy}
                          onClick={() => record(r, r.balance)}>
                          Paid in full ({amount(r.balance, r.currency)})
                        </button>
                        <button className="btn btn-ghost" style={{ marginTop: 0 }}
                          disabled={busy || !Number(paying.amount)}
                          onClick={() => record(r, paying.amount)}>
                          Part payment
                        </button>
                      </div>
                      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                        A returned payment goes in as a negative amount, so the balance
                        reopens and the record of both stays.
                      </div>
                    </td>
                  </tr>
                )}
                </React.Fragment>
              );})}
            </tbody>
          </table>
          {note && <div className="no-print" style={{ color: "var(--ok, #4ea373)", marginTop: 6 }}>{note}</div>}

          {byCurrency.map(([ccy, t]) => (
            <div className="card" key={ccy} style={{ marginTop: 14 }}>
              {byCurrency.length > 1 && (
                <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                  Billed in {ccy}. Amounts in different currencies are never added together.
                </div>
              )}
              <div className="row"><span className="muted">Invoiced</span>
                <span style={{ fontWeight: 600 }}>{amount(t.invoiced, ccy)}</span></div>
              <div className="row"><span className="muted">Received</span>
                <span style={{ fontWeight: 600 }}>{amount(t.paid, ccy)}</span></div>
              <div className="row" style={{ marginTop: 6, paddingTop: 8, borderTop: "1px solid var(--line)" }}>
                <span style={{ fontWeight: 700 }}>Outstanding</span>
                <span style={{ fontWeight: 700, fontSize: 18 }}>{amountWithCode(t.balance, ccy)}</span>
              </div>

              <table className="aging">
                <thead>
                  <tr>{BUCKETS.map(([label]) => <th key={label} className="num">{label}</th>)}</tr>
                </thead>
                <tbody>
                  <tr>
                    {t.buckets.map((v, i) => (
                      <td key={i} className="num" style={i === 3 && v > 0 ? { color: "var(--warn)", fontWeight: 600 } : undefined}>
                        {v ? amount(v, ccy) : "—"}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Aged from the invoice date.
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
