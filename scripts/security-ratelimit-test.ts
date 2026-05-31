/**
 * Rate Limit Security Test
 * Verifies rate limiting is active on auth endpoints.
 * Intentionally triggers 429 — this is a PASS condition.
 *
 * Usage: npx tsx scripts/security-ratelimit-test.ts [url]
 */
const BASE = process.argv[2] ?? "https://ekiapp-backend.vercel.app";

async function run() {
  console.log("=== RATE LIMIT SECURITY TEST ===\n");
  console.log(`Target: ${BASE}\n`);

  let got429 = false;
  let attempts = 0;

  // Rapid-fire login attempts (should trigger 429 within 10-15 attempts)
  for (let i = 0; i < 15; i++) {
    attempts++;
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ratelimit-test@nonexistent.com", password: "x" }),
    });
    if (r.status === 429) { got429 = true; break; }
  }

  console.log(`  Attempts: ${attempts}`);
  console.log(`  429 received: ${got429}`);
  console.log(`\n  ${got429 ? "✅ PASS — Rate limiter is active" : "⚠️ NOT TRIGGERED (may need more attempts or different IP)"}`);
  process.exit(got429 ? 0 : 1);
}

run().catch(e => { console.error("FATAL:", e); process.exit(1); });
