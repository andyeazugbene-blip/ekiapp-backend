/**
 * E2E Wallet Flow Test — Complete order→payment→wallet→release cycle
 */
const BASE = "https://ekiapp-backend.vercel.app";

async function api(m, p, b, t, o = {}) {
  const h = { "Content-Type": "application/json" };
  if (t) h["Authorization"] = `Bearer ${t}`;
  if (o.dk) h["x-debug-key"] = o.dk;
  const r = await fetch(`${BASE}${p}`, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  const d = await r.json().catch(() => ({}));
  await new Promise(r => setTimeout(r, 1200));
  return { s: r.status, d };
}

async function login(email) {
  const r = await api("POST", "/api/auth/login", { email, password: "Abdou22314" });
  if (!r.d.token) throw new Error(`Login failed for ${email}: ${JSON.stringify(r.d)}`);
  return r.d.token;
}

async function main() {
  console.log("\n══════════════ E2E WALLET FLOW TEST ══════════════\n");

  const VT = await login("vendor@eki.app");
  const BT = await login("buyer@eki.app");

  // Wallet before
  let r = await api("GET", "/api/vendors/me/dashboard", null, VT);
  const P0 = r.d.earnings?.pendingPayout || 0, A0 = r.d.earnings?.availableBalance || 0;
  console.log(`💰 BEFORE: pending=${P0} available=${A0}`);

  // Get vendor slug + currency
  r = await api("GET", "/api/vendors/me", null, VT);
  const v = r.d.vendor || r.d;
  const currency = v.currency?.toLowerCase() || "usd";
  console.log(`🏪 Store: ${v.storeName}, Currency: ${currency}`);

  // Get matching zone
  r = await api("GET", "/api/delivery/zones", null, VT);
  const zones = (r.d.zones || []).filter(z => z.currency?.toLowerCase() === currency);
  if (!zones.length) { console.log(`❌ No zone for ${currency}`); return; }
  const zone = zones[0];
  console.log(`📍 Zone: ${zone.name} (${zone.currency})`);

  // Create product in vendor's currency
  r = await api("POST", "/api/products", {
    title: `E2E Wallet Test ${Date.now()}`,
    priceAmount: 2000,
    stock: 99,
    currency: currency.toUpperCase(),
    weightGrams: 500,
    isActive: true,
  }, VT);
  const PID = r.d.product?.id;
  if (!PID) { console.log(`❌ Product create failed: ${JSON.stringify(r.d).substring(0,200)}`); return; }
  console.log(`📦 Product: ${PID} €20.00 (${currency})`);

  // Add to cart
  await api("POST", "/api/cart/items", { productId: PID, quantity: 1 }, BT);
  console.log(`🛒 Added to cart`);

  r = await api("GET", "/api/cart", null, BT);
  const CID = r.d.id || r.d.cart?.id;
  if (!CID) { console.log(`❌ No cart: ${JSON.stringify(r.d).substring(0,200)}`); return; }
  console.log(`🛒 Cart: ${CID}`);

  // Checkout
  r = await api("POST", "/api/payments/create-intent", {
    cartId: CID,
    destinationZoneId: zone.id,
    deliveryAddress: "123 Test St, London",
    deliveryCountry: zone.country,
  }, BT);
  if (r.s !== 201) { console.log(`❌ Checkout: ${JSON.stringify(r.d).substring(0,300)}`); return; }
  const OID = r.d.orderIds?.[0];
  const PI = r.d.paymentIntentId;
  const AMT = r.d.amount;
  console.log(`\n🧾 Order: ${OID}`);
  console.log(`💳 PI: ${PI || "wallet_paid"}`);
  console.log(`💰 Total: €${(AMT/100).toFixed(2)}`);

  // Trigger wallet credit
  if (PI) {
    console.log(`\n⏳ Simulating Stripe webhook...`);
    await new Promise(r => setTimeout(r, 3000));
    r = await api("POST", "/api/stripe/webhook-test", { orderId: OID }, null, { dk: "eki-debug-2026" });
    console.log(`🔄 Webhook: ${JSON.stringify(r.d).substring(0,200)}`);
  }

  await new Promise(r => setTimeout(r, 1500));
  r = await api("GET", "/api/vendors/me/dashboard", null, VT);
  const P1 = r.d.earnings?.pendingPayout || 0, A1 = r.d.earnings?.availableBalance || 0;
  console.log(`💰 AFTER PAYMENT: pending=${P1} (+${P1-P0}) available=${A1}`);

  // Vendor marks DELIVERED
  console.log(`\n📬 Marking DELIVERED...`);
  r = await api("PATCH", `/api/orders/vendor/${OID}/status`, { status: "DELIVERED" }, VT);
  console.log(`   Status: ${r.d.order?.status}`);

  await new Promise(r => setTimeout(r, 1500));
  r = await api("GET", "/api/vendors/me/dashboard", null, VT);
  const P2 = r.d.earnings?.pendingPayout || 0, A2 = r.d.earnings?.availableBalance || 0;
  console.log(`💰 AFTER DELIVERY: pending=${P2} available=${A2} (+${A2-A1} available)`);

  // Buyer marks COMPLETED
  console.log(`\n✅ Marking COMPLETED...`);
  r = await api("POST", `/api/orders/${OID}/complete`, null, BT);
  console.log(`   Status: ${r.d.order?.status}`);

  await new Promise(r => setTimeout(r, 1500));
  r = await api("GET", "/api/vendors/me/dashboard", null, VT);
  const P3 = r.d.earnings?.pendingPayout || 0, A3 = r.d.earnings?.availableBalance || 0;
  console.log(`💰 FINAL: pending=${P3} available=${A3}`);

  // Notifications
  r = await api("GET", "/api/notifications?limit=3", null, VT);
  const vn = (r.d.items || []).slice(0,3);
  console.log(`\n🔔 Vendor notifs: ${vn.length}`);
  vn.forEach(n => console.log(`   [${n.type}] ${n.title}`));

  r = await api("GET", "/api/notifications?limit=3", null, BT);
  const bn = (r.d.items || []).slice(0,3);
  console.log(`🔔 Buyer notifs: ${bn.length}`);
  bn.forEach(n => console.log(`   [${n.type}] ${n.title}`));

  // Summary
  const gained = (P3 - P0) + (A3 - A0);
  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  Pending: ${P0} → ${P3}  (${P3-P0 > 0 ? "+" : ""}${P3-P0})`);
  console.log(`  Available: ${A0} → ${A3}  (${A3-A0 > 0 ? "+" : ""}${A3-A0})`);
  console.log(`  Gained: €${(gained/100).toFixed(2)}`);
  console.log(`  ${gained > 0 ? "✅ WALLET FLOW WORKS" : "❌ NOTHING MOVED"}`);
  console.log(``);
}

main().catch(console.error);
