# ADR-0005: R2 Presigned Upload Model

## Context
Vendors need to upload product images. Serverless functions have body size limits and timeout constraints. Direct-to-storage uploads via presigned URLs bypass both.

## Decision
- Backend generates a presigned PUT URL for Cloudflare R2
- Frontend PUTs the file directly to R2 (no proxy through backend)
- Backend returns the public URL for the uploaded file
- Content-type whitelist: jpeg, png, webp, gif, pdf
- Category-based path: `{category}/{userId}/{timestamp}-{hash}.{ext}`
- KYC/verification documents are blocked from the public bucket

## Alternatives Considered
- **Multipart upload through backend:** Hits Vercel 4.5MB body limit and 10s timeout.
- **AWS S3 directly:** Works but R2 has zero egress fees.
- **Cloudflare Images:** Better for thumbnails but doesn't replace general file storage.

## Consequences
- Frontend must handle PUT to presigned URL (not POST to backend)
- Presigned URLs expire in 5 minutes
- R2 requires `forcePathStyle: true` in S3Client
- `flexibleChecksumsMiddleware` must be removed (causes SignatureDoesNotMatch)
- `S3_PUBLIC_URL` is required when `S3_ENDPOINT` is set (no AWS-style fallback for R2)

## Operational Notes
- Env vars: S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_PUBLIC_URL
- Boot validation: throws if endpoint set without public URL
- Boot validation: throws if endpoint contains bucket name (common misconfiguration)
- Endpoint: `POST /api/uploads/request-url` (authenticated)
