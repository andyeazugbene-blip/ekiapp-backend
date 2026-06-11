/**
 * Payout Flow Test
 *
 * Tests:
 * 1. Vendor creates a payout request
 * 2. Admin approves the payout request (triggers email receipt)
 * 3. Admin marks the payout as paid
 *
 * Prerequisites:
 * - A running backend with seeded DB (npm run seed:qa)
 * - A vendor with wallet balance and payout method
 * - An admin user
 *
 * Usage:
 *   VENDOR_TOKEN=<vendor-jwt> ADMIN_TOKEN=<admin-jwt> npx tsx scripts/test-payout-flow.ts
 *
 * Or with a single backend token that has both roles:
 *   TEST_TOKEN=<jwt> npx tsx scripts/test-payout-flow.ts
 */

import crypto from "crypto";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:3000/api";
const VENDOR_TOKEN = process.env.VENDOR_TOKEN ?? process.env.TEST_TOKEN ?? "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? process.env.TEST_TOKEN ?? "";

interface PayoutMethod {
  id: string;
  type: string;
  details: string;
}

interface PayoutRequest {
  id: string;
  vendorId: string;
  amount: number;
  currency: string;
  status: string;
  netAmount: number;
  withdrawalFeeAmount: number;
  notes?: string | null;
}

interface ApiResponse<T> {
  data?: T;
  payoutRequest?: T;
  payoutRequests?: T[];
  payoutMethod?: PayoutMethod;
  payoutMethods?: PayoutMethod[];
  error?: string;
  message?: string;
}

