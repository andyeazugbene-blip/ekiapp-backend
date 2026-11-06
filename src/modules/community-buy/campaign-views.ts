import type { NextFunction, Request, Response } from "express";

/** Eki staff only. Removed from every Community Buy response outside the admin API. */
const STAFF_ONLY_FIELDS = new Set(["adminIssueNotes", "disputeReason", "disputedById", "reviewedById", "internalNotes"]);

/** Between Eki, the organiser and the supplier. A buyer has no need to see these. */
const PARTY_ONLY_FIELDS = [
  "reviewNotes",
  "reviewCriteria",
  "reviewedAt",
  "wholesaleAmountMinor",
  "supplierDeclineReason",
  "supplierDeclinedAt",
  "disputedAt",
  "supplierInventoryStatus",
  "supplierInventoryStatusAt",
  "paidTotal",
] as const;

const MAX_DEPTH = 12;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function stripStaffFields<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => stripStaffFields(item, depth + 1)) as unknown as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!STAFF_ONLY_FIELDS.has(key)) out[key] = stripStaffFields(item, depth + 1);
  }
  return out as T;
}

/** Covers every route, including new ones, so a staff note can't reach an app by accident. */
export function hideStaffFields(_request: Request, response: Response, next: NextFunction): void {
  const json = response.json.bind(response);
  response.json = (body: unknown) => json(stripStaffFields(body));
  next();
}

type SupplierNames = {
  supplier?: { vendor?: { storeName?: string } | null } | null;
  supplierAccount?: { businessName?: string | null; user?: { name?: string | null } | null } | null;
};

/**
 * What a buyer sees of a campaign they aren't running or supplying. The supplier
 * is reduced to its name, because the full row holds payout and Stripe details.
 */
export function buyerCampaignView<T extends object>(campaign: T & SupplierNames): T {
  const view = { ...campaign } as Record<string, unknown>;
  for (const field of PARTY_ONLY_FIELDS) delete view[field];
  delete view.contributions;
  if (campaign.supplier) view.supplier = { vendor: { storeName: campaign.supplier.vendor?.storeName } };
  if (campaign.supplierAccount) {
    view.supplierAccount = { businessName: campaign.supplierAccount.businessName, user: { name: campaign.supplierAccount.user?.name } };
  }
  return view as T;
}
