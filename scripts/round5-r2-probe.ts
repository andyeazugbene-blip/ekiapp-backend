/**
 * R2 storage probe — does NOT require valid credentials.
 *
 * Hits the upload endpoint with two auth states to figure out if storage
 * is configured in production:
 *   1. No token  → expect 401 (proves the endpoint is registered + auth runs)
 *   2. Bad token → expect 401 (proves token verification runs)
 *
 * If a real JWT is provided as argv[3], also issues a real upload-URL
 * request to verify storage is configured end-to-end.
 *
 * Usage:
 *   npx tsx scripts/round5-r2-probe.ts <BASE_URL>
 *   npx tsx scripts/round5-r2-probe.ts <BASE_URL> <JWT>
 */

const BASE = process.argv[2] ?? "https://italian-market-place.vercel.app";
const TOKEN = process.argv[3];

async function probe(label: string, headers: Record<string, string> = {}): Promise<void> {
  const res = await fetch(`${BASE}/api/uploads/request-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      filename: "round5-probe.png",
      contentType: "image/png",
      category: "product",
    }),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  const printable = typeof body === "string" ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400);
  console.log(`\n[${label}]`);
  console.log(`  status: ${res.status}`);
  console.log(`  body:   ${printable}`);
}

async function main(): Promise<void> {
  console.log(`R2 probe against ${BASE}`);
  await probe("no auth", {});
  await probe("bad auth", { Authorization: "Bearer fake.fake.fake" });
  if (TOKEN) {
    await probe("real auth", { Authorization: `Bearer ${TOKEN}` });
  }
}

main().catch((error) => {
  console.error("probe failed:", error);
  process.exit(1);
});
