/**
 * Handle normalization. Messages identifies people by phone number (ideally E.164)
 * or email. Every comparison the server makes (allowlist, read scope) goes through
 * `normalizeHandle`, and anything that does not normalize never matches. That keeps
 * the checks fail-closed: a short code or a local-format number cannot slip through.
 */

const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type HandleKind = "phone" | "email";

export interface NormalizedHandle {
  kind: HandleKind;
  value: string;
}

/** Characters people put inside phone numbers that carry no meaning. */
const PHONE_PUNCTUATION = /[\s\-().\u00a0]/g;

export function parseHandle(raw: string): NormalizedHandle | undefined {
  let s = raw.trim();
  if (!s) return undefined;
  const lower = s.toLowerCase();
  if (lower.startsWith("mailto:")) s = s.slice(7);
  else if (lower.startsWith("tel:")) s = s.slice(4);
  if (s.includes("@")) {
    const email = s.toLowerCase();
    return EMAIL.test(email) ? { kind: "email", value: email } : undefined;
  }
  const phone = s.replace(PHONE_PUNCTUATION, "");
  return E164.test(phone) ? { kind: "phone", value: phone } : undefined;
}

/** Normalized handle string, or undefined when the input is not an E.164 number or email. */
export function normalizeHandle(raw: string): string | undefined {
  return parseHandle(raw)?.value;
}

export function isE164(raw: string): boolean {
  return E164.test(raw.trim());
}

/** True for strings that look like a phone number but are not valid E.164. */
export function looksLikeNonE164Phone(raw: string): boolean {
  const s = raw.trim();
  if (!/^[\d\s\-().+\u00a0]+$/.test(s)) return false;
  if (!/\d/.test(s)) return false;
  return normalizeHandle(s) === undefined;
}

/** Masks a handle for logs: `+1415•••0123`, `su•••@example.com`. */
export function maskHandle(raw: string): string {
  const s = raw.trim();
  if (s.includes("@")) {
    const [user = "", domain = ""] = s.split("@");
    return `${user.slice(0, 2)}•••@${domain}`;
  }
  if (s.length <= 6) return "•••";
  return `${s.slice(0, 5)}•••${s.slice(-4)}`;
}
