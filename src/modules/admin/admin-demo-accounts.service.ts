import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

const MAX_CREDIT_MINOR = 1_000_000; // €10,000 cap per call — a deliberate ceiling, not a guess at what's "enough".
const DEFAULT_CREDIT_MINOR = 500_000; // €5,000 — generous for a marketing demo, never auto-applied silently (always an explicit admin action).

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
};
