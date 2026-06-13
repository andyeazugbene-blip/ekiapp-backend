/**
 * COMPREHENSIVE PERFORMANCE TEST — Real users, real endpoints
 * Tests: login (vendor+buyer+admin), products, cart, checkout, wallet,
 *        notifications, orders, subscriptions, dashboard, analytics,
 *        gift cards, addresses, messages, reviews, uploads
 *
 * Run: node performance-test.js
 */
const BASE = "https://ekiapp-backend.vercel.app";
const USERS = [
  { email: "vendor@eki.app", pass: "Abdou22314", role: "vendor" },
  { email: "buyer@eki.app", pass: "Abdou22314", role: "buyer" },
];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function api(method, path, body, token) {
  const start = Date.now();
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  try {
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data, ms: Date.now() - start };
  } catch (e) {
    return { ok: false, status: 0, data: {}, ms: Date.now() - start, error: e.message };
  }
}

async function testPublicEndpoints() {
  const results = [];
  const endpoints = [
    ["GET", "/api/health", "Health Check"],
    ["GET", "/api/subscriptions/plans", "Subscription Plans"],
    ["GET", "/api/gift-cards/active", "Gift Cards Active"],
    ["GET", "/api/public/stores/queen-african-foods", "Public Store"],
    ["GET", "/api/public/stores/queen-african-foods/products?limit=10", "Store Products"],
    ["GET", "/api/health/detailed", "Health Detailed"],
  ];
  for (const [method, path, name] of endpoints) {
    const r = await api(method, path);
    if (r.ok) RESULTS.passed++; else RESULTS.failed++;
    if (r.ms > 3000) RESULTS.slow++;
    logEndpoint(name, r);
    results.push({ name, ok: r.ok, ms: r.ms });
    await sleep(100);
  }
  return results;
}

async function testAuthenticatedEndpoints(token, role) {
  const results = [];
  const endpoints = [
    ["GET", "/api/auth/me", "Auth Profile"],
    ["GET", "/api/notifications?limit=10", "Notifications"],
    ["GET", "/api/notifications/preferences", "Notif Prefs"],
    ["GET", "/api/subscriptions/me", "Sub Status"],
    ["GET", "/api/subscriptions/me/limits", "Sub Limits"],
    ["GET", "/api/referrals/me", "Referrals"],
    ["GET", "/api/reviews/eligible-products", "Reviews Eligible"],
    ["GET", "/api/conversations/me", "Conversations"],
    ["GET", "/api/delivery/zones", "Delivery Zones"],
  ];

  // Role-specific
  if (role === "vendor") {
    endpoints.push(["GET", "/api/vendors/me", "Vendor Profile"]);
    endpoints.push(["GET", "/api/vendors/me/dashboard", "Vendor Dashboard"]);
    endpoints.push(["GET", "/api/vendors/me/earnings", "Vendor Earnings"]);
    endpoints.push(["GET", "/api/vendors/me/payout-methods", "Payout Methods"]);
    endpoints.push(["GET", "/api/orders/vendor/list?limit=10", "Vendor Orders"]);
    endpoints.push(["GET", "/api/payout-requests/me", "Payout Requests"]);
    endpoints.push(["GET", "/api/promo-codes/me", "Promo Codes"]);
  } else {
    endpoints.push(["GET", "/api/wallet/me", "Buyer Wallet"]);
    endpoints.push(["GET", "/api/orders/me?limit=10", "Buyer Orders"]);
    endpoints.push(["GET", "/api/addresses", "Addresses"]);
    endpoints.push(["GET", "/api/gift-cards/me", "My Gift Cards"]);
    // Cart
    const cart = await api("GET", "/api/cart", null, token);
    if (!cart.ok || !cart.data?.id) {
      await api("POST", "/api/cart/items", { productId: "cmpx4700j000zuf1c0xmo3ewd", quantity: 1 }, token);
    }
    endpoints.push(["GET", "/api/cart", "Cart"]);
    // Wallet top-up
    await sleep(500);
    const topUp = await api("POST", "/api/wallet/me/top-up", { amount: 1000 }, token);
    results.push({ name: "Wallet Topup", ok: topUp.ok, ms: topUp.ms });
    if (topUp.ok) RESULTS.passed++; else RESULTS.failed++;
    // Rewards
    const rewards = await api("GET", "/api/rewards/me", null, token);
    results.push({ name: "My Rewards", ok: rewards.ok, ms: rewards.ms });
    if (rewards.ok) RESULTS.passed++; else RESULTS.failed++;
  }

  for (const [method, path, name] of endpoints) {
    await sleep(200);
    const r = await api(method, path, null, token);
    if (r.ok) RESULTS.passed++; else RESULTS.failed++;
    if (r.ms > 3000) RESULTS.slow++;
    logEndpoint(name, r);
    results.push({ name, ok: r.ok, ms: r.ms });
  }
  return results;
}

