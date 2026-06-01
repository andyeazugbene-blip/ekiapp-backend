import "dotenv/config";

const BASE = (process.argv[2] || process.env.API_BASE_URL || "https://ekiapp-backend.vercel.app").replace(/\/$/, "");

type Result = { ok: boolean; label: string; detail: string };
const results: Result[] = [];

function pass(label: string, detail: string) {
  results.push({ ok: true, label, detail });
  console.log(`PASS ${label}: ${detail}`);
}

function fail(label: string, detail: string) {
  results.push({ ok: false, label, detail });
  console.log(`FAIL ${label}: ${detail}`);
}

async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${BASE}${path}`, init);
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { response, body };
}

async function main() {
  const health = await request("/api/health");
  if (health.response.ok) pass("health", "API health endpoint is reachable");
  else fail("health", `expected 200, got ${health.response.status}`);

  const adminUnauthed = await request("/api/admin/dashboard");
  if (adminUnauthed.response.status === 401) pass("admin auth guard", "Admin dashboard blocks unauthenticated access");
  else fail("admin auth guard", `expected 401, got ${adminUnauthed.response.status}`);

  const invalidLogin = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "nobody@example.com", password: "wrong-password" }),
  });
  if ([401, 423, 429].includes(invalidLogin.response.status)) {
    pass("login failure handling", `Invalid login returned ${invalidLogin.response.status}`);
  } else {
    fail("login failure handling", `expected 401/423/429, got ${invalidLogin.response.status}`);
  }

  let throttled = false;
  for (let index = 0; index < 12; index += 1) {
    const attempt = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ratelimit@example.com", password: `wrong-${index}` }),
    });
    if ([423, 429].includes(attempt.response.status)) {
      throttled = true;
      break;
    }
  }
  if (throttled) pass("rate limiting", "Repeated invalid logins trigger lockout or throttling");
  else fail("rate limiting", "No 423/429 seen after repeated invalid logins");

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    console.error(`\nSecurity audit failed with ${failed.length} issue(s).`);
    process.exitCode = 1;
    return;
  }

  console.log("\nSecurity audit passed.");
}

main().catch((error) => {
  console.error("Security audit crashed", error);
  process.exitCode = 1;
});
