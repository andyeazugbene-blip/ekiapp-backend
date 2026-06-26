import { VendorVerificationStatus } from "@prisma/client";

import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { stripe } from "../../lib/stripe";
import { AppError } from "../../shared/errors/app-error";
import { communicationService } from "../communications/communication.service";

export const stripeIdentityService = {
  async createVerificationSession(userId: string): Promise<{ url: string; sessionId: string }> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: { id: true, verificationStatus: true, storeName: true, user: { select: { email: true } } },
    });

    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    if (vendor.verificationStatus === "VERIFIED") {
      throw new AppError("Vendor is already verified", 409);
    }

    const session = await stripe.identity.verificationSessions.create({
      type: "document",
      metadata: {
        vendorId: vendor.id,
        userId,
        storeName: vendor.storeName,
      },
      options: {
        document: {
          require_matching_selfie: true,
        },
      },
      return_url: `${env.frontendUrl}/verification-callback`,
    });

    if (!session.url) {
      throw new AppError("Failed to create verification session", 500);
    }

    await prisma.vendor.update({
      where: { id: vendor.id },
      data: {
        stripeVerificationSessionId: session.id,
        verificationStatus: "PENDING",
        verificationFailureReason: null,
      },
    });

    logger.info("Stripe Identity session created", {
      vendorId: vendor.id,
      sessionId: session.id,
    });

    return { url: session.url, sessionId: session.id };
  },

  async handleVerificationCompleted(session: {
    id: string;
    status: string;
    last_error?: { code?: string; reason?: string } | null;
    metadata?: Record<string, string> | null;
  }): Promise<void> {
    const vendorId = session.metadata?.vendorId;

    if (!vendorId) {
      logger.warn("Stripe Identity webhook missing vendorId metadata", { sessionId: session.id });
      return;
    }

    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { id: true, verificationStatus: true, stripeVerificationSessionId: true },
    });

    if (!vendor) {
      logger.warn("Stripe Identity webhook: vendor not found", { vendorId, sessionId: session.id });
      return;
    }

    if (session.status === "verified") {
      const updatedVendor = await prisma.vendor.update({
        where: { id: vendorId },
        data: {
          verificationStatus: VendorVerificationStatus.VERIFIED,
          stripeVerificationSessionId: session.id,
          verifiedAt: new Date(),
          verificationFailureReason: null,
        },
        select: { userId: true, storeName: true, user: { select: { email: true } } },
      });

      logger.info("Vendor verified via Stripe Identity", { vendorId, sessionId: session.id });

      communicationService.send({
        eventKey: "vendor_verification_approved",
        recipientId: updatedVendor.userId,
        recipientEmail: updatedVendor.user.email,
        variables: { store_name: updatedVendor.storeName },
      }).catch((err) => logger.warn("Stripe Identity verified communication failed", { vendorId, error: String(err) }));

      return;
    }

    if (session.status === "requires_input") {
      const reason = session.last_error?.reason ?? session.last_error?.code ?? "Verification failed";

      const updatedVendor = await prisma.vendor.update({
        where: { id: vendorId },
        data: {
          verificationStatus: VendorVerificationStatus.REJECTED,
          stripeVerificationSessionId: session.id,
          verificationFailureReason: reason,
        },
        select: { userId: true, storeName: true, user: { select: { email: true } } },
      });

      logger.info("Vendor verification failed via Stripe Identity", {
        vendorId,
        sessionId: session.id,
        reason,
      });

      communicationService.send({
        eventKey: "vendor_verification_rejected",
        recipientId: updatedVendor.userId,
        recipientEmail: updatedVendor.user.email,
        variables: { store_name: updatedVendor.storeName, reason },
      }).catch((err) => logger.warn("Stripe Identity rejected communication failed", { vendorId, error: String(err) }));

      return;
    }

    logger.info("Stripe Identity webhook: unhandled session status", {
      vendorId,
      sessionId: session.id,
      status: session.status,
    });
  },

  async getVerificationStatus(userId: string): Promise<{
    verificationStatus: VendorVerificationStatus;
    stripeVerificationSessionId: string | null;
    verifiedAt: Date | null;
    verificationFailureReason: string | null;
  }> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: {
        verificationStatus: true,
        stripeVerificationSessionId: true,
        verifiedAt: true,
        verificationFailureReason: true,
      },
    });

    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    return vendor;
  },
};
