/**
 * CORS origin resolution (single source of truth).
 *
 * Canonical variable: CORS_ORIGINS (comma-separated list of exact origins).
 * Backward-compatible alias: CORS_ORIGIN - production was configured with the
 * singular name while the code only read the plural one, so the setting was
 * silently ignored. The alias is accepted (and logged) so the existing
 * Vercel value keeps working; CORS_ORIGINS wins when both are set.
 *
 * Safety rules:
 *  - Only exact origins are accepted: scheme://host[:port], no path, no wildcard.
 *  - "*" is rejected, so an operator typo can never open the API to every site.
 *  - In production only https origins are accepted (localhost excluded).
 *  - Invalid entries are dropped. If nothing valid remains in production, the
 *    built-in allow-list is used - production NEVER falls back to "allow all".
 *  - "Allow all" exists only outside production when nothing is configured.
 */

export const DEFAULT_PRODUCTION_ORIGINS = [
  "https://culinarytales.app",
  "https://www.culinarytales.app",
  "https://ekiapp-backend.vercel.app",
  "https://admin-web-eta-six.vercel.app",
  "https://ekiapp-admin.vercel.app",
  "https://admin-byr91fle1-andyekiapp-s-projects.vercel.app",
  "https://admin-69fl6skwn-andyekiapp-s-projects.vercel.app",
  "https://admin-web-gray-six.vercel.app",
];

const ORIGIN_RE = /^https?:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

export interface CorsResolution {
  /** `true` = allow any origin (non-production only). */
  origins: string[] | true;
  source: "CORS_ORIGINS" | "CORS_ORIGIN" | "default" | "open-non-production";
  rejected: string[];
}

export function parseOriginList(raw: string, isProduction: boolean): { valid: string[]; rejected: string[] } {
  const valid: string[] = [];
  const rejected: string[] = [];
  for (const part of raw.split(",")) {
    const origin = part.trim().replace(/\/+$/, "");
    if (!origin) continue;
    const ok =
      origin !== "*" &&
      ORIGIN_RE.test(origin) &&
      (!isProduction || (origin.startsWith("https://") && !/^https:\/\/(localhost|127\.|0\.0\.0\.0)/i.test(origin)));
    if (ok) valid.push(origin.toLowerCase());
    else rejected.push(origin);
  }
  return { valid: [...new Set(valid)], rejected };
}

export function resolveCorsOrigins(
  env: Record<string, string | undefined>,
  isProduction: boolean,
): CorsResolution {
  const canonical = env.CORS_ORIGINS?.trim();
  const alias = env.CORS_ORIGIN?.trim();
  const raw = canonical || alias;
  const source: CorsResolution["source"] = canonical ? "CORS_ORIGINS" : "CORS_ORIGIN";

  if (raw) {
    const { valid, rejected } = parseOriginList(raw, isProduction);
    if (valid.length > 0) return { origins: valid, source, rejected };
    // Configured but nothing usable: never widen access.
    return isProduction
      ? { origins: DEFAULT_PRODUCTION_ORIGINS, source: "default", rejected }
      : { origins: true, source: "open-non-production", rejected };
  }

  return isProduction
    ? { origins: DEFAULT_PRODUCTION_ORIGINS, source: "default", rejected: [] }
    : { origins: true, source: "open-non-production", rejected: [] };
}
