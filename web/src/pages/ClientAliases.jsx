import React, { useState } from "react";

// The other names a customer gets called in mail.
//
// Most short forms need nothing here - the matcher works out "Blank projects"
// and "Stevenson" on its own, because both reduce to the same distinctive
// word as the full name. This is for the ones no rule could reach: "WITW" has
// no textual relationship to "WhatIfTheWorld Gallery", and guessing at that on
// an invoice is not something software should do by itself.
//
// Suggestions are offered and never applied. An alias decides whose statement
// a job lands on, so each one is a person's decision, one tap.

/** Same normalisation the matcher uses, so what you see is what it will match. */
const norm = (s) =>
  String(s ?? "").toLowerCase().replace(/[‘’'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();

const CORPORATE = /^(pty|ltd|limited|proprietary|inc|incorporated|llc|plc|npc|npo|cc)$/i;

/** Mirrors suggestAliases in _shared/clientmatch.ts. Offers only a contiguous
 *  piece of the real name, or an initialism from a squashed-together word. */
export function suggest(client, others = []) {
  const source = String(client?.legal_name || client?.name || "");
  if (!source.trim()) return [];

  const formsOf = (c) =>
    [c.legal_name, c.name, ...(c.aliases ?? [])].map(norm).filter(Boolean);
  const taken = new Set(others.filter((o) => o.id !== client.id).flatMap(formsOf));
  const already = new Set(formsOf(client));
  const out = [];
  const offer = (v) => {
    const t = String(v).trim();
    if (t.length < 3) return;
    const n = norm(t);
    if (already.has(n) || taken.has(n) || out.some((o) => norm(o) === n)) return;
    out.push(t);
  };

  const words = source.replace(/[,.]/g, " ").replace(/\(.*?\)/g, " ")
    .replace(/\s+/g, " ").trim().split(" ").filter(Boolean);

  const trimmed = [...words];
  while (trimmed.length > 1 && CORPORATE.test(trimmed[trimmed.length - 1])) trimmed.pop();
  if (trimmed.length && trimmed.length < words.length) offer(trimmed.join(" "));

  const camel = trimmed.find((w) => /[a-z][A-Z]/.test(w));
  if (camel) {
    offer(camel);
    const letters = camel.replace(/([a-z])([A-Z])/g, "$1 $2").split(" ")
      .map((p) => p[0]).join("").toUpperCase();
    if (letters.length >= 3) offer(letters);
  }

  return out.slice(0, 4);
}

export default function ClientAliases({ client, others, onChange }) {
  const [typed, setTyped] = useState("");
  const list = client.aliases ?? [];
  const ideas = suggest(client, others).filter((s) => !list.some((a) => norm(a) === norm(s)));

  const add = (value) => {
    const v = String(value ?? "").trim();
    if (!v) return;
    if (list.some((a) => norm(a) === norm(v))) { setTyped(""); return; }
    onChange([...list, v]);
    setTyped("");
  };

  const remove = (value) => onChange(list.filter((a) => a !== value));

  return (
    <div style={{ marginTop: 4 }}>
      <label>Also called</label>
      <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
        Short forms used in email — “WITW”, “Stevenson”, a trading name. Only
        needed for names that look nothing like the one above; the obvious
        shortenings are already understood.
      </div>

      {list.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {list.map((a) => (
            <span key={a} style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              border: "1px solid var(--line, #ddd)", borderRadius: 999,
              padding: "3px 6px 3px 10px", fontSize: 13,
            }}>
              {a}
              <button type="button" onClick={() => remove(a)} aria-label={`Remove ${a}`}
                style={{ background: "none", border: "none", cursor: "pointer",
                  font: "inherit", lineHeight: 1, padding: "0 2px" }}>×</button>
            </span>
          ))}
        </div>
      )}

      <input
        value={typed}
        placeholder="Type a short name and press Enter"
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(typed); } }}
        onBlur={() => add(typed)}
      />

      {ideas.length > 0 && (
        <div style={{ marginTop: 6, fontSize: 13 }}>
          <span className="muted">Suggestions: </span>
          {ideas.map((s) => (
            <button type="button" key={s} onClick={() => add(s)}
              style={{ background: "none", border: "none", cursor: "pointer",
                font: "inherit", color: "var(--accent, #0a58ca)", padding: "0 8px 0 0" }}>
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
