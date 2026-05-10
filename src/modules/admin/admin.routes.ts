import { Router } from "express";

import { authenticate, requireRole } from "../../middlewares/authenticate";
import {
  adminApprovePayoutRequest,
  adminListPayoutRequests,
  adminMarkPayoutRequestPaid,
  adminRejectPayoutRequest,
} from "../payouts/payouts.controller";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  approveProduct,
  approveVendor,
  disableProduct,
  listOrders,
  listPayments,
  listProducts,
  listUsers,
  listVendors,
  listWalletTransactions,
  rejectVendor,
} from "./admin-listings.controller";
import { completeOrder } from "./admin-orders.controller";

export const adminRouter = Router();

adminRouter.use(authenticate, requireRole("ADMIN"));

adminRouter.get("/users", asyncHandler(listUsers));
adminRouter.get("/vendors", asyncHandler(listVendors));
adminRouter.get("/products", asyncHandler(listProducts));
adminRouter.get("/orders", asyncHandler(listOrders));
adminRouter.get("/payments", asyncHandler(listPayments));
adminRouter.get("/wallet-transactions", asyncHandler(listWalletTransactions));

adminRouter.patch("/vendors/:id/approve", asyncHandler(approveVendor));
adminRouter.patch("/vendors/:id/reject", asyncHandler(rejectVendor));
adminRouter.patch("/products/:id/approve", asyncHandler(approveProduct));
adminRouter.patch("/products/:id/disable", asyncHandler(disableProduct));

adminRouter.patch("/orders/:id/complete", asyncHandler(completeOrder));

adminRouter.get("/payout-requests", asyncHandler(adminListPayoutRequests));
adminRouter.patch(
  "/payout-requests/:id/approve",
  asyncHandler(adminApprovePayoutRequest),
);
adminRouter.patch(
  "/payout-requests/:id/reject",
  asyncHandler(adminRejectPayoutRequest),
);
adminRouter.patch(
  "/payout-requests/:id/mark-paid",
  asyncHandler(adminMarkPayoutRequestPaid),
);
