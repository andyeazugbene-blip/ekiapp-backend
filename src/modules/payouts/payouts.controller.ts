import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { payoutsService } from "./payouts.service";
import {
  validateCreatePayoutRequestInput,
  validateListPayoutRequestsQuery,
  validateRejectPayoutRequestInput,
} from "./payouts.validation";

function requireUserId(request: Request): string {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  return request.user.id;
}

function requireIdParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new AppError("Invalid id", 400);
  }
  return id;
}

export async function createPayoutRequest(request: Request, response: Response): Promise<void> {
  const input = validateCreatePayoutRequestInput(request.body);
  const payoutRequest = await payoutsService.createRequest(requireUserId(request), input);
  response.status(201).json({ payoutRequest });
}

export async function listOwnPayoutRequests(request: Request, response: Response): Promise<void> {
  const payoutRequests = await payoutsService.listOwn(requireUserId(request));
  response.status(200).json({ payoutRequests });
}

export async function adminListPayoutRequests(
  request: Request,
  response: Response,
): Promise<void> {
  const query = validateListPayoutRequestsQuery(request.query as Record<string, unknown>);
  const payoutRequests = await payoutsService.adminList(query);
  response.status(200).json({ payoutRequests });
}

export async function adminApprovePayoutRequest(
  request: Request,
  response: Response,
): Promise<void> {
  const payoutRequest = await payoutsService.adminApprove(
    requireUserId(request),
    requireIdParam(request),
  );
  response.status(200).json({ payoutRequest });
}

export async function adminRejectPayoutRequest(
  request: Request,
  response: Response,
): Promise<void> {
  const input = validateRejectPayoutRequestInput(request.body);
  const payoutRequest = await payoutsService.adminReject(
    requireUserId(request),
    requireIdParam(request),
    input,
  );
  response.status(200).json({ payoutRequest });
}

export async function adminMarkPayoutRequestPaid(
  request: Request,
  response: Response,
): Promise<void> {
  const payoutRequest = await payoutsService.adminMarkPaid(
    requireUserId(request),
    requireIdParam(request),
  );
  response.status(200).json({ payoutRequest });
}
export async function adminGetPayoutRequest(
  request: Request,
  response: Response,
): Promise<void> {
  const payoutRequest = await payoutsService.adminGet(requireIdParam(request));
  response.status(200).json({ payoutRequest });
}
