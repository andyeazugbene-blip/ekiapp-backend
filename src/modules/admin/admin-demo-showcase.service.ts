import { randomBytes } from "crypto";

import bcrypt from "bcryptjs";
import { UserRole } from "@prisma/client";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { currencyFromCountry, marketCodeToCountryName, resolveMarketCode } from "../../shared/currency";
import { resolveUniqueSlug, resolveUniqueText } from "../../shared/utils/slug";
import { cartService } from "../cart/cart.service";
import { communityCampaignsService, REVIEW_CRITERIA_KEYS } from "../community-buy/community-campaigns.service";
import { paymentsService } from "../payments/payments.service";
import { productsService } from "../products/products.service";
import { subscriptionOffersService } from "../regular-deliveries/subscription-offers.service";
import { subscriptionsService } from "../subscriptions/subscriptions.service";
import { vendorMarketsService } from "../vendors/vendor-markets.service";

const IMAGE_BASE = "https://pub-29ae2f4344894a4bb136efd5be978924.r2.dev";
const MAIN_PRODUCTS = [
  { title: "Egusi Seeds 1kg", priceAmount: 1450, image: "seed-egusi.png", stock: 120, category: "Grains & Seeds" },
  { title: "Dried Fish Selection", priceAmount: 1990, image: "seed-dried-fish.png", stock: 80, category: "Fish & Seafood" },
];
const COMPANION_PRODUCTS = [
  { title: "Dried Fish Family Pack", priceAmount: 2450, image: "seed-dried-fish.png", stock: 200, category: "Fish & Seafood" },
  { title: "Egusi Seeds 2kg", priceAmount: 2650, image: "seed-egusi.png", stock: 200, category: "Grains & Seeds" },
];
const COMPANION_WALLET_MINOR = 100_000;
const CAMPAIGN_DAYS = 30;

export interface ShowcaseMain {
  userId: string;
  vendorId: string;
  supplierAccountId: string;
  country: string;
}

export interface ShowcaseResult {
  companionStoreName: string | null;
  created: string[];
  /** Steps that couldn't complete. Empty means every feature is ready to show. */
  warnings: string[];
}

function countryNames(country: string) {
  const code = resolveMarketCode(country) ?? country.trim().toUpperCase();
  return { code, name: marketCodeToCountryName(code) ?? country };
}

async function createCompanion(country: string, reason: string) {
  const { name } = countryNames(country);
  const currency = currencyFromCountry(country);
  const suffix = randomBytes(4).toString("hex");
  const storeName = await resolveUniqueText("Eki Demo Market", async (candidate) => (await prisma.vendor.findUnique({ where: { storeName: candidate }, select: { id: true } })) !== null);
  const storeSlug = await resolveUniqueSlug(storeName, async (candidate) => (await prisma.vendor.findUnique({ where: { storeSlug: candidate }, select: { id: true } })) !== null);
  // Nobody logs in as this account: its password is random and never stored anywhere readable.
  const password = await bcrypt.hash(randomBytes(32).toString("hex"), 12);

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email: `demo-market-${suffix}@demo.eki.invalid`, name: "Eki Demo Market", password, role: UserRole.BUYER, isTest: true, emailVerifiedAt: new Date(), country },
    });
    const vendor = await tx.vendor.create({
      data: { userId: user.id, storeName, storeSlug, country, currency, isTest: true, verificationStatus: "VERIFIED", verifiedAt: new Date() },
      select: { id: true, storeName: true },
    });
    await vendorMarketsService.ensureInitialAssignment(vendor.id, country, tx);
    await tx.deliveryZone.create({ data: { vendorId: vendor.id, name, country: name, isActive: true, baseFeeAmount: 500, feePerKgAmount: 0 } });
    const wallet = await tx.buyerWallet.create({ data: { buyerId: user.id, currency, balance: COMPANION_WALLET_MINOR } });
    await tx.buyerWalletTransaction.create({
      data: { walletId: wallet.id, buyerId: user.id, type: "TOP_UP", amount: COMPANION_WALLET_MINOR, currency, description: `Demo showcase companion: ${reason}` },
    });
    return { userId: user.id, vendorId: vendor.id, storeName: vendor.storeName };
  });
}

async function createProducts(userId: string, products: typeof MAIN_PRODUCTS) {
  const created: Array<{ id: string }> = [];
  for (const product of products) {
    created.push(
      await productsService.createProduct(userId, {
        title: product.title,
        description: `${product.title} from a demo store. Not a real listing.`,
        priceAmount: product.priceAmount,
        images: [`${IMAGE_BASE}/${product.image}`],
        category: product.category,
        stock: product.stock,
        weightGrams: 1000,
      } as never),
    );
  }
  return created;
}

