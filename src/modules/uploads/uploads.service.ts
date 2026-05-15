import crypto from "crypto";
import path from "path";

import { generatePresignedUpload, isStorageConfigured } from "../../lib/storage";
import { AppError } from "../../shared/errors/app-error";
import type { RequestUploadInput, UploadUrlResponse } from "./uploads.types";

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

    return result;
  },
};
