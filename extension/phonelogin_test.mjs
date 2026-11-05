// The three functions, lifted out of content.js and checked against the web
// app's identity.js, which is the version the accounts were actually made with.
import { readFileSync } from "node:fs";
const src = readFileSync("/home/claude/oneshot/extension/content.js", "utf8");
const grab = (name) => {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error("missing " + name);
  let d = 0, j = src.indexOf("{", i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") d++; else if (src[k] === "}") { d--; if (!d) return src.slice(i, k + 1); }
  }
};
const ext = new Function(`${grab("isPhone")}${grab("normalizePhone")}${grab("toLoginEmail")}
  return { isPhone, normalizePhone, toLoginEmail };`)();

// the app's own version, verbatim
function isPhone(v) { return /^[+0-9][0-9 \-()]{6,}$/.test(v.trim()) && !v.includes("@"); }
function normalizePhone(v) { const d = v.replace(/\D/g, "");
  if (d.startsWith("0")) return "+27" + d.slice(1);
  if (d.startsWith("27")) return "+" + d; return "+" + d; }
function toLoginEmail(i) { const v = i.trim(); if (!isPhone(v)) return v;
  return `${normalizePhone(v).replace("+", "")}@phone.oneshot.local`; }

let pass = 0, fail = 0;
const ok = (c, w) => { c ? (pass++, console.log("  ok   " + w)) : (fail++, console.log("  FAIL " + w)); };

const cases = ["074 589 7070", "0745897070", "+27 74 589 7070", "27745897070",
  "+27745897070", "(074) 589-7070", "lungelo@section9.co.za",
  "lungelosihlemkhize@gmail.com", "  0745897070  "];
for (const c of cases) {
  const a = ext.toLoginEmail(c), b = toLoginEmail(c);
  ok(a === b, `${JSON.stringify(c)} → ${a}`);
}
ok(ext.toLoginEmail("074 589 7070") === "27745897070@phone.oneshot.local",
   "the number Lungelo signed up with resolves to his real account");
ok(ext.toLoginEmail("lungelo@section9.co.za") === "lungelo@section9.co.za",
   "an email is left exactly as it is");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
