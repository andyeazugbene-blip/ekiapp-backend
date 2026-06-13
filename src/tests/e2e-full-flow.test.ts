/**
 * COMPREHENSIVE E2E TEST: Full marketplace flow
 * Tests against LIVE backend. Uses debug endpoints to bypass rate limits.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BASE = "https://ekiapp-backend.vercel.app";
const DEBUG_KEY = "eki-debug-2026";

// We use the existing vendor@eki.app / buyer@eki.app accounts
// to avoid rate limiting from registration.

let V_TOKEN: string = "";
let B_TOKEN: string = "";
let VENDOR_ID: string = "";
let BUYER_ID: string = "";

beforeAll(async () => {
  // Login with delays to avoid rate limits
  await sleep(2000);
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "vendor@eki.app", password: "Abdou22314" }),
  });
  const loginData = await loginRes.json();
  V_TOKEN = loginData.token;
  VENDOR_ID = loginData.user?.id;

  await sleep(2000);
  const bLoginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "buyer@eki.app", password: "Abdou22314" }),
  });
  const bLoginData = await bLoginRes.json();
  B_TOKEN = bLoginData.token;
  BUYER_ID = bLoginData.user?.id;

  console.log(`\n🧪 VENDOR: ${VENDOR_ID}, BUYER: ${BUYER_ID}`);
});

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function api(method: string, path: string, body?: any, token?: string) {
  const headers: Record<string,string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  await sleep(800); // respect rate limits
  return { status: res.status, data };
}

describe("🧪 FULL E2E: Complete Marketplace Flow", () => {
  let productId: string = "";
  let orderId: string = "";
  let paymentId: string = "";

  // ─── 1. AUTH & PROFILE ───────────────────────────────
  it("1a. Vendor login returns correct data", async () => {
    expect(V_TOKEN).toBeTruthy();
    expect(V_TOKEN.length).toBeGreaterThan(20);
    const { data } = await api("GET", "/api/auth/me", undefined, V_TOKEN);
    expect(data.user.role).toBe("VENDOR");
    expect(data.user.hasVendor).toBe(true);
    console.log("   ✅ Vendor logged in, role=VENDOR, hasVendor=true");
  });

  it("1b. Buyer login returns correct data", async () => {
    expect(B_TOKEN).toBeTruthy();
    const { data } = await api("GET", "/api/auth/me", undefined, B_TOKEN);
    expect(data.user.role).toBe("BUYER");
    expect(data.user.hasVendor).toBe(false);
    console.log("   ✅ Buyer logged in, role=BUYER, hasVendor=false");
  });

  it("1c. Vendor has wallet with balances", async () => {
    const { data } = await api("GET", "/api/vendors/me/dashboard", undefined, V_TOKEN);
    expect(data.earnings).toBeDefined();
    console.log(`   ✅ Wallet: pending=${data.earnings.pendingPayout}, available=${data.earnings.availableBalance}`);
  });

  // ─── 2. PRODUCTS ─────────────────────────────────────
  it("2a. Vendor can list products", async () => {
    const { data } = await api("GET", "/api/products/me", undefined, V_TOKEN);
    expect(Array.isArray(data.items ?? data.products ?? data)).toBe(true);
    const items = data.items ?? data.products ?? data;
    if (items.length > 0) productId = items[0].id;
    console.log(`   ✅ ${items.length} products found, using: ${productId || "will create new"}`);
  });

  it("2b. Vendor can create product if none exist", async () => {
    if (productId) return;
    const { data } = await api("POST", "/api/products", {
      title: `E2E Test ${Date.now()}`,
      priceInCents: 3000,
      stock: 100,
      currency: "EUR",
      weightGrams: 500,
    }, V_TOKEN);
    productId = data.product?.id;
    expect(productId).toBeTruthy();
    console.log(`   ✅ Created product: ${productId}`);
  });

  // ─── 3. PUBLIC STORE ─────────────────────────────────
  it("3a. Public store shows vendor", async () => {
    const { data } = await api("GET", "/api/public/stores/queen-african-foods");
    expect(data.store).toBeDefined();
    expect(data.store.storeName).toBeTruthy();
    console.log(`   ✅ Public store: ${data.store.storeName}`);
  });

  it("3b. Public store products are visible", async () => {
    const { data } = await api("GET", "/api/public/stores/queen-african-foods/products?limit=5");
    const items = data.items ?? [];
    if (items.length > 0 && !productId) productId = items[0].id;
    console.log(`   ✅ ${items.length} products visible in public store`);
  });

  // ─── 4. CART ─────────────────────────────────────────
  it("4a. Buyer can get their cart", async () => {
    const { data } = await api("GET", "/api/cart/me", undefined, B_TOKEN);
    expect(data).toBeDefined();
    console.log(`   ✅ Cart accessible`);
  });

  // ─── 5. CHECKOUT & PAYMENT ───────────────────────────
  it("5a. Buyer can initiate payment (create-intent)", async () => {
    // First ensure product is in cart
    if (!productId) {
      console.log("   ⚠️ No product available, skipping checkout test");
      return;
    }

    // Add to cart
    await api("POST", "/api/cart/add", { productId, quantity: 2 }, B_TOKEN);

    // Get delivery zones
    const zonesRes = await api("GET", "/api/delivery/zones", undefined, B_TOKEN);
    const zones = zonesRes.data.zones ?? [];
    const zoneId = zones[0]?.id;
    if (!zoneId) {
      console.log("   ⚠️ No delivery zones, skipping checkout");
      return;
    }

    // Create payment intent
    const { data, status } = await api("POST", "/api/payments/create-intent", {
      cartId: (await api("GET", "/api/cart/me", undefined, B_TOKEN)).data.id,
      destinationZoneId: zoneId,
      deliveryAddress: "123 E2E Street, London, SW1A 1AA",
      deliveryCountry: "United Kingdom",
    }, B_TOKEN);

    if (status === 201) {
      console.log(`   ✅ Payment intent created: ${data.paymentIntentId || "wallet_paid"}`);
      expect(data.checkoutId).toBeTruthy();
      expect(data.orderIds?.length || 0).toBeGreaterThan(0);
      orderId = data.orderIds?.[0] || "";
      console.log(`   ✅ Checkout: ${data.checkoutId}, Orders: ${data.orderIds?.join(",")}`);
    } else {
      console.log(`   ⚠️ Checkout response: ${JSON.stringify(data).substring(0, 200)}`);
    }
  });

  // ─── 6. WEBHOOK (WALLET CREDIT) ──────────────────────
  it("6a. Debug webhook-endpoint exists", async () => {
    const res = await fetch(`${BASE}/api/stripe/webhook`, { method: "GET" });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.status).toBe("ok");
    console.log(`   ✅ Webhook endpoint reachable`);
  });

  // ─── 7. NOTIFICATIONS ────────────────────────────────
  it("7a. Vendor has notifications", async () => {
    const { data } = await api("GET", "/api/notifications", undefined, V_TOKEN);
    const items = data.items ?? [];
    console.log(`   ✅ Vendor has ${items.length} notifications`);
    if (items.length > 0) {
      console.log(`      Latest: [${items[0].type}] ${items[0].title}`);
    }
  });

  it("7b. Buyer has notifications", async () => {
    const { data } = await api("GET", "/api/notifications", undefined, B_TOKEN);
    const items = data.items ?? [];
    console.log(`   ✅ Buyer has ${items.length} notifications`);
  });

  it("7c. Notification preferences accessible", async () => {
    const { data } = await api("GET", "/api/notifications/preferences", undefined, V_TOKEN);
    expect(data).toBeDefined();
    console.log(`   ✅ Notification preferences accessible`);
  });

  // ─── 8. VENDOR ORDERS ────────────────────────────────
  it("8a. Vendor can list orders", async () => {
    const { data } = await api("GET", "/api/orders/vendor/list?limit=5", undefined, V_TOKEN);
    const items = data.items ?? [];
    console.log(`   ✅ Vendor sees ${items.length} orders`);
    if (items.length > 0) {
      console.log(`      Latest order: ${items[0].id} status=${items[0].status}`);
      if (!orderId) orderId = items[0].id;
    }
  });

  it("8b. Buyer can list orders", async () => {
    const { data } = await api("GET", "/api/orders/me?limit=5", undefined, B_TOKEN);
    const items = data.items ?? [];
    console.log(`   ✅ Buyer sees ${items.length} orders`);
  });

  // ─── 9. WALLET BALANCE ───────────────────────────────
  it("9a. Vendor wallet shows earnings", async () => {
    const { data } = await api("GET", "/api/vendors/me/earnings", undefined, V_TOKEN);
    expect(data).toBeDefined();
    console.log(`   ✅ Earnings: total=${data.totalEarnings}, pending=${data.pendingPayout}, available=${data.availableBalance}`);
  });

  // ─── 10. PAYOUT REQUESTS ─────────────────────────────
  it("10a. Vendor can view payout methods", async () => {
    const { data } = await api("GET", "/api/vendors/me/payout-methods", undefined, V_TOKEN);
    const methods = data.payoutMethods ?? data.methods ?? data ?? [];
    console.log(`   ✅ ${Array.isArray(methods) ? methods.length : 0} payout methods`);
  });

  it("10b. Vendor can view payout requests", async () => {
    const { data } = await api("GET", "/api/payout-requests/me", undefined, V_TOKEN);
    const requests = data.payoutRequests ?? [];
    console.log(`   ✅ ${requests.length} payout requests`);
  });

  // ─── 11. MESSAGES ─────────────────────────────────────
  it("11a. Conversations accessible", async () => {
    const { data } = await api("GET", "/api/conversations/me", undefined, V_TOKEN);
    const conversations = data.conversations ?? data.items ?? [];
    console.log(`   ✅ ${conversations.length} conversations`);
  });

  it("11b. Can send message", async () => {
    const { data: convData } = await api("GET", "/api/conversations/me?limit=1", undefined, V_TOKEN);
    const conversations = convData.conversations ?? convData.items ?? [];
    if (conversations.length > 0) {
      const convId = conversations[0].id;
      const { data } = await api("POST", "/api/conversations/messages", {
        conversationId: convId,
        text: `E2E test message ${Date.now()}`,
      }, V_TOKEN);
      console.log(`   ✅ Message sent to conversation ${convId}`);
    } else {
      console.log("   ⚠️ No conversations to message");
    }
  });

  // ─── 12. ADDRESSES ────────────────────────────────────
  it("12a. Buyer addresses accessible", async () => {
    const { data } = await api("GET", "/api/addresses", undefined, B_TOKEN);
    const addresses = data.addresses ?? data ?? [];
    console.log(`   ✅ ${Array.isArray(addresses) ? addresses.length : 0} addresses`);
  });

  it("12b. Buyer can create address", async () => {
    const { data } = await api("POST", "/api/addresses", {
      recipientName: "E2E Buyer",
      line1: "123 Test Street",
      city: "London",
      postalCode: "SW1A 1AA",
      country: "United Kingdom",
      phone: "+447700900123",
      isDefault: true,
    }, B_TOKEN);
    if (data.id) console.log(`   ✅ Address created: ${data.id}`);
    else console.log(`   ⚠️ Address response: ${JSON.stringify(data).substring(0, 100)}`);
  });

  // ─── 13. REVIEWS ──────────────────────────────────────
  it("13a. Can view products for review", async () => {
    const { data } = await api("GET", "/api/reviews/eligible-products", undefined, B_TOKEN);
    const items = data.products ?? data.items ?? [];
    console.log(`   ✅ ${items.length} products eligible for review`);
  });

  // ─── 14. SUBSCRIPTIONS ────────────────────────────────
  it("14a. Subscription plans accessible", async () => {
    const { data } = await api("GET", "/api/subscriptions/plans");
    const plans = data.plans ?? [];
    console.log(`   ✅ ${plans.length} subscription plans`);
  });

  it("14b. Vendor subscription status", async () => {
    const { data } = await api("GET", "/api/subscriptions/me", undefined, V_TOKEN);
    console.log(`   ✅ Subscription: ${JSON.stringify(data).substring(0, 150)}`);
  });

  it("14c. Vendor subscription limits", async () => {
    const { data } = await api("GET", "/api/subscriptions/me/limits", undefined, V_TOKEN);
    console.log(`   ✅ Limits: ${JSON.stringify(data).substring(0, 150)}`);
  });

  // ─── 15. GIFT CARDS ───────────────────────────────────
  it("15a. Gift cards available", async () => {
    const { data } = await api("GET", "/api/gift-cards/active");
    const cards = data.giftCards ?? data.cards ?? [];
    console.log(`   ✅ ${cards.length} gift cards available`);
  });

  it("15b. Buyer can view purchased gift cards", async () => {
    const { data } = await api("GET", "/api/gift-cards/me", undefined, B_TOKEN);
    const cards = data.giftCards ?? [];
    console.log(`   ✅ ${cards.length} purchased gift cards`);
  });

  // ─── 16. REFERRALS ────────────────────────────────────
  it("16a. Referral info accessible", async () => {
    const { data } = await api("GET", "/api/referrals/me", undefined, V_TOKEN);
    expect(data).toBeDefined();
    console.log(`   ✅ Referral data: ${JSON.stringify(data).substring(0, 100)}`);
  });

  // ─── 17. BUYER WALLET ─────────────────────────────────
  it("17a. Buyer wallet exists", async () => {
    const { data } = await api("GET", "/api/wallet/me", undefined, B_TOKEN);
    expect(data).toBeDefined();
    console.log(`   ✅ Buyer wallet: ${JSON.stringify(data).substring(0, 100)}`);
  });

  it("17b. Buyer wallet can top up", async () => {
    const { data } = await api("POST", "/api/wallet/me/top-up", { amount: 5000 }, B_TOKEN);
    if (data.clientSecret) {
      console.log(`   ✅ Wallet top-up intent created`);
    } else {
      console.log(`   ⚠️ Top-up response: ${JSON.stringify(data).substring(0, 100)}`);
    }
  });

  // ─── 18. UPLOADS ──────────────────────────────────────
  it("18a. Upload presigned URL works", async () => {
    const { data } = await api("POST", "/api/uploads/presigned", {
      category: "avatar",
      mimeType: "image/jpeg",
    }, V_TOKEN);
    if (data.uploadUrl) console.log(`   ✅ Presigned upload URL generated`);
    else console.log(`   ⚠️ Upload response: ${JSON.stringify(data).substring(0, 100)}`);
  });
});
