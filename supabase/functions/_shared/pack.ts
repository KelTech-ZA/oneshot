// The monthly pack: a statement, then every invoice behind it, as one PDF.
//
// WHY IT IS DRAWN RATHER THAN PRINTED
//
// The app's invoices are printed from the browser, which is the right way to
// do it when a person is standing there: the letterhead is HTML and Chrome
// renders it. There is no browser here. Edge functions have no headless
// Chrome, so the pack is drawn directly into a PDF - positions, not markup.
//
// That means this file and web/src/pages/Letterhead.jsx describe the same
// document twice, which is a real cost and worth being honest about. The
// alternative was worse: a rendering service to keep alive and pay for, or an
// email of raw HTML that every mail client would lay out differently. A
// customer's accounts department files a PDF.
//
// NOTHING IS COMPUTED HERE
//
// Every figure arrives already worked out - totals, VAT, balances, ageing.
// A document that does its own arithmetic is a document that can disagree
// with the database it came from, and this one is a demand for money. The
// caller reads the numbers; this draws them.

import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

// ---------------------------------------------------------------------------

export interface Issuer {
  trading_name?: string | null;
  legal_name?: string | null;
  address?: string | null;
  vat_number?: string | null;
  reg_number?: string | null;
  billing_email?: string | null;
  phone?: string | null;
  bank_account_holder?: string | null;
  bank_name?: string | null;
  bank_branch?: string | null;
  bank_branch_code?: string | null;
  bank_account_number?: string | null;
  bank_swift?: string | null;
  invoice_footer?: string | null;
}

export interface PackLine {
  description?: string | null;
  unit?: string | null;
  quantity?: number | string | null;
  unit_price?: number | string | null;
  line_total?: number | string | null;
}

export interface PackInvoice {
  number: string;
  invoice_date: string;
  due_date?: string | null;
  job_ref?: string | null;
  their_reference?: string | null;
  bill_to_name?: string | null;
  bill_to_address?: string | null;
  bill_to_vat_number?: string | null;
  currency?: string | null;
  payment_terms?: string | null;
  lines?: PackLine[] | null;
  subtotal?: number | string | null;
  vat?: number | string | null;
  vat_rate?: number | string | null;
  total?: number | string | null;
  paid?: number | string | null;
  balance?: number | string | null;
  state?: string | null;
  days_overdue?: number | null;
}

export interface PackInput {
  issuer: Issuer;
  /** Who it is addressed to. */
  client: { name: string; address?: string | null; vat_number?: string | null };
  period: { from: string; to: string };
  invoices: PackInvoice[];
  /** Worked out by the caller: [current, 30, 60, 90+]. */
  ageing: [number, number, number, number];
  currency: string;
  outstanding: number;
  /** PNG or JPEG bytes for the letterhead, when the workspace has one. */
  logo?: Uint8Array | null;
}

// ---------------------------------------------------------------------------

const A4 = { w: 595.28, h: 841.89 };
const M = 42;                      // margin
const INK = rgb(0.12, 0.13, 0.14);
const SOFT = rgb(0.45, 0.48, 0.5);
const RULE = rgb(0.82, 0.84, 0.85);
const BAND = rgb(0.957, 0.961, 0.965);

const n = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

