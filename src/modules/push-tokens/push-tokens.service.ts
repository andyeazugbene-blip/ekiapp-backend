import type { PushToken } from "@prisma/client";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

export const pushTokensService = {
  async register(userId: string, token: string, platform?: string): Promise<PushToken> {
    // Validate Expo push token format
    if (!token.startsWith("ExponentPushToken[") && !token.startsWith("ExpoPushToken[")) {
      throw new AppError("Invalid Expo push token format", 400);
    }

    // Upsert: if token already exists for this user, just return it
    return prisma.pushToken.upsert({
      where: { userId_token: { userId, token } },
      update: { platform },
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
