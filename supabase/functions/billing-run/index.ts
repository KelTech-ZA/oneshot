// OneShot — the monthly invoice pack.
//
// On the day a customer is billed, everything owed since their last pack is
// gathered into one PDF — the statement, then every invoice behind it — and
// emailed. Nobody presses anything.
//
// Two ways in:
//
//   cron    once an hour, with the shared secret. Does every customer whose
//           day it is. This is the one that matters.
//   a human POST with an ops JWT and a client_id, to run one now. Used for
//           the first run of a new customer, and for testing against a real
//           inbox without waiting for the 25th.
//
// WHY THE ROW IS WRITTEN BEFORE THE EMAIL
//
// Because the alternative is working out what has already been sent by
// reading an inbox, and because cron retries. The run row is claimed first,
// under a unique index on (client_id, period_to). A second attempt at the
// same period finds it. A duplicate job is embarrassing; a duplicate invoice
// pack gets paid twice or starts an argument.
//
// WHY IT USUALLY GOES TO THE OFFICE
//
// billing_direct is false until somebody turns it on per customer. An invoice
// pack cannot be unsent, and in the month this was written every invoice in
// the database had a null due date, one email arrived twice, and the parser
// read a conversation three months wide. None of those reached a customer
// because a person was in the way. The schedule is automatic either way; what
// is optional is who is on the other end.
//
// Deploy: supabase functions deploy billing-run --no-verify-jwt

import { createClient } from "npm:@supabase/supabase-js@2";
import { Resend } from "npm:resend";
import { age, buildPack } from "../_shared/pack.ts";
import type { PackInvoice, PackLine, PackVatGroup } from "../_shared/pack.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const resend = new Resend(Deno.env.get("RESEND_API_KEY")!);
const FROM = Deno.env.get("NOTIFY_FROM") ?? "OneShot <jobs@osteomvion.resend.app>";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-billing-secret",
  "access-control-allow-methods": "POST, OPTIONS",
  "content-type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const money = (v: unknown) => {
  const x = Number(v ?? 0);
  return (x < 0 ? "-" : "") + Math.abs(x).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
};

interface Due {
  tenant_id: string;
  client_id: string;
  client_name: string;
  period_from: string;
  period_to: string;
  send_to: string | null;
  direct: boolean;
}

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
};

// ---------------------------------------------------------------------------

/** One customer's pack, start to finish. Never throws: a failure is recorded
 *  on the run, which makes that customer due again on the next poll. */
