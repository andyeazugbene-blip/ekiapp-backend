/**
 * Regression tests for the buyer-wallet race-condition fix (commit a41e10d).
 *
 * getWallet() and listTransactions() both resolve the buyer's wallet via
 * getOrCreateWallet(). The mobile Wallet screen fires both requests
 * concurrently on load, so the loser's findUnique() can return null before
 * either create() commits, throwing a raw Prisma P2002 unique-constraint
 * error instead of ever seeing the winner's row. Fixed with a
 * create-and-catch-P2002-then-refetch pattern (mirrors webhook idempotency
 * elsewhere in this codebase) — these tests pin that exact behavior down so
 * it can't silently regress.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("../lib/prisma", () => ({
  prisma: {
    buyerWallet: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
    },
    buyerWalletTransaction: { findMany: vi.fn() },
  },
}));

vi.mock("../lib/stripe", () => ({
  stripe: { paymentIntents: { create: vi.fn() } },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { buyerWalletService } from "../modules/buyer-wallet/buyer-wallet.service";

const m = vi.mocked(prisma, true);
const BUYER_ID = "buyer-1";

function p2002() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`buyerId`)", {
    code: "P2002",
    clientVersion: "6.0.0",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getOrCreateWallet() via getWallet() — P2002 race handling", () => {
  it("returns the existing wallet without calling create() when one already exists", async () => {
    m.buyerWallet.findUnique.mockResolvedValue({ id: "wallet-1", buyerId: BUYER_ID, balance: 0 } as any);

    const result = await buyerWalletService.getWallet(BUYER_ID);

    expect(result).toEqual({ id: "wallet-1", buyerId: BUYER_ID, balance: 0 });
    expect(m.buyerWallet.create).not.toHaveBeenCalled();
  });

  it("creates a new wallet on a genuinely first visit (no race)", async () => {
    m.buyerWallet.findUnique.mockResolvedValue(null as any);
    m.buyerWallet.create.mockResolvedValue({ id: "wallet-new", buyerId: BUYER_ID, balance: 0 } as any);

    const result = await buyerWalletService.getWallet(BUYER_ID);

    expect(result).toEqual({ id: "wallet-new", buyerId: BUYER_ID, balance: 0 });
    expect(m.buyerWallet.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ buyerId: BUYER_ID }) }));
  });

  it("loses the create race (P2002), never throws, and returns the winner's row instead of a duplicate", async () => {
    m.buyerWallet.findUnique.mockResolvedValue(null as any);
    m.buyerWallet.create.mockRejectedValue(p2002());
    m.buyerWallet.findUniqueOrThrow.mockResolvedValue({ id: "wallet-winner", buyerId: BUYER_ID, balance: 0 } as any);

    const result = await buyerWalletService.getWallet(BUYER_ID);

    expect(result).toEqual({ id: "wallet-winner", buyerId: BUYER_ID, balance: 0 });
    expect(m.buyerWallet.findUniqueOrThrow).toHaveBeenCalledWith({ where: { buyerId: BUYER_ID } });
  });

  it("does not hide an unrelated database error behind the P2002 recovery path", async () => {
    m.buyerWallet.findUnique.mockResolvedValue(null as any);
    m.buyerWallet.create.mockRejectedValue(new Error("Can't reach database server"));

    await expect(buyerWalletService.getWallet(BUYER_ID)).rejects.toThrow("Can't reach database server");
    expect(m.buyerWallet.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("does not hide a different Prisma error code behind the P2002 recovery path", async () => {
    m.buyerWallet.findUnique.mockResolvedValue(null as any);
    m.buyerWallet.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", { code: "P2003", clientVersion: "6.0.0" }),
    );

    await expect(buyerWalletService.getWallet(BUYER_ID)).rejects.toMatchObject({ code: "P2003" });
    expect(m.buyerWallet.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe("listTransactions() — the concurrent caller that used to lose the race", () => {
  it("resolves the wallet via the same P2002-safe path before listing transactions", async () => {
    m.buyerWallet.findUnique.mockResolvedValue(null as any);
    m.buyerWallet.create.mockRejectedValue(p2002());
    m.buyerWallet.findUniqueOrThrow.mockResolvedValue({ id: "wallet-winner", buyerId: BUYER_ID, balance: 0 } as any);
    m.buyerWalletTransaction.findMany.mockResolvedValue([]);

    const result = await buyerWalletService.listTransactions(BUYER_ID, { limit: 20 } as any);

    expect(result).toEqual({ items: [], nextCursor: null });
    expect(m.buyerWalletTransaction.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { walletId: "wallet-winner" } }));
  });
});
