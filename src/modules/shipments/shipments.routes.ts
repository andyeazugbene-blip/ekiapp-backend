import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  createShipment,
  getShipmentByOrder,
  listVendorShipments,
  updateShipment,
} from "./shipments.controller";

export const shipmentsRouter = Router();

shipmentsRouter.use(authenticate);

// Vendor: manage shipments
shipmentsRouter.get("/", asyncHandler(listVendorShipments));
shipmentsRouter.post("/orders/:orderId", asyncHandler(createShipment));
shipmentsRouter.patch("/:id", asyncHandler(updateShipment));

// Buyer/Vendor: view shipment by order
shipmentsRouter.get("/orders/:orderId", asyncHandler(getShipmentByOrder));
