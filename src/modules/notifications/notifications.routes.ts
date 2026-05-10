import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import { listNotifications, markNotificationRead } from "./notifications.controller";

export const notificationsRouter = Router();

notificationsRouter.use(authenticate);

notificationsRouter.get("/", asyncHandler(listNotifications));
notificationsRouter.patch("/:id/read", asyncHandler(markNotificationRead));
