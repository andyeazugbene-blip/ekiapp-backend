/**
 * URL-safe slug utilities.
 *
 * Slugs are lowercase, alphanumeric, with hyphens between words. Diacritics
 * are stripped (e.g. "Caffè" → "caffe"). Non-ASCII letters are removed.
 */

export function slugify(input: string): string {
  return input
    .normalize("NFD")
    // Strip combining diacritic marks
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // Replace any non alphanumeric with a hyphen
    .replace(/[^a-z0-9]+/g, "-")
    // Trim leading/trailing hyphens
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolve a unique slug given a base candidate and an async existence check.
 * Appends -2, -3, ... until a free slug is found. Caps attempts to avoid
 * pathological loops; falls back to a timestamp-suffixed slug as last resort.
 */
export async function resolveUniqueSlug(
  base: string,
  exists: (candidate: string) => Promise<boolean>,
  options: { maxAttempts?: number } = {},
): Promise<string> {
  const maxAttempts = options.maxAttempts ?? 50;
  const safeBase = slugify(base) || "store";

  if (!(await exists(safeBase))) {
    return safeBase;
  }

  for (let i = 2; i <= maxAttempts; i++) {
    const candidate = `${safeBase}-${i}`;
    if (!(await exists(candidate))) {
      return candidate;
    }
  }

  // Pathological fallback — vanishingly rare in practice.
  return `${safeBase}-${Date.now().toString(36)}`;
}
