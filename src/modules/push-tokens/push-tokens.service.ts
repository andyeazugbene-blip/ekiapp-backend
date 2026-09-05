import type { PushToken } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

export const pushTokensService = {
  async register(userId: string, token: string, platform?: string): Promise<PushToken> {
    // Validate Expo push token format
    if (!token.startsWith("ExponentPushToken[") && !token.startsWith("ExpoPushToken[")) {
      throw new AppError("Invalid Expo push token format", 400);
    }

    // token is globally unique — a device installation belongs to exactly
    // one user at a time. If this exact token was previously registered
    // under a DIFFERENT user (logout, then a different account signs in on
    // the same device), re-registering it here reassigns it to the current
    // user instead of leaving a stale second row that would keep pushing
    // to a device its old owner is no longer signed into.
    return prisma.pushToken.upsert({
      where: { token },
      update: { userId, platform },
      create: { userId, token, platform },
    });
  },

  async remove(userId: string, token: string): Promise<void> {
    const result = await prisma.pushToken.deleteMany({
      where: { userId, token },
    });
    if (result.count === 0) {
      throw new AppError("Push token not found", 404);
    }
  },
};
