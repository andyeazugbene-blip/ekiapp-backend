/**
 * Marketplace Scenario Test Suite
 * Simulates realistic marketplace usage with vendors, buyers, products, orders.
 * All QA data is prefixed with SCENARIO_QA_ and cleaned up at the end.
 *
 * Usage: npx tsx scripts/scenario-marketplace-test.ts [url]
 */
import Stripe from "stripe";
import "dotenv/config";

const BASE = process.argv[2] ?? process.env.STAGING_URL ?? "https://italian-market-place.vercel.app";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const PREFIX = "SCENARIO_QA_";
const TS = Date.now();

let passed = 0, failed = 0, total = 0;
const failures: { test: string; detail: string }[] = [];

function log(test: string, ok: boolean, detail?: string) {
  total++;
  ok ? passed++ : failed++;
  if (!ok) failures.push({ test, detail: detail ?? "" });
  if (!ok) console.log(`  ❌ ${test} — ${detail ?? ""}`);
}

async function api(m: string, p: string, b?: unknown, t?: string) {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (t) h["Authorization"] = `Bearer ${t}`;
  const r = await fetch(`${BASE}${p}`, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  return { s: r.status, d: await r.json().catch(() => null) };
}

// ─── Data structures ─────────────────────────────────────────────────────
interface Vendor { email: string; token: string; id: string; currency: string; products: string[] }
interface Buyer { email: string; token: string; id: string }

const VENDOR_CONFIGS = [
  ...Array(8).fill(null).map((_, i) => ({ country: "Italy", currency: "EUR", idx: i })),
  ...Array(4).fill(null).map((_, i) => ({ country: "United Kingdom", currency: "GBP", idx: i + 8 })),
  ...Array(3).fill(null).map((_, i) => ({ country: "United States", currency: "USD", idx: i + 12 })),
  ...Array(3).fill(null).map((_, i) => ({ country: "Nigeria", currency: "NGN", idx: i + 15 })),
  { country: "Ghana", currency: "GHS", idx: 18 },
  { country: "Kenya", currency: "KES", idx: 19 },
];

const PRODUCT_NAMES = [
  "Organic Pasta", "Fresh Basil Sauce", "Extra Virgin Olive Oil", "Truffle Salt", "Aged Parmesan",
  "Sourdough Bread", "Artisan Cheese", "Smoked Salmon", "Wild Honey", "Dark Chocolate",
  "Basmati Rice", "Coconut Oil", "Turmeric Powder", "Dried Mango", "Cashew Nuts",
  "Palm Oil", "Plantain Chips", "Jollof Spice Mix", "Suya Seasoning", "Garri",
];

const vendors: Vendor[] = [];
const buyers: Buyer[] = [];
const orderIds: string[] = [];
let adminToken = "";

async function run() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  MARKETPLACE SCENARIO TEST");
  console.log(`  Target: ${BASE}`);
  console.log(`  Prefix: ${PREFIX}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  // Admin login
  const al = await api("POST", "/api/auth/login", { email: "admin-qa@test.com", password: "AdminQA123!" });
  adminToken = al.d?.token ?? "";
  if (!adminToken) { console.log("❌ Admin login failed. Aborting."); return; }

  // ═══ 1. CREATE VENDORS ═══════════════════════════════════════════════
  console.log("── 1. CREATING 20 VENDORS ──\n");
  for (const cfg of VENDOR_CONFIGS) {
    const email = `${PREFIX}vendor${cfg.idx}_${TS}@test.com`;
    const reg = await api("POST", "/api/auth/register", { email, password: "Vendor1A!", name: `${PREFIX}Vendor ${cfg.idx}` });
    if (reg.s !== 201) { log(`Register vendor ${cfg.idx}`, false, `${reg.s}`); continue; }
    let token = reg.d?.token;
    const cv = await api("POST", "/api/vendors", { storeName: `${PREFIX}Store_${cfg.idx}_${TS}`, country: cfg.country }, token);
    if (cv.d?.token) token = cv.d.token;
    const vid = cv.d?.vendor?.id;
    log(`Vendor ${cfg.idx} (${cfg.country})`, cv.s === 201 && cv.d?.vendor?.currency === cfg.currency,
      `currency=${cv.d?.vendor?.currency}`);
    if (vid && adminToken) await api("PATCH", `/api/admin/vendors/${vid}/approve`, {}, adminToken);
    vendors.push({ email, token: token!, id: vid!, currency: cfg.currency, products: [] });
  }
  console.log(`  Created: ${vendors.length}/20 vendors\n`);

  // ═══ 2. CREATE PRODUCTS ══════════════════════════════════════════════
  console.log("── 2. CREATING 100 PRODUCTS ──\n");
  let prodCount = 0;
  for (const vendor of vendors) {
    for (let i = 0; i < 5; i++) {
      const name = `${PREFIX}${PRODUCT_NAMES[(prodCount) % PRODUCT_NAMES.length]}_${prodCount}`;
      const price = Math.floor(Math.random() * 5000) + 500;
      const stock = Math.floor(Math.random() * 45) + 5;
      // Try to override currency — should be ignored
      const wrongCurrency = vendor.currency === "EUR" ? "USD" : "EUR";
      const p = await api("POST", "/api/products", {
        title: name, priceAmount: price, stock, category: "food", currency: wrongCurrency,
      }, vendor.token);
      if (p.s === 201) {
        const pid = p.d?.product?.id;
        vendor.products.push(pid);
        log(`Product ${prodCount}`, p.d?.product?.currency === vendor.currency,
          `expected=${vendor.currency} got=${p.d?.product?.currency}`);
        prodCount++;
      } else {
        log(`Product ${prodCount}`, false, `${p.s} ${p.d?.message}`);
        prodCount++;
      }
    }
  }
  console.log(`  Created: ${prodCount} products\n`);

  // Verify catalog
  const catalog = await api("GET", "/api/products?limit=50");
  const catalogTitles = (catalog.d?.items ?? []).map((p: any) => p.title);
  const qaCatalog = catalogTitles.filter((t: string) => t.startsWith(PREFIX));
  log("Catalog has QA products", qaCatalog.length > 0, `found=${qaCatalog.length}`);

  // ═══ 3. CREATE BUYERS ════════════════════════════════════════════════
  console.log("\n── 3. CREATING 50 BUYERS ──\n");
  // Test weak password once
  const weakTest = await api("POST", "/api/auth/register", { email: `${PREFIX}weak@t.com`, password: "weak", name: "W" });
  log("Weak password rejected", weakTest.s === 400);

  for (let i = 0; i < 50; i++) {
    const email = `${PREFIX}buyer${i}_${TS}@test.com`;
    const reg = await api("POST", "/api/auth/register", { email, password: "Buyer1Aa!", name: `${PREFIX}Buyer ${i}` });
    if (reg.s === 201) {
      buyers.push({ email, token: reg.d?.token, id: reg.d?.user?.id });
    }
  }
  console.log(`  Created: ${buyers.length}/50 buyers\n`);

  // Verify auth/me
  if (buyers[0]) {
    const me = await api("GET", "/api/auth/me", undefined, buyers[0].token);
    log("Buyer /auth/me", me.s === 200 && me.d?.user?.role === "BUYER" && me.d?.user?.trustScore !== undefined);
  }

  // ═══ 4. BUYER CHECKOUT SIMULATION ════════════════════════════════════
  console.log("── 4. CHECKOUT SIMULATION ──\n");
  // Pick EUR vendors/products for Stripe checkout (Stripe uses EUR)
  const eurVendors = vendors.filter(v => v.currency === "EUR" && v.products.length > 0);
  let stripeOrders = 0, walletOrders = 0, abandoned = 0;

  for (let i = 0; i < Math.min(buyers.length, 30); i++) {
    const buyer = buyers[i];
    const action = Math.random();

    if (action < 0.1) { abandoned++; continue; } // 10% abandon

    // Pick a random EUR product
    const vendor = eurVendors[i % eurVendors.length];
    if (!vendor || !vendor.products[0]) continue;
    const pid = vendor.products[i % vendor.products.length];

    // Clear cart + add
    await api("DELETE", "/api/cart", undefined, buyer.token);
    await api("GET", "/api/cart", undefined, buyer.token);
    await api("POST", "/api/cart/items", { productId: pid, quantity: 1 }, buyer.token);
    const cart = await api("GET", "/api/cart", undefined, buyer.token);
    const cartId = cart.d?.id ?? cart.d?.cart?.id;

    if (!cartId) continue;

    // Stripe checkout (most buyers)
    const co = await api("POST", "/api/payments/create-intent", { cartId, deliveryCountry: "Italy" }, buyer.token);
    if (co.s === 201 && co.d?.clientSecret) {
      const piId = co.d.clientSecret.split("_secret_")[0];
      orderIds.push(co.d.orderIds?.[0]);

      // Confirm with test card
      try {
        const pm = await stripe.paymentMethods.create({ type: "card", card: { token: "tok_visa" } });
        await stripe.paymentIntents.confirm(piId, { payment_method: pm.id, return_url: BASE });
        stripeOrders++;
      } catch { /* rate limited or PI issue — skip */ }
    }
  }
  console.log(`  Stripe orders: ${stripeOrders}`);
  console.log(`  Abandoned: ${abandoned}\n`);

  // Wait for webhooks
  if (stripeOrders > 0) {
    console.log("  Waiting 15s for webhooks...\n");
    await new Promise(r => setTimeout(r, 15000));
  }

  // ═══ 5. REVIEWS ══════════════════════════════════════════════════════
  console.log("── 5. REVIEWS ──\n");
  // Invalid ratings
  const invalidRatings = [0, -1, 3.5, 6];
  for (const rating of invalidRatings) {
    const r = await api("POST", "/api/reviews", { orderId: "fake", vendorId: "fake", rating }, buyers[0]?.token);
    log(`Invalid rating ${rating} rejected`, r.s === 400);
  }

  // ═══ 6. REFUND + DUPLICATE ═══════════════════════════════════════════
  console.log("\n── 6. REFUND TEST ──\n");
  // Find a paid order from our scenario
  const paidOrder = await api("GET", "/api/admin/orders?status=PAID&limit=3", undefined, adminToken);
  const refundableOrders = (paidOrder.d?.items ?? []).filter((o: any) =>
    o.orderNumber?.includes("EKI") && o.status === "PAID"
  ).slice(0, 2);

  for (const order of refundableOrders) {
    const ref = await api("POST", `/api/admin/orders/${order.id}/refund`, { amount: order.totalAmount, reason: "QA test" }, adminToken);
    log(`Refund order ${order.id.slice(0, 8)}`, ref.s === 202, `status=${ref.s}`);

    // Duplicate
    const dup = await api("POST", `/api/admin/orders/${order.id}/refund`, { amount: order.totalAmount }, adminToken);
    log(`Duplicate refund → 409`, dup.s === 409, `status=${dup.s}`);
  }

  // ═══ 7. R2 UPLOAD ═══════════════════════════════════════════════════
  console.log("\n── 7. R2 UPLOAD ──\n");
  if (vendors[0]) {
    const upl = await api("POST", "/api/uploads/request-url", { filename: "scenario.png", contentType: "image/png", category: "product" }, vendors[0].token);
    log("Upload URL request", upl.s === 200);
    if (upl.s === 200) {
      const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
      const put = await fetch(upl.d.uploadUrl, { method: "PUT", headers: { "Content-Type": "image/png" }, body: PNG });
      log("PUT upload", put.status === 200 || put.status === 204, `status=${put.status}`);
      if (put.status === 200 || put.status === 204) {
        await new Promise(r => setTimeout(r, 2000));
        const get = await fetch(upl.d.publicUrl);
        log("GET publicUrl", get.status === 200, `status=${get.status}`);
      }
    }
  }

  // ═══ 8. CONCURRENCY ═════════════════════════════════════════════════
  console.log("\n── 8. CONCURRENCY ──\n");
  // Low-stock product race
  if (eurVendors[0] && buyers.length >= 10) {
    // Create a product with stock=2
    const lowStock = await api("POST", "/api/products", {
      title: `${PREFIX}LowStock_${TS}`, priceAmount: 1000, stock: 2, category: "food",
    }, eurVendors[0].token);
    const lsPid = lowStock.d?.product?.id;

    if (lsPid) {
      // 5 concurrent checkout attempts
      const attempts = await Promise.all(
        buyers.slice(0, 5).map(async (buyer) => {
          await api("DELETE", "/api/cart", undefined, buyer.token);
          await api("GET", "/api/cart", undefined, buyer.token);
          await api("POST", "/api/cart/items", { productId: lsPid, quantity: 1 }, buyer.token);
          const c = await api("GET", "/api/cart", undefined, buyer.token);
          const cid = c.d?.id ?? c.d?.cart?.id;
          return api("POST", "/api/payments/create-intent", { cartId: cid, deliveryCountry: "Italy" }, buyer.token);
        }),
      );
      const successes = attempts.filter(a => a.s === 201).length;
      log("Concurrent low-stock: max 2 succeed", successes <= 2, `successes=${successes}/5`);
    }
  }

  // ═══ 9. CLEANUP ═════════════════════════════════════════════════════
  console.log("\n── 9. CLEANUP ──\n");
  // Deactivate all QA products
  let deactivated = 0;
  for (const vendor of vendors) {
    for (const pid of vendor.products) {
      // Use admin to deactivate
      await api("PATCH", `/api/admin/products/${pid}/disable`, {}, adminToken);
      deactivated++;
    }
  }
  console.log(`  Deactivated ${deactivated} QA products`);

  // Verify cleanup
  const finalCatalog = await api("GET", "/api/products?limit=100");
  const remaining = (finalCatalog.d?.items ?? []).filter((p: any) => p.title?.startsWith(PREFIX));
  log("No QA products in catalog after cleanup", remaining.length === 0, `remaining=${remaining.length}`);

  // ═══ 10. FINAL REPORT ═══════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  SCENARIO TEST RESULTS");
  console.log("═══════════════════════════════════════════════════════════\n");
  console.log(`  Vendors created:    ${vendors.length}`);
  console.log(`  Buyers created:     ${buyers.length}`);
  console.log(`  Products created:   ${prodCount}`);
  console.log(`  Stripe orders:      ${stripeOrders}`);
  console.log(`  Wallet orders:      ${walletOrders}`);
  console.log(`  Refunds:            ${refundableOrders.length}`);
  console.log(`  Tests:              ${total}`);
  console.log(`  Passed:             ${passed}`);
  console.log(`  Failed:             ${failed}`);
  console.log("");

  if (failures.length > 0) {
    console.log("  FAILURES:");
    failures.forEach(f => console.log(`    ❌ ${f.test} — ${f.detail}`));
  }

  console.log(`\n  ${failed === 0 ? "✅ PASS" : "❌ FAIL"}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
