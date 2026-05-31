/**
 * OTP Scenarios Seed Script
 * Creates test OTP scenarios without sending real SMS/email.
 * 
 * Scenarios:
 * 1. Valid OTP
 * 2. Expired OTP
 * 3. Wrong OTP attempts
 * 4. Max attempts reached
 * 5. Already used OTP
 * 6. Resend cooldown
 * 
 * Usage:
 *   npm run seed:otp
 */
import { PrismaClient } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import "dotenv/config";

const prisma = new PrismaClient();

// ─── CONFIG ─────────────────────────────────────────────────────────────────

const PREFIX = process.env.QA_SEED_PREFIX || "SEED_QA_";
const ALLOW_EMAIL_SMS = process.env.QA_ALLOW_EMAIL_SMS === "true";

// ─── HELPERS ────────────────────────────────────────────────────────────────

function log(section: string, message: string) {
  console.log(`  [${section}] ${message}`);
}

async function hashOtp(otp: string): Promise<string> {
  return bcrypt.hash(otp, 10);
}

function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  OTP SCENARIOS SEED");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Prefix: ${PREFIX}`);
  console.log(`  Email/SMS: ${ALLOW_EMAIL_SMS ? "ENABLED" : "DISABLED"}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  if (!ALLOW_EMAIL_SMS) {
    log("INFO", "SMS/Email disabled - OTPs will be created but not sent");
  }

  const scenarios: any[] = [];

  // ─── SCENARIO 1: VALID OTP ──────────────────────────────────────────────

  console.log("── SCENARIO 1: VALID OTP ──\n");

  const email1 = `${PREFIX.toLowerCase()}otp001@example.com`;
  const otp1 = generateOtp();
  const hash1 = await hashOtp(otp1);

  await prisma.emailOtp.create({
    data: {
      email: email1,
      codeHash: hash1,
      purpose: "vendor_onboarding_email",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
      attempts: 0,
    },
  });

  scenarios.push({
    scenario: "VALID_OTP",
    email: email1,
    otp: otp1,
    description: "Valid OTP, not expired, no attempts",
  });

  log("SCENARIO 1", `Email: ${email1}, OTP: ${otp1}`);

  // ─── SCENARIO 2: EXPIRED OTP ────────────────────────────────────────────

  console.log("\n── SCENARIO 2: EXPIRED OTP ──\n");

  const email2 = `${PREFIX.toLowerCase()}otp002@example.com`;
  const otp2 = generateOtp();
  const hash2 = await hashOtp(otp2);

  await prisma.emailOtp.create({
    data: {
      email: email2,
      codeHash: hash2,
      purpose: "vendor_onboarding_email",
      expiresAt: new Date(Date.now() - 60 * 1000), // Expired 1 minute ago
      attempts: 0,
    },
  });

  scenarios.push({
    scenario: "EXPIRED_OTP",
    email: email2,
    otp: otp2,
    description: "OTP expired 1 minute ago",
  });

  log("SCENARIO 2", `Email: ${email2}, OTP: ${otp2} (EXPIRED)`);

  // ─── SCENARIO 3: WRONG OTP ATTEMPTS ─────────────────────────────────────

  console.log("\n── SCENARIO 3: WRONG OTP ATTEMPTS ──\n");

  const email3 = `${PREFIX.toLowerCase()}otp003@example.com`;
  const otp3 = generateOtp();
  const hash3 = await hashOtp(otp3);

  await prisma.emailOtp.create({
    data: {
      email: email3,
      codeHash: hash3,
      purpose: "vendor_onboarding_email",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      attempts: 2, // 2 wrong attempts already
    },
  });

  scenarios.push({
    scenario: "WRONG_ATTEMPTS",
    email: email3,
    otp: otp3,
    description: "2 wrong attempts already made",
  });

  log("SCENARIO 3", `Email: ${email3}, OTP: ${otp3}, Attempts: 2`);

  // ─── SCENARIO 4: MAX ATTEMPTS REACHED ───────────────────────────────────

  console.log("\n── SCENARIO 4: MAX ATTEMPTS REACHED ──\n");

  const email4 = `${PREFIX.toLowerCase()}otp004@example.com`;
  const otp4 = generateOtp();
  const hash4 = await hashOtp(otp4);

  await prisma.emailOtp.create({
    data: {
      email: email4,
      codeHash: hash4,
      purpose: "vendor_onboarding_email",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      attempts: 5, // Max attempts (assuming limit is 5)
    },
  });

  scenarios.push({
    scenario: "MAX_ATTEMPTS",
    email: email4,
    otp: otp4,
    description: "Max attempts reached, should be locked",
  });

  log("SCENARIO 4", `Email: ${email4}, OTP: ${otp4}, Attempts: 5 (LOCKED)`);

  // ─── SCENARIO 5: ALREADY USED OTP ───────────────────────────────────────

  console.log("\n── SCENARIO 5: ALREADY USED OTP ──\n");

  const email5 = `${PREFIX.toLowerCase()}otp005@example.com`;
  const otp5 = generateOtp();
  const hash5 = await hashOtp(otp5);

  await prisma.emailOtp.create({
    data: {
      email: email5,
      codeHash: hash5,
      purpose: "vendor_onboarding_email",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      attempts: 1,
      consumedAt: new Date(), // Already consumed
    },
  });

  scenarios.push({
    scenario: "ALREADY_USED",
    email: email5,
    otp: otp5,
    description: "OTP already consumed",
  });

  log("SCENARIO 5", `Email: ${email5}, OTP: ${otp5} (USED)`);

  // ─── SCENARIO 6: RESEND COOLDOWN ────────────────────────────────────────

  console.log("\n── SCENARIO 6: RESEND COOLDOWN ──\n");

  const email6 = `${PREFIX.toLowerCase()}otp006@example.com`;
  const otp6a = generateOtp();
  const hash6a = await hashOtp(otp6a);

  // First OTP created 30 seconds ago
  await prisma.emailOtp.create({
    data: {
      email: email6,
      codeHash: hash6a,
      purpose: "vendor_onboarding_email",
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      attempts: 0,
      createdAt: new Date(Date.now() - 30 * 1000),
    },
  });

  scenarios.push({
    scenario: "RESEND_COOLDOWN",
    email: email6,
    otp: otp6a,
    description: "Recent OTP exists, resend should be blocked (cooldown)",
  });

  log("SCENARIO 6", `Email: ${email6}, OTP: ${otp6a} (COOLDOWN)`);

  // ─── DELIVERY OTP SCENARIOS ─────────────────────────────────────────────

  console.log("\n── DELIVERY OTP SCENARIOS ──\n");

  // Create a test order for delivery OTP
  const buyerEmail = `${PREFIX.toLowerCase()}otp_buyer@example.com`;
  let buyer = await prisma.user.findUnique({ where: { email: buyerEmail } });

  if (!buyer) {
    buyer = await prisma.user.create({
      data: {
        email: buyerEmail,
        name: `${PREFIX}OTP Buyer`,
        password: await bcrypt.hash("SeedQA123!", 10),
        role: "BUYER",
        emailVerifiedAt: new Date(),
      },
    });
  }

  const vendorEmail = `${PREFIX.toLowerCase()}otp_vendor@example.com`;
  let vendorUser = await prisma.user.findUnique({ where: { email: vendorEmail } });

  if (!vendorUser) {
    vendorUser = await prisma.user.create({
      data: {
        email: vendorEmail,
        name: `${PREFIX}OTP Vendor`,
        password: await bcrypt.hash("SeedQA123!", 10),
        role: "VENDOR",
        emailVerifiedAt: new Date(),
      },
    });
  }

  let vendor = await prisma.vendor.findUnique({ where: { userId: vendorUser.id } });

  if (!vendor) {
    vendor = await prisma.vendor.create({
      data: {
        userId: vendorUser.id,
        storeName: `${PREFIX}OTP Store`,
        storeSlug: `${PREFIX.toLowerCase()}otp-store-${Date.now()}`,
        currency: "EUR",
        verificationStatus: "VERIFIED",
      },
    });
  }

  let product = await prisma.product.findFirst({
    where: {
      vendorId: vendor.id,
      title: `${PREFIX}OTP Test Product`,
    },
  });

  if (!product) {
    product = await prisma.product.create({
      data: {
        vendorId: vendor.id,
        title: `${PREFIX}OTP Test Product`,
        priceInCents: 1000,
        currency: "EUR",
        stock: 10,
        isActive: true,
      },
    });
  }

  const order = await prisma.order.create({
    data: {
      buyerId: buyer.id,
      vendorId: vendor.id,
      status: "DISPATCHED",
      subtotalAmount: 1000,
      deliveryFeeAmount: 500,
      platformFeeAmount: 100,
      vendorEarnings: 900,
      totalAmount: 1500,
      currency: "EUR",
      items: {
        create: {
          productId: product.id,
          vendorId: vendor.id,
          quantity: 1,
          unitAmount: 1000,
          totalAmount: 1000,
          currency: "EUR",
          productTitle: product.title,
        },
      },
    },
  });

  const deliveryOtp = generateOtp();
  const deliveryHash = await hashOtp(deliveryOtp);

  await prisma.deliveryOtp.create({
    data: {
      orderId: order.id,
      codeHash: deliveryHash,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
      attempts: 0,
    },
  });

  scenarios.push({
    scenario: "DELIVERY_OTP_VALID",
    orderId: order.id,
    orderNumber: order.orderNumber,
    otp: deliveryOtp,
    description: "Valid delivery OTP for order confirmation",
  });

  log("DELIVERY OTP", `Order: ${order.orderNumber}, OTP: ${deliveryOtp}`);

  // ─── SAVE REPORT ────────────────────────────────────────────────────────

  console.log("\n── SAVING REPORT ──\n");

  const report = {
    timestamp: new Date().toISOString(),
    allowEmailSms: ALLOW_EMAIL_SMS,
    scenarios,
  };

  const fs = await import("fs/promises");
  await fs.writeFile("OTP_SEED_REPORT.md", `# OTP Scenarios Report

**Generated:** ${new Date().toISOString()}
**Email/SMS Sending:** ${ALLOW_EMAIL_SMS ? "ENABLED" : "DISABLED"}

## Email OTP Scenarios

${scenarios.filter(s => !s.orderId).map((s, i) => `### ${i + 1}. ${s.scenario}
- **Email:** ${s.email}
- **OTP:** ${s.otp}
- **Description:** ${s.description}
`).join("\n")}

## Delivery OTP Scenarios

${scenarios.filter(s => s.orderId).map((s, i) => `### ${i + 1}. ${s.scenario}
- **Order:** ${s.orderNumber}
- **OTP:** ${s.otp}
- **Description:** ${s.description}
`).join("\n")}

## Testing

### Email OTP Verification
\`\`\`bash
# Verify valid OTP
POST /api/auth/verify-email-otp
{
  "email": "${scenarios[0].email}",
  "code": "${scenarios[0].otp}"
}

# Try expired OTP (should fail)
POST /api/auth/verify-email-otp
{
  "email": "${scenarios[1].email}",
  "code": "${scenarios[1].otp}"
}

# Try wrong OTP (should increment attempts)
POST /api/auth/verify-email-otp
{
  "email": "${scenarios[0].email}",
  "code": "000000"
}

# Try max attempts (should be locked)
POST /api/auth/verify-email-otp
{
  "email": "${scenarios[3].email}",
  "code": "${scenarios[3].otp}"
}

# Try already used OTP (should fail)
POST /api/auth/verify-email-otp
{
  "email": "${scenarios[4].email}",
  "code": "${scenarios[4].otp}"
}
\`\`\`

### Delivery OTP Verification
\`\`\`bash
# Confirm delivery with OTP
POST /api/orders/${scenarios.find(s => s.orderId)?.orderId}/confirm-delivery
{
  "otp": "${scenarios.find(s => s.orderId)?.otp}"
}
\`\`\`

### Expected Behaviors
1. **VALID_OTP**: Should verify successfully
2. **EXPIRED_OTP**: Should return "OTP expired" error
3. **WRONG_ATTEMPTS**: Should allow verification but track attempts
4. **MAX_ATTEMPTS**: Should return "Too many attempts" error
5. **ALREADY_USED**: Should return "OTP already used" error
6. **RESEND_COOLDOWN**: Resend should be blocked for ~60 seconds
7. **DELIVERY_OTP_VALID**: Should confirm delivery and update order status

### Security Checks
- OTP codes should never be exposed in API responses
- Failed attempts should be rate-limited
- Expired OTPs should be rejected
- Used OTPs should not be reusable
- Resend should have cooldown period

## Cleanup
\`\`\`bash
npm run cleanup:qa
\`\`\`
`);

  log("SAVE", "Report saved to OTP_SEED_REPORT.md");

  // Also save JSON for programmatic access
  await fs.writeFile("OTP_SEED_REPORT.json", JSON.stringify(report, null, 2));
  log("SAVE", "JSON report saved to OTP_SEED_REPORT.json");

  // ─── SUMMARY ────────────────────────────────────────────────────────────

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  OTP SCENARIOS COMPLETE");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Scenarios created: ${scenarios.length}`);
  console.log(`  Email OTPs: ${scenarios.filter(s => !s.orderId).length}`);
  console.log(`  Delivery OTPs: ${scenarios.filter(s => s.orderId).length}`);
  console.log("═══════════════════════════════════════════════════════════\n");
  console.log(`  ✅ Report: OTP_SEED_REPORT.md`);
  console.log(`  ✅ JSON: OTP_SEED_REPORT.json`);
  console.log(`  ✅ Cleanup: npm run cleanup:qa\n`);

  if (!ALLOW_EMAIL_SMS) {
    console.log("  ℹ️  Note: SMS/Email sending is disabled");
    console.log("  ℹ️  OTPs are created in DB but not sent");
    console.log("  ℹ️  Use OTP codes from report for testing\n");
  }
}

main()
  .catch((e) => {
    console.error("FATAL ERROR:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
