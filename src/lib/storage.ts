import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { logger } from "./logger";

// S3-compatible storage client (works with AWS S3, Cloudflare R2, MinIO).
// Configure via env vars. If not configured, presigned URLs are not generated.

const BUCKET = process.env.S3_BUCKET;
const REGION = process.env.S3_REGION ?? "auto";
const RAW_ENDPOINT = process.env.S3_ENDPOINT?.trim(); // Required for R2
const ACCESS_KEY = process.env.S3_ACCESS_KEY_ID;
const SECRET_KEY = process.env.S3_SECRET_ACCESS_KEY;
const PUBLIC_URL = process.env.S3_PUBLIC_URL ?? process.env.UPLOAD_BASE_URL ?? "";

function normalizeEndpoint(rawEndpoint: string | undefined, bucket: string | undefined): string | undefined {
  if (!rawEndpoint) {
    return undefined;
  }

  const normalized = rawEndpoint.trim().replace(/\/+$/, "");

  if (!bucket) {
    return normalized;
  }

  const bucketSuffix = `/${bucket}`;

  try {
    const url = new URL(normalized);
    if (url.pathname === bucketSuffix || url.pathname.endsWith(bucketSuffix)) {
      url.pathname = url.pathname.replace(new RegExp(`${bucketSuffix}$`), "");
      return url.toString().replace(/\/+$/, "");
    }
    return normalized;
  } catch {
    if (normalized.endsWith(bucketSuffix)) {
      return normalized.slice(0, -bucketSuffix.length);
    }
    return normalized;
  }
}

const ENDPOINT = normalizeEndpoint(RAW_ENDPOINT, BUCKET); // Required for R2

// ─── Startup validation ──────────────────────────────────────────────────────

let storageDisabled = false;

if (RAW_ENDPOINT && ENDPOINT && RAW_ENDPOINT !== ENDPOINT) {
  logger.warn(
    `S3_ENDPOINT included a bucket path and was normalized for R2 compatibility. ` +
    `Use the account-level endpoint when possible.`,
  );
}

// If S3_ENDPOINT is configured (R2/MinIO), S3_PUBLIC_URL is required — there is no
// reliable AWS-style fallback for non-AWS providers.
if (!storageDisabled && ENDPOINT && BUCKET && ACCESS_KEY && SECRET_KEY && !PUBLIC_URL) {
  logger.error(
    "S3_PUBLIC_URL (or UPLOAD_BASE_URL) is required when S3_ENDPOINT is configured. " +
    "Set it to your R2 public bucket URL or custom domain (e.g. https://cdn.example.com). Storage DISABLED.",
  );
  storageDisabled = true;
}

let s3: S3Client | null = null;

if (!storageDisabled && BUCKET && ACCESS_KEY && SECRET_KEY) {
  s3 = new S3Client({
    region: REGION,
    ...(ENDPOINT ? { endpoint: ENDPOINT } : {}),
    credentials: {
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
    },
    forcePathStyle: true, // Required for R2 and MinIO
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  // Remove the flexible checksums middleware that causes R2 SignatureDoesNotMatch
  s3.middlewareStack.remove("flexibleChecksumsMiddleware");
  logger.info("S3 storage client initialized", { bucket: BUCKET, region: REGION });
}

export interface PresignedUpload {
  uploadUrl: string;
  publicUrl?: string;
  key: string;
}

const PRESIGN_EXPIRY = 300; // 5 minutes

// @ts-ignore — kept for documentation; will be used when content-length validation is added
const _MAX_SIZES: Record<string, number> = {
  product: 5 * 1024 * 1024,       // 5MB
  avatar: 2 * 1024 * 1024,        // 2MB
  cover: 5 * 1024 * 1024,         // 5MB
  verification: 10 * 1024 * 1024, // 10MB
  attachment: 5 * 1024 * 1024,    // 5MB
};

const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
]);

/**
 * Generate a presigned PUT URL for direct browser upload.
 * Returns null if storage is not configured (dev mode).
 *
 */
export async function generatePresignedUpload(
  key: string,
  contentType: string,
  category: string,
): Promise<PresignedUpload | null> {
  if (!s3 || !BUCKET) {
    // If not configured, return a mock upload URL for local dev/testing
    const mockBaseUrl = process.env.PUBLIC_URL_BASE?.trim().replace(/\/+$/, "")
      ?? `http://localhost:${process.env.PORT ?? 4000}`;
    return {
      uploadUrl: `${mockBaseUrl}/api/uploads/mock-upload?key=${encodeURIComponent(key)}`,
      publicUrl: `${mockBaseUrl}/api/uploads/mock-download?key=${encodeURIComponent(key)}`,
      key,
    };
  }

  // Validate content type against allowlist
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Content type "${contentType}" is not allowed`);
  }

  // Public uploads need a public URL. Verification uploads are returned only
  // through admin short-lived signed reads.
  if (category !== "verification" && !PUBLIC_URL) {
    throw new Error("S3_PUBLIC_URL is not configured. Cannot generate public URL for uploads.");
  }

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(s3, command, {
    expiresIn: PRESIGN_EXPIRY,
  });

  const publicUrl = category === "verification" ? undefined : `${PUBLIC_URL}/${key}`;

  return { uploadUrl, publicUrl, key };
}

export async function objectExists(key: string): Promise<boolean> {
  if (!s3 || !BUCKET) return process.env.NODE_ENV !== "production";
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

export async function generatePresignedRead(key: string, expiresIn = 300): Promise<string> {
  if (!s3 || !BUCKET) {
    const mockBaseUrl = process.env.PUBLIC_URL_BASE?.trim().replace(/\/+$/, "")
      ?? `http://localhost:${process.env.PORT ?? 4000}`;
    return `${mockBaseUrl}/api/uploads/mock-download?key=${encodeURIComponent(key)}`;
  }
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });
}

export async function deleteStoredObject(key: string): Promise<void> {
  if (!key) return;
  if (!s3 || !BUCKET) return;
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

export function isStorageConfigured(): boolean {
  return s3 !== null || process.env.NODE_ENV !== "production";
}

export function getPublicUrl(key: string): string {
  if (!PUBLIC_URL) {
    throw new Error("S3_PUBLIC_URL is not configured. Cannot generate public URL.");
  }
  return `${PUBLIC_URL}/${key}`;
}
