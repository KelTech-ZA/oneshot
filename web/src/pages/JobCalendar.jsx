import React from "react";

// Nine weeks of days, stacked as rows - the shape of a wall planner, which is
// how ops already think about a fortnight of work.
//
// The window starts on the Monday of LAST week rather than this one, because
// overdue jobs are the ones that most need finding and a calendar that begins
// today hides them.
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

const WEEKS = 9;
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

  const start = mondayOf(new Date());
  start.setDate(start.getDate() - 7);          // include last week's overdue

  const weeks = [];
  for (let w = 0; w < WEEKS; w++) {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + w * 7 + i);
      days.push(d);
    }
    weeks.push(days);
  }

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
        // The month is named on the row where it starts, so the column stays
        // readable without a heading between every four rows.
        const firstOfMonth = days.find((d) => d.getDate() <= 7);
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
