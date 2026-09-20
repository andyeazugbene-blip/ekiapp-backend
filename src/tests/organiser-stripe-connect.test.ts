/**
 * Stripe Connect production hardening — organiser-stripe-connect.service.ts.
 * Covers the pre-existing self-service onboard()/refresh()/getStatus() only
 * lightly (already the exact pattern proven correct in
 * supplier-stripe-connect.test.ts); the real new-behavior coverage here is
 * getStatusForAdmin() (admin-triggered live refresh, never disguising a
 * failed live read as fresh) and handleAccountUpdated() (the account.updated
 * webhook target) — both new this change.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma", () => ({
  prisma: {
    organiserProfile: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("../lib/stripe", () => ({
  stripe: {
    accounts: { create: vi.fn(), retrieve: vi.fn() },
    accountLinks: { create: vi.fn() },
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "../lib/prisma";
import { stripe } from "../lib/stripe";
import { organiserStripeConnectService, deriveConnectAccountFields } from "../modules/community-buy/organiser-stripe-connect.service";

const m = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deriveConnectAccountFields() — the single source both sync paths share", () => {
  it("extracts requirements as field-name identifiers, never a value, and defaults missing ones to empty/false/null", () => {
    const result = deriveConnectAccountFields({
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      requirements: {
        currently_due: ["individual.dob.day", "external_account"],
        eventually_due: ["individual.id_number"],
        past_due: ["individual.verification.document"],
        disabled_reason: "requirements.past_due",
      },
    } as never);
    expect(result).toEqual({
      chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false,
      stripeRequirementsCurrentlyDue: ["individual.dob.day", "external_account"],
      stripeRequirementsEventuallyDue: ["individual.id_number"],
      stripeRequirementsPastDue: ["individual.verification.document"],
      stripeDisabledReason: "requirements.past_due",
    });
  });

  it("a fully-enabled account with no outstanding requirements", () => {
    const result = deriveConnectAccountFields({
      charges_enabled: true, payouts_enabled: true, details_submitted: true,
      requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null },
    } as never);
    expect(result).toEqual({
      chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true,
      stripeRequirementsCurrentlyDue: [], stripeRequirementsEventuallyDue: [], stripeRequirementsPastDue: [], stripeDisabledReason: null,
    });
  });

  it("missing requirements object entirely defaults every array to empty and disabledReason to null", () => {
    const result = deriveConnectAccountFields({ charges_enabled: false, payouts_enabled: false, details_submitted: false } as never);
    expect(result.stripeRequirementsCurrentlyDue).toEqual([]);
    expect(result.stripeRequirementsEventuallyDue).toEqual([]);
    expect(result.stripeRequirementsPastDue).toEqual([]);
    expect(result.stripeDisabledReason).toBeNull();
  });
});

describe("getStatusForAdmin() — admin-only live refresh", () => {
  it("404s for a nonexistent organiser profile", async () => {
    m.organiserProfile.findUnique.mockResolvedValue(null as never);
    await expect(organiserStripeConnectService.getStatusForAdmin("org-missing")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("returns all-false/fetchedLive:false with no Stripe call when onboarding was never started", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({
      id: "org-1", providerConnectedAccountId: null, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false,
      stripeRequirementsCurrentlyDue: [], stripeRequirementsEventuallyDue: [], stripeRequirementsPastDue: [], stripeDisabledReason: null, stripeStatusFetchedAt: null,
    } as never);

    const result = await organiserStripeConnectService.getStatusForAdmin("org-1");

    expect(stripe.accounts.retrieve).not.toHaveBeenCalled();
    expect(result).toEqual({
      providerConnectedAccountId: null, fetchedLive: false, stripeStatusFetchedAt: null,
      chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false,
      stripeRequirementsCurrentlyDue: [], stripeRequirementsEventuallyDue: [], stripeRequirementsPastDue: [], stripeDisabledReason: null,
    });
  });

  it("restricted account: fresh Stripe read shows disabled_reason and past_due requirements, persisted and returned fresh", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({
      id: "org-2", providerConnectedAccountId: "acct_restricted", chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false,
      stripeRequirementsCurrentlyDue: [], stripeRequirementsEventuallyDue: [], stripeRequirementsPastDue: [], stripeDisabledReason: null, stripeStatusFetchedAt: null,
    } as never);
    vi.mocked(stripe.accounts.retrieve).mockResolvedValue({
      charges_enabled: false, payouts_enabled: false, details_submitted: false,
      requirements: { currently_due: ["individual.verification.document"], eventually_due: [], past_due: ["individual.verification.document"], disabled_reason: "requirements.past_due" },
    } as never);

    const result = await organiserStripeConnectService.getStatusForAdmin("org-2");

    expect(result.fetchedLive).toBe(true);
    expect(result.chargesEnabled).toBe(false);
    expect(result.payoutsEnabled).toBe(false);
    expect(result.stripeDisabledReason).toBe("requirements.past_due");
    expect(result.stripeRequirementsPastDue).toEqual(["individual.verification.document"]);
    expect(m.organiserProfile.update).toHaveBeenCalledWith({
      where: { id: "org-2" },
      data: expect.objectContaining({ chargesEnabled: false, payoutsEnabled: false, stripeDisabledReason: "requirements.past_due" }),
    });
  });

  it("onboarding incomplete: details not submitted, currently_due populated, no disabled_reason yet", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({
      id: "org-3", providerConnectedAccountId: "acct_incomplete", chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false,
      stripeRequirementsCurrentlyDue: [], stripeRequirementsEventuallyDue: [], stripeRequirementsPastDue: [], stripeDisabledReason: null, stripeStatusFetchedAt: null,
    } as never);
    vi.mocked(stripe.accounts.retrieve).mockResolvedValue({
      charges_enabled: false, payouts_enabled: false, details_submitted: false,
      requirements: { currently_due: ["individual.dob.day", "individual.id_number"], eventually_due: ["business_profile.url"], past_due: [], disabled_reason: null },
    } as never);

    const result = await organiserStripeConnectService.getStatusForAdmin("org-3");

    expect(result.fetchedLive).toBe(true);
    expect(result.detailsSubmitted).toBe(false);
    expect(result.stripeRequirementsCurrentlyDue).toEqual(["individual.dob.day", "individual.id_number"]);
    expect(result.stripeDisabledReason).toBeNull();
  });

  it("payouts enabled: fully onboarded account reports true/true/true with empty requirements", async () => {
    m.organiserProfile.findUnique.mockResolvedValue({
      id: "org-4", providerConnectedAccountId: "acct_ready", chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false,
      stripeRequirementsCurrentlyDue: [], stripeRequirementsEventuallyDue: [], stripeRequirementsPastDue: [], stripeDisabledReason: null, stripeStatusFetchedAt: null,
    } as never);
    vi.mocked(stripe.accounts.retrieve).mockResolvedValue({
      charges_enabled: true, payouts_enabled: true, details_submitted: true,
      requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null },
    } as never);

    const result = await organiserStripeConnectService.getStatusForAdmin("org-4");

    expect(result.fetchedLive).toBe(true);
    expect(result.chargesEnabled).toBe(true);
    expect(result.payoutsEnabled).toBe(true);
    expect(result.detailsSubmitted).toBe(true);
  });

  it("a failed live Stripe read returns the cached row explicitly marked fetchedLive:false — never disguises stale data as fresh, and never writes to the DB", async () => {
    const cachedFetchedAt = new Date("2026-01-01T00:00:00.000Z");
    m.organiserProfile.findUnique.mockResolvedValue({
      id: "org-5", providerConnectedAccountId: "acct_5", chargesEnabled: true, payoutsEnabled: false, detailsSubmitted: true,
      stripeRequirementsCurrentlyDue: ["individual.dob.day"], stripeRequirementsEventuallyDue: [], stripeRequirementsPastDue: [], stripeDisabledReason: null,
      stripeStatusFetchedAt: cachedFetchedAt,
    } as never);
    vi.mocked(stripe.accounts.retrieve).mockRejectedValue(new Error("network error"));

    const result = await organiserStripeConnectService.getStatusForAdmin("org-5");

    expect(result.fetchedLive).toBe(false);
    expect(result.stripeStatusFetchedAt).toBe(cachedFetchedAt);
    expect(result.chargesEnabled).toBe(true);
    expect(result.payoutsEnabled).toBe(false);
    expect(m.organiserProfile.update).not.toHaveBeenCalled();
  });
});

describe("handleAccountUpdated() — account.updated webhook target", () => {
  it("syncs all fields for the matching organiser and reports handled:true", async () => {
    m.organiserProfile.findFirst.mockResolvedValue({ id: "org-6" } as never);

    const result = await organiserStripeConnectService.handleAccountUpdated({
      id: "acct_6", charges_enabled: true, payouts_enabled: true, details_submitted: true,
      requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null },
    } as never);

    expect(m.organiserProfile.findFirst).toHaveBeenCalledWith({ where: { providerConnectedAccountId: "acct_6" }, select: { id: true } });
    expect(m.organiserProfile.update).toHaveBeenCalledWith({
      where: { id: "org-6" },
      data: expect.objectContaining({ chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true }),
    });
    expect(result).toEqual({ handled: true });
  });

  it("a connected account with no matching organiser (vendor's or supplier's own account) is a safe no-op — no DB write, handled:false", async () => {
    m.organiserProfile.findFirst.mockResolvedValue(null as never);

    const result = await organiserStripeConnectService.handleAccountUpdated({ id: "acct_vendor_owned" } as never);

    expect(result).toEqual({ handled: false });
    expect(m.organiserProfile.update).not.toHaveBeenCalled();
  });

  it("a restricted account arriving via webhook persists disabled_reason exactly like the admin-triggered path does", async () => {
    m.organiserProfile.findFirst.mockResolvedValue({ id: "org-7" } as never);

    await organiserStripeConnectService.handleAccountUpdated({
      id: "acct_7", charges_enabled: false, payouts_enabled: false, details_submitted: false,
      requirements: { currently_due: ["individual.verification.document"], eventually_due: [], past_due: ["individual.verification.document"], disabled_reason: "requirements.past_due" },
    } as never);

    expect(m.organiserProfile.update).toHaveBeenCalledWith({
      where: { id: "org-7" },
      data: expect.objectContaining({ stripeDisabledReason: "requirements.past_due", stripeRequirementsPastDue: ["individual.verification.document"] }),
    });
  });
});
