import { prisma } from "../lib/prisma";
import { AppError } from "./errors/app-error";

/**
 * Demo and QA accounts (isTest) hold wallet credit that was never paid for, so
 * they must never transact with real accounts: fake credit reaching a real
 * vendor would become a real payout, and a real buyer paying a demo store
 * would be charged for goods nobody will ship. These helpers are that boundary.
 */
export const TEST_ACCOUNT_ISOLATION_CODE = "TEST_ACCOUNT_ISOLATION";
export const DEMO_REAL_CARD_BLOCKED_CODE = "DEMO_REAL_CARD_BLOCKED";

export async function viewerIsTest(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { isTest: true } });
  return user?.isTest === true;
}

/** Throws unless the buyer and every seller are on the same side of the boundary. */
export async function assertSameAccountWorld(buyerId: string, vendorIds: string[]): Promise<void> {
  const [buyerIsTest, vendors] = await Promise.all([
    viewerIsTest(buyerId),
    prisma.vendor.findMany({ where: { id: { in: [...new Set(vendorIds)] } }, select: { isTest: true } }),
  ]);
  if (vendors.every((vendor) => vendor.isTest === buyerIsTest)) return;
  throw new AppError(
    buyerIsTest ? "Demo accounts can only buy from demo stores." : "This item is not available.",
    403,
    undefined,
    TEST_ACCOUNT_ISOLATION_CODE,
  );
}

/**
 * On live Stripe a demo account's card would be really charged, for goods that
 * don't exist. Test mode stays open so the card flow can still be exercised.
 */
export async function assertCardAllowedForAccount(userId: string): Promise<void> {
  if (!(process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_live_")) return;
  if (!(await viewerIsTest(userId))) return;
  throw new AppError(
    "Demo accounts don't use real cards. Everything else in this flow works normally.",
    403,
    undefined,
    DEMO_REAL_CARD_BLOCKED_CODE,
  );
}
