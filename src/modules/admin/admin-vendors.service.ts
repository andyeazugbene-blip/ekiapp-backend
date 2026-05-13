import type { Vendor } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";

export const adminVendorsService = {
  async suspendVendor(
    adminId: string,
    vendorId: string,
    reason?: string,
  ): Promise<Vendor> {
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) {
      throw new AppError("Vendor not found", 404);
    }
    if (vendor.isSuspended) {
      throw new AppError("Vendor is already suspended", 409);
    }

    // Suspend vendor and disable all their products
    const [updated] = await prisma.$transaction([
      prisma.vendor.update({
        where: { id: vendorId },
        data: {
          isSuspended: true,
          suspendedReason: reason ?? null,
        },
      }),
      prisma.product.updateMany({
        where: { vendorId, isActive: true },
        data: { isActive: false },
      }),
    ]);

    await recordAudit({
      actorId: adminId,
      action: "vendor.suspend",
      entityType: "Vendor",
      entityId: vendorId,
      metadata: { reason },
    });

    return updated;
  },

  async unsuspendVendor(adminId: string, vendorId: string): Promise<Vendor> {
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) {
      throw new AppError("Vendor not found", 404);
    }
    if (!vendor.isSuspended) {
      throw new AppError("Vendor is not suspended", 409);
    }

    const updated = await prisma.vendor.update({
      where: { id: vendorId },
      data: {
        isSuspended: false,
        suspendedReason: null,
      },
    });

    await recordAudit({
      actorId: adminId,
      action: "vendor.unsuspend",
      entityType: "Vendor",
      entityId: vendorId,
    });

    return updated;
  },
};
