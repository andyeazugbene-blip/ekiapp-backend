const B = "https://italian-market-place.vercel.app";
const TS = Date.now();

async function api(m: string, p: string, b?: unknown, t?: string) {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (t) h["Authorization"] = `Bearer ${t}`;
  const r = await fetch(`${B}${p}`, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  const d = await r.json().catch(() => null);
  return { s: r.status, d };
}

async function run() {
  console.log("══ VENDOR API TEST ══\n");

  // Register fresh user
  const reg = await api("POST", "/api/auth/register", {
    email: `vendor${TS}@test.com`, password: "VendorPass1!", name: "Test Vendor",
  });
  console.log("✅ Register:", reg.s);
  let t = reg.d?.token;

  // Create vendor
  console.log("\n── CREATE VENDOR ──");
  const cv = await api("POST", "/api/vendors", {
    storeName: `Fresh Foods ${TS}`,
    description: "Quality Italian ingredients",
    country: "Italy",
  }, t);
  console.log(cv.s === 201 ? "✅" : "❌", "POST /vendors:", cv.s, "slug=" + cv.d?.vendor?.storeSlug);
  console.log(cv.d?.token ? "✅" : "❌", "Fresh token returned:", !!cv.d?.token);
  if (cv.d?.token) t = cv.d.token;

  const me = await api("GET", "/api/auth/me", undefined, t);
  console.log(me.d?.user?.role === "VENDOR" ? "✅" : "❌", "Role:", me.d?.user?.role);

  // Profile
  console.log("\n── VENDOR PROFILE ──");
  const vm = await api("GET", "/api/vendors/me", undefined, t);
  console.log(vm.s === 200 ? "✅" : "❌", "GET /vendors/me:", vm.s, vm.d?.vendor?.storeName);

  const vu = await api("PATCH", "/api/vendors/me", { description: "Updated desc", city: "Milan" }, t);
  console.log(vu.s === 200 ? "✅" : "❌", "PATCH /vendors/me:", vu.s, "city=" + vu.d?.vendor?.city);

  // Subscriptions
  console.log("\n── SUBSCRIPTIONS ──");
  const af = await api("POST", "/api/subscriptions/activate", { plan: "free" }, t);
  console.log(af.s === 200 ? "✅" : "❌", "FREE:", af.d?.subscription?.plan, "max=" + af.d?.limits?.maxProducts);

  const ag = await api("POST", "/api/subscriptions/activate", { plan: "growth" }, t);
  console.log(ag.s === 200 ? "✅" : "❌", "GROWTH:", ag.d?.subscription?.plan,
    "flash=" + ag.d?.limits?.flashSales, "analytics=" + ag.d?.limits?.analytics, "max=" + ag.d?.limits?.maxProducts);

  const ap = await api("POST", "/api/subscriptions/activate", { plan: "pro" }, t);
  console.log(ap.s === 200 ? "✅" : "❌", "PRO:", ap.d?.subscription?.plan, "unlimited=" + (ap.d?.limits?.maxProducts === -1));

  const lim = await api("GET", "/api/subscriptions/me/limits", undefined, t);
  console.log(lim.s === 200 ? "✅" : "❌", "Limits:", lim.d?.plan, JSON.stringify(lim.d?.limits));

  // Products (unverified)
  console.log("\n── PRODUCTS ──");
  const p1 = await api("POST", "/api/products", { title: "Test", priceAmount: 1000, stock: 5 }, t);
  console.log(p1.s === 403 ? "✅" : "❌", "Create (unverified):", p1.s, p1.d?.message);

  // Dashboard + earnings
  console.log("\n── DASHBOARD ──");
  const dash = await api("GET", "/api/vendors/me/dashboard", undefined, t);
  console.log(dash.s === 200 ? "✅" : "❌", "Dashboard:", dash.s);

  const earn = await api("GET", "/api/vendors/me/earnings", undefined, t);
  console.log(earn.s === 200 ? "✅" : "❌", "Earnings:", earn.s);

  // Buyers
  console.log("\n── BUYERS ──");
  const buyers = await api("GET", "/api/vendors/me/buyers", undefined, t);
  console.log(buyers.s === 200 ? "✅" : "❌", "Buyers:", buyers.s, "count=" + buyers.d?.items?.length);

  // Payout methods
  console.log("\n── PAYOUTS ──");
  const pm = await api("POST", "/api/vendors/me/payout-methods", {
    type: "BANK_TRANSFER", label: "My Bank",
    details: { iban: "IT60X0542811101000000123456", bank: "UniCredit" },
  }, t);
  console.log(pm.s === 201 ? "✅" : "❌", "Create payout method:", pm.s);

  const pml = await api("GET", "/api/vendors/me/payout-methods", undefined, t);
  console.log(pml.s === 200 ? "✅" : "❌", "List payout methods:", pml.s, "count=" + pml.d?.payoutMethods?.length);

  // Stripe Connect
  console.log("\n── STRIPE CONNECT ──");
  const sc = await api("GET", "/api/vendors/me/stripe-connect/status", undefined, t);
  console.log(sc.s === 200 ? "✅" : "❌", "Connect status:", sc.s);

  // Verification
  console.log("\n── VERIFICATION ──");
  const vr = await api("GET", "/api/vendors/me/verification", undefined, t);
  console.log((vr.s === 200 || vr.s === 404) ? "✅" : "❌", "Verification:", vr.s);

  // Orders
  console.log("\n── ORDERS ──");
  const vo = await api("GET", "/api/vendors/me/orders", undefined, t);
  console.log(vo.s === 200 ? "✅" : "❌", "Orders:", vo.s, "count=" + (vo.d?.items?.length ?? 0));

  // Public store
  console.log("\n── PUBLIC STORE ──");
  const slug = cv.d?.vendor?.storeSlug;
  const ps = await api("GET", `/api/public/stores/${slug}`);
  console.log(ps.s === 200 ? "✅" : "❌", "Public store:", ps.s, ps.d?.store?.storeName);

  const pp = await api("GET", `/api/public/stores/${slug}/products`);
  console.log(pp.s === 200 ? "✅" : "❌", "Public products:", pp.s, "count=" + pp.d?.items?.length);

  const html = await fetch(`${B}/store/${slug}`);
  console.log(html.status === 200 ? "✅" : "❌", "HTML page:", html.status);
  console.log("   shareUrl:", cv.d?.vendor?.shareUrl);

  // OTP
  console.log("\n── OTP ──");
  const otp = await api("POST", "/api/auth/send-otp", {
    contact: `vendor${TS}@test.com`, purpose: "vendor_onboarding_email",
  }, t);
  console.log(otp.s === 200 ? "✅" : "❌", "Send OTP:", otp.s, otp.d?.message);

  // Upload
  console.log("\n── UPLOAD ──");
  const upl = await api("POST", "/api/uploads/request-url", {
    filename: "product.jpg", contentType: "image/jpeg", category: "product",
  }, t);
  console.log((upl.s === 200 || upl.s === 503) ? "✅" : "❌", "Upload URL:", upl.s,
    upl.s === 200 ? "url=" + upl.d?.uploadUrl?.slice(0, 60) + "..." : upl.d?.message);

  console.log("\n══ VENDOR API TEST COMPLETE ══");
}

run().catch(e => console.error("FATAL:", e));
