import { PrismaClient, BuyerWalletTxType } from "@prisma/client";

const prisma = new PrismaClient();
const API_BASE = "https://ekiapp-backend.vercel.app/api";
const BUYER_EMAIL = "seed_qa_buyer002@example.com";
const BUYER_PASSWORD = "SeedQA123!";
const PRODUCT_IDS = ["cmps8eqwa0007ufpkh6otw2l7", "cmps8d2he0018ufwworgc870h"];
const TARGET_WALLET_BALANCE = 50000;
const DELIVERY_COUNTRY = "Nigeria";
const DELIVERY_ADDRESS = "QA Mixed Vendor Frontend Flow Test";

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
  const paymentIntentId = `qa_mixed_vendor_frontend_topup_${Date.now()}`;

  await prisma.$transaction(async (tx) => {
    await tx.buyerWallet.update({ where: { id: wallet.id }, data: { balance: { increment: delta } } });
    await tx.buyerWalletTransaction.create({
      data: {
        walletId: wallet.id,
        buyerId,
        type: BuyerWalletTxType.TOP_UP,
        amount: delta,
        currency: wallet.currency,
        description: "QA mixed vendor frontend-flow top-up",
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

  await ensureWalletBalance(buyer.id);
  const walletBeforeCheckout = (await prisma.buyerWallet.findUniqueOrThrow({ where: { buyerId: buyer.id } })).balance;

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
  if (!clearRes.ok) throw new Error(`Clear cart failed: ${clearRes.status} ${JSON.stringify(clearRes.body)}`);

  for (const productId of PRODUCT_IDS) {
    const addRes = await api("/cart/items", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ productId, quantity: 1 }),
    });
    if (!addRes.ok) throw new Error(`Add to cart failed: ${addRes.status} ${JSON.stringify(addRes.body)}`);
  }

  const cartRes = await api("/cart", { method: "GET", headers: authHeaders });
  if (!cartRes.ok || !cartRes.body?.cart?.id) throw new Error(`Get cart failed: ${cartRes.status} ${JSON.stringify(cartRes.body)}`);

  const cart = cartRes.body.cart;

  const checkoutRes = await api("/payments/create-intent", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      cartId: cart.id,
      deliveryCountry: DELIVERY_COUNTRY,
      deliveryAddress: DELIVERY_ADDRESS,
    }),
  });
  if (!checkoutRes.ok) throw new Error(`Create intent failed: ${checkoutRes.status} ${JSON.stringify(checkoutRes.body)}`);

  const intent = checkoutRes.body;
  const perOrderAmount = Math.round(intent.amount / Math.max(1, intent.orderIds.length));

  const applyResults = [] as any[];
  for (const orderId of intent.orderIds) {
    const applyRes = await api("/wallet/me/apply", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ orderId, amount: perOrderAmount }),
    });
    applyResults.push({ orderId, status: applyRes.status, ok: applyRes.ok, body: applyRes.body });
  }

  const orders = await prisma.order.findMany({
    where: { id: { in: intent.orderIds } },
    include: { payment: true, items: true },
    orderBy: { createdAt: "asc" },
  });
  const walletAfterApply = await prisma.buyerWallet.findUnique({ where: { buyerId: buyer.id } });
  const cartAfter = await prisma.cart.findUnique({ where: { buyerId: buyer.id }, include: { items: true } });

  const result = {
    checkoutResponse: intent,
    perOrderAmountUsedByFrontend: perOrderAmount,
    applyResults,
    wallet: {
      beforeCheckout: walletBeforeCheckout,
      afterApply: walletAfterApply?.balance ?? null,
      deducted: walletAfterApply ? walletBeforeCheckout - walletAfterApply.balance : null,
    },
    orders: orders.map((order) => ({
      id: order.id,
      vendorId: order.vendorId,
      totalAmount: order.totalAmount,
      status: order.status,
      paymentStatus: order.payment?.status ?? null,
      paymentProvider: order.payment?.provider ?? null,
      items: order.items.map((item) => ({ productId: item.productId, totalAmount: item.totalAmount })),
    })),
    cartAfterApply: {
      itemCount: cartAfter?.items?.length ?? 0,
    },
    checks: {
      checkoutStillStripeBased: !!intent.paymentIntentId && intent.clientSecret !== "wallet_paid",
      frontendAppliedEqualSplit: true,
      splitMatchesActualOrderTotals: orders.every((order) => order.totalAmount === perOrderAmount),
      ordersMarkedPaid: orders.every((order) => order.status === "PAID"),
      paymentsMarkedSucceeded: orders.every((order) => order.payment?.status === "SUCCEEDED"),
      cartClearedByBackend: (cartAfter?.items?.length ?? 0) === 0,
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
