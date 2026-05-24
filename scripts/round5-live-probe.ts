/**
 * Round 5 live production probe.
 *
 * Hits the deployed API and inspects:
 *   1. /api/health            — basic up check
 *   2. /api/health/detailed   — DB, Stripe, Paystack components
 *   3. /api/auth/register     — Turnstile gating (no token, bogus token)
 *
 * Does NOT modify any data. The register attempts always fail at the
 * Turnstile layer or with a duplicate/validation error, never creating
 * a real account.
 *
 * Usage:
 *   npx tsx scripts/round5-live-probe.ts <BASE_URL>
 */

const BASE = process.argv[2] ?? "https://italian-market-place.vercel.app";

interface Json {
  [k: string]: unknown;
}

async function probe(label: string, url: string, init?: RequestInit): Promise<{ status: number; body: Json | string }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: Json | string = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  console.log(`\n[${label}] ${url}`);
  console.log(`  status: ${res.status}`);
  const printable = typeof body === "string" ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400);
  console.log(`  body:   ${printable}`);
  return { status: res.status, body };
}

async function main(): Promise<void> {
  console.log(`Round 5 live probe against ${BASE}`);

  await probe("health basic", `${BASE}/api/health`);
  await probe("health detailed", `${BASE}/api/health/detailed`);

  // Register, no Turnstile token
  await probe(
    "register: no token",
    `${BASE}/api/auth/register`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `live-probe-${Date.now()}@example.com`,
        password: "Password1",
        name: "Live Probe",
      }),
    },
  );

  // Register, bogus Turnstile token
  await probe(
    "register: bogus token",
    `${BASE}/api/auth/register`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `live-probe-bogus-${Date.now()}@example.com`,
        password: "Password1",
        name: "Live Probe",
        "cf-turnstile-response": "bogus-token-from-round5-probe",
      }),
    },
  );
}

main().catch((error) => {
  console.error("probe failed:", error);
  process.exit(1);
});
