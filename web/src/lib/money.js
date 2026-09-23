// Invoice currency. Four for now; adding a fifth is one row here plus one
// value in the check constraint on jobs.currency and
// workspace_billing.default_currency.
//
// Nothing in here converts. The amounts on job_charges are already in the
// job's currency - the office typed them that way. A helper that quietly
// multiplied by a rate would be the single most dangerous function in the app.

export const CURRENCIES = [
  // An invoice reads in its own currency's conventions, not the workspace's:
  // a dollar invoice to an American client should say 1,234.50, not 1 234,50.
  { code: "ZAR", symbol: "R",  locale: "en-ZA", name: "South African rand" },
  { code: "USD", symbol: "$",  locale: "en-US", name: "US dollar" },
  { code: "EUR", symbol: "€",  locale: "en-IE", name: "Euro" },
  { code: "GBP", symbol: "£",  locale: "en-GB", name: "Pound sterling" },
];

export const DEFAULT_CURRENCY = "ZAR";

export const currencyOf = (code) =>
  CURRENCIES.find((c) => c.code === code) ?? CURRENCIES[0];

// A job is billed in its own currency, else whatever the workspace bills in,
// else rand. Kept in one place so the screen, the print and any future export
// cannot disagree about what an invoice is denominated in.
export const jobCurrency = (job, issuer) =>
  job?.currency || issuer?.default_currency || DEFAULT_CURRENCY;

// Just the number, grouped and to two places.
export const money = (n, code = DEFAULT_CURRENCY) =>
  (Number(n) || 0).toLocaleString(currencyOf(code).locale,
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Symbol and number: "R 1 234,50", "$ 1,234.50".
export const amount = (n, code = DEFAULT_CURRENCY) =>
  `${currencyOf(code).symbol} ${money(n, code)}`;

// For totals on a printed invoice. "$" alone is ambiguous across four
// countries, so the document states the code once, next to the money.
export const amountWithCode = (n, code = DEFAULT_CURRENCY) =>
  `${currencyOf(code).symbol} ${money(n, code)} ${code}`;
