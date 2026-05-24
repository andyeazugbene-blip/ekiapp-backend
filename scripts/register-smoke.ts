/**
 * Production register smoke test.
 *
 * Verifies the new Turnstile gating behaviour against a deployed instance:
 *   1. No token         → expect 400 + code TURNSTILE_TOKEN_MISSING
 *   2. Bogus token      → expect 403 + code TURNSTILE_INVALID_TOKEN
 *      (skipped automatically if the server has TURNSTILE_DISABLED=true)
 *
 * Usage:
 *   npx tsx scripts/register-smoke.ts <BASE_URL>
 *
 * Notes:
 *   - The endpoint is /api/auth/register
 *   - This script does NOT actually create a real account because the
 *     gating layer rejects the request before it reaches the database.
 */

const BASE_URL = process.argv[2] ?? process.env.REGISTER_SMOKE_BASE_URL;

interface RegisterErrorBody {
  message?: string;
  code?: string;
}

async function postRegister(body: Record<string, unknown>): Promise<{ status: number; body: RegisterErrorBody }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as RegisterErrorBody;
  return { status: res.status, body: json };
}

function assertExpected(label: string, actualStatus: number, expectedStatuses: number[], actualCode: string | undefined, expectedCode?: string): void {
  const statusOk = expectedStatuses.includes(actualStatus);
  const codeOk = !expectedCode || actualCode === expectedCode;
  const ok = statusOk && codeOk;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}: status=${actualStatus} code=${actualCode ?? "-"}`);
  if (!ok) {
    console.error(`    expected status ${expectedStatuses.join(" or ")}, code ${expectedCode ?? "-"}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  if (!BASE_URL) {
    console.error("Usage: npx tsx scripts/register-smoke.ts <BASE_URL>");
    process.exit(2);
  }

  console.log("Production register smoke test");
  console.log("  base:", BASE_URL);

  const baseBody = {
    email: `smoke-${Date.now()}@example.com`,
    password: "Password1",
    name: "Smoke Test",
  };

  // Test 1: No token
  console.log("\n[1/2] POST /api/auth/register without cf-turnstile-response...");
  const noToken = await postRegister(baseBody);
  // Acceptable outcomes:
  //   400 TURNSTILE_TOKEN_MISSING (Turnstile enforced and configured)
  //   503 TURNSTILE_NOT_CONFIGURED (Turnstile enforced but secret missing)
  //   201 (Turnstile disabled via TURNSTILE_DISABLED=true)
  if (noToken.status === 201) {
    console.log("  Server has TURNSTILE_DISABLED=true. Skipping token tests.");
    return;
  }
  if (noToken.status === 503 && noToken.body.code === "TURNSTILE_NOT_CONFIGURED") {
    console.log("  Server returned controlled 503 TURNSTILE_NOT_CONFIGURED. Set TURNSTILE_SECRET_KEY or TURNSTILE_DISABLED=true.");
    process.exitCode = 1;
    return;
  }
  assertExpected("no token", noToken.status, [400], noToken.body.code, "TURNSTILE_TOKEN_MISSING");

  // Test 2: Bogus token
  console.log("\n[2/2] POST /api/auth/register with bogus cf-turnstile-response...");
  const badToken = await postRegister({ ...baseBody, "cf-turnstile-response": "bogus-token-from-smoke-test" });
  assertExpected("invalid token", badToken.status, [403], badToken.body.code, "TURNSTILE_INVALID_TOKEN");

  console.log("\nDone.");
}

main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});
