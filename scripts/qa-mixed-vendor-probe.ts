import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const buyer = await prisma.user.findUnique({
    where: { email: "seed_qa_buyer002@example.com" },
  });

  const wallet = buyer
    ? await prisma.buyerWallet.findUnique({ where: { buyerId: buyer.id } })
    : null;

  const products = await prisma.product.findMany({
    where: {
      id: { in: ["cmps8eqwa0007ufpkh6otw2l7", "cmps8d2he0018ufwworgc870h"] },
    },
    include: { vendor: true },
  });

  const zones = await prisma.deliveryZone.findMany({
    where: { country: "Nigeria", isActive: true },
    select: { id: true, name: true, country: true, currency: true, vendorId: true },
  });

  console.log(JSON.stringify({
    buyer: buyer ? {
      id: buyer.id,
      email: buyer.email,
      role: buyer.role,
      wallet,
    } : null,
    products: products.map((product) => ({
      id: product.id,
      title: product.title,
      priceInCents: product.priceInCents,
      currency: product.currency,
      stock: product.stock,
      vendorId: product.vendorId,
      vendorStore: product.vendor.storeName,
    })),
    zones,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