/** 1 234.56 - a space, because that is how money is written here. */
export function money(v: unknown, ccy = ""): string {
  const x = n(v);
  const s = Math.abs(x).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${ccy ? ccy + " " : ""}${x < 0 ? "-" : ""}${s}`;
}

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

export class Pack {
  private doc!: PDFDocument;
  private reg!: Awaited<ReturnType<PDFDocument["embedFont"]>>;
  private bold!: Awaited<ReturnType<PDFDocument["embedFont"]>>;
  private logo: unknown = null;
  private logoDims: { width: number; height: number } | null = null;
  private page!: ReturnType<PDFDocument["addPage"]>;
  private y = 0;

  constructor(private readonly input: PackInput) {}

  // --- the small mechanics --------------------------------------------------

  private w(text: string, size: number, bold = false) {
    return (bold ? this.bold : this.reg).widthOfTextAtSize(text, size);
  }

  private put(text: string, x: number, size: number, opts: {
    bold?: boolean; color?: typeof INK; right?: number;
  } = {}) {
    const t = String(text ?? "");
    const at = opts.right != null ? opts.right - this.w(t, size, opts.bold) : x;
    this.page.drawText(t, {
      x: at, y: this.y, size,
      font: opts.bold ? this.bold : this.reg,
      color: opts.color ?? INK,
    });
  }

  /** Breaks a string to fit a width, so a long crate description wraps rather
   *  than running under the next column. */
  private wrap(text: string, width: number, size: number, bold = false): string[] {
    const words = clean(text).split(" ").filter(Boolean);
    if (!words.length) return [""];
    const out: string[] = [];
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (this.w(next, size, bold) <= width) { line = next; continue; }
      if (line) out.push(line);
      // A single word longer than the column - a URL, a reference - is cut
      // rather than allowed to overrun.
      if (this.w(word, size, bold) > width) {
        let part = "";
        for (const ch of word) {
          if (this.w(part + ch, size, bold) > width) { out.push(part); part = ch; }
          else part += ch;
        }
        line = part;
      } else line = word;
    }
    if (line) out.push(line);
    return out;
  }

  private rule(y = this.y, color = RULE) {
    this.page.drawLine({
      start: { x: M, y }, end: { x: A4.w - M, y },
      thickness: 0.7, color,
    });
  }

  private newPage() {
    this.page = this.doc.addPage([A4.w, A4.h]);
    this.y = A4.h - M;
  }

  /** Room for `need` points, or a fresh page. Returns true if it broke. */
  private room(need: number): boolean {
    if (this.y - need > M + 50) return false;
    this.newPage();
    this.header(true);
    return true;
  }

  // --- the letterhead -------------------------------------------------------

  private header(continued = false) {
    const top = this.y;

    if (this.logo && this.logoDims) {
      const h = 38;
      const w = (this.logoDims.width / this.logoDims.height) * h;
      // deno-lint-ignore no-explicit-any
      this.page.drawImage(this.logo as any, { x: M, y: top - h, width: w, height: h });
    } else {
      // No logo on file: the trading name does the job, which is what the
      // printed letterhead does too.
      this.y = top - 14;
      this.put(clean(this.input.issuer.trading_name) || "", M, 17, { bold: true });
    }

    // Issuer details, right-aligned against the margin.
    const iss = this.input.issuer;
    const right = A4.w - M;
    let ry = top - 2;
    const small = (t: string, bold = false) => {
      if (!clean(t)) return;
      this.y = ry;
      this.put(clean(t), 0, 8.5, { right, color: SOFT, bold });
      ry -= 11;
    };
    small(iss.legal_name ?? "", true);
    for (const l of String(iss.address ?? "").split("\n")) small(l);
    if (iss.vat_number) small(`VAT ${iss.vat_number}`);
    if (iss.reg_number) small(`Reg ${iss.reg_number}`);
    if (iss.phone) small(String(iss.phone));
    if (iss.billing_email) small(String(iss.billing_email));

    this.y = Math.min(top - 52, ry) - 8;
    this.rule(this.y);
    this.y -= (continued ? 18 : 26);
  }

  private footer(note: string) {
    const lines = String(note ?? "").split("\n").map(clean).filter(Boolean);
    if (!lines.length) return;
    let fy = M + 26;
    this.rule(fy + 12);
    for (const l of lines) {
      for (const part of this.wrap(l, A4.w - M * 2, 7.5)) {
        this.y = fy;
        this.put(part, M, 7.5, { color: SOFT });
        fy -= 9.5;
      }
    }
  }

  // --- the statement --------------------------------------------------------

  private statement() {
    const { client, period, invoices, ageing, currency, outstanding } = this.input;
    this.newPage();
    this.header();

    this.put("STATEMENT OF ACCOUNT", M, 15, { bold: true });
    this.y -= 16;
    this.put(`${period.from} to ${period.to}`, M, 9, { color: SOFT });
    this.y -= 24;

    this.put("TO", M, 7.5, { color: SOFT, bold: true });
    this.y -= 12;
    this.put(clean(client.name), M, 11, { bold: true });
    this.y -= 13;
    for (const l of String(client.address ?? "").split("\n").map(clean).filter(Boolean)) {
      this.put(l, M, 9, { color: SOFT });
      this.y -= 11;
    }
    if (client.vat_number) { this.put(`VAT ${client.vat_number}`, M, 9, { color: SOFT }); this.y -= 11; }
    this.y -= 14;

    // Columns: date, number, job, total, paid, balance
    const cx = { date: M, num: M + 68, job: M + 148, total: 400, paid: 468, bal: A4.w - M };
    this.page.drawRectangle({
      x: M - 6, y: this.y - 5, width: A4.w - M * 2 + 12, height: 18, color: BAND,
    });
    this.put("Date", cx.date, 8, { bold: true, color: SOFT });
    this.put("Invoice", cx.num, 8, { bold: true, color: SOFT });
    this.put("Job", cx.job, 8, { bold: true, color: SOFT });
    this.put("Total", 0, 8, { bold: true, color: SOFT, right: cx.total });
    this.put("Paid", 0, 8, { bold: true, color: SOFT, right: cx.paid });
    this.put("Balance", 0, 8, { bold: true, color: SOFT, right: cx.bal });
    this.y -= 20;

    for (const inv of invoices) {
      if (this.room(26)) {
        this.put("Statement continued", M, 9, { color: SOFT, bold: true });
        this.y -= 20;
      }
      this.put(inv.invoice_date ?? "", cx.date, 9);
      this.put(inv.number ?? "", cx.num, 9, { bold: true });
      this.put(clean(inv.job_ref ?? "—").slice(0, 22), cx.job, 9, { color: SOFT });
      this.put(money(inv.total), 0, 9, { right: cx.total });
      this.put(money(inv.paid), 0, 9, { right: cx.paid, color: SOFT });
      this.put(money(inv.balance), 0, 9, { right: cx.bal, bold: n(inv.balance) > 0 });
      this.y -= 8;
      this.rule(this.y);
      this.y -= 13;
    }

    this.y -= 10;
    // Right-aligned well clear of the figure rather than against it: at six
    // digits the amount reaches back past the Paid column and the two words
    // end up printed on top of each other.
    this.put("Total outstanding", 0, 11, { bold: true, right: cx.total });
    this.put(`${currency} ${money(outstanding)}`, 0, 13, { bold: true, right: cx.bal });
    this.y -= 30;

    // Ageing. The reason a statement exists rather than a list of invoices.
    this.put("AGED", M, 7.5, { color: SOFT, bold: true });
    this.y -= 16;
    const labels = ["Current", "30 days", "60 days", "90+ days"];
    const colW = (A4.w - M * 2) / 4;
    const base = this.y;
    labels.forEach((lab, i) => {
      const x = M + colW * i;
      this.y = base;
      this.put(lab, x, 8, { color: SOFT });
      this.y = base - 14;
      this.put(money(ageing[i]), x, 11, { bold: i === 3 && n(ageing[3]) > 0 });
    });
    this.y = base - 36;

    // Where to pay. A statement that does not say how to settle it is a
    // statement somebody has to reply to before they can pay.
    const iss = this.input.issuer;
    if (iss.bank_account_number) {
      this.rule(this.y);
      this.y -= 18;
      this.put("PAYMENT", M, 7.5, { color: SOFT, bold: true });
      this.y -= 14;
      const bank = [
        clean(iss.bank_account_holder),
        [clean(iss.bank_name), clean(iss.bank_branch)].filter(Boolean).join(" · "),
        `Account ${clean(iss.bank_account_number)}`,
        iss.bank_branch_code ? `Branch ${clean(iss.bank_branch_code)}` : "",
        iss.bank_swift ? `SWIFT ${clean(iss.bank_swift)}` : "",
      ].filter(Boolean);
      for (const l of bank) { this.put(l, M, 9); this.y -= 12; }
      this.y -= 4;
      this.put("Please quote the invoice number with payment.", M, 8.5, { color: SOFT });
    }

    this.footer(this.input.issuer.invoice_footer ?? "");
  }

  // --- one invoice ----------------------------------------------------------

  private invoice(inv: PackInvoice) {
    const ccy = inv.currency ?? this.input.currency ?? "";
    this.newPage();
    this.header();

    this.put("TAX INVOICE", M, 15, { bold: true });
    this.put(inv.number ?? "", 0, 15, { bold: true, right: A4.w - M });
    this.y -= 18;

    const facts: string[] = [`Issued ${inv.invoice_date ?? ""}`];
    if (inv.due_date) facts.push(`Due ${inv.due_date}`);
    if (inv.job_ref) facts.push(`Job ${inv.job_ref}`);
    if (inv.their_reference) facts.push(`Your ref ${clean(inv.their_reference)}`);
    this.put(facts.join("   ·   "), M, 9, { color: SOFT });
    // Said on the invoice itself, not only on the statement, because this page
    // is the one that gets forwarded to whoever pays it.
    if (n(inv.days_overdue) > 0 && n(inv.balance) > 0) {
      this.put(`${inv.days_overdue} day${n(inv.days_overdue) === 1 ? "" : "s"} overdue`, 0, 9,
        { right: A4.w - M, bold: true, color: rgb(0.78, 0.35, 0.12) });
    } else if (inv.state === "paid") {
      this.put("PAID", 0, 9, { right: A4.w - M, bold: true, color: rgb(0.2, 0.5, 0.33) });
    }
    this.y -= 26;

    this.put("BILL TO", M, 7.5, { color: SOFT, bold: true });
    this.y -= 12;
    this.put(clean(inv.bill_to_name ?? this.input.client.name), M, 11, { bold: true });
    this.y -= 13;
    for (const l of String(inv.bill_to_address ?? "").split("\n").map(clean).filter(Boolean)) {
      this.put(l, M, 9, { color: SOFT });
      this.y -= 11;
    }
    if (inv.bill_to_vat_number) { this.put(`VAT ${inv.bill_to_vat_number}`, M, 9, { color: SOFT }); this.y -= 11; }
    this.y -= 14;

    const cx = { desc: M, qty: 372, unit: 420, price: 492, amt: A4.w - M };
    // Where the totals block's labels end. Short of cx.price, because a bold
    // 13pt amount in the hundreds of thousands runs back to about x=481 and
    // would otherwise touch the word in front of it.
    const labelRight = 468;
    const descW = cx.qty - M - 28;
    this.page.drawRectangle({
      x: M - 6, y: this.y - 5, width: A4.w - M * 2 + 12, height: 18, color: BAND,
    });
    this.put("Description", cx.desc, 8, { bold: true, color: SOFT });
    this.put("Qty", 0, 8, { bold: true, color: SOFT, right: cx.qty });
    this.put("Unit", cx.unit - 28, 8, { bold: true, color: SOFT });
    this.put("Price", 0, 8, { bold: true, color: SOFT, right: cx.price });
    this.put("Amount", 0, 8, { bold: true, color: SOFT, right: cx.amt });
    this.y -= 20;

    for (const line of inv.lines ?? []) {
      const parts = this.wrap(line.description ?? "", descW, 9);
      if (this.room(14 + parts.length * 11)) {
        this.put(`${inv.number} continued`, M, 9, { color: SOFT, bold: true });
        this.y -= 20;
      }
      const top = this.y;
      parts.forEach((p, i) => { this.y = top - i * 11; this.put(p, cx.desc, 9); });
      this.y = top;
      this.put(String(n(line.quantity)).replace(/\.00$/, ""), 0, 9, { right: cx.qty });
      this.put(clean(line.unit ?? ""), cx.unit - 28, 9, { color: SOFT });
      this.put(money(line.unit_price), 0, 9, { right: cx.price });
      this.put(money(line.line_total), 0, 9, { right: cx.amt });
      this.y = top - (parts.length - 1) * 11 - 8;
      this.rule(this.y);
      this.y -= 13;
    }

    this.y -= 8;
    const totals: [string, string, boolean][] = [
      ["Subtotal", money(inv.subtotal), false],
      ...(n(inv.vat) > 0
        ? [[`VAT ${n(inv.vat_rate) || 15}%`, money(inv.vat), false] as [string, string, boolean]]
        : []),
      [`Total ${ccy}`, money(inv.total), true],
    ];
    for (const [label, value, strong] of totals) {
      this.put(label, 0, strong ? 11 : 9, { right: labelRight, bold: strong, color: strong ? INK : SOFT });
      this.put(value, 0, strong ? 13 : 9, { right: cx.amt, bold: strong });
      this.y -= strong ? 20 : 14;
    }

    if (n(inv.paid) !== 0) {
      this.put("Received", 0, 9, { right: labelRight, color: SOFT });
      this.put(money(inv.paid), 0, 9, { right: cx.amt, color: SOFT });
      this.y -= 16;
      this.put("Balance", 0, 11, { right: labelRight, bold: true });
      this.put(money(inv.balance), 0, 13, { right: cx.amt, bold: true });
      this.y -= 20;
    }

    if (inv.payment_terms) {
      this.y -= 6;
      this.put(`Payment due within ${clean(inv.payment_terms)} days of invoice date.`,
        M, 8.5, { color: SOFT });
    }

    this.footer(this.input.issuer.invoice_footer ?? "");
  }

  // --- the whole thing ------------------------------------------------------

  async build(): Promise<Uint8Array> {
    this.doc = await PDFDocument.create();
    this.reg = await this.doc.embedFont(StandardFonts.Helvetica);
    this.bold = await this.doc.embedFont(StandardFonts.HelveticaBold);

    if (this.input.logo?.length) {
      // A logo that will not decode must not cost the customer their pack.
      try {
        const bytes = this.input.logo;
        const png = bytes[0] === 0x89 && bytes[1] === 0x50;
        const img = png ? await this.doc.embedPng(bytes) : await this.doc.embedJpg(bytes);
        this.logo = img;
        this.logoDims = { width: img.width, height: img.height };
      } catch {
        this.logo = null;
      }
    }

    this.statement();
    for (const inv of this.input.invoices) this.invoice(inv);

    this.doc.setTitle(`Statement and invoices — ${this.input.client.name}`);
    this.doc.setProducer("OneShot");
    this.doc.setCreationDate(new Date());
    return await this.doc.save();
  }
}

export const buildPack = (input: PackInput) => new Pack(input).build();

/**
 * Ageing, from the invoice date. Here rather than in the drawing code so the
 * figure on the statement is the same one the caller can show on screen.
 */
export function age(invoices: PackInvoice[], asAt = new Date()): [number, number, number, number] {
  const b: [number, number, number, number] = [0, 0, 0, 0];
  for (const i of invoices) {
    const bal = n(i.balance);
    if (bal <= 0) continue;
    const days = Math.floor((asAt.getTime() - new Date(i.invoice_date).getTime()) / 86400000);
    b[days >= 90 ? 3 : days >= 60 ? 2 : days >= 30 ? 1 : 0] += bal;
  }
  return b.map((x) => Math.round(x * 100) / 100) as [number, number, number, number];
}
