import { describe, it, expect, vi, beforeEach } from "vitest";
import { LedgerAccountType, LedgerDirection, LedgerOwnerType } from "@prisma/client";

import { ledgerService } from "../modules/ledger/ledger.service";

function makeFakeTx() {
  const accounts = new Map<string, { id: string; type: string; currency: string; ownerType: string; ownerId: string }>();
  const entries: any[] = [];
  let accountSeq = 0;
  let entrySeq = 0;

  return {
    ledgerAccount: {
      findUnique: vi.fn(async ({ where: { type_currency_ownerType_ownerId: k } }: any) => {
        const key = `${k.type}:${k.currency}:${k.ownerType}:${k.ownerId}`;
        return accounts.get(key) ?? null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const key = `${data.type}:${data.currency}:${data.ownerType}:${data.ownerId}`;
        const account = { id: `acct-${++accountSeq}`, ...data };
        accounts.set(key, account);
        return account;
      }),
    },
    ledgerEntry: {
      create: vi.fn(async ({ data }: any) => {
        const entry = { id: `entry-${++entrySeq}`, reversesEntryId: null, ...data };
        entries.push(entry);
        return entry;
      }),
      findMany: vi.fn(async ({ where }: any) => {
        if (where.businessRefType && where.reversesEntryId === null) {
          return entries.filter((e) => e.businessRefType === where.businessRefType && e.businessRefId === where.businessRefId && e.reversesEntryId === null);
        }
        if (where.reversesEntryId?.in) {
          return entries.filter((e) => where.reversesEntryId.in.includes(e.reversesEntryId));
        }
        return [];
      }),
    },
    _entries: entries,
  };
}

describe("ledgerService.postEntries", () => {
  let tx: ReturnType<typeof makeFakeTx>;
  beforeEach(() => { tx = makeFakeTx(); });

  it("posts a balanced 2-leg entry and creates accounts on first use", async () => {
    const entries = await ledgerService.postEntries(tx as any, {
      currency: "gbp",
      businessRefType: "Payment",
      businessRefId: "pay-1",
      providerRef: "pi_123",
      description: "test capture",
      legs: [
        { accountType: LedgerAccountType.PROVIDER_CASH, ownerType: LedgerOwnerType.PLATFORM, direction: LedgerDirection.DEBIT, amount: 1000 },
        { accountType: LedgerAccountType.VENDOR_PAYABLE, ownerType: LedgerOwnerType.VENDOR, ownerId: "vendor-1", direction: LedgerDirection.CREDIT, amount: 1000 },
      ],
    });

    expect(entries).toHaveLength(2);
    expect(tx.ledgerAccount.create).toHaveBeenCalledTimes(2);
  });

  it("reuses an existing account instead of creating a duplicate", async () => {
    const leg = { accountType: LedgerAccountType.PROVIDER_CASH, ownerType: LedgerOwnerType.PLATFORM, direction: LedgerDirection.DEBIT, amount: 500 };
    const credit = { accountType: LedgerAccountType.VENDOR_PAYABLE, ownerType: LedgerOwnerType.VENDOR, ownerId: "vendor-1", direction: LedgerDirection.CREDIT, amount: 500 };

    await ledgerService.postEntries(tx as any, { currency: "gbp", businessRefType: "Payment", businessRefId: "pay-1", description: "first", legs: [leg, credit] });
    await ledgerService.postEntries(tx as any, { currency: "gbp", businessRefType: "Payment", businessRefId: "pay-2", description: "second", legs: [leg, credit] });

    // Same account reused both times — only 2 accounts total, not 4.
    expect(tx.ledgerAccount.create).toHaveBeenCalledTimes(2);
  });

  it("throws when debits do not equal credits — an unbalanced ledger must never be posted", async () => {
    await expect(
      ledgerService.postEntries(tx as any, {
        currency: "gbp",
        businessRefType: "Payment",
        businessRefId: "pay-bad",
        description: "unbalanced",
        legs: [
          { accountType: LedgerAccountType.PROVIDER_CASH, ownerType: LedgerOwnerType.PLATFORM, direction: LedgerDirection.DEBIT, amount: 1000 },
          { accountType: LedgerAccountType.VENDOR_PAYABLE, ownerType: LedgerOwnerType.VENDOR, ownerId: "vendor-1", direction: LedgerDirection.CREDIT, amount: 900 },
        ],
      }),
    ).rejects.toThrow(/unbalanced/);
  });

  it("drops zero-amount legs (e.g. a 0bps platform fee) without breaking balance", async () => {
    const entries = await ledgerService.postEntries(tx as any, {
      currency: "gbp",
      businessRefType: "Payment",
      businessRefId: "pay-zero-fee",
      description: "zero fee plan",
      legs: [
        { accountType: LedgerAccountType.PROVIDER_CASH, ownerType: LedgerOwnerType.PLATFORM, direction: LedgerDirection.DEBIT, amount: 1000 },
        { accountType: LedgerAccountType.VENDOR_PAYABLE, ownerType: LedgerOwnerType.VENDOR, ownerId: "vendor-1", direction: LedgerDirection.CREDIT, amount: 1000 },
        { accountType: LedgerAccountType.PLATFORM_FEE_REVENUE, ownerType: LedgerOwnerType.PLATFORM, direction: LedgerDirection.CREDIT, amount: 0 },
      ],
    });
    expect(entries).toHaveLength(2);
  });

  it("postEntriesSafely swallows errors and never throws", async () => {
    await expect(
      ledgerService.postEntriesSafely(tx as any, {
        currency: "gbp",
        businessRefType: "Payment",
        businessRefId: "pay-bad-2",
        description: "unbalanced but safe",
        legs: [
          { accountType: LedgerAccountType.PROVIDER_CASH, ownerType: LedgerOwnerType.PLATFORM, direction: LedgerDirection.DEBIT, amount: 1000 },
          { accountType: LedgerAccountType.VENDOR_PAYABLE, ownerType: LedgerOwnerType.VENDOR, ownerId: "vendor-1", direction: LedgerDirection.CREDIT, amount: 1 },
        ],
      }),
    ).resolves.toBeUndefined();
  });
});

