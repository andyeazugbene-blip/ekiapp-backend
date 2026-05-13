import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  createAddress,
  deleteAddress,
  listAddresses,
  updateAddress,
} from "./addresses.controller";

export const addressesRouter = Router();

addressesRouter.use(authenticate);

addressesRouter.get("/", asyncHandler(listAddresses));
addressesRouter.post("/", asyncHandler(createAddress));
addressesRouter.patch("/:id", asyncHandler(updateAddress));
addressesRouter.delete("/:id", asyncHandler(deleteAddress));
