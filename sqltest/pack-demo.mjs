// Renders a real pack so it can be looked at.
//
//   npx esbuild supabase/functions/_shared/pack.ts --bundle --format=esm \
//     --platform=node --external:npm:pdf-lib@1.17.1 \
//     --outfile=supabase/functions/_shared/pack.js
//   sed -i 's#"npm:pdf-lib@1.17.1"#"pdf-lib"#' supabase/functions/_shared/pack.js
//   node sqltest/pack-demo.mjs
//
// The esbuild step exists only because Node will not read Deno's npm: import
// specifier. The edge function runs pack.ts directly; pack.js is a build
// artefact for looking at the output here and is not committed.
//
// The data below is Section 9's own, read out of the live database: the
// workspace letterhead, two real invoices with their real line items. A demo
// built from invented numbers proves the code runs, not that the document is
// right.

import fs from "node:fs/promises";
import { buildPack, age } from "../supabase/functions/_shared/pack.js";

const issuer = {
  trading_name: "Section 9",
  legal_name: "Crate Logik (Pty) Ltd",
  address: "95 Sir Lowry Road, Woodstock\nCape Town, South Africa\n7925",
  vat_number: "4220281440",
  reg_number: "2017/093735/07",
  billing_email: "accounts@section9.co.za",
  phone: null,
  bank_account_holder: "Crate Logik (Pty) Ltd",
  bank_name: "Nedbank",
  bank_branch: "Gardens",
  bank_branch_code: "101009",
  bank_account_number: "1145253296",
  bank_swift: "NEDSZAJJ",
  invoice_footer:
    "All credit card payments will be subject to 11.5% service fee\n" +
    "All bank charges, domestic or abroad, are for the account of the remitter.",
};

const invoices = [
  {
    number: "SEC90002",
    invoice_date: "2026-09-29",
    due_date: "2026-10-29",
    job_ref: "JOB-2026-0147",
    bill_to_name: "Charles Moffet Gallery",
    bill_to_address: "511 Canal Street\nNew York, NY 10013\nUnited States",
    currency: "ZAR",
    payment_terms: "30",
    vat_rate: 0,
    lines: [
      { description: "Crate build:  207 x 37 x 146cm(h)", unit: "crate", quantity: 1, unit_price: 3135.00, line_total: 3135.00 },
      { description: "Packing labour: 2 x techs @ R150 p/hr each x 1hr", unit: "hour", quantity: 2, unit_price: 150.00, line_total: 300.00 },
      { description: "Delivery: Welgemoed-CPT Intl. airport", unit: "job", quantity: 1, unit_price: 1983.25, line_total: 1983.25 },
      { description: "Airline handling & scanning fee", unit: "job", quantity: 1, unit_price: 907.50, line_total: 907.50 },
      { description: "Customs forwarding charges", unit: "job", quantity: 1, unit_price: 1563.00, line_total: 1563.00 },
      { description: "Airfreight: CPT-JFK/EWR @ 187vkg", unit: "job", quantity: 1, unit_price: 24782.38, line_total: 24782.38 },
      { description: "Destination charges up to door delivery (DDU)", unit: "job", quantity: 1, unit_price: 27285.46, line_total: 27285.46 },
    ],
    subtotal: 59956.59, vat: 0, total: 59956.59,
    paid: 20000, balance: 39956.59, state: "owing", days_overdue: 5,
  },
  {
    number: "SEC90004",
    invoice_date: "2026-10-13",
    due_date: "2026-11-12",
    job_ref: "JOB-2026-0241",
    bill_to_name: "Charles Moffet Gallery",
    bill_to_address: "511 Canal Street\nNew York, NY 10013\nUnited States",
    currency: "ZAR",
    payment_terms: "30",
    vat_rate: 15,
    lines: [
      { description: "Packing labour: 3x techs @ R150p/h each", unit: "hour", quantity: 3, unit_price: 450.00, line_total: 1350.00 },
      { description: "Delivery: CBD local delivery", unit: "job", quantity: 1, unit_price: 110.00, line_total: 110.00 },
    ],
    subtotal: 1460.00, vat: 219.00, total: 1679.00,
    paid: 0, balance: 1679.00, state: "owing", days_overdue: 0,
  },
];

const pdf = await buildPack({
  issuer,
  client: {
    name: "Charles Moffet Gallery",
    address: "511 Canal Street\nNew York, NY 10013\nUnited States",
    vat_number: null,
  },
  period: { from: "2026-09-01", to: "2026-11-03" },
  invoices,
  ageing: age(invoices, new Date("2026-11-03")),
  currency: "ZAR",
  outstanding: 41635.59,
  logo: null,              // the live function fetches it from the branding bucket
});

const out = new URL("../../pack-demo.pdf", import.meta.url).pathname;
await fs.writeFile(out, pdf);
console.log(`${out}  ${(pdf.length / 1024).toFixed(1)} kB`);
