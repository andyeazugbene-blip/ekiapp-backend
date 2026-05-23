/**
 * Marketplace Scenario Test Suite v2
 * Rate-limit aware, uses real orders for review validation, clean separation of concerns.
 *
 * Usage: npx tsx scripts/scenario-marketplace-test.ts [url]
 */
import Stripe from "stripe";
import "dotenv/config";

const BASE = process.argv[2] ?? process.env.STAGING_URL ?? "https://italian-market-place.vercel.app";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const PREFIX = "SCENARIO_QA_";
const TS = Date.now();
const DELAY_MS = 1200; // delay between registrations to avoid rate limit

let passed = 0, failed = 0, total = 0;
const failures: { test: string; detail: string }[] = [];

function log(test: string, ok: boolean, detail?: string) {
  total++; ok ? passed++ : failed++;
  if (!ok) failures.push({ test, detail: detail ?? "" });
  if (!ok) console.log(`  ❌ ${test} — ${detail ?? ""}`);
}

async function api(m: string, p: string, b?: unknown, t?: string) {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (t) h["Authorization"] = `Bearer ${t}`;
  const r = await fetch(`${BASE}${p}`, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  return { s: r.status, d: await r.json().catch(() => null) };
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

interface Vendor { email: string; token: string; id: string; currency: string; products: string[] }
interface Buyer { email: string; token: string; id: string }

const VENDOR_CONFIGS = [
  ...Array(4).fill(null).map((_, i) => ({ country: "Italy", currency: "EUR", idx: i })),
  ...Array(2).fill(null).map((_, i) => ({ country: "United Kingdom", currency: "GBP", idx: i + 4 })),
  { country: "United States", currency: "USD", idx: 6 },
  { country: "Nigeria", currency: "NGN", idx: 7 },
  { country: "Ghana", currency: "GHS", idx: 8 },
  { country: "Kenya", currency: "KES", idx: 9 },
];

const PRODUCT_NAMES = [
  "Organic Pasta", "Fresh Basil Sauce", "Extra Virgin Olive Oil", "Truffle Salt", "Aged Parmesan",
  "Sourdough Bread", "Artisan Cheese", "Smoked Salmon", "Wild Honey", "Dark Chocolate",
];

const vendors: Vendor[] = [];
const buyers: Buyer[] = [];
let adminToken = "";

async function run() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  MARKETPLACE SCENARIO TEST v2");
  console.log(`  Target: ${BASE}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Admin login
  const al = await api("POST", "/api/auth/login", { email: "admin-qa@test.com", password: "AdminQA123!" });
  adminToken = al.d?.token ?? "";
  if (!adminToken) { console.log("❌ Admin login failed. Aborting."); return; }

  // ═══ 1. CREATE VENDORS (with delay to avoid rate limit) ══════════════
  console.log("── 1. CREATING 10 VENDORS (rate-limit aware) ──\n");
  for (const cfg of VENDOR_CONFIGS) {
    await sleep(DELAY_MS);
    const email = `${PREFIX}v${cfg.idx}_${TS}@test.com`;
    const reg = await api("POST", "/api/auth/register", { email, password: "Vendor1A!", name: `${PREFIX}V${cfg.idx}` });
    if (reg.s === 429) { log(`Vendor ${cfg.idx} rate-limited`, false, "429 — increase delay"); continue; }
    if (reg.s !== 201) { log(`Vendor ${cfg.idx}`, false, `${reg.s}`); continue; }
    let token = reg.d?.token;
    const cv = await api("POST", "/api/vendors", { storeName: `${PREFIX}S${cfg.idx}_${TS}`, country: cfg.country }, token);
    if (cv.d?.token) token = cv.d.token;
    const vid = cv.d?.vendor?.id;
    log(`Vendor ${cfg.idx} (${cfg.country})`, cv.s === 201 && cv.d?.vendor?.currency === cfg.currency,
      `currency=${cv.d?.vendor?.currency}`);
    if (vid) await api("PATCH", `/api/admin/vendors/${vid}/approve`, {}, adminToken);
    vendors.push({ email, token: token!, id: vid!, currency: cfg.currency, products: [] });
  }
  console.log(`  Created: ${vendors.length}/${VENDOR_CONFIGS.length}\n`);

  // ═══ 2. CREATE PRODUCTS ══════════════════════════════════════════════
  console.log("── 2. CREATING PRODUCTS (5 per vendor) ──\n");
  let prodCount = 0;
  for (const vendor of vendors) {
    for (let i = 0; i < 5; i++) {
      const name = `${PREFIX}${PRODUCT_NAMES[prodCount % PRODUCT_NAMES.length]}_${prodCount}`;
      const price = Math.floor(Math.random() * 5000) + 500;
      const stock = Math.floor(Math.random() * 45) + 5;
      const wrongCurrency = vendor.currency === "EUR" ? "USD" : "EUR";
      const p = await api("POST", "/api/products", {
        title: name, priceAmount: price, stock, category: "food", currency: wrongCurrency,
      }, vendor.token);
      if (p.s === 201) {
        vendor.products.push(p.d?.product?.id);
        log(`Product ${prodCount} currency`, p.d?.product?.currency === vendor.currency,
          `expected=${vendor.currency} got=${p.d?.product?.currency}`);
      } else {
        log(`Product ${prodCount}`, false, `${p.s} ${p.d?.message}`);
      }
      prodCount++;
    }
  }
  console.log(`  Created: ${prodCount}\n`);

  // ═══ 3. CREATE BUYERS (with delay) ═══════════════════════════════════
  console.log("── 3. CREATING 5 BUYERS ──\n");
  for (let i = 0; i < 5; i++) {
    await sleep(DELAY_MS);
    const email = `${PREFIX}b${i}_${TS}@test.com`;
    const reg = await api("POST", "/api/auth/register", { email, password: "Buyer1Aa!", name: `${PREFIX}B${i}` });
    if (reg.s === 201) buyers.push({ email, token: reg.d?.token, id: reg.d?.user?.id });
  }
  log("Buyers created", buyers.length >= 3, `count=${buyers.length}`);

  // Verify auth/me
  if (buyers[0]) {
    const me = await api("GET", "/api/auth/me", undefined, buyers[0].token);
    log("Buyer /auth/me", me.s === 200 && me.d?.user?.role === "BUYER" && me.d?.user?.trustScore !== undefined);
  }

  // ═══ 4. STRIPE CHECKOUT ══════════════════════════════════════════════
  console.log("\n── 4. STRIPE CHECKOUT ──\n");
  const eurVendors = vendors.filter(v => v.currency === "EUR" && v.products.length > 0);
  let paidOrderId: string | undefined;

  if (eurVendors[0] && buyers[0]) {
    const buyer = buyers[0];
    const pid = eurVendors[0].products[0];
    await api("DELETE", "/api/cart", undefined, buyer.token);
    await api("GET", "/api/cart", undefined, buyer.token);
    await api("POST", "/api/cart/items", { productId: pid, quantity: 1 }, buyer.token);
    const cart = await api("GET", "/api/cart", undefined, buyer.token);
    const cartId = cart.d?.id ?? cart.d?.cart?.id;

    const co = await api("POST", "/api/payments/create-intent", { cartId, deliveryCountry: "Italy" }, buyer.token);
    log("Checkout created", co.s === 201, `status=${co.s}`);

    if (co.s === 201) {
      const piId = co.d.clientSecret.split("_secret_")[0];
      paidOrderId = co.d.orderIds?.[0];
      const pm = await stripe.paymentMethods.create({ type: "card", card: { token: "tok_visa" } });
      const confirmed = await stripe.paymentIntents.confirm(piId, { payment_method: pm.id, return_url: BASE });
      log("Payment confirmed", confirmed.status === "succeeded", `status=${confirmed.status}`);

      console.log("  Waiting 12s for webhook...");
      await sleep(12000);

      const order = await api("GET", `/api/orders/${paidOrderId}`, undefined, buyer.token);
      log("Order PAID", order.d?.order?.status === "PAID", `status=${order.d?.order?.status}`);
    }
  }

  // ═══ 5. REVIEWS (using real paid order) ══════════════════════════════
  console.log("\n── 5. REVIEW VALIDATION ──\n");

  // Test with fake order → expect 404
  const fakeReview = await api("POST", "/api/reviews", { orderId: "fake", vendorId: "fake", rating: 5 }, buyers[0]?.token);
  log("Fake order → 404", fakeReview.s === 404, `status=${fakeReview.s}`);

  // Invalid ratings against a real order (if we have one that's DELIVERED/COMPLETED)
  // Since our order is PAID (not DELIVERED), we expect 400 "can only review after delivered"
  if (paidOrderId && buyers[0]) {
    const vendorId = eurVendors[0]?.id ?? "";
    const reviewAttempt = await api("POST", "/api/reviews", { orderId: paidOrderId, vendorId, rating: 5 }, buyers[0].token);
    log("Review before delivery → rejected", reviewAttempt.s === 400, `status=${reviewAttempt.s} msg=${reviewAttempt.d?.message?.slice(0, 50)}`);

    // Invalid ratings (these hit validation before order check)
    for (const rating of [0, -1, 3.5, 6]) {
      const r = await api("POST", "/api/reviews", { orderId: paidOrderId, vendorId, rating }, buyers[0].token);
      log(`Rating ${rating} rejected`, r.s === 400, `status=${r.s} msg=${r.d?.message?.slice(0, 40)}`);
    }
  }

  // ═══ 6. REFUND + DUPLICATE ═══════════════════════════════════════════
  console.log("\n── 6. REFUND ──\n");
  if (paidOrderId) {
    const ref = await api("POST", `/api/admin/orders/${paidOrderId}/refund`, { amount: 100, reason: "QA" }, adminToken);
    log("Admin refund", ref.s === 202, `status=${ref.s}`);
    const dup = await api("POST", `/api/admin/orders/${paidOrderId}/refund`, { amount: 100 }, adminToken);
    log("Duplicate refund → 409", dup.s === 409, `status=${dup.s}`);
  }

  // ═══ 7. R2 UPLOAD (using confirmed vendor token) ═════════════════════
  console.log("\n── 7. R2 UPLOAD ──\n");
  const uploadVendor = vendors.find(v => !!v.token);
  if (uploadVendor) {
    const upl = await api("POST", "/api/uploads/request-url", { filename: "scenario.png", contentType: "image/png", category: "product" }, uploadVendor.token);
    log("Upload URL", upl.s === 200, `status=${upl.s}`);
    if (upl.s === 200) {
      const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
      const put = await fetch(upl.d.uploadUrl, { method: "PUT", headers: { "Content-Type": "image/png" }, body: PNG });
      log("PUT upload", put.status === 200 || put.status === 204, `status=${put.status}`);
      if (put.status === 200 || put.status === 204) {
        await sleep(2000);
        const get = await fetch(upl.d.publicUrl);
        log("GET publicUrl", get.status === 200, `status=${get.status}`);
      }
    }
  }

  // ═══ 8. RATE LIMIT TEST (dedicated) ═════════════════════════════════
  console.log("\n── 8. RATE LIMIT VERIFICATION ──\n");
  // Rapid-fire 12 login attempts to trigger rate limit
  let gotRateLimited = false;
  for (let i = 0; i < 12; i++) {
    const r = await api("POST", "/api/auth/login", { email: "nonexistent@test.com", password: "x" });
    if (r.s === 429) { gotRateLimited = true; break; }
  }
  log("Rate limiter triggers on rapid auth", gotRateLimited, gotRateLimited ? "429 received" : "not triggered (may need more attempts)");

  // ═══ 9. CONCURRENCY ═════════════════════════════════════════════════
  console.log("\n── 9. CONCURRENCY ──\n");
  if (eurVendors[0] && buyers.length >= 3) {
    const lowStock = await api("POST", "/api/products", {
      title: `${PREFIX}LowStock_${TS}`, priceAmount: 1000, stock: 2, category: "food",
    }, eurVendors[0].token);
    const lsPid = lowStock.d?.product?.id;
    if (lsPid) {
      eurVendors[0].products.push(lsPid);
      const attempts = await Promise.all(
        buyers.slice(0, 3).map(async (buyer) => {
          await api("DELETE", "/api/cart", undefined, buyer.token);
          await api("GET", "/api/cart", undefined, buyer.token);
          await api("POST", "/api/cart/items", { productId: lsPid, quantity: 1 }, buyer.token);
          const c = await api("GET", "/api/cart", undefined, buyer.token);
          const cid = c.d?.id ?? c.d?.cart?.id;
          return api("POST", "/api/payments/create-intent", { cartId: cid, deliveryCountry: "Italy" }, buyer.token);
        }),
      );
      const successes = attempts.filter(a => a.s === 201).length;
      log("Low-stock concurrency: max 2 succeed", successes <= 2, `successes=${successes}/3`);
    }
  }

  // ═══ 10. CLEANUP ════════════════════════════════════════════════════
  console.log("\n── 10. CLEANUP ──\n");
  let deactivated = 0;
  for (const vendor of vendors) {
    for (const pid of vendor.products) {
      await api("PATCH", `/api/admin/products/${pid}/disable`, {}, adminToken);
      deactivated++;
    }
  }
  console.log(`  Deactivated: ${deactivated} products`);

  const finalCatalog = await api("GET", "/api/products?limit=100");
  const remaining = (finalCatalog.d?.items ?? []).filter((p: any) => p.title?.startsWith(PREFIX));
  log("Cleanup: no QA products visible", remaining.length === 0, `remaining=${remaining.length}`);

  // ═══ SUMMARY ════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("═══════════════════════════════════════════════════════════\n");
  console.log(`  Vendors: ${vendors.length} | Buyers: ${buyers.length} | Products: ${prodCount}`);
  console.log(`  Tests: ${total} | ✅ ${passed} | ❌ ${failed}\n`);

  if (failures.length > 0) {
    console.log("  FAILURES:");
    failures.forEach(f => console.log(`    ❌ ${f.test} — ${f.detail}`));
  }

  console.log(`\n  ${failed === 0 ? "✅ PASS" : "❌ FAIL"}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
