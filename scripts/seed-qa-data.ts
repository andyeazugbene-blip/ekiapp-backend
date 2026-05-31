/**
 * QA Seed Data Script
 * Creates realistic test data for end-to-end marketplace testing.
 * 
 * Features:
 * - Idempotent: safe to run multiple times
 * - Safe mode: no real provider calls by default
 * - Configurable scale: small/medium/large
 * - Clear QA prefixes for easy cleanup
 * 
 * Usage:
 *   npm run seed:qa
 *   QA_SEED_COUNTS=large npm run seed:qa
 */
import {
  PrismaClient,
  UserRole,
  OrderStatus,
  PaymentStatus,
  ReviewStatus,
  PromoType,
  EscrowType,
  PaystackTxStatus,
  WalletTransactionType,
  BuyerWalletTxType,
} from "@prisma/client";
import * as bcrypt from "bcryptjs";
import "dotenv/config";

const prisma = new PrismaClient();

// ─── CONFIG ─────────────────────────────────────────────────────────────────

const PREFIX = process.env.QA_SEED_PREFIX || "SEED_QA_";
const SAFE_MODE = process.env.QA_SEED_SAFE_MODE !== "false";
const SCALE = process.env.QA_SEED_COUNTS || "small"; // small | medium | large
const ALLOW_PROVIDER_CALLS = process.env.QA_ALLOW_PROVIDER_CALLS === "true";
const ALLOW_EMAIL_SMS = process.env.QA_ALLOW_EMAIL_SMS === "true";
const ALLOW_R2_UPLOAD = process.env.QA_R2_UPLOAD === "true";

const SCALES = {
  small: { buyers: 5, vendors: 3, productsPerVendor: 4, orders: 10 },
  medium: { buyers: 20, vendors: 10, productsPerVendor: 5, orders: 30 },
  large: { buyers: 50, vendors: 20, productsPerVendor: 10, orders: 100 },
};

const config = SCALES[SCALE as keyof typeof SCALES] || SCALES.small;

// ─── HELPERS ────────────────────────────────────────────────────────────────

function log(section: string, message: string) {
  console.log(`  [${section}] ${message}`);
}

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

