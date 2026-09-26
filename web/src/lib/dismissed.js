// Notices you have already dealt with.
//
// Dismissing used to mean removing a banner from React state, which lasted
// until the next render. Open the job, come back to the board, and all five
// "Job still open" banners were there again - because the reminder is rebuilt
// from the database on every mount and nothing recorded that you had seen it.
//
// A dismissal is now written down. X means gone, and stays gone.
//
// Stored per device rather than per account: it is a reading position, not
// data. Dismissing on the laptop leaving the phone alone is the right
// behaviour, and it needs no table, no migration and no round trip.

const KEY = "oneshot_dismissed_v1";
const MAX = 500;            // keys are tiny; this is about 20KB at worst

// Private browsing, cleared site data and locked-down browsers all make
// localStorage throw rather than return nothing. A notice that cannot be
// remembered as dismissed is a nuisance; a crash is worse.
function read() {
  try {
    const raw = localStorage.getItem(KEY);
    return Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [];
  } catch { return []; }
}

function write(list) {
  try {
    // Oldest first, so slicing from the end keeps the most recent.
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)));
  } catch { /* nothing to be done, and not worth interrupting anyone over */ }
}

export function isDismissed(key) {
  return read().includes(key);
}

// Returns only the ones still worth showing.
export function keepUndismissed(items, keyOf = (x) => x.key) {
  const seen = new Set(read());
  return items.filter((x) => !seen.has(keyOf(x)));
}

export function dismiss(...keys) {
  const flat = keys.flat().filter(Boolean).map(String);
  if (!flat.length) return;
  const cur = read();
  write([...cur, ...flat.filter((k) => !cur.includes(k))]);
}
