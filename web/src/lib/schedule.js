// Reading time ranges out of the free-text `time_window` field.
// Handles "9am-10:30am", "09:00-12:00", "9-11am", "14h30 - 16h00",
// "2pm to 4pm", and single times like "9:00am" or "morning".
// Returns minutes from midnight: { start, end, exact } or null.

const NAMED = { morning: [480, 720], afternoon: [720, 1020], evening: [1020, 1200] };
const DEFAULT_MINUTES = 120; // assumed length when only a start is given

function parseClock(raw, inheritedMeridiem) {
  const m = String(raw).trim().match(/^(\d{1,2})(?:[:h.](\d{2}))?\s*(am|pm|noon)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  let mer = (m[3] || inheritedMeridiem || "").toLowerCase();
  if (mer === "noon") mer = "pm";
  if (h > 23 || min > 59) return null;
  if (mer === "pm" && h < 12) h += 12;
  if (mer === "am" && h === 12) h = 0;
  return h * 60 + min;
}

export function parseWindow(tw) {
  if (!tw) return null;
  const t = String(tw).toLowerCase().trim().replace(/(\d)\s*noon/g, "$1pm").replace(/\bnoon\b/g, "12pm");

  for (const [word, [start, end]] of Object.entries(NAMED))
    if (t.includes(word)) return { start, end, exact: false };

  const CLOCK = "\\d{1,2}(?:[:h.]\\d{2})?\\s*(?:am|pm)?";
  const range = t.match(new RegExp(`(${CLOCK})\\s*(?:-|–|—|to|until|till)\\s*(${CLOCK})`, "i"));
  if (range) {
    const tailMer = (range[2].match(/am|pm/i) || [])[0];
    const start = parseClock(range[1], tailMer);
    let end = parseClock(range[2]);
    if (start !== null && end !== null) {
      if (end <= start) end += 720;                 // "9-1pm" style rollover
      if (end > start) return { start, end, exact: true };
    }
  }

  const single = t.match(new RegExp(`(${CLOCK})`, "i"));
  if (single) {
    const start = parseClock(single[1]);
    if (start !== null) return { start, end: start + DEFAULT_MINUTES, exact: false };
  }
  return null;
}

export function overlaps(a, b) {
  if (!a || !b) return false;
  return a.start < b.end && b.start < a.end;
}

export const fmt = (mins) => {
  const h = Math.floor(mins / 60) % 24, m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

// Jobs on the same date whose window overlaps the proposed one.
export function findClashes(proposedWindow, jobs, { excludeId } = {}) {
  const p = parseWindow(proposedWindow);
  if (!p) return [];
  return jobs
    .filter((j) => j.id !== excludeId)
    .map((j) => ({ job: j, win: parseWindow(j.time_window) }))
    .filter(({ win }) => overlaps(p, win))
    .map(({ job, win }) => ({ job, win, certain: p.exact && win.exact }));
}
