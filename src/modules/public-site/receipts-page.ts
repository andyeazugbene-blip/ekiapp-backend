import type { Request, Response } from "express";
import jwt from "jsonwebtoken";

import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

const PURPOSE = "receipt";
const LIFETIME = "15m";

const STATUS_LABEL: Record<string, string> = {
  PAID: "Paid",
  PAYMENT_PROCESSING: "Payment under review",
  PLEDGED: "Not charged yet",
  INITIATED: "Not charged yet",
  PAYMENT_FAILED: "Payment failed",
  CHARGE_FAILED: "Payment failed",
  REFUND_PENDING: "Refund started",
  REFUND_PROCESSING: "Refund in progress",
  REFUNDED: "Refunded",
  REFUND_FAILED: "Refund in progress",
  CANCELLED: "Cancelled",
};

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

function dateTime(value: Date): string {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/London" }).format(value);
}

export function renderReceipt(title: string, rows: [string, string][]): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} | Eki</title>
  <meta name="robots" content="noindex" />
  <style>
    *{box-sizing:border-box}body{margin:0;padding:16px;background:#f6f8f7;color:#111827;font-family:Inter,Arial,sans-serif}
    main{max-width:520px;margin:0 auto;background:#fff;border:1px solid #dde7e2;border-radius:20px;padding:26px}
    .logo{display:inline-grid;place-items:center;width:44px;height:44px;border-radius:12px;background:#076b51;color:#fff;font-weight:800;margin-bottom:14px}
    h1{margin:0 0 14px;font-size:24px;letter-spacing:-.02em}
    .row{display:flex;justify-content:space-between;gap:16px;padding:11px 0;border-top:1px solid #eef2f0;font-size:15px}.row span{color:#5f6b66}.row b{text-align:right}
    button{width:100%;height:48px;margin-top:18px;border:0;border-radius:14px;background:#076b51;color:#fff;font-weight:700;font-size:15px;cursor:pointer}
    @media print{body{background:#fff}main{border:0}button{display:none}}
  </style>
</head>
<body>
  <main>
    <div class="logo">eki</div>
    <h1>${esc(title)}</h1>
    ${rows.map(([label, value]) => `<div class="row"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("\n    ")}
    <button onclick="window.print()">Save or print</button>
  </main>
</body>
</html>`;
}

/** A short-lived link, so the app can open a receipt in a browser without putting the session there. */
function signReceiptLink(kind: "contribution", id: string, userId: string): string {
  const token = jwt.sign({ purpose: PURPOSE, kind, id }, env.jwtSecret, { subject: userId, expiresIn: LIFETIME });
  return `${env.frontendUrl}/receipt/${token}`;
}

export const receiptsService = {
  async contributionLink(userId: string, contributionId: string): Promise<{ url: string }> {
    const contribution = await prisma.campaignContribution.findUnique({ where: { id: contributionId }, select: { participant: { select: { userId: true } } } });
    if (!contribution || contribution.participant.userId !== userId) throw new AppError("Contribution not found", 404);
    return { url: signReceiptLink("contribution", contributionId, userId) };
  },
};

export async function getReceiptPage(request: Request, response: Response): Promise<void> {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "private, no-store");
  const expired = () => response.status(410).send(renderReceipt("This link has expired", [["What to do", "Open the receipt again from the Eki app"]]));
  let claims: jwt.JwtPayload;
  try {
    claims = jwt.verify(String(request.params.token ?? ""), env.jwtSecret) as jwt.JwtPayload;
  } catch {
    expired();
    return;
  }
  if (claims.purpose !== PURPOSE || claims.kind !== "contribution" || typeof claims.id !== "string") {
    expired();
    return;
  }
  const contribution = await prisma.campaignContribution.findUnique({
    where: { id: claims.id },
    select: {
      id: true, amount: true, buyerServiceFeeAmount: true, deliveryFeeAmountMinor: true, currency: true, status: true, createdAt: true,
      participant: { select: { userId: true, campaign: { select: { title: true } } } },
    },
  });
  if (!contribution || contribution.participant.userId !== claims.sub) {
    expired();
    return;
  }
  const paid = contribution.status === "PAID" || contribution.status.startsWith("REFUND");
  const total = contribution.amount + contribution.buyerServiceFeeAmount + contribution.deliveryFeeAmountMinor;
  response.status(200).send(renderReceipt("Contribution receipt", [
    ["Campaign", contribution.participant.campaign.title],
    ["Contribution reference", contribution.id.slice(-10).toUpperCase()],
    ["Payment status", STATUS_LABEL[contribution.status] ?? contribution.status],
    ["Contribution", money(contribution.amount, contribution.currency)],
    ["Fees", money(contribution.buyerServiceFeeAmount, contribution.currency)],
    ["Delivery", money(contribution.deliveryFeeAmountMinor, contribution.currency)],
    [paid ? "Total paid" : "Total if it goes ahead", money(total, contribution.currency)],
    ["Date", dateTime(contribution.createdAt)],
  ]));
}