async function runOne(due: Due): Promise<{ client: string; status: string; detail?: string }> {
  const label = `${due.client_name} ${due.period_from}..${due.period_to}`;

  // ---- claim the period -----------------------------------------------------
  // Upsert, not insert: a retry after a failure must land on the same row so
  // the unique index keeps protecting against two packs.
  const { data: run, error: claimErr } = await admin.from("billing_runs")
    .upsert({
      tenant_id: due.tenant_id,
      client_id: due.client_id,
      period_from: due.period_from,
      period_to: due.period_to,
      status: "building",
      error: null,
      created_at: new Date().toISOString(),
      went_direct: due.direct,
    }, { onConflict: "client_id,period_to" })
    .select().single();

  if (claimErr || !run) {
    console.error(`billing-run: could not claim ${label}:`, claimErr?.message);
    return { client: due.client_name, status: "failed", detail: claimErr?.message };
  }

  const fail = async (why: string) => {
    await admin.from("billing_runs")
      .update({ status: "failed", error: why.slice(0, 500) }).eq("id", run.id);
    console.error(`billing-run: ${label}: ${why}`);
    return { client: due.client_name, status: "failed", detail: why };
  };

  try {
    // ---- what is being billed ----------------------------------------------
    // tenant_id as well as client_id. The service role sees every workspace,
    // so the scoping that RLS does for a browser has to be written out here;
    // a client id is enough on its own today and this costs nothing.
    const { data: rows, error: invErr } = await admin.from("invoice_ledger")
      .select("*")
      .eq("tenant_id", due.tenant_id)
      .eq("client_id", due.client_id)
      .gte("invoice_date", due.period_from)
      .lte("invoice_date", due.period_to)
      .neq("status", "void")
      .order("invoice_date").order("number");
    if (invErr) return await fail(`reading invoices: ${invErr.message}`);

    const invoices = (rows ?? []) as unknown as
      (PackInvoice & {
        id: string; job_id?: string | null; issued_by?: string | null;
      })[];

    // Nothing to send is a real outcome, not a failure: it is recorded so the
    // customer is not asked again this month, and no email goes out. A pack
    // reading "you owe nothing" every month is how people learn to ignore it.
    if (!invoices.length) {
      await admin.from("billing_runs").update({
        status: "nothing_to_bill", invoice_count: 0, sent_at: new Date().toISOString(),
      }).eq("id", run.id);
      console.log(`billing-run: ${label}: nothing to bill`);
      return { client: due.client_name, status: "nothing_to_bill" };
    }

    if (!due.send_to) {
      return await fail("no address to send to: the customer has no billing email and the workspace has none either");
    }

    // What each invoice is for, not just what it came to.
    await attachLines(invoices);
    // And, where it carries supplies at more than one rate, the split the
    // printed document has to show.
    await attachVatBreakdown(invoices);

    // ---- the letterhead -----------------------------------------------------
    const { data: issuer } = await admin.from("workspace_billing")
      .select("*").eq("tenant_id", due.tenant_id).maybeSingle();
    const { data: client } = await admin.from("clients")
      .select("name,legal_name,billing_address,vat_number")
      .eq("id", due.client_id).maybeSingle();

    let logo: Uint8Array | null = null;
    if (issuer?.logo_path) {
      // A logo that will not load must not cost the customer their pack.
      try {
        const { data: blob } = await admin.storage.from("branding").download(issuer.logo_path);
        if (blob) logo = new Uint8Array(await blob.arrayBuffer());
      } catch (e) {
        console.warn(`billing-run: logo not loaded:`, e instanceof Error ? e.message : e);
      }
    }

    const outstanding = invoices.reduce((t, i) => t + Number(i.balance ?? 0), 0);
    const invoiced = invoices.reduce((t, i) => t + Number(i.total ?? 0), 0);
    const currency = invoices[0]?.currency ?? issuer?.default_currency ?? "ZAR";

    // ---- the document -------------------------------------------------------
    const pdf = await buildPack({
      issuer: issuer ?? {},
      client: {
        name: client?.legal_name || client?.name || due.client_name,
        address: client?.billing_address ?? null,
        vat_number: client?.vat_number ?? null,
      },
      period: { from: due.period_from, to: due.period_to },
      invoices,
      ageing: age(invoices),
      currency,
      outstanding: Math.round(outstanding * 100) / 100,
      logo,
    });

    // ---- keep what was sent -------------------------------------------------
    // Stored before the email, so the office can open exactly what the
    // customer received rather than a document regenerated later from
    // invoices that have moved on since.
    const path = `${due.tenant_id}/billing/${due.client_id}/${due.period_to}.pdf`;
    const { error: upErr } = await admin.storage.from("documents")
      .upload(path, pdf, { contentType: "application/pdf", upsert: true });
    if (upErr) return await fail(`storing the pack: ${upErr.message}`);

    // ---- send ---------------------------------------------------------------
    const name = client?.legal_name || client?.name || due.client_name;
    const asAt = due.period_to;
    const subject = due.direct
      ? `Statement of account — ${name} — as at ${asAt}`
      : `Invoice pack ready to send — ${name} — as at ${asAt}`;

    const rowsHtml = invoices.map((i) => `
      <tr>
        <td style="padding:4px 10px 4px 0">${esc(i.invoice_date)}</td>
        <td style="padding:4px 10px 4px 0"><b>${esc(i.number)}</b></td>
        <td style="padding:4px 10px 4px 0;text-align:right">${esc(money(i.total))}</td>
        <td style="padding:4px 0;text-align:right">${esc(money(i.balance))}</td>
      </tr>`).join("");

    const html = due.direct
      ? `<div style="font:14px/1.5 system-ui,sans-serif;color:#222">
           <p>Dear ${esc(name)},</p>
           <p>Your statement of account as at ${esc(asAt)} is attached, together with
              every invoice it covers.</p>
           <table style="border-collapse:collapse;margin:14px 0">
             <tr style="color:#777;font-size:12px">
               <td style="padding-right:10px">Date</td><td style="padding-right:10px">Invoice</td>
               <td style="text-align:right;padding-right:10px">Total</td><td style="text-align:right">Balance</td>
             </tr>${rowsHtml}
           </table>
           <p><b>Total outstanding: ${esc(currency)} ${esc(money(outstanding))}</b></p>
           <p style="color:#777;font-size:13px">Please quote the invoice number with payment.
              Any query, reply to this email.</p>
         </div>`
      : `<div style="font:14px/1.5 system-ui,sans-serif;color:#222">
           <p>The monthly pack for <b>${esc(name)}</b> is attached — statement as at
              ${esc(asAt)}, then ${invoices.length} invoice${invoices.length === 1 ? "" : "s"}.</p>
           <table style="border-collapse:collapse;margin:14px 0">
             <tr style="color:#777;font-size:12px">
               <td style="padding-right:10px">Date</td><td style="padding-right:10px">Invoice</td>
               <td style="text-align:right;padding-right:10px">Total</td><td style="text-align:right">Balance</td>
             </tr>${rowsHtml}
           </table>
           <p><b>Outstanding: ${esc(currency)} ${esc(money(outstanding))}</b></p>
           <p style="color:#777;font-size:13px">Nothing has been sent to the customer.
              Check it and forward if it is right.</p>
         </div>`;

    const { data: sent, error: mailErr } = await resend.emails.send({
      from: FROM,
      to: due.send_to,
      replyTo: issuer?.billing_email || undefined,
      subject,
      html,
      attachments: [{
        filename: `${name.replace(/[^\w\- ]+/g, "").trim() || "statement"} ${asAt}.pdf`,
        content: b64(pdf),
      }],
    });
    if (mailErr) return await fail(`sending: ${mailErr.message}`);

    // ---- record it ----------------------------------------------------------
    await admin.from("billing_runs").update({
      status: "sent",
      invoice_count: invoices.length,
      invoiced: Math.round(invoiced * 100) / 100,
      outstanding: Math.round(outstanding * 100) / 100,
      currency,
      pdf_path: path,
      sent_to: due.send_to,
      went_direct: due.direct,
      provider_id: sent?.id ?? null,
      sent_at: new Date().toISOString(),
      error: null,
    }).eq("id", run.id);

    // ---- and say it is waiting ----------------------------------------------
    // Only when it stopped at the office. A pack that went straight to the
    // customer needs nothing from anybody, and a reminder about it would be
    // the kind of notification people learn to dismiss without reading.
    if (!due.direct) {
      const owner = await whoToTell(due.tenant_id, invoices);
      if (owner) {
        const { data: rem } = await admin.from("job_reminders").insert({
          tenant_id: due.tenant_id,
          user_id: owner,
          created_by: owner,
          due_at: new Date(Date.now() + 60_000).toISOString(),
          subject: `Invoice pack for ${name} is ready to send`,
          note: `${invoices.length} invoice${invoices.length === 1 ? "" : "s"}, `
              + `${currency} ${money(outstanding)} outstanding. Check it and forward to the customer.`,
          source: "billing_run",
          external_id: `billing:${run.id}`,
        }).select("id").single();
        if (rem?.id) await admin.from("billing_runs").update({ reminder_id: rem.id }).eq("id", run.id);
      } else {
        console.warn(`billing-run: ${label}: nobody to remind`);
      }
    }

    console.log(`billing-run: ${label}: sent ${invoices.length} to ${due.send_to}`);
    return { client: due.client_name, status: "sent" };
  } catch (e) {
    return await fail(e instanceof Error ? e.message : String(e));
  }
}

