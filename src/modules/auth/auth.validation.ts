import { AppError } from "../../shared/errors/app-error";
import type { LoginInput, RegisterInput } from "./auth.types";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateRegisterInput(input: unknown): RegisterInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }

  const { email, password, name } = input as Partial<RegisterInput>;

  if (!email || typeof email !== "string" || !EMAIL_REGEX.test(email)) {
    throw new AppError("Invalid email", 400);
  }

  if (!password || typeof password !== "string" || password.length < 8) {
    throw new AppError("Password must be at least 8 characters", 400);
  }

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    throw new AppError("Invalid name", 400);
  }

  // Role is not client-provided at registration. All users start as BUYER
  // and are promoted to VENDOR only after creating a vendor profile.
  return {
    email: email.toLowerCase().trim(),
    password,
    name: name.trim(),
  };
}

export function validateLoginInput(input: unknown): LoginInput {
  if (!input || typeof input !== "object") {
    throw new AppError("Invalid request body", 400);
  }

  const { email, password } = input as Partial<LoginInput>;

  if (!email || typeof email !== "string") {
    throw new AppError("Invalid email", 400);
  }

  if (!password || typeof password !== "string") {
    throw new AppError("Invalid password", 400);
  }

  return {
    email: email.toLowerCase().trim(),
    password,
  };
}
