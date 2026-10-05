/**
 * Mandatory admin 2FA switch (handbook §13 L491).
 *
 * ADMIN_2FA_ENFORCE=true|1   -> admins without enabled 2FA are refused on
 *                               sensitive routes (403 TWO_FACTOR_SETUP_REQUIRED)
 * ADMIN_2FA_ENFORCE=false|0  -> legacy pass-through when 2FA is not enabled
 * unset                      -> enforced only when NODE_ENV === "production"
 *
 * Read at call time (not import time) so tests and ops can flip it.
 */
export function isAdmin2faEnforced(): boolean {
  const raw = (process.env.ADMIN_2FA_ENFORCE ?? "").trim().toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return process.env.NODE_ENV === "production";
}
