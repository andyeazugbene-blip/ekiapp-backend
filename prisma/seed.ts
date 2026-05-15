import { PrismaClient, UserRole } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const defaultPassword = await bcrypt.hash("password123", 10);

  const buyer = await prisma.user.upsert({
    where: { email: "buyer@example.com" },
    update: { name: "Sample Buyer" },
    create: {
      email: "buyer@example.com",
      name: "Sample Buyer",
      password: defaultPassword,
      role: UserRole.BUYER,
    },
  });

  const vendorOwner = await prisma.user.upsert({
    where: { email: "vendor@example.com" },
    update: { name: "Sample Vendor Owner" },
    create: {
      email: "vendor@example.com",
      name: "Sample Vendor Owner",
      password: defaultPassword,
      role: UserRole.VENDOR,
    },
  });

  const vendor = await prisma.vendor.upsert({
    where: { userId: vendorOwner.id },
    update: { storeName: "Sample Store" },
    create: {
      userId: vendorOwner.id,
      storeName: "Sample Store",
      storeSlug: "sample-store",
    },
  });

  await prisma.wallet.upsert({
    where: { vendorId: vendor.id },
    update: {},
    create: {
      vendorId: vendor.id,
      currency: "usd",
    },
  });

  const product = await prisma.product.upsert({
    where: {
      vendorId_title: {
        vendorId: vendor.id,
        title: "Sample Marketplace Product",
      },
    },
    update: {
      description: "Seeded product for payment flow testing.",
      priceInCents: 4999,
      currency: "usd",
      isActive: true,
    },
    create: {
      vendorId: vendor.id,
      title: "Sample Marketplace Product",
      description: "Seeded product for payment flow testing.",
      priceInCents: 4999,
      currency: "usd",
      isActive: true,
    },
  });

  console.log("Seed complete");
  console.log({
    buyerId: buyer.id,
    vendorId: vendor.id,
    productId: product.id,
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
