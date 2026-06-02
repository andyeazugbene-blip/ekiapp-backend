import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    emailVerificationToken: {
      create: vi.fn().mockResolvedValue({}),
    },
    vendor: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    wallet: {
      upsert: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("../lib/email-queue", () => ({
  enqueueEmail: vi.fn(),
}));

vi.mock("../lib/email-templates", () => ({
  emailTemplates: {
    welcomeBuyer: vi.fn().mockReturnValue({ subject: "Welcome", html: "<p>Hi</p>" }),
  },
}));

import { prisma } from "../lib/prisma";
import { authService } from "../modules/auth/auth.service";
import { vendorsService } from "../modules/vendors/vendors.service";

const userFindUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>;
const userFindFirst = prisma.user.findFirst as unknown as ReturnType<typeof vi.fn>;
const vendorFindUnique = prisma.vendor.findUnique as unknown as ReturnType<typeof vi.fn>;
const vendorFindFirst = prisma.vendor.findFirst as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Auth and vendor uniqueness guards", () => {
  it("blocks buyer registration when phone is already in use", async () => {
    userFindUnique.mockResolvedValue(null);
    userFindFirst.mockResolvedValue({ id: "user-existing" });

    await expect(
      authService.register({
        email: "fresh@example.com",
        password: "ValidPass123",
        name: "Fresh Buyer",
        phone: "+233565544556",
      }),
    ).rejects.toThrow("Phone already registered");
  });

  it("blocks profile phone changes when another account already uses the phone", async () => {
    userFindUnique.mockResolvedValue({ id: "user-1", phone: "+233111111111" });
    userFindFirst.mockResolvedValue({ id: "user-2" });

    await expect(
      authService.updateProfile("user-1", { phone: "+233565544556" }),
    ).rejects.toThrow("Phone already registered");
  });

  it("blocks vendor creation when store name already exists", async () => {
    vendorFindUnique.mockResolvedValue(null);
    vendorFindFirst.mockResolvedValue({ id: "vendor-existing" });

    await expect(
      vendorsService.createVendor("user-1", {
        storeName: "Fresh Market",
      }),
    ).rejects.toThrow("Store name already exists");

    expect(vendorFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          storeName: expect.objectContaining({
            equals: "Fresh Market",
            mode: "insensitive",
          }),
        }),
      }),
    );
  });

  it("blocks vendor store rename when another vendor already uses the target name", async () => {
    vendorFindUnique.mockResolvedValue({ id: "vendor-1", userId: "user-1", storeName: "Alpha Foods" });
    vendorFindFirst.mockResolvedValue({ id: "vendor-2" });

    await expect(
      vendorsService.updateOwnVendor("user-1", { storeName: "Fresh Market" }),
    ).rejects.toThrow("Store name already exists");
  });
});
