import { prisma } from "../../lib/prisma";

/**
 * Dual-path resolver mirroring createSupplierOrder()/releaseSupplierPayment()'s
 * existing SupplierAccount-vs-legacy-Vendor pattern. Extracted from
 * campaign-authorisation.service.ts (M7) into its own module so a second,
 * unrelated consumer (organiser-fee.service.ts) can reuse it without
 * creating a circular import between the two payment-mode service files —
 * neither owns the other, and this resolution logic is payment-mode-
 * agnostic (it only ever reads campaign.fulfilmentOwner/supplierAccountId/
 * supplierId, never anything Direct-Charge- or PLEDGE_THEN_CHARGE-specific).
 */
export async function resolveCampaignConnectedAccountId(campaign: { fulfilmentOwner: string; supplierAccountId: string | null; supplierId: string | null }): Promise<string | null> {
  if (campaign.fulfilmentOwner !== "SUPPLIER") return null; // SELF-fulfilment has no connected account.
  if (campaign.supplierAccountId) {
    const account = await prisma.supplierAccount.findUnique({ where: { id: campaign.supplierAccountId }, select: { providerConnectedAccountId: true } });
    return account?.providerConnectedAccountId ?? null;
  }
  if (campaign.supplierId) {
    const supplier = await prisma.supplierProfile.findUnique({ where: { id: campaign.supplierId }, include: { vendor: { select: { stripeAccountId: true } } } });
    return supplier?.vendor.stripeAccountId ?? null;
  }
  return null;
}

/** Resolves the ledger owner (SupplierAccount.id or legacy Vendor.id) for SUPPLIER_PAYABLE/SUPPLIER_CONNECTED_BALANCE legs — same dual-path shape as resolveCampaignConnectedAccountId(). */
export async function resolveCampaignSupplierLedgerOwnerId(campaign: { supplierAccountId: string | null; supplierId: string | null }): Promise<string | null> {
  if (campaign.supplierAccountId) return campaign.supplierAccountId;
  if (campaign.supplierId) {
    const supplier = await prisma.supplierProfile.findUnique({ where: { id: campaign.supplierId }, select: { vendorId: true } });
    return supplier?.vendorId ?? null;
  }
  return null;
}
