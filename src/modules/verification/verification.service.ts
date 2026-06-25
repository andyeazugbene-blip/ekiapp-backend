import { VendorVerificationStatus, type Prisma, type VerificationDocument } from "@prisma/client";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { deleteStoredObject, generatePresignedRead } from "../../lib/storage";
import { CURSOR_ORDER_BY } from "../../shared/constants";
import { AppError } from "../../shared/errors/app-error";
import type { ReviewVerificationInput, SubmitVerificationInput } from "./verification.types";

const APPROVED_RETENTION_DAYS = 3;
const REJECTED_RETENTION_DAYS = 7;
const STALE_PENDING_DAYS = 14;

type VerificationStatusFilter = "PENDING" | "VERIFIED" | "REJECTED";

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function parsePositiveInt(value: unknown, fallback: number, max = 100): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new AppError(`Invalid limit/page value`, 400);
  }
  return parsed;
}

function normalizeVendorStatus(value: unknown): VerificationStatusFilter | undefined {
  if (value === undefined || value === "" || value === "all") return undefined;
  if (typeof value !== "string") throw new AppError("Invalid status", 400);
  const upper = value.toUpperCase();
  if (upper === "PENDING" || upper === "PENDING_DOCS" || upper === "UNDER_REVIEW") return "PENDING";
  if (upper === "VERIFIED" || upper === "APPROVED") return "VERIFIED";
  if (upper === "REJECTED") return "REJECTED";
  throw new AppError("Invalid status", 400);
}

function documentSummary(documents: VerificationDocument[]) {
  const counts = {
    governmentId: 0,
    businessRegistration: 0,
    selfie: 0,
    total: documents.length,
  };
  for (const doc of documents) {
    if (doc.type === "GOVERNMENT_ID") counts.governmentId++;
    if (doc.type === "BUSINESS_REGISTRATION") counts.businessRegistration++;
    if (doc.type === "SELFIE") counts.selfie++;
  }
  return counts;
}

function docsAlreadyDeleted(documents: VerificationDocument[]): boolean {
  return documents.length > 0 && documents.every((doc) => Boolean(doc.deletedAt) || (!doc.frontUrl && !doc.backUrl));
}

