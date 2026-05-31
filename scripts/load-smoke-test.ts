/**
 * Load Smoke Test — lightweight production safety check.
 * Sends a small burst of requests to verify latency and error rate.
 * Safe for production: read-only endpoints, low volume.
 *
 * Usage: npx tsx scripts/load-smoke-test.ts [url]
 */
const BASE = process.argv[2] ?? "https://ekiapp-backend.vercel.app";
const TOTAL_REQUESTS = 20;

interface Result { path: string; status: number; latencyMs: number; error?: string }

async function timedFetch(path: string): Promise<Result> {
  const start = Date.now();
  try {
    const r = await fetch(`${BASE}${path}`);
    return { path, status: r.status, latencyMs: Date.now() - start };
  } catch (e) {
    return { path, status: 0, latencyMs: Date.now() - start, error: (e as Error).message };
  }
}

async function main() {
  console.log("=== LOAD SMOKE TEST ===");
  console.log(`Target: ${BASE}`);
  console.log(`Requests: ${TOTAL_REQUESTS}\n`);

  const endpoints = [
    "/api/products",
    "/api/health",
    "/openapi.json",
    "/api/auth/me", // should return 401
    "/api/products",
  ];

  const results: Result[] = [];

  // Send requests in batches of 5
  for (let i = 0; i < TOTAL_REQUESTS; i++) {
    const path = endpoints[i % endpoints.length];
    results.push(await timedFetch(path));
  }

  // Calculate metrics
  const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);
  const errors = results.filter(r => r.status === 0 || r.status >= 500);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];
  const errorRate = (errors.length / results.length) * 100;

  console.log("Results:");
  console.log(`  Total requests: ${results.length}`);
  console.log(`  p50 latency:    ${p50}ms`);
  console.log(`  p95 latency:    ${p95}ms`);
  console.log(`  p99 latency:    ${p99}ms`);
  console.log(`  Error rate:     ${errorRate.toFixed(1)}% (${errors.length}/${results.length})`);
  console.log(`  401s (expected): ${results.filter(r => r.status === 401).length}`);

  const pass = p95 < 500 && errorRate < 1;
  console.log(`\n${pass ? "✅ PASS" : "❌ FAIL"} — p95 < 500ms: ${p95 < 500}, error rate < 1%: ${errorRate < 1}`);
  process.exit(pass ? 0 : 1);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
