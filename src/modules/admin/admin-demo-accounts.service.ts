import bcrypt from "bcryptjs";
import { UserRole } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";
import { resolveUniqueSlug } from "../../shared/utils/slug";

const MAX_CREDIT_MINOR = 1_000_000; // €10,000 cap per call — a deliberate ceiling, not a guess at what's "enough".
const DEFAULT_CREDIT_MINOR = 500_000; // €5,000 — generous for a marketing demo, never auto-applied silently (always an explicit admin action).
const BCRYPT_ROUNDS = 12; // matches auth.service.ts's own constant — kept separate since this module never imports auth internals.

/**
 * Marketing/demo accounts (12 Oct 2026 request): a real buyer account that
 * can complete a genuine checkout — real cart, real order, real vendor
 * notification — without a real card or real money moving, and without
 * ever touching the Stripe code path at all.
 *
 * Deliberately NOT a new "fake payment" branch bolted onto
 * payments.service.ts (the single most sensitive code path in the app).
 * Instead this reuses the EXISTING, already-proven "fully paid by wallet
 * balance, no Stripe call" branch that already exists for any buyer whose
 * BuyerWallet balance covers the order — crediting a wallet is the entire
 * mechanism. Zero new logic in the payment pipeline, zero new risk there.
 */
export const adminDemoAccountsService = {
  async provision(
    userId: string,
    input: { reason: string; creditMinor?: number; currency?: string },
  ): Promise<{ userId: string; isTest: boolean; walletBalanceMinor: number; currency: string }> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, isTest: true, email: true } });
    if (!user) throw new AppError("User not found", 404);
    if (user.role !== "BUYER") {
      throw new AppError("Demo provisioning is only for buyer accounts — a demo vendor/admin account is a different, unbuilt request.", 409);
    }

    const creditMinor = input.creditMinor ?? DEFAULT_CREDIT_MINOR;
    if (!Number.isInteger(creditMinor) || creditMinor <= 0 || creditMinor > MAX_CREDIT_MINOR) {
      throw new AppError(`creditMinor must be a positive integer up to ${MAX_CREDIT_MINOR}`, 400);
    }
    const currency = (input.currency ?? "EUR").toUpperCase();

    const result = await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { isTest: true } });

      const wallet = await tx.buyerWallet.upsert({
        where: { buyerId: userId },
        create: { buyerId: userId, currency, balance: creditMinor },
        update: { balance: { increment: creditMinor } },
      });

      await tx.buyerWalletTransaction.create({
        data: {
          walletId: wallet.id,
          buyerId: userId,
          type: "TOP_UP",
          amount: creditMinor,
          currency,
          description: `Demo account provisioning: ${input.reason}`,
        },
      });

      return wallet;
    });

    return { userId, isTest: true, walletBalanceMinor: result.balance, currency: result.currency };
  },

  /**
   * Admin-initiated demo buyer creation (18 Oct 2026 request): public
   * registration is Turnstile-gated and cannot be scripted, so a demo
   * account meant to hand to a client can only be created by a human
   * typing it into the real signup form OR by an authenticated, 2FA'd
   * admin creating it directly here. This is the latter — email is
   * marked verified immediately (never leaves a demo account stuck
   * behind an OTP step) and the wallet is credited in the same
   * transaction as provision() above.
   */
  async createAndProvision(input: {
    email: string;
    password: string;
    name: string;
    reason: string;
    creditMinor?: number;
    currency?: string;
    /**
     * 19 Oct 2026: the demo account must also be able to add and publish
     * foodstuff for a live client walkthrough — not just buy. Gives the
     * SAME account a Vendor profile (role stays BUYER; store access is
     * capability-based via hasVendor, same as any real account that is
     * both a buyer and a seller — see role-select.tsx). Pre-verified and
     * pre-zoned so a product the demo adds publishes immediately, unlike
     * a real new vendor (intentional: this is a marketing demo, not a
     * test of the verification gate itself).
     */
    storeName?: string;
    country?: string;
  }): Promise<{
    userId: string;
    email: string;
    isTest: boolean;
    walletBalanceMinor: number;
    currency: string;
    vendor: { id: string; storeName: string; storeSlug: string } | null;
  }> {
    const existing = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
    if (existing) {
      throw new AppError("Email already registered", 409);
    }

    const creditMinor = input.creditMinor ?? DEFAULT_CREDIT_MINOR;
    if (!Number.isInteger(creditMinor) || creditMinor <= 0 || creditMinor > MAX_CREDIT_MINOR) {
      throw new AppError(`creditMinor must be a positive integer up to ${MAX_CREDIT_MINOR}`, 400);
    }
    const currency = (input.currency ?? "EUR").toUpperCase();
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    const storeName = input.storeName?.trim();
    let storeSlug: string | null = null;
    if (storeName) {
      storeSlug = await resolveUniqueSlug(storeName, async (candidate) => {
        const hit = await prisma.vendor.findUnique({ where: { storeSlug: candidate }, select: { id: true } });
        return hit !== null;
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: input.email,
          name: input.name,
          password: passwordHash,
          role: UserRole.BUYER,
          isTest: true,
          emailVerifiedAt: new Date(),
          country: input.country,
        },
      });

      const wallet = await tx.buyerWallet.create({
        data: { buyerId: user.id, currency, balance: creditMinor },
      });

      await tx.buyerWalletTransaction.create({
        data: {
          walletId: wallet.id,
          buyerId: user.id,
          type: "TOP_UP",
          amount: creditMinor,
          currency,
          description: `Demo account creation: ${input.reason}`,
        },
      });

      let vendor: { id: string; storeName: string; storeSlug: string } | null = null;
      if (storeName && storeSlug) {
        vendor = await tx.vendor.create({
          data: {
            userId: user.id,
            storeName,
            storeSlug,
            country: input.country,
            currency,
            isTest: true,
            verificationStatus: "VERIFIED",
            verifiedAt: new Date(),
          },
          select: { id: true, storeName: true, storeSlug: true },
        });
        // So the first product the demo adds publishes immediately
        // instead of sitting on "configure delivery to go live".
        await tx.deliveryZone.create({
          data: {
            vendorId: vendor.id,
            name: "Demo delivery zone",
            country: input.country ?? "GB",
            isActive: true,
            baseFeeAmount: 500,
            feePerKgAmount: 0,
          },
        });
      }

      return { userId: user.id, wallet, vendor };
    });

    return {
      userId: result.userId,
      email: input.email,
      isTest: true,
      walletBalanceMinor: result.wallet.balance,
      currency: result.wallet.currency,
      vendor: result.vendor,
    };
  },
};
