import type { Request, Response } from "express";

import { AppError } from "../../shared/errors/app-error";
import { authService } from "./auth.service";
import { validateLoginInput, validateRegisterInput } from "./auth.validation";

export async function register(request: Request, response: Response): Promise<void> {
  const input = validateRegisterInput(request.body);
  const result = await authService.register(input);
  response.status(201).json(result);
}

export async function login(request: Request, response: Response): Promise<void> {
  const input = validateLoginInput(request.body);
  const result = await authService.login(input);
  response.status(200).json(result);
}

export async function me(request: Request, response: Response): Promise<void> {
  if (!request.user) {
    throw new AppError("Unauthorized", 401);
  }
  const user = await authService.getCurrentUser(request.user.id);
  response.status(200).json({ user });
}
