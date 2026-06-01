import { PrismaClient, UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";
import { DEFAULT_PLAN_CONFIGS } from "../src/modules/subscriptions/subscriptions.types";

const prisma = new PrismaClient();

async function main() {
  const defaultPassword = await bcrypt.hash("password123", 10);

  // ─── Cleanup QA artifacts ──────────────────────────────────────────────
  await prisma.product.updateMany({
    where: { title: { startsWith: "QA " } },
    data: { isActive: false },
  });
  await prisma.product.updateMany({
    where: { title: { startsWith: "Test " } },
    data: { isActive: false },
  });

  // ─── Buyer ─────────────────────────────────────────────────────────────
  const buyer = await prisma.user.upsert({
    where: { email: "buyer@example.com" },
    update: { name: "Demo Buyer" },
    create: {
      email: "buyer@example.com",
      name: "Demo Buyer",
      password: defaultPassword,
      role: UserRole.BUYER,
      country: "Italy",
    },
  });

  // ─── Vendor Owner (VERIFIED) ───────────────────────────────────────────
  const vendorOwner = await prisma.user.upsert({
    where: { email: "vendor@example.com" },
    update: { name: "Mama Chi", role: UserRole.VENDOR },
    create: {
      email: "vendor@example.com",
      name: "Mama Chi",
      password: defaultPassword,
      role: UserRole.VENDOR,
    },
  });

  const vendor = await prisma.vendor.upsert({
    where: { userId: vendorOwner.id },
    update: {
      storeName: "Mama Chi Foodstuff",
      storeSlug: "mama-chi-foodstuff",
      description: "Authentic Italian & African foodstuff — pasta, spices, sauces, and more.",
      country: "Italy",
      city: "Rome",
      verificationStatus: "VERIFIED",
    },
    create: {
      userId: vendorOwner.id,
      storeName: "Mama Chi Foodstuff",
      storeSlug: "mama-chi-foodstuff",
      description: "Authentic Italian & African foodstuff — pasta, spices, sauces, and more.",
      country: "Italy",
      city: "Rome",
      verificationStatus: "VERIFIED",
    },
  });

  // Vendor wallet
  await prisma.wallet.upsert({
    where: { vendorId: vendor.id },
    update: {},
    create: { vendorId: vendor.id, currency: "usd" },
  });

  // Vendor subscription (FREE plan active)
  await prisma.vendorSubscription.upsert({
    where: { vendorId: vendor.id },
    update: { plan: "FREE", status: "ACTIVE" },
    create: { vendorId: vendor.id, plan: "FREE", status: "ACTIVE" },
  });

  await Promise.all(
    Object.values(DEFAULT_PLAN_CONFIGS).map((plan) =>
      prisma.subscriptionPlanConfig.upsert({
        where: { plan: plan.plan },
        update: plan,
        create: plan,
      }),
    ),
  );

  // ─── Delivery Zones ────────────────────────────────────────────────────
  const italyZone = await prisma.deliveryZone.upsert({
    where: { id: "seed-zone-italy" },
    update: {
      name: "Italy",
      country: "Italy",
      baseFeeAmount: 500,
      feePerKgAmount: 200,
      currency: "usd",
      isActive: true,
    },
    create: {
      id: "seed-zone-italy",
      name: "Italy",
      country: "Italy",
      baseFeeAmount: 500,
      feePerKgAmount: 200,
      currency: "usd",
      isActive: true,
    },
  });

  await prisma.deliveryZone.upsert({
    where: { id: "seed-zone-us" },
    update: {
      name: "United States",
      country: "United States",
      baseFeeAmount: 1500,
      feePerKgAmount: 500,
      currency: "usd",
      isActive: true,
    },
    create: {
      id: "seed-zone-us",
      name: "United States",
      country: "United States",
      baseFeeAmount: 1500,
      feePerKgAmount: 500,
      currency: "usd",
      isActive: true,
    },
  });

  // ─── Products ──────────────────────────────────────────────────────────
  const product1 = await prisma.product.upsert({
    where: { vendorId_title: { vendorId: vendor.id, title: "Spaghetti di Gragnano" } },
    update: { priceInCents: 1299, stock: 50, isActive: true },
    create: {
      vendorId: vendor.id,
      title: "Spaghetti di Gragnano",
      description: "Premium Italian dried pasta, 500g. PGI certified from Gragnano, Naples.",
      priceInCents: 1299,
      currency: "usd",
      stock: 50,
      weightGrams: 550,
      category: "pasta",
      isActive: true,
      images: ["https://images.unsplash.com/photo-1551462147-ff29053bfc14?w=600"],
    },
  });

  const product2 = await prisma.product.upsert({
    where: { vendorId_title: { vendorId: vendor.id, title: "Sugo al Basilico" } },
    update: { priceInCents: 899, stock: 30, isActive: true },
    create: {
      vendorId: vendor.id,
      title: "Sugo al Basilico",
      description: "Homemade tomato and basil sauce, 350ml jar. No preservatives.",
      priceInCents: 899,
      currency: "usd",
      stock: 30,
      weightGrams: 400,
      category: "sauces",
      isActive: true,
      images: ["https://images.unsplash.com/photo-1472476443507-c7a5948772fc?w=600"],
    },
  });

  const product3 = await prisma.product.upsert({
    where: { vendorId_title: { vendorId: vendor.id, title: "Olio Extra Vergine di Oliva" } },
    update: { priceInCents: 2499, stock: 20, isActive: true },
    create: {
      vendorId: vendor.id,
      title: "Olio Extra Vergine di Oliva",
      description: "Cold-pressed extra virgin olive oil, 750ml. From Puglia, Italy.",
      priceInCents: 2499,
      currency: "usd",
      stock: 20,
      weightGrams: 850,
      category: "oils",
      isActive: true,
      images: ["https://images.unsplash.com/photo-1474979266404-7f28db32e8c9?w=600"],
    },
  });

  // ─── Admin ─────────────────────────────────────────────────────────────
  const adminPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD ?? "AdminDemo123!", 10);
  await prisma.user.upsert({
    where: { email: process.env.ADMIN_EMAIL ?? "admin@ekiapp.com" },
    update: { role: UserRole.ADMIN, password: adminPassword },
    create: {
      email: process.env.ADMIN_EMAIL ?? "admin@ekiapp.com",
      name: process.env.ADMIN_NAME ?? "Admin",
      password: adminPassword,
      role: UserRole.ADMIN,
    },
  });

  console.log("✅ Seed complete");
  console.log({
    buyer: { id: buyer.id, email: buyer.email },
    vendor: { id: vendor.id, slug: vendor.storeSlug },
    products: [product1.id, product2.id, product3.id],
    deliveryZones: [italyZone.id, "seed-zone-us"],
    admin: process.env.ADMIN_EMAIL ?? "admin@ekiapp.com",
  });
}

main()
  .catch((error) => {
    console.error("Seed failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
