/**
 * Launch Health Check
 * Verifies all critical services are operational before/after deploy.
 *
 * Usage: npx tsx scripts/launch-health-check.ts [url]
 * Default URL: https://ekiapp-backend.vercel.app
 */
const BASE = process.argv[2] ?? "https://ekiapp-backend.vercel.app";

async function main() {
  console.log("=== LAUNCH HEALTH CHECK ===");
  console.log(`Target: ${BASE}\n`);

  let passed = 0, failed = 0;

  // 1. Basic health
  const h = await fetch(`${BASE}/api/health`);
  check("GET /api/health", h.status === 200, `${h.status}`);

  // 2. Detailed health (DB + Stripe + Paystack)
  const hd = await fetch(`${BASE}/api/health/detailed`);
  const hdData = await hd.json() as any;
  check("GET /api/health/detailed", hd.status === 200, `status=${hdData?.status}`);
  check("Database connectivity", hdData?.checks?.database?.status === "ok", hdData?.checks?.database?.status);
  check("Stripe connectivity", hdData?.checks?.stripe?.status === "ok", hdData?.checks?.stripe?.status);
  check("Stripe live mode", hdData?.checks?.stripe?.detail === "live", hdData?.checks?.stripe?.detail ?? "unknown");
  check("Storage connectivity", hdData?.checks?.storage?.status === "ok", hdData?.checks?.storage?.status ?? "missing");

  // 3. OpenAPI spec
  const spec = await fetch(`${BASE}/openapi.json`);
  check("OpenAPI spec", spec.status === 200, `${spec.status}`);

  // 4. Auth endpoint
  const auth = await fetch(`${BASE}/api/auth/me`);
  check("Auth guard (no token → 401)", auth.status === 401, `${auth.status}`);

  // 5. Products (public)
  const prods = await fetch(`${BASE}/api/products`);
  check("Products endpoint", prods.status === 200, `${prods.status}`);

  // 6. Upload endpoint exists
  const upl = await fetch(`${BASE}/api/uploads/request-url`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("Upload endpoint (401 without auth)", upl.status === 401, `${upl.status}`);

  // 7. Webhook endpoints
  const sw = await fetch(`${BASE}/api/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": "t=1,v1=x" }, body: "{}" });
  check("Stripe webhook (400 bad sig)", sw.status === 400, `${sw.status}`);

  const pw = await fetch(`${BASE}/api/paystack/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("Paystack webhook (400 bad sig)", pw.status === 400, `${pw.status}`);

  console.log(`\n=== RESULTS: ✅ ${passed} | ❌ ${failed} ===`);
  console.log(failed === 0 ? "\n✅ ALL SYSTEMS OPERATIONAL" : "\n❌ ISSUES DETECTED");
  process.exit(failed > 0 ? 1 : 0);

  function check(name: string, ok: boolean, detail: string) {
    ok ? passed++ : failed++;
    console.log(`${ok ? "✅" : "❌"} ${name} — ${detail}`);
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
