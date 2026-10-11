/**
 * Bug fix 2026-10-11 ("prevent duplicate notifications across repeated
 * scheduler runs and overlapping jobs"): unit coverage for withJobLock's
 * control flow against a mocked prisma.$transaction/$queryRaw. The actual
 * SQL (pg_try_advisory_lock/pg_advisory_unlock, and that the lock-acquire
 * and lock-release share one connection via an interactive $transaction)
 * was separately verified against a real local Postgres — mocks here only
 * prove withJobLock's own branching (skip vs run vs always-release).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mTx = { $queryRaw: vi.fn() };
vi.mock("../lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn((cb: (tx: typeof mTx) => unknown) => cb(mTx)),
  },
}));

import { prisma } from "../lib/prisma";
import { withJobLock } from "../modules/internal/internal.routes";

const m = vi.mocked(prisma, true) as any;

beforeEach(() => {
  vi.clearAllMocks();
  m.$transaction.mockImplementation((cb: (tx: typeof mTx) => unknown) => cb(mTx));
});

describe("withJobLock", () => {
  it("runs the job and returns its result when the advisory lock is free", async () => {
    mTx.$queryRaw.mockResolvedValueOnce([{ locked: true }]).mockResolvedValueOnce(undefined); // lock, then unlock
    const fn = vi.fn().mockResolvedValue({ processed: 3 });

    const result = await withJobLock("automation sweep", fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ processed: 3 });
    expect(mTx.$queryRaw).toHaveBeenCalledTimes(2); // lock + unlock
  });

  it("skips the job (never calls fn) when the advisory lock is already held", async () => {
    mTx.$queryRaw.mockResolvedValueOnce([{ locked: false }]);
    const fn = vi.fn();

    const result = await withJobLock("automation sweep", fn);

    expect(fn).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true, reason: "already_running" });
    expect(mTx.$queryRaw).toHaveBeenCalledTimes(1); // only the lock attempt — no unlock for a lock we don't hold
  });

  it("always releases the lock even when the job throws", async () => {
    mTx.$queryRaw.mockResolvedValueOnce([{ locked: true }]).mockResolvedValueOnce(undefined);
    const fn = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(withJobLock("automation sweep", fn)).rejects.toThrow("boom");

    expect(mTx.$queryRaw).toHaveBeenCalledTimes(2); // lock attempted AND unlock still ran (finally)
  });

  it("uses the job name as the lock key, so two different job names never collide", async () => {
    mTx.$queryRaw.mockResolvedValue([{ locked: true }]);
    await withJobLock("job-a", async () => ({}));
    await withJobLock("job-b", async () => ({}));

    const lockCalls = mTx.$queryRaw.mock.calls.filter((_, i) => i % 2 === 0);
    // Each call is a tagged-template invocation; the job name is passed as
    // the interpolated value, not hardcoded into the query string.
    expect(lockCalls[0][1]).toBe("job-a");
    expect(lockCalls[1][1]).toBe("job-b");
  });
});