/** The lines behind each invoice.
 *
 *  invoice_ledger carries an invoice's totals, not what it is for: the lines
 *  live in job_charges against the job. Without this the pack renders a
 *  column header and then jumps to the total, which is exactly the document
 *  a customer rings up about.
 *
 *  Nothing is invented. A line's amount is its own if it has one and
 *  quantity x price otherwise; subtotal and VAT are filled in only when the
 *  invoice row does not carry them, and then from the lines and the
 *  invoice's own total, never from a rate assumed here. */
async function attachLines(
  invoices: (PackInvoice & { job_id?: string | null })[],
): Promise<void> {
  const jobIds = [...new Set(invoices.map((i) => i.job_id).filter(Boolean))] as string[];
  if (!jobIds.length) return;

  // select("*") rather than naming columns: job_charges has gained columns
  // over time and PostgREST fails the whole read on one it does not know.
  const { data, error } = await admin.from("job_charges")
    .select("*").in("job_id", jobIds)
    .order("sort", { ascending: true, nullsFirst: true })
    .order("created_at");
  if (error) {
    // Totals without lines is a poorer pack. No pack at all is worse.
    console.warn("billing-run: lines not read:", error.message);
    return;
  }

  const num = (v: unknown) => {
    const x = Number(v ?? 0);
    return Number.isFinite(x) ? x : 0;
  };
  const by = new Map<string, PackLine[]>();
  for (const c of (data ?? []) as Record<string, unknown>[]) {
    const job = String(c.job_id ?? "");
    if (!job) continue;
    const qty = num(c.quantity);
    const price = num(c.unit_price);
    const amount = c.line_total == null ? qty * price : num(c.line_total);
    if (!by.has(job)) by.set(job, []);
    by.get(job)!.push({
      description: (c.description as string) ?? null,
      unit: (c.unit as string) ?? null,
      quantity: qty,
      unit_price: price,
      line_total: Math.round(amount * 100) / 100,
      // sql/66. Null means the line is at the invoice's own rate, which is
      // every line written before per-line VAT existed. Dropping it here
      // would print a zero-rated export leg as though it were taxed.
      vat_rate: c.vat_rate == null ? null : num(c.vat_rate),
    });
  }

  for (const inv of invoices) {
    if (!inv.lines?.length && inv.job_id) inv.lines = by.get(inv.job_id) ?? [];
    if (!inv.lines?.length) continue;

    const sum = Math.round(inv.lines.reduce((t, l) => t + num(l.line_total), 0) * 100) / 100;
    if (inv.subtotal == null) inv.subtotal = sum;

    // VAT is whatever the total is over the lines. On a job with no VAT that
    // difference is zero and nothing is shown, which is the right answer; a
    // rate written in here would be a guess at somebody else's tax position.
    if (inv.vat == null) {
      const gap = Math.round((num(inv.total) - num(inv.subtotal)) * 100) / 100;
      inv.vat = gap > 0.004 ? gap : 0;
      if (inv.vat_rate == null && num(inv.vat) > 0 && num(inv.subtotal) > 0) {
        inv.vat_rate = Math.round((num(inv.vat) / num(inv.subtotal)) * 1000) / 10;
      }
    }
  }
}