async function api<T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  token: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${json.message ?? JSON.stringify(json)}`);
  }
  return json;
}

function print(label: string, data: unknown): void {
  console.log(`\n  ✅ ${label}:`, JSON.stringify(data, null, 2));
}

async function main(): Promise<void> {
  console.log("\n═══════════════════════════════════════════");
  console.log("  Payout Flow Test");
  console.log("═══════════════════════════════════════════\n");

  if (!VENDOR_TOKEN || !ADMIN_TOKEN) {
    console.error("❌ VENDOR_TOKEN and ADMIN_TOKEN (or TEST_TOKEN) are required");
    console.error("   VENDOR_TOKEN=<vendor-jwt> ADMIN_TOKEN=<admin-jwt> npx tsx scripts/test-payout-flow.ts");
    process.exit(1);
  }

  // ─── Step 1: List vendor payout methods ───────────────────────────────
  console.log("📋 Step 1: List vendor payout methods");
  const methodsRes = await api<PayoutMethod[]>("GET", "/vendors/me/payout-methods", VENDOR_TOKEN);
  const methods = methodsRes.payoutMethods ?? methodsRes.data ?? [];
  if (methods.length === 0) {
    console.log("  ⚠️ No payout methods found. Creating a test bank method...");
    const created = await api<PayoutMethod>("POST", "/vendors/me/payout-methods", VENDOR_TOKEN, {
      type: "bank_transfer",
      bankName: "Test Bank",
      accountNumber: `00${crypto.randomInt(10000000, 99999999)}`,
      accountName: "Test Vendor",
      country: "GB",
      currency: "GBP",
    });
    const method = created.payoutMethod ?? created.data;
    if (!method?.id) {
      console.error("❌ Could not create payout method");
      process.exit(1);
    }
    print("Created payout method", { id: method.id, type: method.type });
    methods.push(method);
  }

  const payoutMethodId = methods[0].id;
  print("Using payout method", { id: payoutMethodId, type: methods[0].type });

  // ─── Step 2: Create payout request ────────────────────────────────────
  console.log("\n📋 Step 2: Create payout request");
  const payoutAmount = 5000; // £50.00 in cents
  const createdRes = await api<PayoutRequest>("POST", "/vendors/me/payout-requests", VENDOR_TOKEN, {
    payoutMethodId,
    amount: payoutAmount,
    notes: "Test payout for flow verification",
  });

  const createdPayout = createdRes.payoutRequest;
  if (!createdPayout?.id) {
    console.error("❌ Failed to create payout request", createdRes);
    process.exit(1);
  }
  print("Created payout request", {
    id: createdPayout.id,
    amount: createdPayout.amount,
    netAmount: createdPayout.netAmount,
    feeAmount: createdPayout.withdrawalFeeAmount,
    currency: createdPayout.currency,
    status: createdPayout.status,
  });

  if (createdPayout.status !== "PENDING") {
    console.error(`❌ Expected PENDING status, got ${createdPayout.status}`);
    process.exit(1);
  }
  console.log("  ✅ Status is PENDING as expected");

  // ─── Step 3: Admin approves payout ─────────────────────────────────────
  console.log("\n📋 Step 3: Admin approves payout request");
  const approveRes = await api<PayoutRequest>(
    "PATCH",
    `/admin/payout-requests/${createdPayout.id}/approve`,
    ADMIN_TOKEN,
  );

  const approvedPayout = approveRes.payoutRequest;
  if (!approvedPayout?.id) {
    console.error("❌ Failed to approve payout request", approveRes);
    process.exit(1);
  }
  print("Approved payout", {
    id: approvedPayout.id,
    status: approvedPayout.status,
  });

  if (approvedPayout.status !== "APPROVED") {
    console.error(`❌ Expected APPROVED status, got ${approvedPayout.status}`);
    process.exit(1);
  }
  console.log("  ✅ Status is APPROVED as expected");
  console.log("  📧 Email receipt should be sent to vendor (check logs for 'enqueue email')");

  // ─── Step 4: Admin marks payout as paid ──────────────────────────────
  console.log("\n📋 Step 4: Admin marks payout as paid");
  const paidRes = await api<PayoutRequest>(
    "PATCH",
    `/admin/payout-requests/${createdPayout.id}/mark-paid`,
    ADMIN_TOKEN,
  );

  const paidPayout = paidRes.payoutRequest;
  if (!paidPayout?.id) {
    console.error("❌ Failed to mark payout as paid", paidRes);
    process.exit(1);
  }
  print("Paid payout", {
    id: paidPayout.id,
    status: paidPayout.status,
  });

  if (paidPayout.status !== "PAID") {
    console.error(`❌ Expected PAID status, got ${paidPayout.status}`);
    process.exit(1);
  }
  console.log("  ✅ Status is PAID as expected");

  // ─── Step 5: Verify by listing vendor's own payout requests ──────────
  console.log("\n📋 Step 5: Verify from vendor's perspective");
  const listRes = await api<PayoutRequest[]>("GET", "/vendors/me/payout-requests", VENDOR_TOKEN);
  const requests = listRes.payoutRequests ?? listRes.data ?? [];

  const found = requests.find((r: PayoutRequest) => r.id === createdPayout.id);
  if (!found) {
    console.error("❌ Payout request not found in vendor's list");
    process.exit(1);
  }
  print("Vendor sees payout as", {
    status: found.status,
    amount: found.amount,
  });

  // ─── Summary ────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════");
  console.log("  ✅ Payout Flow Test PASSED");
  console.log("═══════════════════════════════════════════\n");
  console.log("  Flow: PENDING → APPROVED (email sent) → PAID");
  console.log("  Payout ID:", createdPayout.id);
  console.log("  Amount:", `${(createdPayout.amount / 100).toFixed(2)} ${createdPayout.currency}`);
  console.log("  Net amount:", `${(createdPayout.netAmount / 100).toFixed(2)} ${createdPayout.currency}`);
  console.log("  Fee:", `${(createdPayout.withdrawalFeeAmount / 100).toFixed(2)} ${createdPayout.currency}`);
  console.log(`\n  Pull the email logs to confirm the receipt was sent.`);
  console.log("\n═══════════════════════════════════════════\n");
}

main().catch((error) => {
  console.error("\n❌ Payout Flow Test FAILED:", error.message);
  process.exit(1);
});
