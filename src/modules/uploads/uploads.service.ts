import crypto from "crypto";
import path from "path";

import { generatePresignedRead, generatePresignedUpload, isStorageConfigured, objectExists } from "../../lib/storage";
import { AppError } from "../../shared/errors/app-error";
import type { CompleteUploadInput, RequestUploadInput, UploadUrlResponse } from "./uploads.types";
import { prisma } from "../../lib/prisma";

const MAX_SIZES: Record<string, number> = {
  product: 5 * 1024 * 1024,
  avatar: 2 * 1024 * 1024,
  cover: 5 * 1024 * 1024,
  verification: 10 * 1024 * 1024,
  message: 5 * 1024 * 1024,
};

function generateKey(userId: string, input: RequestUploadInput): string {
  // Sanitize filename: extract only the extension, strip path traversal characters
  const sanitizedFilename = input.filename.replace(/[/\\:*?"<>|]/g, "");
  const ext = path.extname(sanitizedFilename) || mimeToExt(input.contentType);
  // Only allow safe extension characters
  const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, "").slice(0, 10);
  const hash = crypto.randomBytes(8).toString("hex");
  const timestamp = Date.now();
  return `${input.category}/${userId}/${timestamp}-${hash}${safeExt}`;
}

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "application/pdf": ".pdf",
  };
  return map[mime] ?? ".bin";
}

export const uploadsService = {
  async requestUploadUrl(userId: string, input: RequestUploadInput): Promise<UploadUrlResponse> {
    // If storage is not configured, return a clear error instead of fake URLs
    if (!isStorageConfigured()) {
      throw new AppError(
        "File upload is not available. Storage service is not configured.",
        503,
      );
    }

    const key = generateKey(userId, input);
    const result = await generatePresignedUpload(key, input.contentType, input.category);

    if (!result) {
      throw new AppError("Failed to generate upload URL", 502);
    }

    const asset = await prisma.uploadAsset.create({
      data: {
        ownerId: userId,
        category: input.category,
        key: result.key,
        publicUrl: result.publicUrl ?? null,
        contentType: input.contentType,
        status: "REQUESTED",
      },
    });

    return { ...result, assetId: asset.id };
  },

  async completeUpload(userId: string, input: CompleteUploadInput): Promise<{ assetId: string; key: string; publicUrl?: string; privateReadUrl?: string }> {
    const asset = await prisma.uploadAsset.findUnique({ where: { id: input.assetId } });
    if (!asset || asset.ownerId !== userId || asset.key !== input.key) {
      throw new AppError("Upload asset not found", 404);
    }
    if (asset.status === "COMPLETED") {
      return {
        assetId: asset.id,
        key: asset.key,
        publicUrl: asset.publicUrl ?? undefined,
        privateReadUrl: asset.category === "verification" ? await generatePresignedRead(asset.key) : undefined,
      };
    }

    const maxSize = MAX_SIZES[asset.category] ?? MAX_SIZES.product;
    if (input.sizeBytes && input.sizeBytes > maxSize) {
      await prisma.uploadAsset.update({ where: { id: asset.id }, data: { status: "FAILED", sizeBytes: input.sizeBytes } });
      throw new AppError(`File is too large for ${asset.category} uploads`, 413);
    }

    const exists = await objectExists(asset.key);
    if (!exists) {
      throw new AppError("Uploaded object was not found in storage", 409);
    }

    const completed = await prisma.uploadAsset.update({
      where: { id: asset.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        sizeBytes: input.sizeBytes ?? asset.sizeBytes,
      },
    });

    return {
      assetId: completed.id,
      key: completed.key,
      publicUrl: completed.publicUrl ?? undefined,
      privateReadUrl: completed.category === "verification" ? await generatePresignedRead(completed.key) : undefined,
    };
  },

  async listAdminUploads(query: { category?: string; status?: string }) {
    return prisma.uploadAsset.findMany({
      where: {
        ...(query.category ? { category: query.category } : {}),
        ...(query.status ? { status: query.status as "REQUESTED" | "COMPLETED" | "FAILED" } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  },

  async getAdminReadUrl(assetId: string) {
    const asset = await prisma.uploadAsset.findUnique({ where: { id: assetId } });
    if (!asset || asset.status !== "COMPLETED") {
      throw new AppError("Completed upload asset not found", 404);
    }
    return {
      asset,
      readUrl: asset.category === "verification"
        ? await generatePresignedRead(asset.key)
        : asset.publicUrl ?? await generatePresignedRead(asset.key),
    };
  },
};
