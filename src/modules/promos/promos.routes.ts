import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import { validatePromo } from "./promos.controller";

export const promosRouter = Router();

promosRouter.use(authenticate);

// Buyer: validate a promo code
promosRouter.post("/validate", asyncHandler(validatePromo));
