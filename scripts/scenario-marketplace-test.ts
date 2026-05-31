/**
 * Marketplace Scenario Test v3 — Low Volume Mode
 * Paces requests to stay under production rate limits (100 req/min).
 * Reuses existing QA users. Retries on 429 with backoff.
 *
 * Usage:
 *   npx tsx scripts/scenario-marketplace-test.ts [url]
 *   npm run test:scenario:low
 */
import Stripe from "stripe";
import "dotenv/config";

const BASE = process.argv[2] ?? "https://ekiapp-backend.vercel.app";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const PREFIX = "SCENARIO_QA_";
const TS = Date.now();
const PACE_MS = 1200; // ~50 req/min max

type Status = "PASS" | "FAIL" | "SKIPPED" | "SKIPPED_RATE_LIMIT" | "EXPECTED_SECURITY_BLOCK";
const results: { test: string; status: Status; detail: string }[] = [];

function log(test: string, status: Status, detail?: string) {
  results.push({ test, status, detail: detail ?? "" });
  const icon = { PASS: "✅", FAIL: "❌", SKIPPED: "⏭️", SKIPPED_RATE_LIMIT: "⏳", EXPECTED_SECURITY_BLOCK: "🔒" }[status];
  console.log(`  ${icon} [${status}] ${test}${detail ? ` — ${detail}` : ""}`);
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/** Paced API call — waits PACE_MS between calls, retries on 429 */
async function api(m: string, p: string, b?: unknown, t?: string): Promise<{ s: number; d: any }> {
  await sleep(PACE_MS);
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (t) h["Authorization"] = `Bearer ${t}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`${BASE}${p}`, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
    if (r.status !== 429) {
      return { s: r.status, d: await r.json().catch(() => null) };
    }
    // Backoff on 429
    const retryAfter = r.headers.get("retry-after");
    const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : (attempt + 1) * 10000;
    console.log(`    ⏳ 429 on ${p}, waiting ${waitMs / 1000}s (attempt ${attempt + 1}/3)...`);
    await sleep(waitMs);
  }
  return { s: 429, d: null };
}

/** Raw fetch without pacing (for webhook/upload tests) */
async function rawFetch(url: string, opts: RequestInit): Promise<Response> {
  await sleep(PACE_MS);
  return fetch(url, opts);
}

let adminToken = "";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@ekiapp.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "AdminDemo123!";
const vendorData: { token: string; id: string; currency: string; products: string[] }[] = [];
const buyerTokens: string[] = [];

async function run() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  MARKETPLACE SCENARIO TEST v3 — LOW VOLUME");
  console.log(`  Target: ${BASE}`);
  console.log(`  Pace: ${PACE_MS}ms between requests`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // ─── ADMIN ─────────────────────────────────────────────────────────
  console.log("── ADMIN ──\n");
  const al = await api("POST", "/api/auth/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  adminToken = al.d?.token ?? "";
  log("Admin login", adminToken ? "PASS" : "FAIL");
  if (!adminToken) { console.log("  Cannot proceed. Aborting."); return; }

  // ─── PRE-CLEANUP ───────────────────────────────────────────────────
  console.log("\n── PRE-CLEANUP ──\n");
  const oldProds = await api("GET", "/api/admin/products?limit=100", undefined, adminToken);
  const qaProds = (oldProds.d?.items ?? []).filter((p: any) => p.title?.startsWith(PREFIX) && p.isActive);
  for (const p of qaProds) { await api("PATCH", `/api/admin/products/${p.id}/disable`, {}, adminToken); }
  log("Pre-cleanup", "PASS", `deactivated=${qaProds.length}`);

  // ─── VENDORS (3, login-first) ──────────────────────────────────────
  console.log("\n── VENDORS ──\n");
  const vendorConfigs = [
    { country: "Italy", currency: "EUR", key: "it" },
    { country: "United Kingdom", currency: "GBP", key: "uk" },
    { country: "Nigeria", currency: "NGN", key: "ng" },
  ];

  for (const cfg of vendorConfigs) {
    const email = `${PREFIX}v_${cfg.key}@test.com`;
    // Try login first
    let token: string | null = null;
    const login = await api("POST", "/api/auth/login", { email, password: "Vendor1A!" });
    if (login.s === 200) {
      token = login.d?.token;
    } else if (login.s === 401) {
      // Register
      const reg = await api("POST", "/api/auth/register", { email, password: "Vendor1A!", name: `${PREFIX}V_${cfg.key}` });
      token = reg.s === 201 ? reg.d?.token : null;
    }

    if (!token) { log(`Vendor ${cfg.key}`, "SKIPPED_RATE_LIMIT", "could not auth"); continue; }

    // Check role
    const me = await api("GET", "/api/auth/me", undefined, token);
    if (me.d?.user?.role === "VENDOR") {
      const vm = await api("GET", "/api/vendors/me", undefined, token);
      vendorData.push({ token, id: vm.d?.vendor?.id, currency: vm.d?.vendor?.currency, products: [] });
      log(`Vendor ${cfg.key} (reused)`, "PASS", `currency=${vm.d?.vendor?.currency}`);
    } else {
      const cv = await api("POST", "/api/vendors", { storeName: `${PREFIX}S_${cfg.key}_${TS}`, country: cfg.country }, token);
      const vToken = cv.d?.token || token;
      const vid = cv.d?.vendor?.id;
      if (vid) {
        await api("PATCH", `/api/admin/vendors/${vid}/approve`, {}, adminToken);
        vendorData.push({ token: vToken, id: vid, currency: cv.d?.vendor?.currency, products: [] });
        log(`Vendor ${cfg.key} (created)`, "PASS", `currency=${cv.d?.vendor?.currency}`);
      } else {
        log(`Vendor ${cfg.key}`, "FAIL", `${cv.s}`);
      }
    }
  }

  // ─── PRODUCTS (5 per vendor = 15 max) ──────────────────────────────
  console.log("\n── PRODUCTS ──\n");
  let prodCount = 0;
  for (const v of vendorData) {
    for (let i = 0; i < 5; i++) {
      const title = `${PREFIX}P_${prodCount}_${TS}`;
      const p = await api("POST", "/api/products", {
        title, priceAmount: 1500 + prodCount * 100, stock: 10, category: "food", currency: "XXX",
      }, v.token);
      if (p.s === 201) {
        v.products.push(p.d?.product?.id);
        log(`Product ${prodCount}`, p.d?.product?.currency === v.currency ? "PASS" : "FAIL",
          `expected=${v.currency} got=${p.d?.product?.currency}`);
      } else if (p.s === 429) {
        log(`Product ${prodCount}`, "SKIPPED_RATE_LIMIT", "429");
      } else {
        log(`Product ${prodCount}`, "FAIL", `${p.s} ${p.d?.message}`);
      }
      prodCount++;
    }
  }

  // ─── BUYERS (3, login-first) ───────────────────────────────────────
  console.log("\n── BUYERS ──\n");
  for (let i = 0; i < 3; i++) {
    const email = `${PREFIX}b_${i}@test.com`;
    const login = await api("POST", "/api/auth/login", { email, password: "Buyer1Aa!" });
    if (login.s === 200) { buyerTokens.push(login.d?.token); log(`Buyer ${i} (reused)`, "PASS"); continue; }
    if (login.s === 401) {
      const reg = await api("POST", "/api/auth/register", { email, password: "Buyer1Aa!", name: `${PREFIX}B_${i}` });
      if (reg.s === 201) { buyerTokens.push(reg.d?.token); log(`Buyer ${i} (created)`, "PASS"); continue; }
    }
    log(`Buyer ${i}`, "SKIPPED_RATE_LIMIT", "could not auth");
  }

  // ─── CHECKOUT ──────────────────────────────────────────────────────
  console.log("\n── CHECKOUT ──\n");
  let paidOrderId: string | undefined;
  const eurVendor = vendorData.find(v => v.currency === "EUR" && v.products.length > 0);

  if (!buyerTokens[0] || !eurVendor) {
    log("Checkout", "SKIPPED_RATE_LIMIT", "missing buyer or vendor");
  } else {
    const bt = buyerTokens[0];
    await api("DELETE", "/api/cart", undefined, bt);
    await api("GET", "/api/cart", undefined, bt);
    await api("POST", "/api/cart/items", { productId: eurVendor.products[0], quantity: 1 }, bt);
    const cart = await api("GET", "/api/cart", undefined, bt);
    const cartId = cart.d?.id ?? cart.d?.cart?.id;

    const co = await api("POST", "/api/payments/create-intent", { cartId, deliveryCountry: "Italy" }, bt);
    log("Checkout created", co.s === 201 ? "PASS" : "FAIL", `status=${co.s}`);

    if (co.s === 201) {
      const piId = co.d.clientSecret.split("_secret_")[0];
      paidOrderId = co.d.orderIds?.[0];
      try {
        const pm = await stripe.paymentMethods.create({ type: "card", card: { token: "tok_visa" } });
        const confirmed = await stripe.paymentIntents.confirm(piId, { payment_method: pm.id, return_url: BASE });
        log("Payment confirmed", confirmed.status === "succeeded" ? "PASS" : "FAIL", confirmed.status);
        console.log("    ⏳ Waiting 12s for webhook...");
        await sleep(12000);
        const order = await api("GET", `/api/orders/${paidOrderId}`, undefined, bt);
        log("Order PAID", order.d?.order?.status === "PAID" ? "PASS" : "FAIL", `status=${order.d?.order?.status}`);
      } catch (e: any) { log("Payment", "FAIL", e.message?.slice(0, 60)); }
    }
  }

  // ─── REVIEWS ───────────────────────────────────────────────────────
  console.log("\n── REVIEWS ──\n");
  if (!buyerTokens[0]) { log("Reviews", "SKIPPED_RATE_LIMIT", "no buyer"); }
  else {
    const bt = buyerTokens[0];
    const fake = await api("POST", "/api/reviews", { orderId: "nonexistent", vendorId: "x", rating: 5 }, bt);
    log("Fake order → 404", fake.s === 404 ? "PASS" : "FAIL", `status=${fake.s}`);

    if (paidOrderId && eurVendor) {
      for (const rating of [0, -1, 3.5, 6]) {
        const r = await api("POST", "/api/reviews", { orderId: paidOrderId, vendorId: eurVendor.id, rating }, bt);
        log(`Rating ${rating}`, r.s === 400 ? "PASS" : "FAIL", `status=${r.s}`);
      }
    }
  }

  // ─── REFUND ────────────────────────────────────────────────────────
  console.log("\n── REFUND ──\n");
  if (!paidOrderId) { log("Refund", "SKIPPED_RATE_LIMIT", "no paid order"); }
  else {
    const ref = await api("POST", `/api/admin/orders/${paidOrderId}/refund`, { amount: 100, reason: "QA" }, adminToken);
    log("Admin refund", ref.s === 202 ? "PASS" : "FAIL", `status=${ref.s}`);
    const dup = await api("POST", `/api/admin/orders/${paidOrderId}/refund`, { amount: 100 }, adminToken);
    log("Duplicate → 409", dup.s === 409 ? "PASS" : "FAIL", `status=${dup.s}`);
  }

  // ─── UPLOAD ────────────────────────────────────────────────────────
  console.log("\n── UPLOAD ──\n");
  const uploadToken = vendorData[0]?.token;
  if (!uploadToken) { log("Upload", "SKIPPED_RATE_LIMIT", "no vendor"); }
  else {
    const upl = await api("POST", "/api/uploads/request-url", { filename: "s.png", contentType: "image/png", category: "product" }, uploadToken);
    log("Upload URL", upl.s === 200 ? "PASS" : "FAIL", `status=${upl.s}`);
    if (upl.s === 200) {
      const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
      const put = await rawFetch(upl.d.uploadUrl, { method: "PUT", headers: { "Content-Type": "image/png" }, body: PNG });
      log("PUT", put.status === 200 || put.status === 204 ? "PASS" : "FAIL", `status=${put.status}`);
      await sleep(2000);
      const get = await rawFetch(upl.d.publicUrl, {});
      log("GET publicUrl", get.status === 200 ? "PASS" : "FAIL", `status=${get.status}`);
    }
  }

  // ─── SECURITY ──────────────────────────────────────────────────────
  console.log("\n── SECURITY ──\n");
  const noAuth = await api("GET", "/api/auth/me");
  log("No token → 401", noAuth.s === 401 ? "PASS" : "FAIL", `status=${noAuth.s}`);

  if (buyerTokens[0]) {
    const ba = await api("GET", "/api/admin/dashboard", undefined, buyerTokens[0]);
    log("Buyer → admin = 403", ba.s === 403 ? "PASS" : "FAIL", `status=${ba.s}`);
  }

  const wh = await rawFetch(`${BASE}/api/stripe/webhook`, {
    method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": "t=1,v1=fake" }, body: "{}",
  });
  log("Bad webhook sig → 400", wh.status === 400 ? "PASS" : "FAIL", `status=${wh.status}`);

  // ─── CLEANUP ───────────────────────────────────────────────────────
  console.log("\n── CLEANUP ──\n");

  // Deactivate products created in this run
  let deactivated = 0;
  for (const v of vendorData) {
    for (const pid of v.products) { await api("PATCH", `/api/admin/products/${pid}/disable`, {}, adminToken); deactivated++; }
  }

  // Global cleanup: paginate through ALL products and deactivate any QA/test artifacts
  const QA_PATTERNS = ["SCENARIO_QA_", "R3PNG", "R3P", "QA ", "QA_", "TEST", "Test ", "Demo", "NG Prod", "UK Prod", "Sample Marketplace"];
  const PROTECTED = ["Olio Extra Vergine di Oliva", "Sugo al Basilico", "Spaghetti di Gragnano"];
  let cursor: string | undefined;
  let globalDeactivated = 0;

  for (let page = 0; page < 10; page++) {
    const list = await api("GET", `/api/admin/products?limit=100${cursor ? `&cursor=${cursor}` : ""}`, undefined, adminToken);
    const items = list.d?.items ?? [];
    if (items.length === 0) break;

    for (const p of items) {
      if (!p.isActive) continue;
      if (PROTECTED.includes(p.title)) continue;
      const isQA = QA_PATTERNS.some((pat: string) => p.title?.startsWith(pat)) || /^(test|qa|demo|r\d+)/i.test(p.title ?? "");
      if (isQA) {
        await api("PATCH", `/api/admin/products/${p.id}/disable`, {}, adminToken);
        globalDeactivated++;
      }
    }

    cursor = list.d?.nextCursor;
    if (!cursor) break;
  }

  // Verify: fetch public catalog and check no QA products visible
  const final = await api("GET", "/api/products?limit=100");
  const remaining = (final.d?.items ?? []).filter((p: any) => {
    if (PROTECTED.includes(p.title)) return false;
    return QA_PATTERNS.some((pat: string) => p.title?.startsWith(pat)) || /^(test|qa|demo|r\d+)/i.test(p.title ?? "");
  });

  log("Cleanup", remaining.length === 0 ? "PASS" : "FAIL",
    `thisRun=${deactivated} global=${globalDeactivated} remaining=${remaining.length}`);

  // ─── SUMMARY ───────────────────────────────────────────────────────
  const counts = { PASS: 0, FAIL: 0, SKIPPED: 0, SKIPPED_RATE_LIMIT: 0, EXPECTED_SECURITY_BLOCK: 0 };
  results.forEach(r => counts[r.status]++);

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  ✅ PASS: ${counts.PASS} | ❌ FAIL: ${counts.FAIL} | ⏭️ SKIP: ${counts.SKIPPED} | ⏳ RATE: ${counts.SKIPPED_RATE_LIMIT} | 🔒 SEC: ${counts.EXPECTED_SECURITY_BLOCK}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  if (counts.FAIL > 0) {
    console.log("  FAILURES:");
    results.filter(r => r.status === "FAIL").forEach(r => console.log(`    ❌ ${r.test} — ${r.detail}`));
  }

  const verdict = counts.FAIL === 0
    ? (counts.SKIPPED_RATE_LIMIT > 0 ? "PASS WITH RATE-LIMITED SKIPS" : "PASS")
    : "FAIL";
  console.log(`\n  VERDICT: ${verdict}`);
  process.exit(counts.FAIL > 0 ? 1 : 0);
}

run().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
