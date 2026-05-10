import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import { login, me, register } from "./auth.controller";

export const authRouter = Router();

authRouter.post("/register", asyncHandler(register));
authRouter.post("/login", asyncHandler(login));
authRouter.get("/me", authenticate, asyncHandler(me));