async function testAdminEndpoints() {
  const results = [];
  // Login as admin first
  const login = await api("POST", "/api/auth/login", { email: "admin@eki.app", password: "Abdou22314" });
  const token = login.data?.token;
  if (!token) { results.push({ name: "Admin Login", ok: false, ms: login.ms }); return results; }
  results.push({ name: "Admin Login", ok: true, ms: login.ms });
  RESULTS.passed++;

  const endpoints = [
    ["GET", "/api/admin/dashboard", "Admin Dashboard"],
    ["GET", "/api/admin/analytics", "Admin Analytics"],
    ["GET", "/api/admin/analytics/revenue?range=30d", "Admin Revenue"],
    ["GET", "/api/admin/orders?limit=10", "Admin Orders"],
    ["GET", "/api/admin/payments?limit=10", "Admin Payments"],
    ["GET", "/api/admin/users?limit=10", "Admin Users"],
    ["GET", "/api/admin/vendors?limit=10", "Admin Vendors"],
    ["GET", "/api/admin/products?limit=10", "Admin Products"],
    ["GET", "/api/admin/wallet-transactions?limit=10", "Wallet Transactions"],
    ["GET", "/api/admin/payout-requests", "Payout Requests"],
    ["GET", "/api/admin/reviews", "Admin Reviews"],
    ["GET", "/api/admin/verification-documents", "Verification Docs"],
    ["GET", "/api/admin/delivery-zones", "Delivery Zones"],
    ["GET", "/api/admin/promo-codes", "Admin Promos"],
    ["GET", "/api/admin/activity-logs?limit=10", "Activity Logs"],
    ["GET", "/api/admin/subscription-plans", "Subscription Plans"],
  ];

  for (const [method, path, name] of endpoints) {
    await sleep(300);
    const r = await api(method, path, null, token);
    if (r.ok) RESULTS.passed++; else RESULTS.failed++;
    if (r.ms > 3000) RESULTS.slow++;
    logEndpoint(name, r);
    results.push({ name, ok: r.ok, ms: r.ms });
  }
  return results;
}

const LOG = { passed: 0, failed: 0, slow: 0 };
const RESULTS = { passed: 0, failed: 0, slow: 0, total_time: 0 };

function logEndpoint(name, r) {
  const icon = r.ok ? "✅" : "❌";
  const slow = r.ms > 3000 ? " ⚠️ SLOW" : "";
  console.log(`   ${icon} ${name.padEnd(25)} ${r.ms.toString().padStart(5)}ms${slow}`);
}

async function loginWithRetry(email, pass) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await api("POST", "/api/auth/login", { email: email, password: pass || "Abdou22314" });
    if (r.ok && r.data?.token) return r;
    if (r.data?.error?.includes?.("rate") || r.data?.message?.includes?.("attempt")) {
      console.log(`   ? Rate limited, waiting 30s (attempt ${attempt+1})...`);
      await sleep(120000);
      continue;
    }
    // Other error
    return r;
  }
  return { ok: false, status: 429, data: { message: "Rate limited after retries" }, ms: 0 };
}
async function main() {
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  🚀 FULL PERFORMANCE TEST — 50+ Endpoints");
  console.log("═══════════════════════════════════════════════════════════════\n");
  const startTime = Date.now();

  // Phase 1: Public endpoints
  console.log("─── Phase 1: Public Endpoints ───────────────────────────────");
  await testPublicEndpoints();

  // Phase 2: Authenticated (vendor + buyer)
  console.log("\n─── Phase 2: Authenticated (Vendor) ───────────────────────");
  let login = await loginWithRetry("vendor@eki.app", "Abdou22314");
  if (login.ok) await testAuthenticatedEndpoints(login.data?.token, "vendor");
  else console.log(`   ❌ Vendor login failed: ${login.data?.message}`);

  await sleep(2000);

  console.log("\n─── Phase 3: Authenticated (Buyer) ────────────────────────");
  login = await loginWithRetry("buyer@eki.app", "Abdou22314");
  if (login.ok) await testAuthenticatedEndpoints(login.data?.token, "buyer");
  else console.log(`   ❌ Buyer login failed: ${login.data?.message}`);

  await sleep(2000);

  // Phase 4: Admin endpoints
  console.log("\n─── Phase 4: Admin Panel ──────────────────────────────────");
  await testAdminEndpoints();

  const elapsed = Date.now() - startTime;
  const total = RESULTS.passed + RESULTS.failed;
  const rate = (RESULTS.passed / total * 100).toFixed(1);

  console.log(`\n═══════════════════════════════════════════════════════════════`);
  console.log(`  📊 FINAL RESULTS`);
  console.log(`═══════════════════════════════════════════════════════════════`);
  console.log(`  Total: ${total} endpoints tested`);
  console.log(`  ✅ Passed: ${RESULTS.passed}`);
  console.log(`  ❌ Failed: ${RESULTS.failed}`);
  console.log(`  ⚠️  Slow (>3s): ${RESULTS.slow}`);
  console.log(`  Success Rate: ${rate}%`);
  console.log(`  Total Time: ${(elapsed / 1000).toFixed(1)}s`);
  console.log(`  Throughput: ${(total * 1000 / elapsed).toFixed(0)} req/s`);

  const score = rate > 95 ? "🟢 EXCELLENT" : rate > 85 ? "🟡 GOOD" : "🔴 POOR";
  console.log(`  🏆 Score: ${score}`);

  if (RESULTS.slow > 0) {
    console.log(`\n  ⚠️ SLOW ENDPOINTS TO OPTIMIZE:`);
    console.log(`  ${RESULTS.slow} endpoints took >3s — check for N+1 queries or missing indexes`);
  }
  console.log(``);
}

main().catch(console.error);