/** The per-rate VAT split for each invoice, where there is more than one rate.
 *
 *  Read, not computed. public.vat_breakdown (sql/68) works it out from the
 *  invoice's own frozen lines and is guaranteed to sum to the vat stored on
 *  the row; a second implementation here would be a second thing that can
 *  disagree with the document.
 *
 *  An invoice at one rate comes back as a single group and pack.ts then
 *  prints it exactly as it did before any of this, so nothing an existing
 *  customer has been receiving changes shape. */
async function attachVatBreakdown(
  invoices: (PackInvoice & { id: string })[],
): Promise<void> {
  const ids = invoices.map((i) => i.id).filter(Boolean);
  if (!ids.length) return;

  const { data, error } = await admin.from("invoice_vat_breakdown")
    .select("invoice_id,vat_breakdown").in("invoice_id", ids);
  if (error) {
    // The view arrives with sql/68. If this function is deployed first, the
    // pack should still go out - without the split, which is how it has
    // always printed.
    console.warn("billing-run: VAT breakdown not read:", error.message);
    return;
  }

  const by = new Map<string, PackVatGroup[]>();
  for (const r of (data ?? []) as Record<string, unknown>[]) {
    const id = String(r.invoice_id ?? "");
    if (id) by.set(id, (r.vat_breakdown as PackVatGroup[]) ?? []);
  }
  for (const inv of invoices) {
    const split = by.get(inv.id);
    if (split?.length) inv.vat_breakdown = split;
  }
}

