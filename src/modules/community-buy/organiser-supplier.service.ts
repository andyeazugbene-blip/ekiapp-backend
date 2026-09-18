import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { vendorMarketsService } from "../vendors/vendor-markets.service";
import { marketConfigurationService } from "./market-configuration.service";
import { supplierAccountService } from "./supplier-account.service";

/**
 * spec §5 permission rule: a role must be granted independently. Being a
 * verified buyer/vendor never automatically makes someone an organiser or
 * supplier — these are separate applications, separately verified.
 */
export const organiserSupplierService = {
  async applyAsOrganiser(userId: string, country: string) {
    const config = await marketConfigurationService.get(country);
    if (!config?.organiserApplicationsEnabled) {
      throw new AppError("Organiser applications are not open in this market yet", 403);
    }
    const existing = await prisma.organiserProfile.findUnique({ where: { userId } });
    if (existing) throw new AppError("Organiser application already exists", 409);
    return prisma.organiserProfile.create({ data: { userId, country } });
  },

  async applyAsSupplier(vendorId: string, country: string) {
    const config = await marketConfigurationService.get(country);
    if (!config?.supplierApplicationsEnabled) {
      throw new AppError("Supplier applications are not open in this market yet", 403);
    }
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { verificationStatus: true } });
    if (!vendor || vendor.verificationStatus !== "VERIFIED") {
      throw new AppError("Only a verified vendor may apply as a Community Buy supplier", 403);
    }
    // A vendor may apply as a Community Buy supplier only for a market they
    // actually have an active VendorMarketAssignment for — otherwise a
    // vendor operating only in the UK could apply to supply France's
    // Community Buy just by sending a different country string, since this
    // application was previously decoupled from the vendor's own markets.
    if (!(await vendorMarketsService.hasActiveMarket(vendorId, country))) {
      throw new AppError("You can only apply as a supplier for a market your vendor account is assigned to", 403);
    }
    const existing = await prisma.supplierProfile.findUnique({ where: { vendorId } });
    if (existing) throw new AppError("Supplier application already exists", 409);
    const created = await prisma.supplierProfile.create({ data: { vendorId, country } });
    // Workstream 1: keep the new user-keyed SupplierAccount in sync with
    // this legacy Vendor-backed application so requireApprovedSupplier()
    // and canSupply never drift from it.
    await supplierAccountService.syncSupplierAccountForProfile(created.id);
    return created;
  },

  async getOrganiserProfile(userId: string) {
    return prisma.organiserProfile.findUnique({ where: { userId } });
  },

  /**
   * Phase 2 (organiser identity display preference) — account-level
   * setting, not per-campaign, so it's set here rather than through
   * community-campaigns.service.ts's update(). Applies to every campaign
   * this organiser runs, current and future.
   */
  async updateOrganiserProfile(userId: string, input: { firstNameOnlyDisplay?: boolean }) {
    const existing = await prisma.organiserProfile.findUnique({ where: { userId } });
    if (!existing) throw new AppError("Organiser profile not found", 404);
    if (input.firstNameOnlyDisplay === undefined) return existing;
    return prisma.organiserProfile.update({ where: { userId }, data: { firstNameOnlyDisplay: input.firstNameOnlyDisplay } });
  },

  async getSupplierProfile(vendorId: string) {
    return prisma.supplierProfile.findUnique({ where: { vendorId } });
  },

  /**
   * Workstream 3 — the organiser-facing supplier picker (spec §8.2,
   * same-market pairing only), now SupplierAccount-driven (item 6: no
   * Vendor should ever be required merely to be selected as supplier).
   * Every verified legacy SupplierProfile already has a mirrored, kept-in-
   * sync SupplierAccount row (syncSupplierAccountForProfile, called from
   * every verify/restrict/unrestrict mutation below and in
   * community-campaigns.service.ts) with the same APPROVED/RESTRICTED state
   * and a single-country coverageRegions — so this single query surfaces
   * both existing Vendor-backed suppliers and new no-Vendor ones together,
   * without a second query or a merge step.
   */
  async listVerifiedSuppliers(country: string) {
    const accounts = await prisma.supplierAccount.findMany({
      where: { supplierState: "APPROVED", coverageRegions: { has: country } },
      include: { user: { select: { name: true } } },
      orderBy: { approvedAt: "desc" },
    });
    return accounts.map((account) => ({
      id: account.id,
      displayName: account.user.name,
      categories: account.categories,
      coverageRegions: account.coverageRegions,
      legacySupplierProfileId: account.legacySupplierProfileId,
    }));
  },

  // ─── Admin verification ─────────────────────────────────────────────────

  async listPendingOrganisers() {
    return prisma.organiserProfile.findMany({
      where: { isVerified: false },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    });
  },

  async listPendingSuppliers() {
    return prisma.supplierProfile.findMany({
      where: { isVerified: false },
      include: { vendor: { select: { storeName: true, verificationStatus: true } } },
      orderBy: { createdAt: "asc" },
    });
  },

  async verifyOrganiser(id: string) {
    return prisma.organiserProfile.update({ where: { id }, data: { isVerified: true, verifiedAt: new Date() } });
  },

  async verifySupplier(id: string) {
    const updated = await prisma.supplierProfile.update({ where: { id }, data: { isVerified: true, verifiedAt: new Date() } });
    await supplierAccountService.syncSupplierAccountForProfile(id);
    return updated;
  },

  // ─── Risk controls — restrict/unrestrict a verified organiser or
  // supplier without revoking verification. A restricted organiser can't
  // create new campaigns; a restricted supplier can't be picked for new
  // campaigns or commit to one awaiting their acceptance. Existing live
  // campaigns are untouched — restriction only closes the door forward. ──

  async listVerifiedOrganisersForAdmin() {
    return prisma.organiserProfile.findMany({
      where: { isVerified: true },
      include: { user: { select: { name: true, email: true } } },
      orderBy: { verifiedAt: "desc" },
    });
  },

  async listVerifiedSuppliersForAdmin() {
    return prisma.supplierProfile.findMany({
      where: { isVerified: true },
      include: { vendor: { select: { storeName: true } } },
      orderBy: { verifiedAt: "desc" },
    });
  },

  /** Real prior state for audit before/after capture — never fabricated, since restrict/unrestrict below have no status guard of their own. */
  async getOrganiserRestrictionState(id: string) {
    return prisma.organiserProfile.findUnique({ where: { id }, select: { isRestricted: true, restrictedReason: true } });
  },

  async getSupplierRestrictionState(id: string) {
    return prisma.supplierProfile.findUnique({ where: { id }, select: { isRestricted: true, restrictedReason: true } });
  },

  async restrictOrganiser(id: string, reason: string) {
    return prisma.organiserProfile.update({ where: { id }, data: { isRestricted: true, restrictedReason: reason } });
  },

  async unrestrictOrganiser(id: string) {
    return prisma.organiserProfile.update({ where: { id }, data: { isRestricted: false, restrictedReason: null } });
  },

  async restrictSupplier(id: string, reason: string) {
    const updated = await prisma.supplierProfile.update({ where: { id }, data: { isRestricted: true, restrictedReason: reason } });
    await supplierAccountService.syncSupplierAccountForProfile(id);
    return updated;
  },

  async unrestrictSupplier(id: string) {
    const updated = await prisma.supplierProfile.update({ where: { id }, data: { isRestricted: false, restrictedReason: null } });
    await supplierAccountService.syncSupplierAccountForProfile(id);
    return updated;
  },
};
