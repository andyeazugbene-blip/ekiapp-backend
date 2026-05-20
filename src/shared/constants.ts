/**
 * Centralized constants used across the codebase.
 * Import from here instead of defining locally per module.
 */

// Pagination
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

// Stable cursor-based orderBy (tie-break on id for deterministic pagination)
export const CURSOR_ORDER_BY = [{ createdAt: "desc" as const }, { id: "desc" as const }];

// Shipping
export const MAX_VENDOR_WEIGHT_GRAMS = 30_000; // 30 kg per vendor group