/** Whose reminder it is: whoever issued the most recent invoice in the pack,
 *  else the workspace's longest-standing ops member. */
async function whoToTell(
  tenantId: string,
  invoices: { issued_by?: string | null }[],
): Promise<string | null> {
  for (let i = invoices.length - 1; i >= 0; i--) {
    if (invoices[i].issued_by) return invoices[i].issued_by!;
  }
  const { data } = await admin.from("memberships")
    .select("user_id").eq("tenant_id", tenantId).eq("role", "ops")
    .order("created_at", { ascending: true }).limit(1).maybeSingle();
  return data?.user_id ?? null;
}

// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: { client_id?: string; on?: string } = {};
  try { body = await req.json(); } catch { /* cron sends nothing */ }

  // ---- who is asking --------------------------------------------------------
  const secret = req.headers.get("x-billing-secret");
  const { data: known } = await admin.from("app_secrets")
    .select("value").eq("key", "billing_hook_secret").maybeSingle();
  const fromCron = !!secret && !!known?.value && secret === known.value;

  let onlyTenant: string | null = null;
  if (!fromCron) {
    // A person. Their own rights decide which workspace they can bill, and
    // only ops can do it at all.
    const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Sign in first." }, 401);
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: "That session has expired." }, 401);
    const { data: profile } = await admin.from("profiles")
      .select("active_tenant_id").eq("id", user.id).maybeSingle();
    onlyTenant = profile?.active_tenant_id ?? null;
    if (!onlyTenant) return json({ error: "No workspace is active for this account." }, 403);
    const { data: m } = await admin.from("memberships")
      .select("role").eq("user_id", user.id).eq("tenant_id", onlyTenant).maybeSingle();
    if (m?.role !== "ops") return json({ error: "Only an ops manager can run billing." }, 403);
  }

  // ---- whose pack is due ----------------------------------------------------
  const today = typeof body.on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.on)
    ? body.on : undefined;
  const { data: dueRows, error: dueErr } = await admin
    .rpc("due_billing_runs", today ? { p_today: today } : {});
  if (dueErr) {
    console.error("billing-run: due_billing_runs failed:", dueErr.message);
    return json({ error: dueErr.message }, 500);
  }

  let due = (dueRows ?? []) as Due[];
  if (onlyTenant) due = due.filter((d) => d.tenant_id === onlyTenant);
  // "Run this customer now", from the client's own page.
  if (body.client_id) due = due.filter((d) => d.client_id === body.client_id);

  if (!due.length) return json({ ok: true, ran: 0, results: [] });

  // One at a time. A customer whose pack fails must not stop the next one,
  // and the whole point of the run row is that each is independent.
  const results = [];
  for (const d of due) results.push(await runOne(d));

  return json({
    ok: true,
    ran: results.length,
    sent: results.filter((r) => r.status === "sent").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  });
});
