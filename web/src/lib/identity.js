// Phone-based accounts: drivers without email sign in with number + password.
// The same normalization lives in the invite-user function — keep in sync.
export function isPhone(v) {
  return /^[+0-9][0-9 \-()]{6,}$/.test(v.trim()) && !v.includes("@");
}
export function normalizePhone(v) {
  const digits = v.replace(/\D/g, "");
  if (digits.startsWith("0")) return "+27" + digits.slice(1);
  if (digits.startsWith("27")) return "+" + digits;
  return "+" + digits;
}
export function toLoginEmail(identifier) {
  const v = identifier.trim();
  if (!isPhone(v)) return v; // already an email
  return `${normalizePhone(v).replace("+", "")}@phone.oneshot.local`;
}
