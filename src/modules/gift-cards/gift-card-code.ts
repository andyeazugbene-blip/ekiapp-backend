import crypto from "crypto";

/**
 * Gift card redemption codes: 16 characters from an unambiguous base32
 * alphabet (no 0/O/1/I/L/U), drawn from crypto.randomBytes. 32 symbols * 16
 * positions (30^16, about 78 bits of entropy): not guessable. Stored WITHOUT dashes; shown
 * as XXXX-XXXX-XXXX-XXXX.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
// 30 symbols; rejection sampling below keeps the distribution uniform.
const CODE_LENGTH = 16;

export function generateGiftCardCode(): string {
  const out: string[] = [];
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < CODE_LENGTH) {
    const bytes = crypto.randomBytes(32);
    for (const b of bytes) {
      if (b >= limit) continue;
      out.push(ALPHABET[b % ALPHABET.length]);
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out.join("");
}

export function formatGiftCardCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, "$1-");
}

/** Uppercases and strips dashes/spaces. Returns null if the shape is invalid. */
export function normaliseGiftCardCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.toUpperCase().replace(/[\s-]/g, "");
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) {
    if (!ALPHABET.includes(ch)) return null;
  }
  return cleaned;
}

export function maskGiftCardCode(code: string | null): string | null {
  if (!code) return null;
  return `••••-••••-••••-${code.slice(-4)}`;
}

/** Validity period of a newly paid gift card, in months (default 12). */
export function giftCardValidityMonths(): number {
  const raw = Number(process.env.GIFT_CARD_VALIDITY_MONTHS);
  return Number.isInteger(raw) && raw > 0 && raw <= 60 ? raw : 12;
}

export function computeGiftCardExpiry(from: Date = new Date()): Date {
  const d = new Date(from.getTime());
  d.setUTCMonth(d.getUTCMonth() + giftCardValidityMonths());
  return d;
}
