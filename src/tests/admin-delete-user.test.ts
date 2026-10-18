/**
 * Found 18 Oct 2026 via a real-Postgres check: a DELETE blocked by an
 * explicit `onDelete: Restrict` FK (every relation deleteUser()'s hard-
 * delete attempt can hit — Order.buyerId among them) surfaces as a
 * PrismaClientUnknownRequestError with NO `.code` at all, unlike an
 * insert/update FK violation (P2003/P2014). The old guard only checked
 * `.code`, so every user with real order history got an unhandled 500
 * instead of falling through to the anonymize fallback this exists for.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userDelete: vi.fn(),
  pushTokenDeleteMany: vi.fn(),
  notificationDeleteMany: vi.fn(),
  productUpdateMany: vi.fn(),
  vendorUpdate: vi.fn(),
  userUpdate: vi.fn(),
}));

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: { findUnique: m.userFindUnique, delete: m.userDelete, update: m.userUpdate },
    pushToken: { deleteMany: m.pushTokenDeleteMany },
    notification: { deleteMany: m.notificationDeleteMany },
    product: { updateMany: m.productUpdateMany },
    vendor: { update: m.vendorUpdate },
    $transaction: (fn: any) =>
      fn({
        pushToken: { deleteMany: m.pushTokenDeleteMany },
        notification: { deleteMany: m.notificationDeleteMany },
        product: { updateMany: m.productUpdateMany },
        vendor: { update: m.vendorUpdate },
        user: { update: m.userUpdate },
      }),
  },
}));

import { adminListingsService } from "../modules/admin/admin-listings.service";

function restrictViolation(): Error {
  // Mirrors the real shape confirmed against Postgres: no `.code`, the
  // Postgres error code and "RESTRICT" text only in the message.
  return new Error(
    'Error occurred during query execution:\nConnectorError(... PostgresError { code: "23001", message: "update or delete on table \\"User\\" violates RESTRICT setting of foreign key constraint \\"Order_buyerId_fkey\\" on table \\"Order\\"" ...',
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  m.userFindUnique.mockResolvedValue({ id: "u1", role: "BUYER", createdAt: new Date(), vendor: null });
  m.pushTokenDeleteMany.mockResolvedValue({});
  m.notificationDeleteMany.mockResolvedValue({});
  m.userUpdate.mockResolvedValue({ id: "u1", email: "deleted_u1@anonymized.local", name: "Deleted user", role: "BUYER", isSuspended: true, suspendedReason: "test", createdAt: new Date(), updatedAt: new Date() });
});

describe("adminListingsService.deleteUser", () => {
  it("hard-deletes when nothing restricts it", async () => {
    m.userDelete.mockResolvedValue({});
    const result = await adminListingsService.deleteUser("u1", "test");
    expect(result.hardDeleted).toBe(true);
  });

  it("falls through to anonymize on a raw RESTRICT-FK violation with no .code (the real bug)", async () => {
    m.userDelete.mockRejectedValue(restrictViolation());
    const result = await adminListingsService.deleteUser("u1", "test");
    expect(result.hardDeleted).toBe(false);
    expect(m.userUpdate).toHaveBeenCalled();
  });

  it("still falls through on Prisma's own known P2003/P2014 codes", async () => {
    const err = Object.assign(new Error("Foreign key constraint failed"), { code: "P2003" });
    m.userDelete.mockRejectedValue(err);
    const result = await adminListingsService.deleteUser("u1", "test");
    expect(result.hardDeleted).toBe(false);
  });

  it("re-throws an unrelated error instead of silently anonymizing", async () => {
    m.userDelete.mockRejectedValue(new Error("Connection terminated unexpectedly"));
    await expect(adminListingsService.deleteUser("u1", "test")).rejects.toThrow("Connection terminated unexpectedly");
    expect(m.userUpdate).not.toHaveBeenCalled();
  });

  it("refuses to delete an admin account", async () => {
    m.userFindUnique.mockResolvedValue({ id: "a1", role: "ADMIN", createdAt: new Date(), vendor: null });
    await expect(adminListingsService.deleteUser("a1", "test")).rejects.toMatchObject({ statusCode: 409 });
  });
});
