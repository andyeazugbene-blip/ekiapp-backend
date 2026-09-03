import type { Prisma } from "@prisma/client";
import { LedgerAccountType, LedgerDirection, LedgerOwnerType } from "@prisma/client";

import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";

type Tx = Prisma.TransactionClient;

/**
 * Internal double-entry ledger (architecture doc §3).
 *
 * This is additive bookkeeping — it runs alongside the existing
 * Payment/Order/Wallet records and never changes their behavior. Every
 * caller wraps its posting call in a try/catch (see `postEntriesSafely`)
 * so a ledger bug can never block or roll back a real payment/refund.
 *
 * The chart-of-accounts mapping used by callers (which event posts to
 * which LedgerAccountType) is an ENGINEERING DEFAULT, not a confirmed
 * accounting policy — see docs/decisions/0006-ledger-chart-of-accounts.md.
 * Entries are append-only: corrections are reversing entries, never
 * updates or deletes.
 */

const PLATFORM_OWNER_ID = "PLATFORM";

export interface LedgerLeg {
  accountType: LedgerAccountType;
  ownerType: LedgerOwnerType;
  ownerId?: string | null; // omit/null for platform-owned accounts
  direction: LedgerDirection;
  amount: number; // minor units, must be > 0
}

export interface PostEntriesInput {
  currency: string;
  businessRefType: string;
  businessRefId: string;
  providerRef?: string | null;
  description: string;
  legs: LedgerLeg[];
}

async function getOrCreateAccount(
  tx: Tx,
  type: LedgerAccountType,
  currency: string,
  ownerType: LedgerOwnerType,
  ownerId: string | null | undefined,
) {
  const resolvedOwnerId = ownerId ?? PLATFORM_OWNER_ID;
  const existing = await tx.ledgerAccount.findUnique({
    where: { type_currency_ownerType_ownerId: { type, currency, ownerType, ownerId: resolvedOwnerId } },
  });
  if (existing) return existing;
  try {
    return await tx.ledgerAccount.create({
      data: { type, currency, ownerType, ownerId: resolvedOwnerId },
    });
  } catch (error) {
    // Concurrent first-write race — the unique constraint means the other
    // writer succeeded; re-read rather than fail the caller's transaction.
    const existingAfterRace = await tx.ledgerAccount.findUnique({
      where: { type_currency_ownerType_ownerId: { type, currency, ownerType, ownerId: resolvedOwnerId } },
    });
    if (existingAfterRace) return existingAfterRace;
    throw error;
  }
}

export const ledgerService = {
  /**
   * Post a balanced set of entries (2+ legs) in one atomic write. Throws if
   * debits don't equal credits — a caller passing unbalanced legs is a bug,
   * and posting an unbalanced ledger is worse than not posting at all.
   */
  async postEntries(tx: Tx, input: PostEntriesInput) {
    // A zero-amount leg (e.g. a 0bps platform-fee plan) is not an error —
    // just nothing to post for that account. Drop it before validating.
    const legs = input.legs.filter((l) => l.amount > 0);
    if (legs.length < 2) throw new Error("ledger: postEntries requires at least 2 non-zero legs");
    const debitTotal = legs.filter((l) => l.direction === LedgerDirection.DEBIT).reduce((s, l) => s + l.amount, 0);
    const creditTotal = legs.filter((l) => l.direction === LedgerDirection.CREDIT).reduce((s, l) => s + l.amount, 0);
    if (debitTotal !== creditTotal) {
      throw new Error(
        `ledger: unbalanced entry for ${input.businessRefType}:${input.businessRefId} — debits=${debitTotal} credits=${creditTotal}`,
      );
    }

    const entries: Awaited<ReturnType<Tx["ledgerEntry"]["create"]>>[] = [];
    for (const leg of legs) {
      const account = await getOrCreateAccount(tx, leg.accountType, input.currency, leg.ownerType, leg.ownerId);
      const entry = await tx.ledgerEntry.create({
        data: {
          accountId: account.id,
          direction: leg.direction,
          amount: leg.amount,
          currency: input.currency,
          businessRefType: input.businessRefType,
          businessRefId: input.businessRefId,
          providerRef: input.providerRef ?? null,
          description: input.description,
        },
      });
      entries.push(entry);
    }
    return entries;
  },

  /** Same as postEntries but swallows and logs errors — for call sites where the ledger must never affect the outer transaction's outcome. */
  async postEntriesSafely(tx: Tx, input: PostEntriesInput): Promise<void> {
    try {
      await this.postEntries(tx, input);
    } catch (error) {
      logger.error("Ledger posting failed (non-fatal — payment/refund still proceeds)", {
        businessRefType: input.businessRefType,
        businessRefId: input.businessRefId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  },

  /**
   * Reverse every not-yet-reversed entry previously posted for this
   * business record — posts an opposite-direction entry on the same
   * account for each, linked via reversesEntryId. Idempotent: entries
   * that already have a reversal are skipped.
   */
  async reverseEntries(
    tx: Tx,
    params: { businessRefType: string; businessRefId: string; providerRef?: string | null; description: string },
  ): Promise<void> {
    const originals = await tx.ledgerEntry.findMany({
      where: { businessRefType: params.businessRefType, businessRefId: params.businessRefId, reversesEntryId: null },
    });
    if (originals.length === 0) return;

    const alreadyReversed = await tx.ledgerEntry.findMany({
      where: { reversesEntryId: { in: originals.map((o) => o.id) } },
      select: { reversesEntryId: true },
    });
    const reversedIds = new Set(alreadyReversed.map((r) => r.reversesEntryId));

    for (const original of originals) {
      if (reversedIds.has(original.id)) continue;
      await tx.ledgerEntry.create({
        data: {
          accountId: original.accountId,
          direction: original.direction === LedgerDirection.DEBIT ? LedgerDirection.CREDIT : LedgerDirection.DEBIT,
          amount: original.amount,
          currency: original.currency,
          businessRefType: params.businessRefType,
          businessRefId: params.businessRefId,
          providerRef: params.providerRef ?? original.providerRef,
          description: params.description,
          reversesEntryId: original.id,
        },
      });
    }
  },

  /** Sum of an account's entries (credits − debits), for reconciliation/reporting. Read-only. */
  async getAccountBalance(type: LedgerAccountType, currency: string, ownerType: LedgerOwnerType, ownerId?: string | null): Promise<number> {
    const account = await prisma.ledgerAccount.findUnique({
      where: { type_currency_ownerType_ownerId: { type, currency, ownerType, ownerId: ownerId ?? PLATFORM_OWNER_ID } },
      include: { entries: true },
    });
    if (!account) return 0;
    return account.entries.reduce((sum, e) => sum + (e.direction === LedgerDirection.CREDIT ? e.amount : -e.amount), 0);
  },
};
