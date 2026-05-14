import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";

export function getHealth(_request: Request, response: Response): void {
  response.status(200).json({
    status: "ok",
  });
}

export async function getHealthDetailed(_request: Request, response: Response): Promise<void> {
  const checks: Record<string, string> = { server: "ok" };

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch (error) {
    checks.database = `error: ${error instanceof Error ? error.message : String(error)}`;
  }

  const allOk = Object.values(checks).every((v) => v === "ok");
  response.status(allOk ? 200 : 503).json({ status: allOk ? "ok" : "degraded", checks });
}
