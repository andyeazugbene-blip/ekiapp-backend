/**
 * Local production-mode smoke test for Turnstile gating.
 * Spawns the app in production mode in-process and runs three checks
 * against the in-memory Express handler via supertest.
 *
 * Usage: npx tsx scripts/smoke-local.ts
 */

process.env.NODE_ENV = "production";
process.env.TURNSTILE_SECRET_KEY = "";
process.env.TURNSTILE_DISABLED = "";
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "smoke-secret";
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "sk_test_smoke";
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_smoke";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://smoke:smoke@localhost:5432/smoke";

async function main(): Promise<void> {
  const request = (await import("supertest")).default;
  const { app } = await import("../src/app");

  console.log("Local production-mode smoke test for /api/auth/register\n");

  // Scenario 1: secret missing, disabled NOT set → 503 TURNSTILE_NOT_CONFIGURED
  console.log("[1/4] secret missing, TURNSTILE_DISABLED unset");
  let res = await request(app)
    .post("/api/auth/register")
    .send({ email: "s1@example.com", password: "Password1", name: "S1" });
  console.log(`  status=${res.status}, code=${res.body.code}, message="${res.body.message}"`);

  // Scenario 2: secret present, no token → 400 TURNSTILE_TOKEN_MISSING
  process.env.TURNSTILE_SECRET_KEY = "fake-secret-for-smoke";
  console.log("\n[2/4] secret present, no cf-turnstile-response in body");
  res = await request(app)
    .post("/api/auth/register")
    .send({ email: "s2@example.com", password: "Password1", name: "S2" });
  console.log(`  status=${res.status}, code=${res.body.code}, message="${res.body.message}"`);

  // Scenario 3: TURNSTILE_DISABLED=true → bypasses, but DB is fake so we expect 503/500/etc.
  // We just want to prove the middleware lets the request through.
  process.env.TURNSTILE_DISABLED = "true";
  process.env.TURNSTILE_SECRET_KEY = "";
  console.log("\n[3/4] TURNSTILE_DISABLED=true (escape hatch)");
  res = await request(app)
    .post("/api/auth/register")
    .send({ email: "s3@example.com", password: "Password1", name: "S3" });
  console.log(`  status=${res.status} (anything other than 400/403/503/Turnstile- means the gate let it through)`);
  console.log(`  body=${JSON.stringify(res.body).slice(0, 200)}`);

  process.exit(0);
}

main().catch((error) => {
  console.error("smoke failed:", error);
  process.exit(1);
});
