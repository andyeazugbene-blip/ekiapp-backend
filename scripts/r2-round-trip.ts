/**
 * R2 round-trip smoke test.
 *
 * Verifies the full upload pipeline:
 *   1. POST /api/uploads/request-url   → presigned URL
 *   2. PUT  <uploadUrl> with 1px PNG   → expect 200
 *   3. GET  <publicUrl>                → expect 200 image/png
 *
 * Usage:
 *   npx tsx scripts/r2-round-trip.ts <BASE_URL> <JWT_TOKEN>
 *
 * Or against the local server:
 *   npm run dev
 *   npx tsx scripts/r2-round-trip.ts http://localhost:4001 <JWT>
 *
 * Required env (server-side): S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY_ID,
 * S3_SECRET_ACCESS_KEY, S3_PUBLIC_URL.
 */

const BASE_URL = process.argv[2] ?? process.env.R2_TEST_BASE_URL;
const TOKEN = process.argv[3] ?? process.env.R2_TEST_TOKEN;

// 1x1 transparent PNG (decoded from base64)
const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(ONE_PIXEL_PNG_BASE64, "base64");

interface UploadUrlResponse {
  uploadUrl: string;
  publicUrl: string;
  key: string;
}

async function main(): Promise<void> {
  if (!BASE_URL || !TOKEN) {
    console.error("Usage: npx tsx scripts/r2-round-trip.ts <BASE_URL> <JWT_TOKEN>");
    process.exit(2);
  }

  console.log("R2 round-trip smoke test");
  console.log("  base:", BASE_URL);

  // 1. Request presigned upload URL
  console.log("\n[1/3] Requesting presigned upload URL...");
  const reqRes = await fetch(`${BASE_URL}/api/uploads/request-url`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      filename: "round-trip.png",
      contentType: "image/png",
      category: "product",
    }),
  });

  if (!reqRes.ok) {
    const text = await reqRes.text();
    console.error(`  FAIL: ${reqRes.status} ${text}`);
    process.exit(1);
  }

  const { uploadUrl, publicUrl, key } = (await reqRes.json()) as UploadUrlResponse;
  console.log("  OK:", { key, publicUrl });

  // 2. PUT the 1x1 PNG to the presigned URL
  console.log("\n[2/3] PUT 1x1 PNG to presigned URL...");
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "image/png" },
    body: PNG_BYTES,
  });

  if (putRes.status !== 200) {
    const text = await putRes.text();
    console.error(`  FAIL: PUT returned ${putRes.status}\n${text}`);
    process.exit(1);
  }
  console.log("  OK: PUT 200");

  // 3. GET the public URL
  console.log("\n[3/3] GET publicUrl...");
  // R2 may have eventual consistency; retry briefly
  let getRes: Response | null = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    getRes = await fetch(publicUrl);
    if (getRes.status === 200) break;
    console.log(`  attempt ${attempt}: ${getRes.status}, retrying...`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!getRes || getRes.status !== 200) {
    console.error(`  FAIL: GET returned ${getRes?.status ?? "no response"}`);
    process.exit(1);
  }
  const contentType = getRes.headers.get("content-type") ?? "";
  if (!contentType.includes("image/png")) {
    console.error(`  FAIL: content-type "${contentType}" is not image/png`);
    process.exit(1);
  }
  console.log("  OK: GET 200, content-type:", contentType);

  console.log("\n✅ R2 round-trip PASS");
}

main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});
