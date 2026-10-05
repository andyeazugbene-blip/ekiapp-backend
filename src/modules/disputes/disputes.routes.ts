import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  partyAddEvidence,
  partyAddMessage,
  partyGetDispute,
  partyGetDisputeByOrder,
  partyRequestAppeal,
} from "./disputes.controller";

/** Buyer/vendor-facing dispute endpoints. Party membership is enforced per dispute in the service. */
export const disputesRouter = Router();
disputesRouter.use(authenticate);
disputesRouter.get("/order/:orderId", asyncHandler(partyGetDisputeByOrder));
disputesRouter.get("/:id", asyncHandler(partyGetDispute));
disputesRouter.post("/:id/evidence", asyncHandler(partyAddEvidence));
disputesRouter.post("/:id/messages", asyncHandler(partyAddMessage));
disputesRouter.post("/:id/appeal", asyncHandler(partyRequestAppeal));
