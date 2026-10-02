// Which year "Monday, 5 Oct" means.
//
// Mail rarely writes the year. The reader supplies it from context without
// noticing, and so must the parser - except the parser had no context to
// supply it from: the intake prompt told the model to resolve dates "using the
// message date" and never gave it one, so the year came out of the model's own
// training instead. Two real jobs were created on 5 and 6 October 2025, a year
// in the past. They existed, search found them, and the board - which shows
// work that is coming - showed nothing. That is the worst shape a bug can
// take here: not an error, just an absence.
//
// So the year is now told to the model AND checked afterwards. This file is
// the checking half, kept pure so the rule can be tested against a fixed
// "today" rather than against whatever day the suite happens to run on.

/** Today where the work happens, not where the server is. */
export function todayInZA(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD. Doing this through Intl rather than
  // toISOString matters: at 01:00 in Durban, UTC is still yesterday.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/** The weekday of a plain YYYY-MM-DD, so a message naming one can be checked. */
export function weekdayOf(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()];
}

const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400000);

/** Same date, one year on. 29 February becomes 28 February rather than 1 March. */
function plusYear(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const year = y + 1;
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  const day = Math.min(d, last);
  return `${year}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export interface YearCheck {
  /** The date to use. */
  date: string;
  /** Set when the year was moved, for the reply and the flag. */
  corrected: boolean;
  /** Set when it is in the past and could NOT be explained as a missing year. */
  suspect: boolean;
}

/**
 * Check the year on a date a message asked for.
 *
 * This is the rule the prompt already states and the model does not reliably
 * follow: a date written without a year means its NEXT occurrence, never a
 * past one. Nobody emails to book work that happened last October.
 *
 * So a requested date in the past is walked forward a year at a time until it
 * is no longer in the past. If three years of that still leaves it behind us,
 * the explanation is not a missing year - it is a misread date - and it is
 * left exactly as the parser read it, flagged for a person. Quietly rewriting
 * a date that might have been deliberate is how you break the one job somebody
 * did mean to record late.
 *
 * `graceDays` is why a fortnight of recent past is left alone: a job logged
 * after the fact, or paperwork catching up on last week's collection, is
 * ordinary work rather than a typo.
 */
export function checkYear(iso: string, today: string, graceDays = 14): YearCheck {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    return { date: iso, corrected: false, suspect: false };
  }

  const inThePast = (d: string) => daysBetween(today, d) > graceDays;
  if (!inThePast(iso)) return { date: iso, corrected: false, suspect: false };

  let date = iso;
  for (let tries = 0; tries < 3 && inThePast(date); tries++) date = plusYear(date);

  // Still behind us after three years: not a missing year at all.
  if (inThePast(date)) return { date: iso, corrected: false, suspect: true };

  return { date, corrected: true, suspect: false };
}
