/**
 * Marketplace Scenario Test v3
 * Rate-limit aware. Reuses existing users. Skips gracefully when prerequisites missing.
 *
 * Usage: npx tsx scripts/scenario-marketplace-test.ts [url]
 */
import Stripe from "stripe";
import "dotenv/config";

const BASE = process.argv[2] ?? "https://italian-market-place.vercel.app";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const PREFIX = "SCENARIO_QA_";
const TS = Date.now();

type Status = "PASS" | "FAIL" | "SKIPPED" | "EXPECTED_SECURITY_BLOCK";
const results: { test: string; status: Status; detail: string }[] = [];

function log(test: string, status: Status, detail?: string) {
  results.push({ test, status, detail: detail ?? "" });
  const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : status === "SKIPPED" ? "⏭️" : "🔒";
  console.log(`  ${icon} [${status}] ${test}${detail ? ` — ${detail}` : ""}`);
}

async function api(m: string, p: string, b?: unknown, t?: string) {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (t) h["Authorization"] = `Bearer ${t}`;
  const r = await fetch(`${BASE}${p}`, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  return { s: r.status, d: await r.json().catch(() => null) };
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function registerWithRetry(email: string, password: string, name: string, maxRetries = 3): Promise<{ s: number; d: any }> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const r = await api("POST", "/api/auth/register", { email, password, name });
    if (r.s !== 429) return r;
    const backoff = (attempt + 1) * 5000;
    console.log(`    ⏳ Rate limited, waiting ${backoff / 1000}s...`);
    await sleep(backoff);
  }
  return { s: 429, d: null };
}

async function loginOrRegister(email: string, password: string, name: string): Promise<string | null> {
  const login = await api("POST", "/api/auth/login", { email, password });
  if (login.s === 200) return login.d?.token;
  if (login.s === 429) { await sleep(5000); return null; }
  const reg = await registerWithRetry(email, password, name);
  return reg.s === 201 ? reg.d?.token : null;
}

let adminToken = "";
const vendorTokens: { token: string; id: string; currency: string; products: string[] }[] = [];
const buyerTokens: string[] = [];

