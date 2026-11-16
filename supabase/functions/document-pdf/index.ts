// One invoice or one quote, as a PDF, for somebody who clicked View or
// Download.
//
// WHY THIS EXISTS
//
// Until now the only way a document left OneShot as a PDF was inside the
// monthly statement pack that billing-run builds and send-statement emails.
// An invoice raised on its own - not against a job - could be created and
// then never looked at again. Same for a quote, which had no document at all.
//
// WHY THE NUMBERS ARE READ HERE
//
// Same rule send-statement states: the caller says WHICH document, and
// everything on the page is read fresh under that caller's own rights. A page
// that could tell this function what to render is a page that could hand a
// customer a figure which never existed in the database - from a stale tab, or
// from somebody who edited the request on the way past.
//
// So this runs on the caller's own JWT, not the service key. RLS decides what
// they may see: ask for another workspace's invoice and the row simply is not
// there, which is the same answer as a number that does not exist. Nothing in
// here re-checks membership, because nothing in here needs to.
//
// WHY IT RENDERS THE SAME WAY THE PACK DOES
//
// buildDocument is the Pack class with the statement cover switched off. The
// invoice a customer downloads here and the one inside their statement are
// drawn by the same code. A separate "downloadable" renderer would be a second
// layout to keep in step, and the first time the two disagreed would be the
// day somebody held both.

import { createClient } from "npm:@supabase/supabase-js@2";
import { buildDocument, type PackInvoice } from "../_shared/pack.ts";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "content-type": "application/json" } });

/** A filename somebody can find again in their downloads folder. */
const safe = (s: unknown) => String(s ?? "document").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60);

const today = () => new Date().toISOString().slice(0, 10);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "not signed in" }, 401);

  let body: { kind?: string; id?: string; download?: boolean };
  try { body = await req.json(); } catch { return json({ error: "bad request" }, 400); }

  const kind = body.kind === "quote" ? "quote" : "invoice";
  const id = String(body.id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "which document?" }, 400);

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${jwt}` } } },
  );

  const { data: { user } } = await sb.auth.getUser(jwt);
  if (!user) return json({ error: "not signed in" }, 401);

  // The issuer's letterhead and banking. Without it the page has no sender,
  // so this is the one read that is worth failing on.
  const { data: issuer } = await sb.from("workspace_billing").select("*").maybeSingle();
  if (!issuer) return json({ error: "this workspace has no billing settings yet" }, 409);

  let doc: PackInvoice;

  if (kind === "invoice") {
    // The invoices row, not the ledger view: the view carries totals but not
    // lines, and the lines frozen on the row at issue are what the document
    // is supposed to show. The ledger is joined only for what it alone knows -
    // what has been received against it.
    const { data: inv, error } = await sb.from("invoices").select("*").eq("id", id).maybeSingle();
    if (error) return json({ error: error.message }, 400);
    if (!inv) return json({ error: "that invoice is not in this workspace" }, 404);

    const { data: led } = await sb.from("invoice_ledger")
      .select("paid,balance,state,days_overdue").eq("id", id).maybeSingle();

    const { data: split } = await sb.from("invoice_vat_breakdown")
      .select("vat_breakdown").eq("invoice_id", id).maybeSingle();

    doc = {
      ...inv,
      kind: "invoice",
      paid: led?.paid ?? 0,
      balance: led?.balance ?? inv.total,
      state: led?.state ?? (inv.status === "void" ? "void" : "owing"),
      days_overdue: led?.days_overdue ?? 0,
      vat_breakdown: split?.vat_breakdown ?? null,
    } as PackInvoice;
  } else {
    const { data: q, error } = await sb.from("quotes").select("*").eq("id", id).maybeSingle();
    if (error) return json({ error: error.message }, 400);
    if (!q) return json({ error: "that quote is not in this workspace" }, 404);

    const { data: split } = await sb.from("quote_vat_breakdown")
      .select("vat_breakdown").eq("quote_id", id).maybeSingle();

    // Whether a date has passed is a decision, so it is made here rather than
    // in the drawing code. A quote that was accepted or declined keeps that
    // word whatever the date says - expiry only describes one nobody answered.
    const open = q.status === "draft" || q.status === "sent";
    const expired = open && q.valid_until && String(q.valid_until) < today();

    doc = {
      ...q,
      kind: "quote",
      // The renderer's date field is shared with invoices; a quote's is its
      // quote_date.
      invoice_date: q.quote_date,
      valid_until: q.valid_until,
      quote_status: expired ? "expired" : q.status,
      vat_breakdown: split?.vat_breakdown ?? null,
    } as PackInvoice;
  }

  // A logo that will not load must not cost somebody their document.
  let logo: Uint8Array | null = null;
  if (issuer.logo_path) {
    try {
      const { data: blob } = await sb.storage.from("branding").download(issuer.logo_path);
      if (blob) logo = new Uint8Array(await blob.arrayBuffer());
    } catch (e) {
      console.warn("document-pdf: logo not loaded:", e instanceof Error ? e.message : e);
    }
  }

  let pdf: Uint8Array;
  try {
    pdf = await buildDocument({ issuer, doc, logo });
  } catch (e) {
    console.error("document-pdf: render failed:", e instanceof Error ? e.stack : e);
    return json({ error: "could not render that document" }, 500);
  }

  const name = `${safe(doc.number ?? (kind === "quote" ? "quote" : "invoice"))}.pdf`;
  return new Response(pdf, {
    headers: {
      ...cors,
      "content-type": "application/pdf",
      // inline for View, attachment for Download. Same bytes either way: the
      // only difference is whether the browser shows it or saves it.
      "content-disposition": `${body.download ? "attachment" : "inline"}; filename="${name}"`,
      "cache-control": "no-store",
    },
  });
});
