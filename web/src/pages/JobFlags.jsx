// What a job is unsure about, in words.
//
// Flags were written by intake and rendered in exactly one place: the pending
// list on the dashboard. The moment a job was confirmed they vanished, which
// is backwards - a warning matters MORE once work has been committed to, not
// less. Two BPQ451 jobs carried a wrong date, were confirmed, and had nothing
// on them to say so.
//
// Two kinds, and the difference is worth showing rather than flattening:
//
//   missing_info:  the message never said. Somebody has to find out.
//   check:         OneShot made a judgement call and wants it looked at.
//
// A field name is not a sentence, so they are rewritten into one. Anything
// unrecognised is printed as-is rather than swallowed: a flag nobody has
// taught this component about is still a flag somebody should see.

const FIELD = {
  scheduled_date: "a date",
  time_window: "a time",
  origin: "a collection address",
  destination: "a delivery address",
  items: "what is being moved",
  pricing: "a price",
  client_ref: "the client's reference",
  contact: "a contact",
};

/** "missing_info:pricing — Crate fabrication" → kind, field, and the aside. */
function read(flag) {
  const raw = String(flag ?? "");
  const [head, ...rest] = raw.split("—");
  const aside = rest.join("—").trim();
  const body = head.trim();

  if (body.startsWith("missing_info:")) {
    const field = body.slice("missing_info:".length).trim();
    return { kind: "missing", text: `Nobody said ${FIELD[field] ?? field.replace(/_/g, " ")}`, aside };
  }
  if (body.startsWith("check:")) {
    const what = body.slice("check:".length).trim();
    const said = {
      date_year_assumed: "The year was not written, so OneShot worked it out",
      date_year_corrected: "The year was corrected",
      date_in_past: "This date is in the past — check it is meant to be",
    }[what];
    return { kind: "check", text: said ?? what.replace(/_/g, " "), aside };
  }
  return { kind: "check", text: raw, aside: "" };
}

/**
 * `compact` is the dashboard's one-line form; the job page gets the full list,
 * because that is where somebody has stopped to look at one job properly.
 */
export default function JobFlags({ flags, compact = false }) {
  const list = (flags ?? []).filter(Boolean).map(read);
  if (!list.length) return null;

  if (compact) {
    return (
      <div style={{ color: "var(--warn)", fontSize: 13, marginTop: 4 }}>
        ⚠ {list.map((f) => f.text).join(" · ")}
      </div>
    );
  }

  const missing = list.filter((f) => f.kind === "missing");
  const checks = list.filter((f) => f.kind === "check");

  return (
    <div className="card no-print" style={{ borderLeft: "3px solid var(--warn)", marginTop: 10 }}>
      {missing.length > 0 && (
        <div style={{ marginBottom: checks.length ? 10 : 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            Still unanswered on this job
          </div>
          {missing.map((f, i) => (
            <div key={i} className="muted" style={{ fontSize: 13, marginTop: 3 }}>
              • {f.text}{f.aside ? ` — ${f.aside}` : ""}
            </div>
          ))}
        </div>
      )}

      {checks.length > 0 && (
        <div>
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            Worth checking
          </div>
          {checks.map((f, i) => (
            <div key={i} className="muted" style={{ fontSize: 13, marginTop: 3 }}>
              • {f.text}{f.aside ? ` — ${f.aside}` : ""}
            </div>
          ))}
          <div className="muted" style={{ fontSize: 12, marginTop: 6, opacity: 0.8 }}>
            OneShot filled these in from what the message implied rather than what it said.
          </div>
        </div>
      )}
    </div>
  );
}