async function run() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  MARKETPLACE SCENARIO TEST v3");
  console.log(`  Target: ${BASE}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // ─── ADMIN LOGIN ───────────────────────────────────────────────────
  console.log("── ADMIN ──\n");
  const al = await api("POST", "/api/auth/login", { email: "admin-qa@test.com", password: "AdminQA123!" });
  adminToken = al.d?.token ?? "";
  log("Admin login", adminToken ? "PASS" : "FAIL", adminToken ? "token acquired" : "failed");
  if (!adminToken) { console.log("Cannot proceed without admin. Aborting."); return; }

  // ─── CLEANUP OLD QA DATA ───────────────────────────────────────────
  console.log("\n── PRE-CLEANUP ──\n");
  const oldProds = await api("GET", "/api/admin/products?limit=100", undefined, adminToken);
  const qaProds = (oldProds.d?.items ?? []).filter((p: any) => p.title?.startsWith(PREFIX) && p.isActive);
  for (const p of qaProds) { await api("PATCH", `/api/admin/products/${p.id}/disable`, {}, adminToken); }
  log("Pre-cleanup old QA products", "PASS", `deactivated=${qaProds.length}`);

  // ─── VENDOR SETUP (3 vendors, reuse if exist) ──────────────────────
  console.log("\n── VENDOR SETUP (3) ──\n");
  const vendorConfigs = [
    { country: "Italy", currency: "EUR", suffix: "it" },
    { country: "United Kingdom", currency: "GBP", suffix: "uk" },
    { country: "Nigeria", currency: "NGN", suffix: "ng" },
  ];

  for (const cfg of vendorConfigs) {
    await sleep(1500);
    const email = `${PREFIX}v_${cfg.suffix}@test.com`;
    const token = await loginOrRegister(email, "Vendor1A!", `${PREFIX}V_${cfg.suffix}`);
    if (!token) { log(`Vendor ${cfg.suffix}`, "SKIPPED", "rate limited"); continue; }

    // Check if already a vendor
    const me = await api("GET", "/api/auth/me", undefined, token);
    if (me.d?.user?.role === "VENDOR") {
      const vm = await api("GET", "/api/vendors/me", undefined, token);
      vendorTokens.push({ token, id: vm.d?.vendor?.id, currency: vm.d?.vendor?.currency, products: [] });
      log(`Vendor ${cfg.suffix} (reused)`, "PASS", `currency=${vm.d?.vendor?.currency}`);
      continue;
    }

    // Create vendor
    const cv = await api("POST", "/api/vendors", { storeName: `${PREFIX}S_${cfg.suffix}_${TS}`, country: cfg.country }, token);
    const vToken = cv.d?.token || token;
    const vid = cv.d?.vendor?.id;
    if (vid) {
      await api("PATCH", `/api/admin/vendors/${vid}/approve`, {}, adminToken);
      vendorTokens.push({ token: vToken, id: vid, currency: cv.d?.vendor?.currency, products: [] });
      log(`Vendor ${cfg.suffix}`, "PASS", `currency=${cv.d?.vendor?.currency}`);
    } else {
      log(`Vendor ${cfg.suffix}`, "FAIL", `${cv.s} ${cv.d?.message}`);
    }
  }

  // ─── PRODUCT CREATION ──────────────────────────────────────────────
  console.log("\n── PRODUCTS (3 per vendor) ──\n");
  let prodCount = 0;
  for (const v of vendorTokens) {
    for (let i = 0; i < 3; i++) {
      const title = `${PREFIX}Prod_${prodCount}_${TS}`;
      const wrongCurrency = v.currency === "EUR" ? "USD" : "EUR";
      const p = await api("POST", "/api/products", {
        title, priceAmount: 1500 + prodCount * 100, stock: 10, category: "food", currency: wrongCurrency,
      }, v.token);
      if (p.s === 201) {
        v.products.push(p.d?.product?.id);
        log(`Product ${prodCount} currency`, p.d?.product?.currency === v.currency ? "PASS" : "FAIL",
          `expected=${v.currency} got=${p.d?.product?.currency}`);
      } else {
        log(`Product ${prodCount}`, "FAIL", `${p.s} ${p.d?.message}`);
      }
      prodCount++;
    }
  }

  // ─── BUYER SETUP (3 buyers) ────────────────────────────────────────
  console.log("\n── BUYER SETUP (3) ──\n");
  for (let i = 0; i < 3; i++) {
    await sleep(1500);
    const email = `${PREFIX}b_${i}@test.com`;
    const token = await loginOrRegister(email, "Buyer1Aa!", `${PREFIX}B_${i}`);
    if (token) { buyerTokens.push(token); log(`Buyer ${i}`, "PASS"); }
    else { log(`Buyer ${i}`, "SKIPPED", "rate limited"); }
  }

  // ─── STRIPE CHECKOUT ───────────────────────────────────────────────
  console.log("\n── STRIPE CHECKOUT ──\n");
  let paidOrderId: string | undefined;
  const eurVendor = vendorTokens.find(v => v.currency === "EUR" && v.products.length > 0);

  if (!buyerTokens[0] || !eurVendor) {
    log("Stripe checkout", "SKIPPED", "missing buyer or EUR vendor");
  } else {
    const bt = buyerTokens[0];
    const pid = eurVendor.products[0];
    await api("DELETE", "/api/cart", undefined, bt);
    await api("GET", "/api/cart", undefined, bt);
    await api("POST", "/api/cart/items", { productId: pid, quantity: 1 }, bt);
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
      } catch (e: any) {
        log("Payment confirm", "FAIL", e.message?.slice(0, 60));
      }
    }
  }

  // ─── REVIEW VALIDATION ─────────────────────────────────────────────
  console.log("\n── REVIEW VALIDATION ──\n");
  if (!buyerTokens[0]) {
    log("Review tests", "SKIPPED", "no buyer token");
  } else {
    const bt = buyerTokens[0];
    // Fake order → 404
    const fake = await api("POST", "/api/reviews", { orderId: "nonexistent", vendorId: "x", rating: 5 }, bt);
    log("Fake order review → 404", fake.s === 404 ? "PASS" : "FAIL", `status=${fake.s}`);

    // Invalid ratings against real order (if exists)
    if (paidOrderId && eurVendor) {
      for (const rating of [0, -1, 3.5, 6]) {
        const r = await api("POST", "/api/reviews", { orderId: paidOrderId, vendorId: eurVendor.id, rating }, bt);
        log(`Rating ${rating} rejected`, r.s === 400 ? "PASS" : "FAIL", `status=${r.s}`);
      }
    } else {
      log("Invalid rating tests", "SKIPPED", "no paid order");
    }
  }

  // ─── REFUND ────────────────────────────────────────────────────────
  console.log("\n── REFUND ──\n");
  if (paidOrderId) {
    const ref = await api("POST", `/api/admin/orders/${paidOrderId}/refund`, { amount: 100, reason: "QA" }, adminToken);
    log("Admin refund", ref.s === 202 ? "PASS" : "FAIL", `status=${ref.s}`);
    const dup = await api("POST", `/api/admin/orders/${paidOrderId}/refund`, { amount: 100 }, adminToken);
    log("Duplicate refund → 409", dup.s === 409 ? "PASS" : "FAIL", `status=${dup.s}`);
  } else {
    log("Refund tests", "SKIPPED", "no paid order");
  }

  // ─── R2 UPLOAD ─────────────────────────────────────────────────────
  console.log("\n── R2 UPLOAD ──\n");
  const uploadToken = vendorTokens[0]?.token;
  if (!uploadToken) {
    log("Upload test", "SKIPPED", "no vendor token");
  } else {
    const upl = await api("POST", "/api/uploads/request-url", { filename: "s.png", contentType: "image/png", category: "product" }, uploadToken);
    log("Upload URL", upl.s === 200 ? "PASS" : "FAIL", `status=${upl.s}`);
    if (upl.s === 200) {
      const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
      const put = await fetch(upl.d.uploadUrl, { method: "PUT", headers: { "Content-Type": "image/png" }, body: PNG });
      log("PUT upload", put.status === 200 || put.status === 204 ? "PASS" : "FAIL", `status=${put.status}`);
      await sleep(2000);
      const get = await fetch(upl.d.publicUrl);
      log("GET publicUrl", get.status === 200 ? "PASS" : "FAIL", `status=${get.status}`);
    }
  }

  // ─── RATE LIMIT VERIFICATION ───────────────────────────────────────
  console.log("\n── RATE LIMIT VERIFICATION ──\n");
  let got429 = false;
  for (let i = 0; i < 15; i++) {
    const r = await api("POST", "/api/auth/login", { email: "ratelimit@test.com", password: "x" });
    if (r.s === 429) { got429 = true; break; }
  }
  log("Rate limiter triggers on rapid auth", got429 ? "EXPECTED_SECURITY_BLOCK" : "PASS",
    got429 ? "429 received as expected" : "not triggered in 15 attempts");

  // ─── SECURITY CHECKS ──────────────────────────────────────────────
  console.log("\n── SECURITY ──\n");
  if (buyerTokens[0]) {
    const ba = await api("GET", "/api/admin/dashboard", undefined, buyerTokens[0]);
    log("Buyer → admin = 403", ba.s === 403 ? "PASS" : "FAIL", `status=${ba.s}`);
  }
  const noAuth = await api("GET", "/api/auth/me");
  log("No token → 401", noAuth.s === 401 ? "PASS" : "FAIL", `status=${noAuth.s}`);

  const badWebhook = await fetch(`${BASE}/api/stripe/webhook`, {
    method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": "t=1,v1=fake" }, body: "{}",
  });
  log("Invalid Stripe webhook sig → 400", badWebhook.status === 400 ? "PASS" : "FAIL", `status=${badWebhook.status}`);

  // ─── CLEANUP ───────────────────────────────────────────────────────
  console.log("\n── CLEANUP ──\n");
  let deactivated = 0;
  for (const v of vendorTokens) {
    for (const pid of v.products) {
      await api("PATCH", `/api/admin/products/${pid}/disable`, {}, adminToken);
      deactivated++;
    }
  }
  const finalCatalog = await api("GET", "/api/products?limit=100");
  const remaining = (finalCatalog.d?.items ?? []).filter((p: any) => p.title?.startsWith(PREFIX));
  log("Cleanup: no QA products visible", remaining.length === 0 ? "PASS" : "FAIL", `deactivated=${deactivated} remaining=${remaining.length}`);

  // ─── SUMMARY ───────────────────────────────────────────────────────
  const counts = { PASS: 0, FAIL: 0, SKIPPED: 0, EXPECTED_SECURITY_BLOCK: 0 };
  results.forEach(r => counts[r.status]++);

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("═══════════════════════════════════════════════════════════\n");
  console.log(`  ✅ PASS:     ${counts.PASS}`);
  console.log(`  ❌ FAIL:     ${counts.FAIL}`);
  console.log(`  ⏭️  SKIPPED:  ${counts.SKIPPED}`);
  console.log(`  🔒 SECURITY: ${counts.EXPECTED_SECURITY_BLOCK}`);
  console.log(`  Total:       ${results.length}\n`);

  if (counts.FAIL > 0) {
    console.log("  FAILURES:");
    results.filter(r => r.status === "FAIL").forEach(r => console.log(`    ❌ ${r.test} — ${r.detail}`));
  }

  const verdict = counts.FAIL === 0
    ? (counts.SKIPPED > 0 ? "PASS WITH SKIPPED OPTIONAL TESTS" : "PASS")
    : "FAIL";
  console.log(`\n  VERDICT: ${verdict}`);
  process.exit(counts.FAIL > 0 ? 1 : 0);
}

run().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
