import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { marketConfigurationService } from "./market-configuration.service";

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
    const existing = await prisma.supplierProfile.findUnique({ where: { vendorId } });
    if (existing) throw new AppError("Supplier application already exists", 409);
    return prisma.supplierProfile.create({ data: { vendorId, country } });
  },

  async getOrganiserProfile(userId: string) {
    return prisma.organiserProfile.findUnique({ where: { userId } });
  },

  async getSupplierProfile(vendorId: string) {
    return prisma.supplierProfile.findUnique({ where: { vendorId } });
  },

  /** Verified suppliers an organiser can pick when creating a campaign in their market — spec §8.2 (same-market pairing only). */
  async listVerifiedSuppliers(country: string) {
    return prisma.supplierProfile.findMany({
      where: { isVerified: true, country },
      include: { vendor: { select: { storeName: true } } },
      orderBy: { verifiedAt: "desc" },
    });
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
    return prisma.supplierProfile.update({ where: { id }, data: { isVerified: true, verifiedAt: new Date() } });
  },
};
