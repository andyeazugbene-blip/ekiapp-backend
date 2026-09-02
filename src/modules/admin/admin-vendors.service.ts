import type { Vendor } from "@prisma/client";

import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { enqueueEmail } from "../../lib/email-queue";
import { emailTemplates } from "../../lib/email-templates";
import { AppError } from "../../shared/errors/app-error";
import { recordAudit } from "../../shared/utils/audit";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const adminVendorsService = {
  async inviteVendor(adminId: string, rawEmail: string): Promise<{ email: string }> {
    const email = rawEmail.trim().toLowerCase();
    if (!email || !EMAIL_REGEX.test(email)) {
      throw new AppError("Invalid email", 400);
    }

    const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true } });
    if (existingUser) {
      throw new AppError(
        existingUser.role === "VENDOR" ? "This email already has a vendor account" : "This email already has an Eki account",
        409,
      );
    }

    const template = emailTemplates.vendorInvite({ email, inviteUrl: env.frontendUrl });
    await enqueueEmail({ to: email, subject: template.subject, html: template.html });

    await recordAudit({
      actorId: adminId,
      action: "vendor.invite",
      entityType: "Vendor",
      entityId: email,
    });

    return { email };
  },

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
