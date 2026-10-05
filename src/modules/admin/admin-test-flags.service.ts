/**
 * Handbook 2.1 L139 / 14.12 — flag / unflag QA records as test data so they
 * are labelled and excluded from production metrics by default.
 *
 * Cascade rules:
 *   user   -> the user, their vendor (if any), orders they bought or sold,
 *             and those orders' payments
 *   vendor -> the vendor, orders sold by it, and those orders' payments
 *   order  -> the order and its payment
 */
import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

export type TestFlagEntity = "user" | "vendor" | "order";

export interface TestFlagResult {
  entity: TestFlagEntity;
  id: string;
  isTest: boolean;
  before: { isTest: boolean };
  affected: { users: number; vendors: number; orders: number; payments: number };
}

export const adminTestFlagsService = {
  async setUserTest(userId: string, isTest: boolean): Promise<TestFlagResult> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, isTest: true, vendor: { select: { id: true } } },
    });
    if (!user) throw new AppError("User not found", 404);
    if (user.role === "ADMIN") throw new AppError("Admin accounts cannot be flagged as test records", 400);

    const vendorId = user.vendor?.id;
    const orderWhere = vendorId ? { OR: [{ buyerId: userId }, { vendorId }] } : { buyerId: userId };

    const [u, v, o, p] = await prisma.$transaction([
      prisma.user.updateMany({ where: { id: userId }, data: { isTest } }),
      prisma.vendor.updateMany({ where: { userId }, data: { isTest } }),
      prisma.order.updateMany({ where: orderWhere, data: { isTest } }),
      prisma.payment.updateMany({ where: { order: orderWhere }, data: { isTest } }),
    ]);
    return {
      entity: "user", id: userId, isTest, before: { isTest: user.isTest },
      affected: { users: u.count, vendors: v.count, orders: o.count, payments: p.count },
    };
  },

  async setVendorTest(vendorId: string, isTest: boolean): Promise<TestFlagResult> {
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { id: true, isTest: true } });
    if (!vendor) throw new AppError("Vendor not found", 404);

    const [v, o, p] = await prisma.$transaction([
      prisma.vendor.updateMany({ where: { id: vendorId }, data: { isTest } }),
      prisma.order.updateMany({ where: { vendorId }, data: { isTest } }),
      prisma.payment.updateMany({ where: { order: { vendorId } }, data: { isTest } }),
    ]);
    return {
      entity: "vendor", id: vendorId, isTest, before: { isTest: vendor.isTest },
      affected: { users: 0, vendors: v.count, orders: o.count, payments: p.count },
    };
  },

  async setOrderTest(orderId: string, isTest: boolean): Promise<TestFlagResult> {
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, isTest: true } });
    if (!order) throw new AppError("Order not found", 404);

    const [o, p] = await prisma.$transaction([
      prisma.order.updateMany({ where: { id: orderId }, data: { isTest } }),
      prisma.payment.updateMany({ where: { orderId }, data: { isTest } }),
    ]);
    return {
      entity: "order", id: orderId, isTest, before: { isTest: order.isTest },
      affected: { users: 0, vendors: 0, orders: o.count, payments: p.count },
    };
  },
};
