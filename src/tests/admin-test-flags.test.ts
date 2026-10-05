/** Test-record flagging cascade (handbook 2.1 L139). */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { p } = vi.hoisted(() => {
  const upd = () => vi.fn(async () => ({ count: 1 }));
  return {
    p: {
      user: { findUnique: vi.fn(), updateMany: upd() },
      vendor: { findUnique: vi.fn(), updateMany: upd() },
      order: { findUnique: vi.fn(), updateMany: upd() },
      payment: { updateMany: upd() },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    },
  };
});
vi.mock("../lib/prisma", () => ({ prisma: p }));

import { adminTestFlagsService } from "../modules/admin/admin-test-flags.service";

beforeEach(() => vi.clearAllMocks());

describe("adminTestFlagsService", () => {
  it("flagging a user cascades to their vendor, orders bought or sold, and those payments", async () => {
    p.user.findUnique.mockResolvedValue({ id: "u1", role: "VENDOR", isTest: false, vendor: { id: "v1" } });
    const res = await adminTestFlagsService.setUserTest("u1", true);
    const orderWhere = { OR: [{ buyerId: "u1" }, { vendorId: "v1" }] };
    expect(p.user.updateMany).toHaveBeenCalledWith({ where: { id: "u1" }, data: { isTest: true } });
    expect(p.vendor.updateMany).toHaveBeenCalledWith({ where: { userId: "u1" }, data: { isTest: true } });
    expect(p.order.updateMany).toHaveBeenCalledWith({ where: orderWhere, data: { isTest: true } });
    expect(p.payment.updateMany).toHaveBeenCalledWith({ where: { order: orderWhere }, data: { isTest: true } });
    expect(res.before).toEqual({ isTest: false });
    expect(res.affected).toEqual({ users: 1, vendors: 1, orders: 1, payments: 1 });
  });

  it("unflagging uses the same cascade with isTest=false; buyer without vendor only matches buyerId", async () => {
    p.user.findUnique.mockResolvedValue({ id: "u2", role: "BUYER", isTest: true, vendor: null });
    await adminTestFlagsService.setUserTest("u2", false);
    expect(p.order.updateMany).toHaveBeenCalledWith({ where: { buyerId: "u2" }, data: { isTest: false } });
  });

  it("refuses admin accounts and unknown users", async () => {
    p.user.findUnique.mockResolvedValueOnce({ id: "a", role: "ADMIN", isTest: false, vendor: null });
    await expect(adminTestFlagsService.setUserTest("a", true)).rejects.toMatchObject({ statusCode: 400 });
    p.user.findUnique.mockResolvedValueOnce(null);
    await expect(adminTestFlagsService.setUserTest("zz", true)).rejects.toMatchObject({ statusCode: 404 });
    expect(p.$transaction).not.toHaveBeenCalled();
  });

  it("vendor flag cascades to its orders and payments but not the owner user", async () => {
    p.vendor.findUnique.mockResolvedValue({ id: "v1", isTest: false });
    await adminTestFlagsService.setVendorTest("v1", true);
    expect(p.user.updateMany).not.toHaveBeenCalled();
    expect(p.order.updateMany).toHaveBeenCalledWith({ where: { vendorId: "v1" }, data: { isTest: true } });
    expect(p.payment.updateMany).toHaveBeenCalledWith({ where: { order: { vendorId: "v1" } }, data: { isTest: true } });
  });

  it("order flag cascades to its payment only", async () => {
    p.order.findUnique.mockResolvedValue({ id: "o1", isTest: false });
    await adminTestFlagsService.setOrderTest("o1", true);
    expect(p.payment.updateMany).toHaveBeenCalledWith({ where: { orderId: "o1" }, data: { isTest: true } });
    expect(p.vendor.updateMany).not.toHaveBeenCalled();
  });
});
