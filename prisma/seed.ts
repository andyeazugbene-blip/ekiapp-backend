import {
  BuyerWalletTxType,
  ConversationType,
  NotificationType,
  OrderStatus,
  PaymentStatus,
  PayoutMethodType,
  PayoutRequestStatus,
  PrismaClient,
  PromoType,
  ReviewStatus,
  ShipmentStatus,
  SubscriptionStatus,
  UserRole,
  VendorVerificationStatus,
  WalletTransactionType,
} from "@prisma/client";
import bcrypt from "bcryptjs";
import { DEFAULT_PLAN_CONFIGS } from "../src/modules/subscriptions/subscriptions.types";

const prisma = new PrismaClient();

const APP_PASSWORD = "Abdou22314";
const BUYER_EMAIL = "buyer@eki.app";
const BUYER_PHONE = "+15550000001";
const VENDOR_ONE_EMAIL = "vendor@eki.app";
const VENDOR_ONE_PHONE = "+15550000011";
const VENDOR_TWO_EMAIL = "vendor2@eki.app";
const VENDOR_TWO_PHONE = "+15550000022";

function usd(amount: number) {
  return Math.round(amount * 100);
}

async function main() {
  const passwordHash = await bcrypt.hash(APP_PASSWORD, 10);
  const adminPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD ?? "AndersonP@55w0rd", 10);

  await Promise.all(
    Object.values(DEFAULT_PLAN_CONFIGS).map((plan) =>
      prisma.subscriptionPlanConfig.upsert({
        where: { plan: plan.plan },
        update: plan,
        create: plan,
      }),
    ),
  );

  const buyer = await prisma.user.create({
    data: {
      email: BUYER_EMAIL,
      name: "Amara Buyer",
      password: passwordHash,
      phone: BUYER_PHONE,
      country: "United Kingdom",
      role: UserRole.BUYER,
      emailVerifiedAt: new Date(),
      referralCode: "BUYERAMARA10",
    },
  });

  const vendorOwnerOne = await prisma.user.create({
    data: {
      email: VENDOR_ONE_EMAIL,
      name: "Queen Vendor",
      password: passwordHash,
      phone: VENDOR_ONE_PHONE,
      country: "United Kingdom",
      role: UserRole.VENDOR,
      emailVerifiedAt: new Date(),
      referralCode: "QUEENAFRO10",
    },
  });

  const vendorOwnerTwo = await prisma.user.create({
    data: {
      email: VENDOR_TWO_EMAIL,
      name: "Lagos Vendor",
      password: passwordHash,
      phone: VENDOR_TWO_PHONE,
      country: "United States",
      role: UserRole.VENDOR,
      emailVerifiedAt: new Date(),
      referralCode: "LAGOSPANTRY10",
    },
  });

  const admin = await prisma.user.create({
    data: {
      email: process.env.ADMIN_EMAIL ?? "adminandy@eki.app",
      name: process.env.ADMIN_NAME ?? "Anderson",
      password: adminPassword,
      role: UserRole.ADMIN,
      emailVerifiedAt: new Date(),
    },
  });

  const vendorOne = await prisma.vendor.create({
    data: {
      userId: vendorOwnerOne.id,
      storeName: "Queen African Foods",
      storeSlug: "queen-african-foods",
      description: "Authentic African pantry staples delivered fast from Birmingham.",
      contactEmail: VENDOR_ONE_EMAIL,
      contactPhone: VENDOR_ONE_PHONE,
      country: "United Kingdom",
      city: "Birmingham",
      businessType: "Foodstuff Store",
      sellerRegion: "Europe",
      currency: "USD",
      verificationStatus: VendorVerificationStatus.VERIFIED,
      stripeAccountStatus: "verified",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
      stripeOnboardedAt: new Date(),
    },
  });

  const vendorTwo = await prisma.vendor.create({
    data: {
      userId: vendorOwnerTwo.id,
      storeName: "Lagos Pantry",
      storeSlug: "lagos-pantry",
      description: "Traditional West African grocery items with fast US fulfillment.",
      contactEmail: VENDOR_TWO_EMAIL,
      contactPhone: VENDOR_TWO_PHONE,
      country: "United States",
      city: "Houston",
      businessType: "Foodstuff Store",
      sellerRegion: "North America",
      currency: "USD",
      verificationStatus: VendorVerificationStatus.VERIFIED,
      stripeAccountStatus: "verified",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
      stripeOnboardedAt: new Date(),
    },
  });

  const [vendorOneWallet, vendorTwoWallet, buyerWallet] = await Promise.all([
    prisma.wallet.create({
      data: {
        vendorId: vendorOne.id,
        currency: "USD",
        pendingBalance: usd(40),
        availableBalance: usd(180),
      },
    }),
    prisma.wallet.create({
      data: {
        vendorId: vendorTwo.id,
        currency: "USD",
        pendingBalance: usd(25),
        availableBalance: usd(145),
      },
    }),
    prisma.buyerWallet.create({
      data: {
        buyerId: buyer.id,
        balance: usd(10),
        currency: "USD",
      },
    }),
  ]);

  await prisma.buyerWalletTransaction.create({
    data: {
      walletId: buyerWallet.id,
      buyerId: buyer.id,
      type: BuyerWalletTxType.TOP_UP,
      amount: usd(10),
      currency: "USD",
      description: "Starter wallet credit",
    },
  });

  await Promise.all([
    prisma.vendorSubscription.create({
      data: {
        vendorId: vendorOne.id,
        plan: "GROWTH",
        status: SubscriptionStatus.ACTIVE,
      },
    }),
    prisma.vendorSubscription.create({
      data: {
        vendorId: vendorTwo.id,
        plan: "BASIC",
        status: SubscriptionStatus.ACTIVE,
      },
    }),
  ]);

  const [ukZone, usZone] = await Promise.all([
    prisma.deliveryZone.create({
      data: {
        name: "United Kingdom",
        country: "United Kingdom",
        baseFeeAmount: usd(3),
        feePerKgAmount: usd(1),
        currency: "USD",
        isActive: true,
        vendorId: vendorOne.id,
      },
    }),
    prisma.deliveryZone.create({
      data: {
        name: "United States",
        country: "United States",
        baseFeeAmount: usd(4),
        feePerKgAmount: usd(1.25),
        currency: "USD",
        isActive: true,
        vendorId: vendorTwo.id,
      },
    }),
  ]);

  const [
    egusi,
    driedFish,
    _locustBeans,
    palmOil,
    yamFlour,
    _shitoSauce,
  ] = await Promise.all([
    prisma.product.create({
      data: {
        vendorId: vendorOne.id,
        title: "Egusi Ground (1kg)",
        description: "Freshly milled egusi seeds from trusted farms in Nigeria.",
        priceInCents: usd(8.5),
        currency: "USD",
        stock: 24,
        weightGrams: 1000,
        category: "Seeds",
        images: ["https://pub-29ae2f4344894a4bb136efd5be978924.r2.dev/seed-egusi.png"],
      },
    }),
    prisma.product.create({
      data: {
        vendorId: vendorOne.id,
        title: "Dried Fish Pack (500g)",
        description: "Cleaned dried fish pack ideal for soups and stews.",
        priceInCents: usd(5),
        currency: "USD",
        stock: 18,
        weightGrams: 500,
        category: "Protein",
        images: ["https://pub-29ae2f4344894a4bb136efd5be978924.r2.dev/seed-dried-fish.png"],
      },
    }),
    prisma.product.create({
      data: {
        vendorId: vendorOne.id,
        title: "Locust Beans (Iru)",
        description: "Rich fermented locust beans for authentic flavor.",
        priceInCents: usd(4.5),
        currency: "USD",
        stock: 16,
        weightGrams: 250,
        category: "Seasoning",
        images: ["https://pub-29ae2f4344894a4bb136efd5be978924.r2.dev/seed-iru.png"],
      },
    }),
    prisma.product.create({
      data: {
        vendorId: vendorTwo.id,
        title: "Palm Kernel Oil",
        description: "Cold-pressed palm kernel oil sourced from Ghana.",
        priceInCents: usd(9),
        currency: "USD",
        stock: 15,
        weightGrams: 750,
        category: "Oils",
        images: ["https://pub-29ae2f4344894a4bb136efd5be978924.r2.dev/seed-palm-kernel.png"],
      },
    }),
    prisma.product.create({
      data: {
        vendorId: vendorTwo.id,
        title: "Fresh Yam Flour",
        description: "Smooth yam flour for amala and swallow dishes.",
        priceInCents: usd(6.75),
        currency: "USD",
        stock: 20,
        weightGrams: 900,
        category: "Flour",
        images: ["https://pub-29ae2f4344894a4bb136efd5be978924.r2.dev/seed-yam-flour.png"],
      },
    }),
    prisma.product.create({
      data: {
        vendorId: vendorTwo.id,
        title: "Ghanaian Shito Sauce",
        description: "Traditional smoky shito sauce made in small batches.",
        priceInCents: usd(7.5),
        currency: "USD",
        stock: 12,
        weightGrams: 350,
        category: "Sauces",
        images: ["https://pub-29ae2f4344894a4bb136efd5be978924.r2.dev/seed-shito.png"],
      },
    }),
  ]);

  await Promise.all([
    prisma.promoCode.createMany({
      data: [
        {
          vendorId: vendorOne.id,
          code: "QUEEN10",
          type: PromoType.PERCENTAGE,
          value: 10,
          minOrderAmount: usd(20),
          maxUses: 100,
          isActive: true,
        },
        {
          vendorId: vendorOne.id,
          code: "QUEEN5OFF",
          type: PromoType.FIXED_AMOUNT,
          value: usd(5),
          minOrderAmount: usd(35),
          maxUses: 50,
          isActive: true,
        },
        {
          vendorId: vendorTwo.id,
          code: "LAGOS10",
          type: PromoType.PERCENTAGE,
          value: 10,
          minOrderAmount: usd(20),
          maxUses: 100,
          isActive: true,
        },
        {
          vendorId: vendorTwo.id,
          code: "LAGOS5OFF",
          type: PromoType.FIXED_AMOUNT,
          value: usd(5),
          minOrderAmount: usd(35),
          maxUses: 50,
          isActive: true,
        },
      ],
    }),
  ]);

  const buyerAddress = await prisma.buyerAddress.create({
    data: {
      buyerId: buyer.id,
      recipientName: "Amara Buyer",
      line1: "14 Broad Street",
      city: "London",
      postalCode: "E1 6RF",
      country: "United Kingdom",
      phone: BUYER_PHONE,
      isDefault: true,
    },
  });

  const checkoutOne = await prisma.checkout.create({
    data: {
      buyerId: buyer.id,
      totalAmount: usd(16.5),
      currency: "USD",
      status: PaymentStatus.SUCCEEDED,
      processedAt: new Date(),
    },
  });

  const checkoutTwo = await prisma.checkout.create({
    data: {
      buyerId: buyer.id,
      totalAmount: usd(18.25),
      currency: "USD",
      status: PaymentStatus.SUCCEEDED,
      processedAt: new Date(),
    },
  });

  const orderOne = await prisma.order.create({
    data: {
      orderNumber: "EKI-2026-000101",
      checkoutId: checkoutOne.id,
      buyerId: buyer.id,
      vendorId: vendorOne.id,
      status: OrderStatus.COMPLETED,
      subtotalAmount: usd(13.5),
      deliveryFeeAmount: usd(3),
      platformFeeAmount: usd(1.65),
      vendorEarnings: usd(11.85),
      totalAmount: usd(16.5),
      currency: "USD",
      deliveryZoneId: ukZone.id,
      deliveryAddress: `${buyerAddress.line1}, ${buyerAddress.city}, ${buyerAddress.postalCode}, ${buyerAddress.country}`,
      deliveredAt: new Date(),
      items: {
        create: [
          {
            productId: egusi.id,
            vendorId: vendorOne.id,
            quantity: 1,
            unitAmount: egusi.priceInCents,
            totalAmount: egusi.priceInCents,
            currency: "USD",
            productTitle: egusi.title,
          },
          {
            productId: driedFish.id,
            vendorId: vendorOne.id,
            quantity: 1,
            unitAmount: driedFish.priceInCents,
            totalAmount: driedFish.priceInCents,
            currency: "USD",
            productTitle: driedFish.title,
          },
        ],
      },
    },
  });

  const orderTwo = await prisma.order.create({
    data: {
      orderNumber: "EKI-2026-000102",
      checkoutId: checkoutTwo.id,
      buyerId: buyer.id,
      vendorId: vendorTwo.id,
      status: OrderStatus.COMPLETED,
      subtotalAmount: usd(14.25),
      deliveryFeeAmount: usd(4),
      platformFeeAmount: usd(1.82),
      vendorEarnings: usd(12.43),
      totalAmount: usd(18.25),
      currency: "USD",
      deliveryZoneId: usZone.id,
      deliveryAddress: `${buyerAddress.line1}, ${buyerAddress.city}, ${buyerAddress.postalCode}, ${buyerAddress.country}`,
      deliveredAt: new Date(),
      items: {
        create: [
          {
            productId: yamFlour.id,
            vendorId: vendorTwo.id,
            quantity: 1,
            unitAmount: yamFlour.priceInCents,
            totalAmount: yamFlour.priceInCents,
            currency: "USD",
            productTitle: yamFlour.title,
          },
          {
            productId: palmOil.id,
            vendorId: vendorTwo.id,
            quantity: 1,
            unitAmount: palmOil.priceInCents,
            totalAmount: palmOil.priceInCents,
            currency: "USD",
            productTitle: palmOil.title,
          },
        ],
      },
    },
  });

  const [paymentOne, paymentTwo] = await Promise.all([
    prisma.payment.create({
      data: {
        orderId: orderOne.id,
        amount: usd(16.5),
        platformFeeAmount: usd(1.65),
        vendorEarningsAmount: usd(11.85),
        currency: "USD",
        status: PaymentStatus.SUCCEEDED,
        provider: "stripe",
        processedAt: new Date(),
      },
    }),
    prisma.payment.create({
      data: {
        orderId: orderTwo.id,
        amount: usd(18.25),
        platformFeeAmount: usd(1.82),
        vendorEarningsAmount: usd(12.43),
        currency: "USD",
        status: PaymentStatus.SUCCEEDED,
        provider: "stripe",
        processedAt: new Date(),
      },
    }),
  ]);

  await Promise.all([
    prisma.shipment.create({
      data: {
        orderId: orderOne.id,
        vendorId: vendorOne.id,
        trackingNumber: "QAF-TRACK-0001",
        carrier: "Royal Mail",
        status: ShipmentStatus.DELIVERED,
        dispatchedAt: new Date(Date.now() - 1000 * 60 * 60 * 72),
        deliveredAt: new Date(),
      },
    }),
    prisma.shipment.create({
      data: {
        orderId: orderTwo.id,
        vendorId: vendorTwo.id,
        trackingNumber: "LP-TRACK-0001",
        carrier: "UPS",
        status: ShipmentStatus.DELIVERED,
        dispatchedAt: new Date(Date.now() - 1000 * 60 * 60 * 48),
        deliveredAt: new Date(),
      },
    }),
  ]);

  await prisma.review.createMany({
    data: [
      {
        buyerId: buyer.id,
        vendorId: vendorOne.id,
        productId: egusi.id,
        orderId: orderOne.id,
        rating: 5,
        comment: "Great quality and very fast delivery.",
        status: ReviewStatus.APPROVED,
      },
      {
        buyerId: buyer.id,
        vendorId: vendorTwo.id,
        productId: yamFlour.id,
        orderId: orderTwo.id,
        rating: 4,
        comment: "Fresh products and careful packaging.",
        status: ReviewStatus.APPROVED,
      },
    ],
  });

  const [vendorOnePayoutMethod, vendorTwoPayoutMethod] = await Promise.all([
    prisma.payoutMethod.create({
      data: {
        vendorId: vendorOne.id,
        type: PayoutMethodType.BANK_TRANSFER,
        label: "Queen African Foods GBP Account",
        isDefault: true,
        details: {
          bankName: "Barclays",
          accountName: "Queen African Foods",
          accountNumber: "12345678",
          sortCode: "20-00-00",
        },
      },
    }),
    prisma.payoutMethod.create({
      data: {
        vendorId: vendorTwo.id,
        type: PayoutMethodType.MOBILE_MONEY,
        label: "Lagos Pantry MoMo",
        isDefault: true,
        details: {
          provider: "MTN",
          accountName: "Lagos Pantry",
          phone: "+233565544556",
        },
      },
    }),
  ]);

  const [vendorOnePayout, vendorTwoPayout] = await Promise.all([
    prisma.payoutRequest.create({
      data: {
        vendorId: vendorOne.id,
        payoutMethodId: vendorOnePayoutMethod.id,
        amount: usd(45),
        currency: "USD",
        status: PayoutRequestStatus.PENDING,
        notes: "Weekly payout request",
      },
    }),
    prisma.payoutRequest.create({
      data: {
        vendorId: vendorTwo.id,
        payoutMethodId: vendorTwoPayoutMethod.id,
        amount: usd(35),
        currency: "USD",
        status: PayoutRequestStatus.PENDING,
        notes: "Requested by vendor from dashboard",
      },
    }),
  ]);

  await prisma.walletTransaction.createMany({
    data: [
      {
        walletId: vendorOneWallet.id,
        vendorId: vendorOne.id,
        orderId: orderOne.id,
        paymentId: paymentOne.id,
        type: WalletTransactionType.PAYMENT_PENDING_CREDIT,
        amount: usd(11.85),
        currency: "USD",
        description: "Order payment credited to pending balance",
      },
      {
        walletId: vendorOneWallet.id,
        vendorId: vendorOne.id,
        type: WalletTransactionType.ADJUSTMENT_CREDIT,
        amount: usd(180),
        currency: "USD",
        description: "Seeded available vendor balance",
      },
      {
        walletId: vendorTwoWallet.id,
        vendorId: vendorTwo.id,
        orderId: orderTwo.id,
        paymentId: paymentTwo.id,
        type: WalletTransactionType.PAYMENT_PENDING_CREDIT,
        amount: usd(12.43),
        currency: "USD",
        description: "Order payment credited to pending balance",
      },
      {
        walletId: vendorTwoWallet.id,
        vendorId: vendorTwo.id,
        type: WalletTransactionType.ADJUSTMENT_CREDIT,
        amount: usd(145),
        currency: "USD",
        description: "Seeded available vendor balance",
      },
    ],
  });

  await prisma.notification.createMany({
    data: [
      {
        userId: buyer.id,
        type: NotificationType.BALANCE_CREDITED,
        title: "Wallet credited",
        body: "Your buyer wallet has been funded with $10 starter credit.",
        data: { amount: 1000, currency: "USD" },
      },
      {
        userId: buyer.id,
        type: NotificationType.ORDER_PAID,
        title: "Order placed with Queen African Foods",
        body: "Your order EKI-2026-000101 was paid successfully.",
        data: { orderId: orderOne.id, orderNumber: orderOne.orderNumber, vendorId: vendorOne.id },
      },
      {
        userId: buyer.id,
        type: NotificationType.ORDER_PAID,
        title: "Order placed with Lagos Pantry",
        body: "Your order EKI-2026-000102 was paid successfully.",
        data: { orderId: orderTwo.id, orderNumber: orderTwo.orderNumber, vendorId: vendorTwo.id },
      },
      {
        userId: vendorOwnerOne.id,
        type: NotificationType.ORDER_PAID,
        title: "New buyer order received",
        body: "Amara Buyer ordered Egusi Ground (1kg) and Dried Fish Pack (500g).",
        data: { buyerId: buyer.id, orderId: orderOne.id, orderNumber: orderOne.orderNumber },
      },
      {
        userId: vendorOwnerTwo.id,
        type: NotificationType.ORDER_PAID,
        title: "New buyer order received",
        body: "Amara Buyer ordered Fresh Yam Flour and Palm Kernel Oil.",
        data: { buyerId: buyer.id, orderId: orderTwo.id, orderNumber: orderTwo.orderNumber },
      },
      {
        userId: vendorOwnerOne.id,
        type: NotificationType.PAYOUT_REQUESTED,
        title: "Payout request created",
        body: "Your payout request for $45.00 is pending review.",
        data: { payoutRequestId: vendorOnePayout.id, amount: 4500, currency: "USD" },
      },
      {
        userId: vendorOwnerTwo.id,
        type: NotificationType.PAYOUT_REQUESTED,
        title: "Payout request created",
        body: "Your payout request for $35.00 is pending review.",
        data: { payoutRequestId: vendorTwoPayout.id, amount: 3500, currency: "USD" },
      },
      {
        userId: vendorOwnerOne.id,
        type: NotificationType.BALANCE_CREDITED,
        title: "Vendor balance updated",
        body: "Your vendor wallet was funded for launch testing.",
        data: { amount: 18000, currency: "USD" },
      },
      {
        userId: vendorOwnerTwo.id,
        type: NotificationType.BALANCE_CREDITED,
        title: "Vendor balance updated",
        body: "Your vendor wallet was funded for launch testing.",
        data: { amount: 14500, currency: "USD" },
      },
    ],
  });

  const [conversationOne, conversationTwo] = await Promise.all([
    prisma.conversation.create({
      data: {
        type: ConversationType.BUYER_VENDOR,
        participantA: buyer.id,
        participantB: vendorOwnerOne.id,
        orderId: orderOne.id,
        lastMessageAt: new Date(),
      },
    }),
    prisma.conversation.create({
      data: {
        type: ConversationType.BUYER_VENDOR,
        participantA: buyer.id,
        participantB: vendorOwnerTwo.id,
        orderId: orderTwo.id,
        lastMessageAt: new Date(),
      },
    }),
  ]);

  await prisma.message.createMany({
    data: [
      {
        conversationId: conversationOne.id,
        senderId: buyer.id,
        text: "Thanks, my order arrived in good condition.",
      },
      {
        conversationId: conversationOne.id,
        senderId: vendorOwnerOne.id,
        text: "Glad to hear that. Thank you for shopping with us.",
      },
      {
        conversationId: conversationTwo.id,
        senderId: buyer.id,
        text: "Please keep me posted when more shito is back in stock.",
      },
      {
        conversationId: conversationTwo.id,
        senderId: vendorOwnerTwo.id,
        text: "Absolutely, we will notify you as soon as it lands.",
      },
    ],
  });

  console.log("Seed complete");
  console.log({
    buyer: BUYER_EMAIL,
    vendors: [VENDOR_ONE_EMAIL, VENDOR_TWO_EMAIL],
    password: APP_PASSWORD,
    slugs: [vendorOne.storeSlug, vendorTwo.storeSlug],
    orders: [orderOne.orderNumber, orderTwo.orderNumber],
    promoCodes: ["QUEEN10", "QUEEN5OFF", "LAGOS10", "LAGOS5OFF"],
    admin: admin.email,
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