async function createOffer(vendorId: string, productIds: string[], title: string) {
  const offer = await subscriptionOffersService.create(vendorId, {
    title,
    description: "Demo Foodstuff Subscription.",
    productIds,
    frequencies: ["WEEKLY", "MONTHLY"],
    substitutionMode: "ASK_BUYER",
    fulfilmentMethod: "DELIVERY",
    discountPercent: 5,
  } as never);
  return subscriptionOffersService.publish(vendorId, offer.id);
}

/** Runs a campaign through the same create, submit, approve and publish path a real one takes. */
async function createLiveCampaign(actorId: string, organiserUserId: string, country: string, title: string, supply: Record<string, unknown>) {
  const { code } = countryNames(country);
  const draft = await communityCampaignsService.create(organiserUserId, { title, country: code } as never);
  await communityCampaignsService.update(organiserUserId, draft.id, {
    description: "Demo campaign. No real goods are sold and no real money moves.",
    currency: currencyFromCountry(country).toUpperCase(),
    minimumShares: 5,
    goalShares: 20,
    maximumShares: 50,
    pricePerShareMinor: 2500,
    deadline: new Date(Date.now() + CAMPAIGN_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    unit: "bag",
    quantityPerOrder: 1,
    images: [`${IMAGE_BASE}/seed-egusi.png`],
    deliveryPreference: "COLLECTION",
    collectionAddressLine1: "1 Demo Street",
    collectionCity: "Demo City",
    collectionPostcode: "DE1 1MO",
    ...supply,
  } as never);
  await communityCampaignsService.submit(organiserUserId, draft.id);
  await communityCampaignsService.approve(actorId, draft.id, Object.fromEntries(REVIEW_CRITERIA_KEYS.map((key) => [key, true])));
  return communityCampaignsService.publish(organiserUserId, draft.id);
}

/**
 * Prepares a demo account so every Eki feature has something real to show:
 * marketing tools unlocked, a store with an order and a buyer to message, live
 * Community Buys, a supplier invitation, and subscription offers. Everything
 * is isTest, so it stays invisible to real accounts and moves no real money.
 *
 * Each step is independent: a failure is reported rather than losing the rest.
 */
export const adminDemoShowcaseService = {
  async seed(actorId: string, main: ShowcaseMain, reason: string): Promise<ShowcaseResult> {
    const created: string[] = [];
    const warnings: string[] = [];
    const step = async <T>(label: string, run: () => Promise<T>): Promise<T | null> => {
      try {
        const value = await run();
        created.push(label);
        return value;
      } catch (error) {
        logger.warn("Demo showcase step failed", { step: label, userId: main.userId, error: String(error) });
        warnings.push(`${label}: ${error instanceof Error ? error.message : "failed"}`);
        return null;
      }
    };

    await step("Growth plan with marketing tools", () => subscriptionsService.assignVendorPlan(actorId, main.vendorId, { plan: "GROWTH" } as never, reason));
    const mainProducts = await step("Store listings", () => createProducts(main.userId, MAIN_PRODUCTS));
    if (mainProducts) {
      await step("Store subscription offer", () => createOffer(main.vendorId, mainProducts.map((p) => p.id), "Weekly Pantry Box"));
    }

    const companion = await step("Companion demo store", () => createCompanion(main.country, reason));
    if (companion) {
      const companionProducts = await step("Companion listings", () => createProducts(companion.userId, COMPANION_PRODUCTS));
      if (companionProducts) {
        await step("Companion subscription offer", () => createOffer(companion.vendorId, companionProducts.map((p) => p.id), "Monthly Family Staples"));
      }
      await step("Supplier invitation", () => createLiveCampaign(actorId, companion.userId, main.country, "Demo Rice Community Buy", {
        fulfilmentOwner: "SUPPLIER",
        supplierAccountId: main.supplierAccountId,
        wholesaleAmountMinor: 1800,
      }));
      if (mainProducts?.[0]) {
        await step("Store order and buyer", async () => {
          const cart = await cartService.addItem(companion.userId, { productId: mainProducts[0].id, quantity: 2 });
          const { name } = countryNames(main.country);
          return paymentsService.createPaymentIntent({
            cartId: cart.id,
            deliveryCountry: name,
            deliveryAddress: "1 Demo Street, Demo City",
            walletAmount: COMPANION_WALLET_MINOR,
            checkoutCurrency: currencyFromCountry(main.country),
          }, companion.userId);
        });
      }
    }

    await step("Own Community Buy", () => createLiveCampaign(actorId, main.userId, main.country, "My Demo Yam Community Buy", { fulfilmentOwner: "SELF" }));

    return { companionStoreName: companion?.storeName ?? null, created, warnings };
  },
};
