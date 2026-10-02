/**
 * Privacy helpers (handbook §13 "mask by default, reveal is audited").
 *
 * List views in the admin panel should return masked contact details by
 * default; a "reveal" action must call an endpoint that writes an audit entry
 * (action `pii.reveal`, entityType/entityId of the record, reason required)
 * before returning the full value. These helpers only do the masking — the
 * reveal endpoint is owned by whichever module owns the list (users, orders…).
 */

/** "jane.doe@example.com" -> "j•••@example.com". Returns null for empty input. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local.slice(0, 1)}•••${domain}`;
}

/** "+353871234567" -> "+353•••••4567" (keeps a country-code prefix and last 4 digits). */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length <= 4) return "•••";
  const last4 = digits.slice(-4);
  const prefix = trimmed.startsWith("+") ? trimmed.slice(0, Math.min(4, trimmed.length - 4)) : "";
  return `${prefix}•••••${last4}`;
}
