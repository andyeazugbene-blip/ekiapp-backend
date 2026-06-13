import { Router } from "express";

import { authenticate } from "../../middlewares/authenticate";
import { asyncHandler } from "../../shared/utils/async-handler";
import {
  getNotificationPreferences, listNotifications, markAllNotificationsRead, markNotificationRead,
  testPushNotification, updateNotificationPreferences,
} from "./notifications.controller";

export const notificationsRouter = Router();

notificationsRouter.use(authenticate);

notificationsRouter.get("/", asyncHandler(listNotifications));
notificationsRouter.get("/preferences", asyncHandler(getNotificationPreferences));
notificationsRouter.patch("/preferences", asyncHandler(updateNotificationPreferences));
notificationsRouter.patch("/read-all", asyncHandler(markAllNotificationsRead));
notificationsRouter.patch("/:id/read", asyncHandler(markNotificationRead));
notificationsRouter.post("/test-push", asyncHandler(testPushNotification));
