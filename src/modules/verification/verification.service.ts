import type { VerificationDocument, VendorVerificationStatus } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { generatePresignedRead } from "../../lib/storage";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import type { ReviewVerificationInput, SubmitVerificationInput } from "./verification.types";

async function assertCompletedVerificationAsset(userId: string, value: string | undefined): Promise<void> {
  if (!value) return;
  const asset = await prisma.uploadAsset.findFirst({
    where: {
      ownerId: userId,
      category: "verification",
      status: "COMPLETED",
      OR: [{ key: value }, { publicUrl: value }],
    },
    select: { id: true },
  });
  if (!asset) {
    throw new AppError("Verification document upload is not completed or does not belong to this account", 400);
  }
}

async function withSignedDocumentUrls<T extends VerificationDocument>(doc: T): Promise<T & { frontReadUrl?: string; backReadUrl?: string }> {
  const frontAsset = await prisma.uploadAsset.findFirst({
    where: { category: "verification", OR: [{ key: doc.frontUrl }, { publicUrl: doc.frontUrl }] },
    select: { key: true },
  });
  const backAsset = doc.backUrl
    ? await prisma.uploadAsset.findFirst({
        where: { category: "verification", OR: [{ key: doc.backUrl }, { publicUrl: doc.backUrl }] },
        select: { key: true },
      })
    : null;

  return {
    ...doc,
    frontReadUrl: frontAsset ? await generatePresignedRead(frontAsset.key) : doc.frontUrl,
    backReadUrl: backAsset ? await generatePresignedRead(backAsset.key) : doc.backUrl ?? undefined,
  };
}

export const verificationService = {
  async submitDocument(
    userId: string,
    input: SubmitVerificationInput,
  ): Promise<VerificationDocument> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: { id: true, verificationStatus: true },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    if (vendor.verificationStatus === "VERIFIED") {
      throw new AppError("Vendor is already verified", 409);
    }

    // Check if a document of this type already exists and is pending
    const existing = await prisma.verificationDocument.findFirst({
      where: {
        vendorId: vendor.id,
        type: input.type,
        status: "PENDING",
      },
    });
    if (existing) {
      throw new AppError("A pending document of this type already exists", 409);
    }

    await assertCompletedVerificationAsset(userId, input.frontUrl);
    await assertCompletedVerificationAsset(userId, input.backUrl);

    const doc = await prisma.verificationDocument.create({
      data: {
        vendorId: vendor.id,
        type: input.type,
        idType: input.idType,
        frontUrl: input.frontUrl,
        backUrl: input.backUrl,
        status: "PENDING",
      },
    });

    // Update vendor status to PENDING if not already
    if (vendor.verificationStatus !== "PENDING") {
      await prisma.vendor.update({
        where: { id: vendor.id },
        data: { verificationStatus: "PENDING" },
      });
    }

    return doc;
  },

  async getOwnVerification(userId: string): Promise<{
    verificationStatus: VendorVerificationStatus;
    documents: VerificationDocument[];
  }> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: { id: true, verificationStatus: true },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }

    const documents = await prisma.verificationDocument.findMany({
      where: { vendorId: vendor.id },
      orderBy: CURSOR_ORDER_BY,
    });

    return {
      verificationStatus: vendor.verificationStatus,
      documents,
    };
  },

  async adminReviewDocument(
    adminId: string,
    documentId: string,
    input: ReviewVerificationInput,
  ): Promise<VerificationDocument> {
    const doc = await prisma.verificationDocument.findUnique({
      where: { id: documentId },
    });
    if (!doc) {
      throw new AppError("Document not found", 404);
    }
    if (doc.status !== "PENDING") {
      throw new AppError("Document already reviewed", 409);
    }

    const updated = await prisma.verificationDocument.update({
      where: { id: documentId },
      data: {
        status: input.status,
        reviewedById: adminId,
        reviewedAt: new Date(),
        rejectionReason: input.rejectionReason,
      },
    });

    // If approved, check if all required docs are approved → verify vendor
    if (input.status === "APPROVED") {
      await this.checkAndVerifyVendor(doc.vendorId);
    }

    // If rejected, update vendor status to REJECTED
    if (input.status === "REJECTED") {
      await prisma.vendor.update({
        where: { id: doc.vendorId },
        data: { verificationStatus: "REJECTED" },
      });
    }

    return updated;
  },

  async adminListPendingDocuments(status?: string): Promise<Array<VerificationDocument & { frontReadUrl?: string; backReadUrl?: string }>> {
    const validStatuses = new Set(["PENDING", "APPROVED", "REJECTED"]);
    const normalizedStatus = status ? status.toUpperCase() : "PENDING";
    const whereStatus = validStatuses.has(normalizedStatus) ? normalizedStatus : "PENDING";
    const docs = await prisma.verificationDocument.findMany({
      where: { status: whereStatus as "PENDING" | "APPROVED" | "REJECTED" },
      orderBy: { createdAt: "asc" },
    });
    return Promise.all(docs.map(withSignedDocumentUrls));
  },

  async checkAndVerifyVendor(vendorId: string): Promise<void> {
    // Check if vendor has at least one approved GOVERNMENT_ID document
    const approvedId = await prisma.verificationDocument.findFirst({
      where: {
        vendorId,
        type: "GOVERNMENT_ID",
        status: "APPROVED",
      },
    });

    if (approvedId) {
      await prisma.vendor.update({
        where: { id: vendorId },
        data: { verificationStatus: "VERIFIED" },
      });
    }
  },
};
