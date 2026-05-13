import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import { applyToOrder, getWallet, listTransactions, topUp } from "./buyer-wallet.controller";

export const buyerWalletRouter = Router();

buyerWalletRouter.use(authenticate);

buyerWalletRouter.get("/me", asyncHandler(getWallet));
buyerWalletRouter.get("/me/transactions", asyncHandler(listTransactions));
buyerWalletRouter.post("/me/top-up", asyncHandler(topUp));
buyerWalletRouter.post("/me/apply", asyncHandler(applyToOrder));
