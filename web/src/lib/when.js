// Local dates and times, the way a person means them.
//
// A reminder is set in the time the person is standing in. "09:00 tomorrow"
// means 09:00 in Cape Town, not 09:00 UTC, and the database stores the instant
// those two things resolve to. Everything here works in local time on purpose:
// `new Date(y, m - 1, d, hh, mm)` is the one constructor that does, and
// `new Date("2026-10-07")` is the one that does not - that parses as UTC
// midnight and lands on the 6th for anyone west of Greenwich.
//
// Kept out of the component so it can be tested without a browser.

export const pad = (n) => String(n).padStart(2, "0");

/** YYYY-MM-DD for a Date, in local time. */
export const dateKey = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** A YYYY-MM-DD string back to a local Date at midnight. */
export const fromKey = (key) => {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};

/** YYYY-MM-DD, n days from the given day. */
export const shiftKey = (key, n) => {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
};

/** The instant a picked day and time resolve to, locally. */
export const instant = (key, hh, mm) => {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1, Number(hh) || 0, Number(mm) || 0, 0, 0);
};

/**
 * An hour from now, rounded up to the next five minutes - the sensible default
 * for a reminder, and never a time that has already gone. Rolls the date over
 * on its own at 23:40, which is the case a naive "this hour plus one" gets
 * wrong: it opens the card on a time that cannot be saved.
 */
export const soon = (from = Date.now()) => {
  const d = new Date(from + 60 * 60 * 1000);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  return d;
};

/** The next given weekday (1 = Monday) at or after tomorrow. */
export const nextWeekday = (weekday, from = new Date()) => {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  do { d.setDate(d.getDate() + 1); } while (((d.getDay() + 6) % 7) + 1 !== weekday);
  return dateKey(d);
};

/**
 * Accepts what people actually type: 9:30, 09:30, 9h30, 0930, 9.30, 9 30.
 * Returns [hh, mm] or null. Deliberately strict about range - 25:00 is a typo,
 * not an instruction to roll over into tomorrow.
 */
export const readTime = (s) => {
  const t = String(s).trim();
  if (!t) return null;
  const m = /^(\d{1,2})\s*(?:[:h.\s]\s*)?(\d{2})$/.exec(t);
  if (!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return [hh, mm];
};

/** "Wed 7 Oct at 09:30" */
export const spell = (d) =>
  `${d.toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" })}`
  + ` at ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * "in 15 minutes", "in 3 hours", "tomorrow", "in 4 days" - or "overdue".
 * Rounded, because a reminder is not a stopwatch and "in 2 hours 51 minutes"
 * reads as noise.
 */
export const away = (d, now = new Date()) => {
  const ms = d - now;
  if (ms <= 0) return "overdue";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `in ${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  if (days === 1) return "in about a day";
  if (days < 14) return `in ${days} days`;
  return `in ${Math.round(days / 7)} weeks`;
};
