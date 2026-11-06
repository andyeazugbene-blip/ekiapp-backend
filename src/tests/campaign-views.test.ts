import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import { buyerCampaignView, hideStaffFields, stripStaffFields } from "../modules/community-buy/campaign-views";

const campaign = () => ({
  id: "c1",
  title: "Rice",
  pricePerShareMinor: 2500,
  adminIssueNotes: "Staff note",
  disputeReason: "Staff reason",
  disputedById: "admin1",
  reviewedById: "admin2",
  reviewNotes: "Note for the organiser",
  reviewCriteria: { price: true },
  wholesaleAmountMinor: 1800,
  supplierDeclineReason: "No stock",
  paidTotal: 5000,
  disputedAt: new Date("2026-11-06T00:00:00Z"),
  contributions: [{ amount: 2500 }],
  supplier: { id: "s1", holdReason: "x", vendor: { storeName: "Foods Ltd" } },
  supplierAccount: { id: "a1", businessName: "Foods Ltd", providerConnectedAccountId: "acct_1", payoutsEnabled: true, user: { name: "Ada" } },
});

describe("stripStaffFields", () => {
  it("removes staff fields at any depth and keeps the rest", () => {
    const out = stripStaffFields({ items: [campaign()], nested: { campaign: campaign() } });
    const text = JSON.stringify(out);
    for (const key of ["adminIssueNotes", "disputeReason", "disputedById", "reviewedById"]) expect(text).not.toContain(key);
    expect(out.items[0].wholesaleAmountMinor).toBe(1800);
    expect(out.items[0].disputedAt).toBeInstanceOf(Date);
  });
});

describe("hideStaffFields", () => {
  it("strips every JSON response on the route", () => {
    const send = vi.fn();
    const response = { json: send } as unknown as Response;
    const next = vi.fn();
    hideStaffFields({} as Request, response, next);
    response.json({ campaign: campaign() });
    expect(next).toHaveBeenCalled();
    expect(JSON.stringify(send.mock.calls[0][0])).not.toContain("adminIssueNotes");
  });
});

describe("buyerCampaignView", () => {
  it("keeps what a buyer needs", () => {
    const view = buyerCampaignView(campaign());
    expect(view.title).toBe("Rice");
    expect(view.pricePerShareMinor).toBe(2500);
    expect(view.supplier).toEqual({ vendor: { storeName: "Foods Ltd" } });
    expect(view.supplierAccount).toEqual({ businessName: "Foods Ltd", user: { name: "Ada" } });
  });

  it("removes commercial terms, other buyers' amounts and supplier payout details", () => {
    const text = JSON.stringify(buyerCampaignView(campaign()));
    for (const key of ["wholesaleAmountMinor", "reviewNotes", "reviewCriteria", "supplierDeclineReason", "paidTotal", "disputedAt", "contributions", "providerConnectedAccountId", "payoutsEnabled", "holdReason"]) {
      expect(text).not.toContain(key);
    }
  });

  it("copes with a campaign that has no supplier", () => {
    const view = buyerCampaignView({ id: "c2", supplier: null, supplierAccount: null });
    expect(view.supplier).toBeNull();
    expect(view.supplierAccount).toBeNull();
  });

  it("doesn't change the original", () => {
    const original = campaign();
    buyerCampaignView(original);
    expect(original.wholesaleAmountMinor).toBe(1800);
  });
});
