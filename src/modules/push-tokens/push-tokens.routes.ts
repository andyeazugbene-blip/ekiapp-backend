import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import { registerPushToken, removePushToken } from "./push-tokens.controller";

export const pushTokensRouter = Router();

pushTokensRouter.use(authenticate);

pushTokensRouter.post("/", asyncHandler(registerPushToken));
pushTokensRouter.delete("/:token", asyncHandler(removePushToken));
