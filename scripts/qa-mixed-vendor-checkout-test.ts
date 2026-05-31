import { PrismaClient, BuyerWalletTxType } from "@prisma/client";

const prisma = new PrismaClient();
const API_BASE = "https://ekiapp-backend.vercel.app/api";
const BUYER_EMAIL = "seed_qa_buyer002@example.com";
const BUYER_PASSWORD = "SeedQA123!";
const PRODUCT_IDS = ["cmps8eqwa0007ufpkh6otw2l7", "cmps8d2he0018ufwworgc870h"];
const TARGET_WALLET_BALANCE = 50000;
const DELIVERY_COUNTRY = "Nigeria";
const DELIVERY_ADDRESS = "QA Mixed Vendor Checkout Test";

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  return { ok: response.ok, status: response.status, body };
}

async function ensureWalletBalance(buyerId: string) {
  const wallet = await prisma.buyerWallet.findUnique({ where: { buyerId } });
  if (!wallet) throw new Error("Buyer wallet not found");

  if (wallet.balance >= TARGET_WALLET_BALANCE) {
    return { before: wallet.balance, after: wallet.balance, toppedUp: 0, walletId: wallet.id };
  }

  const delta = TARGET_WALLET_BALANCE - wallet.balance;
  const paymentIntentId = `qa_mixed_vendor_topup_${Date.now()}`;

  await prisma.$transaction(async (tx) => {
    await tx.buyerWallet.update({
      where: { id: wallet.id },
      data: { balance: { increment: delta } },
    });

    await tx.buyerWalletTransaction.create({
      data: {
        walletId: wallet.id,
        buyerId,
        type: BuyerWalletTxType.TOP_UP,
        amount: delta,
        currency: wallet.currency,
        description: "QA mixed vendor checkout top-up",
        paymentIntentId,
      },
    });
  });

  const updated = await prisma.buyerWallet.findUniqueOrThrow({ where: { id: wallet.id } });
  return { before: wallet.balance, after: updated.balance, toppedUp: delta, walletId: wallet.id };
}

