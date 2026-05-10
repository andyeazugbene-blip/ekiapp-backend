import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  createPayoutMethod,
  createVendor,
  getOwnVendor,
  listPayoutMethods,
  updateOwnVendor,
} from "./vendors.controller";

export const vendorsRouter = Router();

vendorsRouter.use(authenticate);

vendorsRouter.post("/", asyncHandler(createVendor));
vendorsRouter.get("/me", asyncHandler(getOwnVendor));
vendorsRouter.patch("/me", asyncHandler(updateOwnVendor));
vendorsRouter.post("/me/payout-methods", asyncHandler(createPayoutMethod));
vendorsRouter.get("/me/payout-methods", asyncHandler(listPayoutMethods));
