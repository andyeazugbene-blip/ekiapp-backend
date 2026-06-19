import type { NextFunction, Request, Response } from "express";

import { AppError } from "../shared/errors/app-error";
import { prisma } from "../lib/prisma";

type SellerPlanFeature = "analytics" | "bundles" | "flashSales" | "discounts" | "marketingTools" | "canReceiveOrders";

export function requireSellerPlanFeature(feature: SellerPlanFeature) {
  return async (request: Request, _response: Response, next: NextFunction): Promise<void> => {
    try {
      if (!request.user) throw new AppError("Unauthorized", 401);

      const vendor = await prisma.vendor.findUnique({ where: { userId: request.user.id }, select: { id: true } });
      if (!vendor) throw new AppError("Vendor profile required", 403);

      const subscription = await prisma.vendorSubscription.findUnique({
        where: { vendorId: vendor.id },
        select: { sellerPlan: { select: { [feature]: true } } },
      });

      const allowed = Boolean((subscription?.sellerPlan as Record<string, boolean> | null)?.[feature]);
      if (!allowed) {
        throw new AppError(`Your current plan does not include this feature: ${feature}`, 403);
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
