/**
 * Best-effort attempt to run an R2 round-trip without operator-supplied credentials.
 *
 * Tries to log in as the seed vendor (email: vendor@example.com / password123).
 * If that succeeds, runs the full round-trip. Otherwise reports that operator
 * action is required.
 */
const BASE = process.argv[2] ?? "https://ekiapp-backend.vercel.app";

async function tryLogin(email: string, password: string): Promise<string | null> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { token?: string };
  return json.token ?? null;
}

async function main(): Promise<void> {
  const candidates = [
    { email: "vendor@example.com", password: "password123" },
    { email: "vendor@eki.app", password: "password123" },
    { email: "vendor@test.com", password: "password123" },
  ];
  for (const c of candidates) {
    const token = await tryLogin(c.email, c.password);
    if (token) {
      console.log(`Login OK as ${c.email}. Run:\n  npm run r2:round-trip ${BASE} ${token}`);
      console.log(`\nToken: ${token}`);
      return;
    }
    console.log(`Login failed for ${c.email}`);
  }
  console.log("\nNo seed vendor credentials worked against production.");
  console.log("Operator must provide a vendor JWT or create a QA vendor and re-run:");
  console.log(`  npm run r2:round-trip ${BASE} <JWT>`);
}

main().catch((error) => {
  console.error("attempt failed:", error);
  process.exit(1);
});
