// Pull the words back out of a PDF this repo just built, so a test can check
// what a person would read rather than trusting that bytes were produced.
//
// Deliberately small: inflate the content streams and take the strings out of
// the text-showing operators. It is not a PDF parser and does not try to be;
// it is enough to assert that a figure is on the page and that two figures
// are not printed as one.
//
// pdf-lib writes hex strings - <4372617465> Tj - rather than literal (Crate)
// ones, and the first version of this file only handled literals. It returned
// six newlines and nothing else, and the assertions built on it passed
// because there was no text for them to find anything wrong in. Both forms
// are handled now, and readText refuses to return a suspiciously empty result
// so that failure cannot happen quietly again.
import zlib from "node:zlib";

export async function PdfReader(bytes) {
  const buf = Buffer.from(bytes);
  const out = [];
  let i = 0;
  while (true) {
    const s = buf.indexOf("stream", i);
    if (s < 0) break;
    let a = s + 6;
    if (buf[a] === 0x0d) a++;
    if (buf[a] === 0x0a) a++;
    const e = buf.indexOf("endstream", a);
    if (e < 0) break;
    let chunk = buf.subarray(a, e);
    try { chunk = zlib.inflateSync(chunk); } catch { /* not compressed */ }
    const txt = chunk.toString("latin1");

    // <hex> Tj   and   [<hex> -2 <hex>] TJ
    for (const m of txt.matchAll(/<([0-9A-Fa-f\s]+)>\s*(?:Tj|TJ|')/g)) out.push(fromHex(m[1]));
    for (const m of txt.matchAll(/\[((?:[^\][]|\\.)*)\]\s*TJ/g)) {
      for (const p of m[1].matchAll(/<([0-9A-Fa-f\s]+)>/g)) out.push(fromHex(p[1]));
    }
    // (literal) Tj, for a writer that uses them
    for (const m of txt.matchAll(/\(((?:\\.|[^()\\])*)\)\s*(?:Tj|TJ|')/g)) out.push(unesc(m[1]));
    for (const m of txt.matchAll(/\[((?:[^\][]|\\.)*)\]\s*TJ/g)) {
      for (const p of m[1].matchAll(/\(((?:\\.|[^()\\])*)\)/g)) out.push(unesc(p[1]));
    }
    out.push("\n");
    i = e + 9;
  }
  return out.join(" ");
}

/** PdfReader, but it throws rather than hand a test nothing to look at. */
export async function readText(bytes, atLeast = 200) {
  const t = await PdfReader(bytes);
  const words = t.replace(/\s+/g, " ").trim();
  if (words.length < atLeast) {
    throw new Error(
      `read only ${words.length} characters out of the PDF, which means this ` +
      `reader did not understand it rather than that the page is empty - ` +
      `assertions against it would pass for the wrong reason`);
  }
  return words;
}

const fromHex = (h) => Buffer.from(h.replace(/\s+/g, ""), "hex").toString("latin1");

const unesc = (s) => s
  .replace(/\\([nrtbf])/g, (_, c) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[c]))
  .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
  .replace(/\\(.)/g, "$1");
