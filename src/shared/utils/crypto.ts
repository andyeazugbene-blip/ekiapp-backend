import crypto from "crypto";

/**
 * Constant-time string comparison for secrets (webhook signatures, shared
 * cron/job secrets). A plain === leaks how many leading characters
 * matched via response-time differences (CWE-208, timing attack).
 * crypto.timingSafeEqual throws on mismatched buffer lengths rather than
 * returning false, so the length check must happen first.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf-8");
  const bufferB = Buffer.from(b, "utf-8");
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}
