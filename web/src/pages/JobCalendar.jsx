import React from "react";

// Two whole months of days, stacked as week rows - the shape of a wall
// planner, which is how ops already think about the month ahead.
//
// Whole months, not a rolling window: it begins on the Monday of the week
// holding the 1st of this month and ends with the last day of next month. A
// grid that starts mid-week mid-month reads as a stub row of the previous
// month sitting above the real one. Anything outstanding before the 1st is
// still reachable through the "earlier" chip below the grid.
//
// It reads jobs; it does not fetch them. The list already has the array, and
// two components fetching the same rows drift apart the moment one of them
// reloads.
//
// Picking a day SCROLLS the list to it. The list always holds every job, so
// you can keep reading up into last week or down into next - the calendar is
// a way of getting somewhere, not a filter.

export const localISO = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const DONE = ["completed", "closed", "cancelled"];

const mondayOf = (d) => {
  const out = new Date(d);
  // getDay(): Sunday is 0, so Sunday must go back six days, not forward one.
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
  out.setHours(0, 0, 0, 0);
  return out;
};

export default function JobCalendar({ jobs, selected, onSelect, compact = false }) {
  const today = localISO(new Date());

  // date -> { total, alert, outstanding }
  const byDate = {};
  let unscheduled = 0;
  for (const j of jobs) {
    if (!j.scheduled_date) { unscheduled++; continue; }
    const cell = byDate[j.scheduled_date] ??= { total: 0, alert: false, outstanding: false };
    cell.total++;
    if (j.last_event_alert) cell.alert = true;
    if (!DONE.includes(j.status)) cell.outstanding = true;
  }

  const now = new Date();
  const start = mondayOf(new Date(now.getFullYear(), now.getMonth(), 1));
  // Day 0 of the month after next is the last day of next month.
  const end = new Date(now.getFullYear(), now.getMonth() + 2, 0);

  const weeks = [];
  for (let cursor = new Date(start); cursor <= end; ) {
    const days = [];
    for (let i = 0; i < 7; i++) {
      days.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(days);
  }

  // Which month owns each row - the one with the most days in it. Ties are
  // impossible: seven days cannot split evenly between two months.
  const majority = weeks.map((days) => {
    const tally = {};
    for (const d of days) {
      const k = `${d.getFullYear()}-${d.getMonth()}`;
      tally[k] = (tally[k] ?? 0) + 1;
    }
    return Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
  });

  // Anything outstanding before the window still has to be reachable.
  const earlier = jobs.filter((j) =>
    j.scheduled_date && j.scheduled_date < localISO(start) && !DONE.includes(j.status));

  const Dots = ({ cell }) => {
    if (!cell) return <span style={{ display: "block", height: 5, marginTop: 3 }} />;
    const tone = cell.alert ? "var(--warn)" : "var(--accent)";
    return (
      <span style={{ display: "flex", gap: 2, justifyContent: "center", height: 5, marginTop: 3 }}>
        {Array.from({ length: Math.min(cell.total, 3) }).map((_, i) => (
          <span key={i} style={{ width: 4, height: 4, borderRadius: "50%", background: tone }} />
        ))}
      </span>
    );
  };

  return (
    <div className="no-print">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2,
        fontSize: 11, color: "var(--muted, #8b9498)", textAlign: "center", marginBottom: 4 }}>
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <div key={i}>{d}</div>)}
      </div>

      {weeks.map((days, wi) => {
        // Head a row with the month that owns most of it, and only when that
        // differs from the row above. Naming the month on whichever row holds
        // the 1st goes wrong at both ends: a 1st falling on a Sunday would
        // label a row of six days from the previous month, and skipping such
        // rows loses the month's heading altogether.
        const firstOfMonth = majority[wi] !== majority[wi - 1] ? days.find(
          (d) => `${d.getFullYear()}-${d.getMonth()}` === majority[wi]) : null;
        return (
          <React.Fragment key={wi}>
            {firstOfMonth && (
              <div className="muted" style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".08em",
                textTransform: "uppercase", margin: "8px 0 2px" }}>
                {firstOfMonth.toLocaleDateString("en-ZA", { month: "long", year: "numeric" })}
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 2 }}>
              {days.map((d) => {
                const key = localISO(d);
                const cell = byDate[key];
                const isToday = key === today;
                const isSel = selected === key;
                const past = key < today;
                return (
                  <button key={key} onClick={() => onSelect(key)}
                    aria-label={`${d.toDateString()}${cell ? `, ${cell.total} job${cell.total > 1 ? "s" : ""}` : ", no jobs"}`}
                    aria-pressed={isSel}
                    style={{
                      padding: compact ? "7px 0 5px" : "5px 0 4px",
                      border: isToday ? "1px solid var(--accent)" : "1px solid transparent",
                      borderRadius: 7, cursor: "pointer", font: "inherit",
                      background: isSel ? "var(--ink)" : "transparent",
                      color: isSel ? "#fff" : past && !cell ? "var(--muted, #8b9498)" : "inherit",
                      opacity: past && !cell ? 0.45 : 1,
                      lineHeight: 1.1,
                    }}>
                    <span style={{ fontSize: compact ? 14 : 13,
                      fontWeight: isToday || cell ? 700 : 400 }}>{d.getDate()}</span>
                    <Dots cell={cell} />
                  </button>
                );
              })}
            </div>
          </React.Fragment>
        );
      })}

      {(earlier.length > 0 || unscheduled > 0) && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
          {earlier.length > 0 && (
            <button onClick={() => onSelect("earlier")}
              className={selected === "earlier" ? "stamp bad" : "stamp pending"}
              style={{ background: "none", cursor: "pointer", padding: "6px 10px" }}>
              {earlier.length} earlier
            </button>
          )}
          {unscheduled > 0 && (
            <button onClick={() => onSelect("none")}
              className={selected === "none" ? "stamp live" : "stamp pending"}
              style={{ background: "none", cursor: "pointer", padding: "6px 10px" }}>
              {unscheduled} unscheduled
            </button>
          )}
        </div>
      )}
    </div>
  );
}
