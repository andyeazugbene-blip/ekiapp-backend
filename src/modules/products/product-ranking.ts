/**
 * Architecture Module 16 ranking inputs: relevance, vendor rating, product
 * performance, shipping compatibility and first-sale promotion. Each is shown
 * as points, so an order can be explained. A sold-out product stays listed, lower.
 */
export const RANKING_POINTS = {
  titleMatch: 40,
  categoryMatch: 15,
  descriptionMatch: 5,
  perStarOfRating: 4,
  deliversToViewer: 20,
  newVendor: 25,
  soldOut: -30,
} as const;

/** Grows slowly, so a few best sellers can't bury every other product. */
const PERFORMANCE_FACTOR = 8;

export type RankingCandidate = {
  title: string;
  category: string | null;
  description: string | null;
  stock: number;
};

export type RankingSignals = {
  search?: string;
  unitsSold: number;
  vendorRating: number | null;
  deliversToViewer: boolean;
  newVendor: boolean;
};

export function productScore(product: RankingCandidate, signals: RankingSignals): number {
  let score = Math.log2(1 + signals.unitsSold) * PERFORMANCE_FACTOR;
  const term = signals.search?.trim().toLowerCase();
  if (term) {
    if (product.title.toLowerCase().includes(term)) score += RANKING_POINTS.titleMatch;
    if (product.category?.toLowerCase().includes(term)) score += RANKING_POINTS.categoryMatch;
    if (product.description?.toLowerCase().includes(term)) score += RANKING_POINTS.descriptionMatch;
  }
  if (signals.vendorRating !== null) score += signals.vendorRating * RANKING_POINTS.perStarOfRating;
  if (signals.deliversToViewer) score += RANKING_POINTS.deliversToViewer;
  if (signals.newVendor) score += RANKING_POINTS.newVendor;
  if (product.stock <= 0) score += RANKING_POINTS.soldOut;
  return score;
}

/** A ranked page is a position in the list, because the order isn't by id. */
const CURSOR_PREFIX = "rank:";

export function encodeRankCursor(offset: number): string {
  return `${CURSOR_PREFIX}${offset}`;
}

export function decodeRankCursor(cursor?: string): number {
  if (!cursor?.startsWith(CURSOR_PREFIX)) return 0;
  const offset = Number(cursor.slice(CURSOR_PREFIX.length));
  return Number.isInteger(offset) && offset > 0 ? offset : 0;
}
