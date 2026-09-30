import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

// The workspace's letterhead, on every printed document.
//
// Read from the workspace_letterhead VIEW, not workspace_billing. The view
// carries only what already appears on paperwork the client receives - name,
// address, VAT and registration numbers, contact details, logo - so a crew
// member printing a job card gets a proper document without the database ever
// handing them the bank account number. Ops edit the underlying row in
// Billing details; there is no second copy of any of it to drift.
//
// Print-only by default. On a job card or an invoice, showing it on screen
// would only tell the user their own company's address, which they already
// know. A statement is different: it IS the document, and the reader needs to
// see what the customer will see before sending it - so that one passes
// screen.

// One fetch per page load however many documents render a letterhead: a job
// card and its invoice both want one, and asking twice is waste.
let cache = null;
let inflight = null;

async function fetchHead() {
  if (cache) return cache;
  if (!inflight) {
    inflight = supabase.from("workspace_letterhead").select("*").maybeSingle()
      .then(({ data }) => { cache = data ?? {}; inflight = null; return cache; })
      .catch(() => { inflight = null; return {}; });
  }
  return inflight;
}

export function clearLetterheadCache() { cache = null; }

export function logoUrl(path) {
  if (!path) return null;
  // Public bucket: a signed URL can expire between opening the print preview
  // and the page rendering, and a missing logo on an invoice is worse than a
  // public one. A logo is on everything the company sends out anyway.
  return supabase.storage.from("branding").getPublicUrl(path).data?.publicUrl ?? null;
}

export function useLetterhead() {
  const [head, setHead] = useState(cache);
  useEffect(() => {
    let alive = true;
    fetchHead().then((h) => { if (alive) setHead(h); });
    return () => { alive = false; };
  }, []);
  return head;
}

/**
 * title   what this document is: "Invoice", "Job card". Optional.
 * meta    [[label, value], ...] printed to the right of the letterhead -
 *         the date and reference a document needs to stand on its own.
 */
export default function Letterhead({ title, meta = [], screen = false }) {
  const head = useLetterhead();
  if (!head) return null;

  const url = logoUrl(head.logo_path);
  const name = head.trading_name || head.legal_name;
  const rows = meta.filter(([, v]) => v);

  // Nothing filled in yet: print the document rather than a broken header.
  if (!name && !url && !rows.length) return null;

  const idLine = [
    head.vat_number && `VAT ${head.vat_number}`,
    head.reg_number && `Reg. ${head.reg_number}`,
    head.eori_number && `EORI ${head.eori_number}`,
  ].filter(Boolean).join(" · ");

  const contact = [head.billing_email, head.phone].filter(Boolean).join(" · ");

  return (
    <div className={"letterhead" + (screen ? " on-screen" : " only-print")}>
      <div className="letterhead-body">
        {url && <img className="letterhead-logo" src={url} alt="" />}
        <div className="letterhead-who">
          {name && <div className="letterhead-name">{name}</div>}
          {head.legal_name && head.trading_name && head.legal_name !== head.trading_name && (
            <div>{head.legal_name}</div>
          )}
          {head.address && <div style={{ whiteSpace: "pre-line" }}>{head.address}</div>}
          {idLine && <div>{idLine}</div>}
          {contact && <div>{contact}</div>}
        </div>

        {(title || rows.length > 0) && (
          <div className="letterhead-doc">
            {title && <div className="letterhead-title">{title}</div>}
            {rows.map(([label, value]) => (
              <div key={label} className="letterhead-metarow">
                <span className="letterhead-metalabel">{label}</span>
                <span className="letterhead-metavalue">{value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
