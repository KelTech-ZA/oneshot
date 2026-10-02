// The year rule, against a fixed "today" so these mean the same thing in 2030.
//
// The case that started it: an email on 2 October 2026 saying "Monday, 5 Oct"
// and "Tuesday, 6 Oct" produced jobs on 5 and 6 October 2025.

function assertEquals(actual: unknown, expected: unknown, note = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${note ? note + ": " : ""}expected ${b}, got ${a}`);
}

import { checkYear, todayInZA, weekdayOf } from "./dates.ts";

const TODAY = "2026-10-02";

Deno.test("the real failure: a year in the past moves forward", () => {
  assertEquals(checkYear("2025-10-05", TODAY), { date: "2026-10-05", corrected: true, suspect: false });
  assertEquals(checkYear("2025-10-06", TODAY), { date: "2026-10-06", corrected: true, suspect: false });
});

Deno.test("a date already in the future is left alone", () => {
  assertEquals(checkYear("2026-10-05", TODAY), { date: "2026-10-05", corrected: false, suspect: false });
  assertEquals(checkYear("2027-03-01", TODAY), { date: "2027-03-01", corrected: false, suspect: false });
});

Deno.test("today, and the recent past, are left alone", () => {
  // A job logged after the fact is ordinary work, not a typo.
  assertEquals(checkYear(TODAY, TODAY).corrected, false);
  assertEquals(checkYear("2026-09-30", TODAY).corrected, false, "two days ago");
  assertEquals(checkYear("2026-09-22", TODAY).corrected, false, "ten days ago");
});

Deno.test("a date too old to be a missing year is flagged, never rewritten", () => {
  // Moving 2019 forward by one year lands in 2020, still years back - so the
  // missing-year explanation does not hold and the date is left as read.
  const r = checkYear("2019-04-01", TODAY);  // three bumps still land in 2022
  assertEquals(r.date, "2019-04-01", "untouched");
  assertEquals(r.corrected, false);
  assertEquals(r.suspect, true, "but surfaced for a person");
});

Deno.test("a missing year lands on the NEXT occurrence, not merely one year on", () => {
  // 28 Sept 2025, read today, means 28 Sept 2026 - four days ago, which is
  // inside the grace period and therefore where it stops.
  assertEquals(checkYear("2025-09-28", TODAY).date, "2026-09-28");
  // 1 May is months behind us, so the next occurrence is next year's.
  assertEquals(checkYear("2026-05-01", TODAY), { date: "2027-05-01", corrected: true, suspect: false });
});

Deno.test("29 February lands on a real day", () => {
  assertEquals(checkYear("2024-02-29", "2024-06-01").date, "2025-02-28");
});

Deno.test("anything that is not a plain date is passed straight through", () => {
  assertEquals(checkYear("Monday 5 Oct", TODAY), { date: "Monday 5 Oct", corrected: false, suspect: false });
  assertEquals(checkYear("", TODAY).corrected, false);
});

Deno.test("today is read in Durban, not in UTC", () => {
  // 01:30 on 3 October in Johannesburg is still 23:30 on 2 October in UTC.
  // Taking the UTC date here would date a job a day early, every night.
  assertEquals(todayInZA(new Date("2026-10-02T23:30:00Z")), "2026-10-03");
  assertEquals(todayInZA(new Date("2026-10-02T06:00:00Z")), "2026-10-02");
});

Deno.test("weekdays are right, so a message naming one can be checked", () => {
  // The mail said "Monday, 5 Oct" and "Tuesday, 6 Oct" - which is 2026, not
  // 2025. Giving the model the weekday is what lets it tell them apart.
  assertEquals(weekdayOf("2026-10-05"), "Monday");
  assertEquals(weekdayOf("2026-10-06"), "Tuesday");
  assertEquals(weekdayOf("2025-10-05"), "Sunday");
  assertEquals(weekdayOf("2026-10-02"), "Friday");
});
