import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import { calculateDelivery } from "./delivery.controller";
import {
  addDeliveryMethod,
  createVendorZone,
  deleteDeliveryMethod,
  deleteVendorZone,
  listActiveZones,
  listVendorZones,
  updateDeliveryMethod,
  updateVendorZone,
} from "./delivery-zones.controller";

export const deliveryRouter = Router();

// Public: list active delivery zones
deliveryRouter.get("/zones", asyncHandler(listActiveZones));

// Authenticated
deliveryRouter.post("/calculate", authenticate, asyncHandler(calculateDelivery));

// Vendor: manage own delivery zones
deliveryRouter.get("/zones/me", authenticate, asyncHandler(listVendorZones));
deliveryRouter.post("/zones/me", authenticate, asyncHandler(createVendorZone));
deliveryRouter.patch("/zones/me/:id", authenticate, asyncHandler(updateVendorZone));
deliveryRouter.delete("/zones/me/:id", authenticate, asyncHandler(deleteVendorZone));

// Vendor: manage delivery methods within a zone
deliveryRouter.post("/zones/me/:zoneId/methods", authenticate, asyncHandler(addDeliveryMethod));
deliveryRouter.patch("/methods/:id", authenticate, asyncHandler(updateDeliveryMethod));
deliveryRouter.delete("/methods/:id", authenticate, asyncHandler(deleteDeliveryMethod));