async function main() {
  const buyer = await prisma.user.findUnique({ where: { email: BUYER_EMAIL } });
  if (!buyer) throw new Error("Buyer user not found");

  const products = await prisma.product.findMany({
    where: { id: { in: PRODUCT_IDS } },
    include: { vendor: true },
  });
  if (products.length !== PRODUCT_IDS.length) throw new Error("Required products not found");

  const distinctVendorIds = [...new Set(products.map((product) => product.vendorId))];
  if (distinctVendorIds.length !== 2) throw new Error("Products are not from two different vendors");

  const walletPrep = await ensureWalletBalance(buyer.id);
  const walletBeforeCheckout = walletPrep.after;

  const loginRes = await api("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: BUYER_EMAIL, password: BUYER_PASSWORD }),
  });
  if (!loginRes.ok || !loginRes.body?.token) {
    throw new Error(`Login failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }
  const token = loginRes.body.token as string;
  const authHeaders = { Authorization: `Bearer ${token}` };

  const clearRes = await api("/cart", { method: "DELETE", headers: authHeaders });
  if (!clearRes.ok) {
    throw new Error(`Clear cart failed: ${clearRes.status} ${JSON.stringify(clearRes.body)}`);
  }

  for (const productId of PRODUCT_IDS) {
    const addRes = await api("/cart/items", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ productId, quantity: 1 }),
    });
    if (!addRes.ok) {
      throw new Error(`Add to cart failed for ${productId}: ${addRes.status} ${JSON.stringify(addRes.body)}`);
    }
  }

  const cartRes = await api("/cart", { method: "GET", headers: authHeaders });
  if (!cartRes.ok || !cartRes.body?.cart?.id) {
    throw new Error(`Get cart failed: ${cartRes.status} ${JSON.stringify(cartRes.body)}`);
  }

  const cart = cartRes.body.cart;
  const cartVendorIds = [...new Set((cart.items ?? []).map((item: any) => item.product?.vendorId))];

  const checkoutRes = await api("/payments/create-intent", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      cartId: cart.id,
      deliveryCountry: DELIVERY_COUNTRY,
      deliveryAddress: DELIVERY_ADDRESS,
      walletAmount: TARGET_WALLET_BALANCE,
    }),
  });
  if (!checkoutRes.ok) {
    throw new Error(`Checkout failed: ${checkoutRes.status} ${JSON.stringify(checkoutRes.body)}`);
  }

  const intent = checkoutRes.body;
  const checkout = await prisma.checkout.findUnique({ where: { id: intent.checkoutId } });

  const orders = await prisma.order.findMany({
    where: { id: { in: intent.orderIds } },
    include: {
      items: true,
      payment: true,
      deliveryZone: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const vendorIds = [...new Set(orders.map((order) => order.vendorId).filter(Boolean))] as string[];
  const vendors = vendorIds.length
    ? await prisma.vendor.findMany({ where: { id: { in: vendorIds } }, select: { id: true, storeName: true } })
    : [];
  const vendorMap = new Map(vendors.map((vendor) => [vendor.id, vendor.storeName]));

  const walletAfterCheckout = await prisma.buyerWallet.findUnique({ where: { buyerId: buyer.id } });
  const cartAfter = await prisma.cart.findUnique({
    where: { buyerId: buyer.id },
    include: { items: true },
  });

  const totalOrderAmount = orders.reduce((sum, order) => sum + order.totalAmount, 0);
  const orderVendorIds = [...new Set(orders.map((order) => order.vendorId))];

  const result = {
    buyer: {
      email: BUYER_EMAIL,
      buyerId: buyer.id,
    },
    products: products.map((product) => ({
      id: product.id,
      title: product.title,
      vendorId: product.vendorId,
      vendorStore: product.vendor.storeName,
      priceInCents: product.priceInCents,
      stock: product.stock,
      currency: product.currency,
    })),
    wallet: {
      beforeTopUp: walletPrep.before,
      toppedUpBy: walletPrep.toppedUp,
      beforeCheckout: walletBeforeCheckout,
      afterCheckout: walletAfterCheckout?.balance ?? null,
      expectedAfterCheckout: walletAfterCheckout ? walletBeforeCheckout - intent.amount : null,
    },
    cartBeforeCheckout: {
      cartId: cart.id,
      itemCount: (cart.items ?? []).length,
      vendorCount: cartVendorIds.length,
      items: (cart.items ?? []).map((item: any) => ({
        id: item.id,
        productId: item.productId,
        quantity: item.quantity,
        vendorId: item.product?.vendorId,
        title: item.product?.title,
        unitAmount: item.product?.priceInCents,
      })),
    },
    checkoutResponse: intent,
    checkoutRecord: checkout,
    orders: orders.map((order) => ({
      id: order.id,
      vendorId: order.vendorId,
      vendorStore: order.vendorId ? vendorMap.get(order.vendorId) ?? null : null,
      status: order.status,
      totalAmount: order.totalAmount,
      subtotalAmount: order.subtotalAmount,
      deliveryFeeAmount: order.deliveryFeeAmount,
      currency: order.currency,
      deliveryZoneId: order.deliveryZoneId,
      deliveryZoneVendorId: order.deliveryZone?.vendorId ?? null,
      payment: order.payment,
      items: order.items.map((item) => ({
        productId: item.productId,
        vendorId: item.vendorId,
        quantity: item.quantity,
        totalAmount: item.totalAmount,
        productTitle: item.productTitle,
      })),
    })),
    checks: {
      twoProductsInCart: (cart.items ?? []).length === 2,
      twoVendorsInCart: cartVendorIds.length === 2,
      walletPaidFlow: intent.clientSecret === "wallet_paid" && intent.paymentIntentId === "",
      twoOrdersCreated: intent.orderIds.length === 2 && orders.length === 2,
      twoVendorsInOrders: orderVendorIds.length === 2,
      orderTotalMatchesCheckoutAmount: totalOrderAmount === intent.amount,
      allOrdersPaid: orders.every((order) => order.status === "PAID"),
      allPaymentsSucceeded: orders.every((order) => order.payment?.status === "SUCCEEDED"),
      allPaymentsWalletProvider: orders.every((order) => order.payment?.provider === "wallet"),
      cartClearedAfterCheckout: (cartAfter?.items?.length ?? 0) === 0,
      walletDeductedExactly: (walletAfterCheckout?.balance ?? null) === walletBeforeCheckout - intent.amount,
      deliveryZoneOwnedByCorrectVendor: orders.every((order) => !order.deliveryZone || order.deliveryZone.vendorId === null || order.deliveryZone.vendorId === order.vendorId),
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