describe("ledgerService.reverseEntries", () => {
  let tx: ReturnType<typeof makeFakeTx>;
  beforeEach(() => { tx = makeFakeTx(); });

  it("posts an opposite-direction entry for every original leg, linked via reversesEntryId", async () => {
    await ledgerService.postEntries(tx as any, {
      currency: "gbp",
      businessRefType: "Payment",
      businessRefId: "pay-1",
      description: "capture",
      legs: [
        { accountType: LedgerAccountType.PROVIDER_CASH, ownerType: LedgerOwnerType.PLATFORM, direction: LedgerDirection.DEBIT, amount: 1000 },
        { accountType: LedgerAccountType.VENDOR_PAYABLE, ownerType: LedgerOwnerType.VENDOR, ownerId: "vendor-1", direction: LedgerDirection.CREDIT, amount: 1000 },
      ],
    });

    await ledgerService.reverseEntries(tx as any, { businessRefType: "Payment", businessRefId: "pay-1", description: "refund" });

    const reversals = tx._entries.filter((e) => e.reversesEntryId !== null);
    expect(reversals).toHaveLength(2);
    expect(reversals.find((e) => e.direction === LedgerDirection.CREDIT && e.accountId === tx._entries[0].accountId)).toBeTruthy();
  });

  it("is idempotent — calling reverseEntries twice does not double-reverse", async () => {
    await ledgerService.postEntries(tx as any, {
      currency: "gbp",
      businessRefType: "Payment",
      businessRefId: "pay-1",
      description: "capture",
      legs: [
        { accountType: LedgerAccountType.PROVIDER_CASH, ownerType: LedgerOwnerType.PLATFORM, direction: LedgerDirection.DEBIT, amount: 1000 },
        { accountType: LedgerAccountType.VENDOR_PAYABLE, ownerType: LedgerOwnerType.VENDOR, ownerId: "vendor-1", direction: LedgerDirection.CREDIT, amount: 1000 },
      ],
    });

    await ledgerService.reverseEntries(tx as any, { businessRefType: "Payment", businessRefId: "pay-1", description: "refund attempt 1" });
    await ledgerService.reverseEntries(tx as any, { businessRefType: "Payment", businessRefId: "pay-1", description: "refund attempt 2 (duplicate webhook replay)" });

    const reversals = tx._entries.filter((e) => e.reversesEntryId !== null);
    expect(reversals).toHaveLength(2); // still 2, not 4
  });

  it("does nothing when there are no original entries for the business ref", async () => {
    await ledgerService.reverseEntries(tx as any, { businessRefType: "Payment", businessRefId: "never-posted", description: "no-op" });
    expect(tx._entries).toHaveLength(0);
  });
});