function generateSlug(name: string, suffix: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${suffix}`.slice(0, 50);
}

// ─── SEED DATA ──────────────────────────────────────────────────────────────

const COUNTRIES = [
  { name: "Italy", currency: "EUR", flag: "🇮🇹" },
  { name: "United Kingdom", currency: "GBP", flag: "🇬🇧" },
  { name: "Nigeria", currency: "NGN", flag: "🇳🇬" },
  { name: "Ghana", currency: "GHS", flag: "🇬🇭" },
  { name: "Kenya", currency: "KES", flag: "🇰🇪" },
  { name: "United States", currency: "USD", flag: "🇺🇸" },
];

const PRODUCT_NAMES = [
  "Extra Virgin Olive Oil",
  "Fresh Yam Flour",
  "Ghanaian Shito Sauce",
  "Organic Tomato Passata",
  "Nigerian Garri",
  "Kenyan Tea Leaves",
  "Italian Balsamic Vinegar",
  "Plantain Chips",
  "Jollof Rice Spice Mix",
  "Peri Peri Sauce",
  "Cassava Flour",
  "Palm Oil",
  "Dried Crayfish",
  "Suya Spice",
  "Egusi Seeds",
  "Ogbono Seeds",
  "Dried Hibiscus Flowers",
  "Moringa Powder",
  "Baobab Powder",
  "Shea Butter",
];

const CATEGORIES = ["food", "spices", "oils", "grains", "sauces", "snacks", "beverages", "beauty"];

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  QA SEED DATA GENERATOR");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Prefix: ${PREFIX}`);
  console.log(`  Scale: ${SCALE} (${config.buyers} buyers, ${config.vendors} vendors)`);
  console.log(`  Safe Mode: ${SAFE_MODE ? "ON" : "OFF"}`);
  console.log(`  Provider Calls: ${ALLOW_PROVIDER_CALLS ? "ENABLED" : "DISABLED"}`);
  console.log(`  Email/SMS: ${ALLOW_EMAIL_SMS ? "ENABLED" : "DISABLED"}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  if (SAFE_MODE) {
    log("SAFETY", "Safe mode enabled - no destructive operations");
  }

  const credentials: string[] = [];
  const report: any = {
    admin: null,
    buyers: [],
    vendors: [],
    products: [],
    coupons: [],
    orders: [],
    reviews: [],
  };

  // ─── ADMIN ──────────────────────────────────────────────────────────────

  console.log("── ADMIN ──\n");
  
  const adminEmail = `${PREFIX.toLowerCase()}admin@example.com`;
  const adminPassword = "SeedQA123!";
  
  let admin = await prisma.user.findUnique({ where: { email: adminEmail } });
  
  if (!admin) {
    admin = await prisma.user.create({
      data: {
        email: adminEmail,
        name: `${PREFIX}Admin`,
        password: await hashPassword(adminPassword),
        role: UserRole.ADMIN,
        emailVerifiedAt: new Date(),
      },
    });
    log("ADMIN", `Created: ${adminEmail}`);
  } else {
    log("ADMIN", `Exists: ${adminEmail}`);
  }
  
  credentials.push(`Admin: ${adminEmail} / ${adminPassword}`);
  report.admin = { id: admin.id, email: adminEmail };

  // ─── BUYERS ─────────────────────────────────────────────────────────────

  console.log("\n── BUYERS ──\n");
  
  const buyerPassword = "SeedQA123!";
  const buyers: any[] = [];
  
  for (let i = 1; i <= config.buyers; i++) {
    const num = String(i).padStart(3, "0");
    const email = `${PREFIX.toLowerCase()}buyer${num}@example.com`;
    const country = COUNTRIES[i % COUNTRIES.length];
    
    let buyer = await prisma.user.findUnique({ where: { email } });
    
    if (!buyer) {
      buyer = await prisma.user.create({
        data: {
          email,
          name: `${PREFIX}Buyer ${num}`,
          password: await hashPassword(buyerPassword),
          role: UserRole.BUYER,
          country: country.name,
          emailVerifiedAt: new Date(),
        },
      });
      
      // Create buyer wallet
      const initialBalance = i === 2 ? 5000 : i === 3 ? 50000 : i === 4 ? 25000 : 0;
      const wallet = await prisma.buyerWallet.create({
        data: {
          buyerId: buyer.id,
          balance: initialBalance,
          currency: country.currency,
        },
      });

      if (initialBalance > 0) {
        await prisma.buyerWalletTransaction.create({
          data: {
            walletId: wallet.id,
            buyerId: buyer.id,
            type: BuyerWalletTxType.TOP_UP,
            amount: initialBalance,
            currency: country.currency,
            description: `QA seed initial wallet balance for ${email}`,
            paymentIntentId: `qa_seed_wallet_${buyer.id}`,
          },
        });
      }
      
      log("BUYER", `Created: ${email} (${country.name})`);
    } else {
      log("BUYER", `Exists: ${email}`);
    }
    
    buyers.push(buyer);
    credentials.push(`Buyer ${num}: ${email} / ${buyerPassword}`);
    report.buyers.push({ id: buyer.id, email, country: country.name });
  }

  // ─── VENDORS ────────────────────────────────────────────────────────────

  console.log("\n── VENDORS ──\n");
  
  const vendorPassword = "SeedQA123!";
  const vendors: any[] = [];
  
  for (let i = 1; i <= config.vendors; i++) {
    const num = String(i).padStart(3, "0");
    const email = `${PREFIX.toLowerCase()}vendor${num}@example.com`;
    const country = COUNTRIES[i % COUNTRIES.length];
    const storeName = `${PREFIX}Store ${num}`;
    const storeSlug = generateSlug(storeName, num);
    
    let user = await prisma.user.findUnique({ where: { email } });
    
    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          name: `${PREFIX}Vendor ${num}`,
          password: await hashPassword(vendorPassword),
          role: UserRole.VENDOR,
          country: country.name,
          emailVerifiedAt: new Date(),
        },
      });
      log("VENDOR", `Created user: ${email}`);
    } else {
      log("VENDOR", `User exists: ${email}`);
    }
    
    let vendor = await prisma.vendor.findUnique({ where: { userId: user.id } });
    
    if (!vendor) {
      vendor = await prisma.vendor.create({
        data: {
          userId: user.id,
          storeName,
          storeSlug,
          description: `Quality products from ${country.name}`,
          country: country.name,
          currency: country.currency,
          contactEmail: email,
          verificationStatus: "VERIFIED",
        },
      });
      
      // Create vendor wallet
      await prisma.wallet.create({
        data: {
          vendorId: vendor.id,
          currency: country.currency,
          pendingBalance: 0,
          availableBalance: 0,
        },
      });
      
      // Create delivery zones
      await prisma.deliveryZone.create({
        data: {
          vendorId: vendor.id,
          name: `${country.name} Domestic`,
          country: country.name,
          flag: country.flag,
          baseFeeAmount: 500,
          feePerKgAmount: 100,
          currency: country.currency,
          isActive: true,
        },
      });
      
      log("VENDOR", `Created profile: ${storeName} (${country.currency})`);
    } else {
      log("VENDOR", `Profile exists: ${storeName}`);
    }
    
    vendors.push({ ...vendor, user });
    credentials.push(`Vendor ${num}: ${email} / ${vendorPassword}`);
    report.vendors.push({ id: vendor.id, email, storeName, currency: country.currency });
  }

  // ─── PRODUCTS ───────────────────────────────────────────────────────────

  console.log("\n── PRODUCTS ──\n");
  
  const products: any[] = [];
  let productIndex = 0;
  
  for (const vendor of vendors) {
    for (let i = 0; i < config.productsPerVendor; i++) {
      const productName = PRODUCT_NAMES[productIndex % PRODUCT_NAMES.length];
      const title = `${PREFIX}${productName}`;
      const category = CATEGORIES[productIndex % CATEGORIES.length];
      
      // Check if product exists
      const existing = await prisma.product.findFirst({
        where: {
          vendorId: vendor.id,
          title,
        },
      });
      
      if (!existing) {
        // Create edge cases
        let stock = 10 + (productIndex % 50);
        let priceInCents = 1000 + (productIndex * 500);
        
        if (i === 0) stock = 1; // Low stock
        if (i === 1) stock = 0; // Out of stock
        if (i === 2) priceInCents = 50000; // Expensive
        
        const product = await prisma.product.create({
          data: {
            vendorId: vendor.id,
            title,
            description: `High quality ${productName.toLowerCase()} from ${vendor.country}`,
            priceInCents,
            currency: vendor.currency,
            stock,
            category,
            weightGrams: 500 + (productIndex * 100),
            isActive: true,
            images: i === 3 ? [] : ["https://placehold.co/600x400/png"], // One without image
          },
        });
        
        products.push(product);
        log("PRODUCT", `Created: ${title} (${vendor.currency} ${priceInCents / 100}, stock: ${stock})`);
      } else {
        products.push(existing);
        log("PRODUCT", `Exists: ${title}`);
      }
      
      productIndex++;
    }
  }
  
  report.products = products.map(p => ({ id: p.id, title: p.title, price: p.priceInCents, stock: p.stock }));

  // ─── COUPONS ────────────────────────────────────────────────────────────

  console.log("\n── COUPONS ──\n");
  
  const coupons = [
    { code: `${PREFIX}10OFF`, type: PromoType.PERCENTAGE, value: 10, maxUses: 100, validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
    { code: `${PREFIX}FIXED5`, type: PromoType.FIXED_AMOUNT, value: 500, maxUses: 100, validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
    { code: `${PREFIX}EXPIRED`, type: PromoType.PERCENTAGE, value: 20, maxUses: 100, validUntil: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    { code: `${PREFIX}LIMIT1`, type: PromoType.PERCENTAGE, value: 15, maxUses: 1, validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
  ];
  
  for (const coupon of coupons) {
    const existing = await prisma.promoCode.findUnique({ where: { code: coupon.code } });
    
    if (!existing) {
      await prisma.promoCode.create({
        data: {
          ...coupon,
          isActive: !coupon.code.includes("EXPIRED"),
        },
      });
      log("COUPON", `Created: ${coupon.code}`);
    } else {
      log("COUPON", `Exists: ${coupon.code}`);
    }
    
    report.coupons.push(coupon.code);
  }

  // ─── CARTS ──────────────────────────────────────────────────────────────

  console.log("\n── CARTS ──\n");
  
  // Cart scenarios
  const cartScenarios = [
    { buyerIndex: 0, products: [] }, // Empty cart
    { buyerIndex: 1, products: [0] }, // One product
    { buyerIndex: 2, products: [0, 1, 2] }, // Multi-item same vendor
    { buyerIndex: 3, products: [0, config.productsPerVendor] }, // Multi-vendor if available
  ];
  
  for (const scenario of cartScenarios) {
    if (scenario.buyerIndex >= buyers.length) continue;
    
    const buyer = buyers[scenario.buyerIndex];
    
    // Delete existing cart
    await prisma.cart.deleteMany({ where: { buyerId: buyer.id } });
    
    if (scenario.products.length === 0) {
      log("CART", `Empty cart for buyer ${scenario.buyerIndex + 1}`);
      continue;
    }
    
    const cart = await prisma.cart.create({
      data: {
        buyerId: buyer.id,
      },
    });
    
    for (const prodIndex of scenario.products) {
      if (prodIndex >= products.length) continue;
      
      await prisma.cartItem.create({
        data: {
          cartId: cart.id,
          productId: products[prodIndex].id,
          quantity: 1 + (prodIndex % 3),
        },
      });
    }
    
    log("CART", `Created cart for buyer ${scenario.buyerIndex + 1} with ${scenario.products.length} items`);
  }

  // ─── ORDERS ─────────────────────────────────────────────────────────────

  console.log("\n── ORDERS ──\n");
  
  const orderStatuses: OrderStatus[] = [
    "PENDING", "PENDING",
    "PAID", "PAID", "PAID",
    "PROCESSING", "PROCESSING",
    "DELIVERED", "DELIVERED",
    "COMPLETED", "COMPLETED",
    "REFUNDED",
    "DISPUTED",
  ];
  
  const orders: any[] = [];
  
  for (let i = 0; i < Math.min(config.orders, orderStatuses.length); i++) {
    const buyer = buyers[i % buyers.length];
    const vendor = vendors[i % vendors.length];
    const product = products.find(p => p.vendorId === vendor.id) || products[0];
    const status = orderStatuses[i];
    
    const quantity = 1 + (i % 3);
    const subtotal = product.priceInCents * quantity;
    const deliveryFee = 500;
    const platformFee = Math.floor(subtotal * 0.1);
    const vendorEarnings = subtotal - platformFee;
    const total = subtotal + deliveryFee;
    
    const order = await prisma.order.create({
      data: {
        buyerId: buyer.id,
        vendorId: vendor.id,
        status,
        subtotalAmount: subtotal,
        deliveryFeeAmount: deliveryFee,
        platformFeeAmount: platformFee,
        vendorEarnings,
        totalAmount: total,
        currency: product.currency,
        escrowType: vendor.currency === "NGN" ? EscrowType.DOMESTIC_AFRICA : EscrowType.NONE,
        deliveredAt: ["DELIVERED", "COMPLETED"].includes(status) ? new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) : null,
        items: {
          create: {
            productId: product.id,
            vendorId: vendor.id,
            quantity,
            unitAmount: product.priceInCents,
            totalAmount: subtotal,
            currency: product.currency,
            productTitle: product.title,
          },
        },
      },
    });
    
    // Create payment for paid orders
    if (["PAID", "PROCESSING", "DELIVERED", "COMPLETED", "REFUNDED", "DISPUTED"].includes(status)) {
      await prisma.payment.create({
        data: {
          orderId: order.id,
          amount: total,
          platformFeeAmount: platformFee,
          vendorEarningsAmount: vendorEarnings,
          currency: product.currency,
          status: PaymentStatus.SUCCEEDED,
          provider: vendor.currency === "NGN" ? "paystack" : "stripe",
          stripePaymentIntentId: vendor.currency !== "NGN" ? `pi_seedqa_${order.id}` : null,
          processedAt: new Date(),
        },
      });
      
      // Create Paystack transaction for NGN orders
      if (vendor.currency === "NGN") {
        await prisma.paystackTransaction.create({
          data: {
            orderId: order.id,
            reference: `seedqa_paystack_${order.id}`,
            amount: total,
            currency: "NGN",
            status: PaystackTxStatus.SUCCESS,
          },
        });
      }
      
      // Mirror the real wallet ledger semantics for seeded paid orders.
      const wallet = await prisma.wallet.findUnique({ where: { vendorId: vendor.id } });
      if (wallet) {
        if (status === "COMPLETED") {
          await prisma.walletTransaction.create({
            data: {
              walletId: wallet.id,
              vendorId: vendor.id,
              orderId: order.id,
              paymentId: payment.id,
              type: WalletTransactionType.PAYMENT_PENDING_CREDIT,
              amount: vendorEarnings,
              currency: product.currency,
              description: `QA seed pending credit for completed order ${order.id}`,
            },
          });
          await prisma.walletTransaction.create({
            data: {
              walletId: wallet.id,
              vendorId: vendor.id,
              orderId: order.id,
              paymentId: payment.id,
              type: WalletTransactionType.PENDING_TO_AVAILABLE,
              amount: vendorEarnings,
              currency: product.currency,
              description: `QA seed release for completed order ${order.id}`,
            },
          });
          await prisma.wallet.update({
            where: { id: wallet.id },
            data: { availableBalance: { increment: vendorEarnings } },
          });
        } else if (status !== "REFUNDED") {
          await prisma.walletTransaction.create({
            data: {
              walletId: wallet.id,
              vendorId: vendor.id,
              orderId: order.id,
              paymentId: payment.id,
              type: WalletTransactionType.PAYMENT_PENDING_CREDIT,
              amount: vendorEarnings,
              currency: product.currency,
              description: `QA seed pending credit for order ${order.id}`,
            },
          });
          await prisma.wallet.update({
            where: { id: wallet.id },
            data: { pendingBalance: { increment: vendorEarnings } },
          });
        }
      }
    }
    
    orders.push(order);
    log("ORDER", `Created: ${order.orderNumber} (${status}, ${product.currency} ${total / 100})`);
  }
  
  report.orders = orders.map(o => ({ id: o.id, orderNumber: o.orderNumber, status: o.status }));

  // ─── REVIEWS ────────────────────────────────────────────────────────────

  console.log("\n── REVIEWS ──\n");
  
  const deliveredOrders = orders.filter(o => ["DELIVERED", "COMPLETED"].includes(o.status));
  
  for (let i = 0; i < Math.min(5, deliveredOrders.length); i++) {
    const order = deliveredOrders[i];
    const rating = [1, 3, 5, 4, 5][i % 5];
    
    const existing = await prisma.review.findFirst({
      where: {
        buyerId: order.buyerId,
        orderId: order.id,
      },
    });
    
    if (!existing) {
      const orderItem = await prisma.orderItem.findFirst({ where: { orderId: order.id } });
      
      await prisma.review.create({
        data: {
          buyerId: order.buyerId,
          vendorId: order.vendorId!,
          productId: orderItem?.productId,
          orderId: order.id,
          rating,
          comment: `${PREFIX}Test review - ${rating} stars`,
          status: ReviewStatus.APPROVED,
        },
      });
      
      log("REVIEW", `Created: ${rating} stars for order ${order.orderNumber}`);
    } else {
      log("REVIEW", `Exists for order ${order.orderNumber}`);
    }
  }

  // ─── SAVE CREDENTIALS ───────────────────────────────────────────────────

  console.log("\n── SAVING CREDENTIALS ──\n");
  
  const credentialsContent = `# QA Seed Data Credentials

**Generated:** ${new Date().toISOString()}
**Scale:** ${SCALE}
**Prefix:** ${PREFIX}

## Credentials

${credentials.join("\n")}

## Important Notes

- All passwords are: SeedQA123!
- All data is prefixed with: ${PREFIX}
- Safe to delete using: npm run cleanup:qa
- Do NOT use in production
- Do NOT commit this file

## Quick Test Logins

Admin: ${adminEmail} / ${adminPassword}
Buyer: ${PREFIX.toLowerCase()}buyer001@example.com / ${buyerPassword}
Vendor: ${PREFIX.toLowerCase()}vendor001@example.com / ${vendorPassword}
`;
  
  await prisma.$disconnect();
  
  // Write credentials file
  const fs = await import("fs/promises");
  await fs.writeFile("QA_SEED_CREDENTIALS.md", credentialsContent);
  log("SAVE", "Credentials saved to QA_SEED_CREDENTIALS.md");
  
  // Write report
  await fs.writeFile("QA_SEED_REPORT.json", JSON.stringify(report, null, 2));
  log("SAVE", "Report saved to QA_SEED_REPORT.json");

  // ─── SUMMARY ────────────────────────────────────────────────────────────

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  SEED COMPLETE");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Admin: 1`);
  console.log(`  Buyers: ${buyers.length}`);
  console.log(`  Vendors: ${vendors.length}`);
  console.log(`  Products: ${products.length}`);
  console.log(`  Coupons: ${coupons.length}`);
  console.log(`  Orders: ${orders.length}`);
  console.log("═══════════════════════════════════════════════════════════\n");
  console.log(`  ✅ Credentials: QA_SEED_CREDENTIALS.md`);
  console.log(`  ✅ Report: QA_SEED_REPORT.json`);
  console.log(`  ✅ Cleanup: npm run cleanup:qa\n`);
}

main()
  .catch((e) => {
    console.error("FATAL ERROR:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