async function getStoredKey(value: string | null | undefined): Promise<string | null> {
  if (!value) return null;
  const asset = await prisma.uploadAsset.findFirst({
    where: {
      category: "verification",
      OR: [{ key: value }, { publicUrl: value }],
    },
    select: { key: true },
  });
  if (asset?.key) return asset.key;
  if (!/^https?:\/\//i.test(value)) return value;
  return null;
}

async function deleteProofsForDocument(doc: VerificationDocument): Promise<{ deleted: boolean; errors: string[]; keys: string[] }> {
  if (doc.deletedAt || (!doc.frontUrl && !doc.backUrl)) {
    return { deleted: true, errors: [], keys: [] };
  }

  const keys = (await Promise.all([getStoredKey(doc.frontUrl), getStoredKey(doc.backUrl)])).filter(
    (key): key is string => Boolean(key),
  );
  const uniqueKeys = Array.from(new Set(keys));
  const errors: string[] = [];

  for (const key of uniqueKeys) {
    try {
      await deleteStoredObject(key);
    } catch (error) {
      errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (errors.length === 0) {
    await prisma.verificationDocument.update({
      where: { id: doc.id },
      data: { frontUrl: "", backUrl: null, deletedAt: new Date() },
    });
    if (uniqueKeys.length > 0) {
      await prisma.uploadAsset.deleteMany({
        where: { category: "verification", key: { in: uniqueKeys } },
      });
    }
  }

  return { deleted: errors.length === 0, errors, keys: uniqueKeys };
}

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
  if (doc.deletedAt || (!doc.frontUrl && !doc.backUrl)) {
    return { ...doc };
  }
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
  async resetPendingDocuments(userId: string): Promise<void> {
    const vendor = await prisma.vendor.findUnique({
      where: { userId },
      select: { id: true, verificationStatus: true },
    });
    if (!vendor) {
      throw new AppError("Vendor profile required", 403);
    }
    if (vendor.verificationStatus === "VERIFIED") {
      throw new AppError("Cannot reset verification for an already verified vendor", 409);
    }
    const pendingDocs = await prisma.verificationDocument.findMany({
      where: { vendorId: vendor.id, status: "PENDING" },
    });
    for (const doc of pendingDocs) {
      const result = await deleteProofsForDocument(doc);
      if (!result.deleted) {
        logger.warn("Verification reset could not delete proof files", {
          documentId: doc.id,
          errors: result.errors,
        });
      }
    }
    await prisma.verificationDocument.deleteMany({
      where: { vendorId: vendor.id, status: "PENDING" },
    });
    await prisma.vendor.update({
      where: { id: vendor.id },
      data: { verificationStatus: "PENDING" },
    });
  },

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
        deletedAt: null,
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
        deleteAfterAt: addDays(new Date(), input.status === "APPROVED" ? APPROVED_RETENTION_DAYS : REJECTED_RETENTION_DAYS),
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
      orderBy: { createdAt: "desc" },
    });
    return Promise.all(docs.map(withSignedDocumentUrls));
  },

  async adminListReviewQueue(query: Record<string, unknown>) {
    const status = normalizeVendorStatus(query.status);
    const page = parsePositiveInt(query.page, 1, 10_000);
    const limit = parsePositiveInt(query.limit, 20);
    const search = typeof query.search === "string" ? query.search.trim() : "";

    const where: Prisma.VendorWhereInput = {
      ...(status ? { verificationStatus: status } : {}),
      ...(search
        ? {
            OR: [
              { storeName: { contains: search, mode: "insensitive" } },
              { contactEmail: { contains: search, mode: "insensitive" } },
              { contactPhone: { contains: search, mode: "insensitive" } },
              { user: { name: { contains: search, mode: "insensitive" } } },
              { user: { email: { contains: search, mode: "insensitive" } } },
              { user: { phone: { contains: search, mode: "insensitive" } } },
            ],
          }
        : {}),
    };

    const vendors = await prisma.vendor.findMany({
      where,
      select: {
        id: true,
        storeName: true,
        contactEmail: true,
        contactPhone: true,
        verificationStatus: true,
        createdAt: true,
        user: { select: { name: true, email: true, phone: true } },
      },
    });

    const vendorIds = vendors.map((vendor) => vendor.id);
    const docs = vendorIds.length > 0
      ? await prisma.verificationDocument.findMany({
          where: { vendorId: { in: vendorIds } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        })
      : [];

    const docsByVendor = new Map<string, VerificationDocument[]>();
    for (const doc of docs) {
      const existing = docsByVendor.get(doc.vendorId) ?? [];
      existing.push(doc);
      docsByVendor.set(doc.vendorId, existing);
    }

    const rows = vendors
      .map((vendor) => {
        const vendorDocs = docsByVendor.get(vendor.id) ?? [];
        return {
          hasDocuments: vendorDocs.length > 0,
          vendorId: vendor.id,
          storeName: vendor.storeName,
          vendorName: vendor.user.name,
          email: vendor.contactEmail ?? vendor.user.email,
          phone: vendor.contactPhone ?? vendor.user.phone,
          verificationStatus: vendor.verificationStatus,
          latestSubmissionDate: vendorDocs[0]?.createdAt ?? vendor.createdAt,
          uploadedDocSummary: documentSummary(vendorDocs),
          docsAlreadyDeleted: docsAlreadyDeleted(vendorDocs),
        };
      })
      .filter((row) => row.hasDocuments)
      .sort((a, b) => b.latestSubmissionDate.getTime() - a.latestSubmissionDate.getTime());

    const total = rows.length;
    const start = (page - 1) * limit;
    const items = rows.slice(start, start + limit);

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  },

  async adminGetReviewDetails(vendorId: string) {
    const vendor = await prisma.vendor.findUnique({
      where: { id: vendorId },
      select: {
        id: true,
        storeName: true,
        storeSlug: true,
        contactEmail: true,
        contactPhone: true,
        country: true,
        city: true,
        verificationStatus: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true, phone: true } },
      },
    });
    if (!vendor) throw new AppError("Vendor not found", 404);

    const documents = await prisma.verificationDocument.findMany({
      where: { vendorId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const proofs = await Promise.all(documents.map(withSignedDocumentUrls));
    const latestReviewed = documents.find((doc) => doc.reviewedAt);
    const latestRejected = documents.find((doc) => doc.rejectionReason);

    return {
      vendor: {
        vendorId: vendor.id,
        storeName: vendor.storeName,
        storeSlug: vendor.storeSlug,
        vendorName: vendor.user.name,
        email: vendor.contactEmail ?? vendor.user.email,
        phone: vendor.contactPhone ?? vendor.user.phone,
        country: vendor.country,
        city: vendor.city,
        verificationStatus: vendor.verificationStatus,
        joinedAt: vendor.createdAt,
      },
      verificationStatus: vendor.verificationStatus,
      uploadedDocSummary: documentSummary(documents),
      docsAlreadyDeleted: docsAlreadyDeleted(documents),
      latestSubmissionDate: documents[0]?.createdAt ?? null,
      reviewedAt: latestReviewed?.reviewedAt ?? null,
      reviewedBy: latestReviewed?.reviewedById ?? null,
      rejectionReason: latestRejected?.rejectionReason ?? null,
      proofs,
    };
  },

  async adminApproveVendorVerification(adminId: string, vendorId: string) {
    const now = new Date();
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { id: true } });
    if (!vendor) throw new AppError("Vendor not found", 404);

    await prisma.$transaction([
      prisma.vendor.update({
        where: { id: vendorId },
        data: { verificationStatus: VendorVerificationStatus.VERIFIED },
      }),
      prisma.verificationDocument.updateMany({
        where: { vendorId, deletedAt: null },
        data: {
          status: "APPROVED",
          reviewedAt: now,
          reviewedById: adminId,
          rejectionReason: null,
          deleteAfterAt: addDays(now, APPROVED_RETENTION_DAYS),
        },
      }),
    ]);

    return this.adminGetReviewDetails(vendorId);
  },

  async adminRejectVendorVerification(adminId: string, vendorId: string, rejectionReason: string) {
    const reason = rejectionReason.trim();
    if (!reason) throw new AppError("rejectionReason is required", 400);
    const now = new Date();
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { id: true } });
    if (!vendor) throw new AppError("Vendor not found", 404);

    await prisma.$transaction([
      prisma.vendor.update({
        where: { id: vendorId },
        data: { verificationStatus: VendorVerificationStatus.REJECTED },
      }),
      prisma.verificationDocument.updateMany({
        where: { vendorId, deletedAt: null },
        data: {
          status: "REJECTED",
          reviewedAt: now,
          reviewedById: adminId,
          rejectionReason: reason,
          deleteAfterAt: addDays(now, REJECTED_RETENTION_DAYS),
        },
      }),
    ]);

    return this.adminGetReviewDetails(vendorId);
  },

  async adminDeleteVendorVerificationFiles(vendorId: string) {
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { id: true } });
    if (!vendor) throw new AppError("Vendor not found", 404);

    const documents = await prisma.verificationDocument.findMany({ where: { vendorId } });
    let deletedDocuments = 0;
    const failures: Array<{ documentId: string; errors: string[] }> = [];

    for (const doc of documents) {
      const result = await deleteProofsForDocument(doc);
      if (result.deleted) {
        deletedDocuments++;
      } else {
        failures.push({ documentId: doc.id, errors: result.errors });
      }
    }

    return {
      vendorId,
      deletedDocuments,
      failedDocuments: failures.length,
      failures,
    };
  },

  async cleanupVerificationProofs(now = new Date()) {
    const stalePendingCutoff = addDays(now, -STALE_PENDING_DAYS);
    const candidates = await prisma.verificationDocument.findMany({
      where: {
        deletedAt: null,
        OR: [
          { deleteAfterAt: { lte: now } },
          { status: "PENDING", createdAt: { lte: stalePendingCutoff } },
        ],
      },
      orderBy: [{ deleteAfterAt: "asc" }, { createdAt: "asc" }],
      take: 250,
    });

    let deletedDocuments = 0;
    const failures: Array<{ documentId: string; errors: string[] }> = [];

    for (const doc of candidates) {
      try {
        const result = await deleteProofsForDocument(doc);
        if (result.deleted) {
          deletedDocuments++;
        } else {
          failures.push({ documentId: doc.id, errors: result.errors });
        }
      } catch (error) {
        failures.push({ documentId: doc.id, errors: [error instanceof Error ? error.message : String(error)] });
      }
    }

    if (failures.length > 0) {
      logger.warn("Verification proof cleanup completed with failures", {
        candidates: candidates.length,
        deletedDocuments,
        failedDocuments: failures.length,
      });
    } else {
      logger.info("Verification proof cleanup completed", {
        candidates: candidates.length,
        deletedDocuments,
      });
    }

    return {
      candidates: candidates.length,
      deletedDocuments,
      failedDocuments: failures.length,
      failures,
    };
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
