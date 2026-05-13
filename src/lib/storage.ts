import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { logger } from "./logger";

// S3-compatible storage client (works with AWS S3, Cloudflare R2, MinIO).
// Configure via env vars. If not configured, presigned URLs are not generated.

const BUCKET = process.env.S3_BUCKET;
const REGION = process.env.S3_REGION ?? "auto";
const ENDPOINT = process.env.S3_ENDPOINT; // Required for R2
const ACCESS_KEY = process.env.S3_ACCESS_KEY_ID;
const SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY;
const PUBLIC_URL = process.env.S3_PUBLIC_URL ?? process.env.UPLOAD_BASE_URL ?? "";

let s3: S3Client | null = null;

if (BUCKET && ACCESS_KEY && SECRET_KEY) {
  s3 = new S3Client({
    region: REGION,
    ...(ENDPOINT ? { endpoint: ENDPOINT } : {}),
    credentials: {
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
    },
    forcePathStyle: true, // Required for R2 and MinIO
  });
  logger.info("S3 storage client initialized", { bucket: BUCKET, region: REGION });
}

export interface PresignedUpload {
  uploadUrl: string;
  publicUrl: string;
  key: string;
}

const PRESIGN_EXPIRY = 300; // 5 minutes

const MAX_SIZES: Record<string, number> = {
  product: 5 * 1024 * 1024,       // 5MB
  avatar: 2 * 1024 * 1024,        // 2MB
  cover: 5 * 1024 * 1024,         // 5MB
  verification: 10 * 1024 * 1024, // 10MB
  attachment: 5 * 1024 * 1024,    // 5MB
};

/**
 * Generate a presigned PUT URL for direct browser upload.
 * Returns null if storage is not configured (dev mode).
 */
export async function generatePresignedUpload(
  key: string,
  contentType: string,
  category: string,
): Promise<PresignedUpload | null> {
  if (!s3 || !BUCKET) {
    return null;
  }

  const maxSize = MAX_SIZES[category] ?? 5 * 1024 * 1024;

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
    ContentLength: maxSize, // Used as max in conditions below
  });

  const uploadUrl = await getSignedUrl(s3, command, {
    expiresIn: PRESIGN_EXPIRY,
  });

  const publicUrl = PUBLIC_URL ? `${PUBLIC_URL}/${key}` : `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;

  return { uploadUrl, publicUrl, key };
}

export function isStorageConfigured(): boolean {
  return s3 !== null;
}

export function getPublicUrl(key: string): string {
  if (PUBLIC_URL) return `${PUBLIC_URL}/${key}`;
  return `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;
}
