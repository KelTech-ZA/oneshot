// Emails a customer their statement of account.
//
// The numbers are read HERE, not taken from the browser. A statement is a
// demand for money: if the page could tell this function what to send, a stale
// tab or a tampered request could post a customer a figure that never existed
// in the database. So the caller says WHICH customer and WHICH period, and
// everything else is read fresh under that caller's own rights.

import { createClient } from "npm:@supabase/supabase-js@2";
import { Resend } from "npm:resend";

const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);
const FROM = Deno.env.get("NOTIFY_FROM") ?? "OneShot <jobs@osteomvion.resend.app>";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
  "content-type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const money = (n: unknown, ccy: string) => {
  const v = Number(n ?? 0);
  try {
    return new Intl.NumberFormat("en-ZA", { style: "currency", currency: ccy }).format(v);
  } catch {
    return `${ccy} ${v.toFixed(2)}`;
  }
};

interface Row {
  id: string;
  number: string; invoice_date: string; job_ref: string | null; their_reference: string | null;
  currency: string; total: number; paid: number; balance: number;
  state: string; days_overdue: number | null; age_days: number;
}

interface Payment {
  id: string; invoice_id: string; paid_on: string; amount: number;
  method: string | null; reference: string | null; notes: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Sign in first." }, 401);

  // The caller's own rights: RLS decides what they can read, and the office-only
  // policy on invoices is what stops crew emailing a customer their balance.
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${jwt}` } } },
  );

  const { data: { user } } = await sb.auth.getUser(jwt);
  if (!user) return json({ error: "That session has expired." }, 401);

  let body: { client_id?: string; from?: string; to?: string; open_only?: boolean };
  try { body = await req.json(); } catch { return json({ error: "Malformed request." }, 400); }

  const { client_id, from, to } = body;
  // A statement shows the whole period. Arrears-only is a different document
  // and has to be asked for, the same way it is on the page.
  const openOnly = body.open_only === true;
  if (!client_id || !from || !to) return json({ error: "Which customer, and over what period?" }, 400);

  const { data: profile } = await sb.from("profiles")
    .select("active_tenant_id").eq("id", user.id).maybeSingle();
  const tenantId = profile?.active_tenant_id;
  if (!tenantId) return json({ error: "No workspace is active for this account." }, 403);

  const { data: client } = await sb.from("clients")
    .select("name,legal_name,billing_email,billing_address").eq("id", client_id).maybeSingle();
  if (!client) return json({ error: "That customer is not one this workspace can see." }, 404);
  if (!client.billing_email) return json({ error: "That customer has no billing email on file." }, 400);

  const { data: issuer } = await sb.from("workspace_letterhead").select("*").maybeSingle();

  const { data: rowsRaw, error } = await sb.from("invoice_ledger").select("*")
    .eq("client_id", client_id)
    .gte("invoice_date", from).lte("invoice_date", to)
    .order("invoice_date").order("number");
  if (error) return json({ error: error.message }, 500);

  const rows = ((rowsRaw ?? []) as Row[])
    .filter((r) => (openOnly ? r.state !== "paid" && r.state !== "void" : true));

  // What was received against those invoices. A statement that shows a balance
  // without showing the payments behind it asks the customer to take the
  // figure on trust - and it is the first thing they query.
  const byInvoice = new Map<string, Payment[]>();
  if (rows.length) {
    const { data: pays } = await sb.from("invoice_payments")
      .select("*").in("invoice_id", rows.map((r) => r.id))
      .order("paid_on").order("created_at");
    for (const p of (pays ?? []) as Payment[]) {
      if (!byInvoice.has(p.invoice_id)) byInvoice.set(p.invoice_id, []);
      byInvoice.get(p.invoice_id)!.push(p);
    }
  }

  if (!rows.length) {
    return json({ error: openOnly
      ? "Nothing is outstanding for that customer in that period, so there is nothing to send."
      : "There are no invoices for that customer in that period." }, 400);
  }

  // Totals per currency. Nothing is converted, so a customer billed in two
  // currencies gets two totals rather than one meaningless one.
  const totals = new Map<string, { invoiced: number; paid: number; balance: number; buckets: number[] }>();
  for (const r of rows) {
    if (r.state === "void") continue;
    const c = r.currency || "ZAR";
    if (!totals.has(c)) totals.set(c, { invoiced: 0, paid: 0, balance: 0, buckets: [0, 0, 0, 0] });
    const t = totals.get(c)!;
    t.invoiced += Number(r.total || 0);
    t.paid += Number(r.paid || 0);
    t.balance += Number(r.balance || 0);
    const a = Number(r.age_days || 0);
    const i = a <= 30 ? 0 : a <= 60 ? 1 : a <= 90 ? 2 : 3;
    t.buckets[i] += Number(r.balance || 0);
  }

  const name = client.legal_name || client.name;
  const th = "padding:4px 8px;text-align:left;font:600 11px system-ui;text-transform:uppercase;letter-spacing:.04em;color:#666;border-bottom:1px solid #ddd";
  const td = "padding:6px 8px;border-bottom:1px solid #eee;font:14px system-ui";
  const num = td + ";text-align:right;font-variant-numeric:tabular-nums";

  const pay = "padding:2px 8px;font:13px system-ui;color:#666";
  const payNum = pay + ";text-align:right;font-variant-numeric:tabular-nums";

  const lines = rows.map((r) => {
    const receipts = (byInvoice.get(r.id) ?? []).map((p) => `
    <tr>
      <td style="${pay}"></td>
      <td style="${pay}">${esc(p.paid_on)}</td>
      <td style="${pay};padding-left:16px" colspan="2">${
        Number(p.amount) < 0 ? "Payment reversed" : "Payment received"
      }${p.method ? ` · ${esc(p.method)}` : ""}${
        p.reference ? ` · ${esc(p.reference)}` : ""}${p.notes ? ` · ${esc(p.notes)}` : ""}</td>
      <td style="${payNum}"></td>
      <td style="${payNum}">${esc(money(p.amount, r.currency))}</td>
      <td style="${payNum}"></td>
      <td style="${pay}"></td>
    </tr>`).join("");

    return `
    <tr>
      <td style="${td}">${esc(r.number)}</td>
      <td style="${td}">${esc(r.invoice_date)}</td>
      <td style="${td}">${esc(r.job_ref ?? "—")}</td>
      <td style="${td}">${esc(r.their_reference ?? "—")}</td>
      <td style="${num}">${esc(money(r.total, r.currency))}</td>
      <td style="${num}">${esc(money(r.paid, r.currency))}</td>
      <td style="${num}">${r.state === "void" ? "—" : esc(money(r.balance, r.currency))}</td>
      <td style="${td}">${esc(r.state.replace("_", " "))}${
        r.days_overdue && r.days_overdue > 0 ? ` <span style="color:#b4531f">· ${r.days_overdue}d late</span>` : ""
      }</td>
    </tr>${receipts}`;
  }).join("");

  const summaries = [...totals.entries()].map(([ccy, t]) => `
    <table style="border-collapse:collapse;margin-top:18px;width:100%">
      <tr><td style="${td};border:none">Invoiced</td>
          <td style="${num};border:none">${esc(money(t.invoiced, ccy))}</td></tr>
      <tr><td style="${td};border:none">Received</td>
          <td style="${num};border:none">${esc(money(t.paid, ccy))}</td></tr>
      <tr><td style="${td};border-top:1px solid #333;font-weight:700">Outstanding${
            totals.size > 1 ? ` (${esc(ccy)})` : ""}</td>
          <td style="${num};border-top:1px solid #333;font-weight:700;font-size:17px">${esc(money(t.balance, ccy))}</td></tr>
    </table>
    <table style="border-collapse:collapse;margin-top:10px;width:100%">
      <tr>${["Current", "30 days", "60 days", "90+ days"].map((h) =>
        `<th style="${th};text-align:right">${h}</th>`).join("")}</tr>
      <tr>${t.buckets.map((v, i) =>
        `<td style="${num}${i === 3 && v > 0 ? ";color:#b4531f;font-weight:600" : ""}">${
          v ? esc(money(v, ccy)) : "—"}</td>`).join("")}</tr>
    </table>`).join("");

  const head = issuer
    ? `<div style="font:700 17px system-ui">${esc(issuer.trading_name || issuer.legal_name || "")}</div>
       <div style="font:13px system-ui;color:#555;white-space:pre-line">${esc(issuer.address ?? "")}</div>
       <div style="font:13px system-ui;color:#555">${
         [issuer.phone, issuer.billing_email].filter(Boolean).map(esc).join(" · ")}</div>
       ${issuer.vat_number ? `<div style="font:13px system-ui;color:#555">VAT ${esc(issuer.vat_number)}</div>` : ""}`
    : "";

  const html = `
  <div style="max-width:760px;margin:0 auto;padding:24px;color:#111">
    ${head}
    <h2 style="font:700 20px system-ui;margin:20px 0 2px">Statement of account</h2>
    <div style="font:13px system-ui;color:#555;margin-bottom:16px">
      ${esc(name)} &nbsp;·&nbsp; ${esc(from)} to ${esc(to)} &nbsp;·&nbsp; as at ${esc(new Date().toISOString().slice(0, 10))}
    </div>
    <table style="border-collapse:collapse;width:100%">
      <tr>${["Invoice", "Date", "Job", "Reference"].map((h) => `<th style="${th}">${h}</th>`).join("")}
          ${["Invoiced", "Paid", "Outstanding"].map((h) => `<th style="${th};text-align:right">${h}</th>`).join("")}
          <th style="${th}">Status</th></tr>
      ${lines}
    </table>
    ${summaries}
    <div style="font:12px system-ui;color:#777;margin-top:14px">Aged from the invoice date.</div>
    ${issuer?.trading_name
      ? `<div style="font:13px system-ui;color:#555;margin-top:20px">
           Please quote the invoice number with payment. Any query, reply to this email.
         </div>` : ""}
  </div>`;

  const subject = `Statement of account — ${name} — as at ${new Date().toISOString().slice(0, 10)}`;

  const { data: sent, error: mailErr } = await resend.emails.send({
    from: FROM,
    to: client.billing_email,
    // A statement is answered by the office, not by the intake address.
    replyTo: issuer?.billing_email || undefined,
    subject,
    html,
  });
  if (mailErr) return json({ error: `Could not send: ${mailErr.message}` }, 502);

  return json({ ok: true, id: sent?.id ?? null, to: client.billing_email, invoices: rows.length });
});
