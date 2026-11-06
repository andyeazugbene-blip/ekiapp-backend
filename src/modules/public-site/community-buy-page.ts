import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { AppError } from "../../shared/errors/app-error";

/** Campaign states a shared link can usefully show. Everything else reads as unavailable. */
const JOINABLE = new Set(["LIVE", "HOLD_WINDOW"]);
const COMING_SOON = new Set(["UNDER_REVIEW", "CHANGES_REQUIRED", "APPROVED"]);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function money(minor: number | null | undefined, currency: string | null | undefined): string {
  if (minor == null) return "";
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: currency ?? "GBP" }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency ?? ""}`.trim();
  }
}

function daysLeft(deadline: Date | null): string {
  if (!deadline) return "";
  const days = Math.ceil((deadline.getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return "Closing today";
  return days === 1 ? "1 day left" : `${days} days left`;
}

const STYLES = `*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:#f6f8f7;color:#111827;font-family:Inter,Arial,sans-serif}
.card{width:min(100%,460px);background:#fff;border:1px solid #dde7e2;border-radius:24px;padding:26px}
.logo{display:inline-grid;place-items:center;width:48px;height:48px;border-radius:14px;background:#076b51;color:#fff;font-weight:800;margin-bottom:16px}
h1{margin:0 0 6px;font-size:26px;letter-spacing:-.03em;line-height:1.2}p{color:#5f6b66;line-height:1.55;margin:10px 0}
img{width:100%;border-radius:16px;margin-bottom:14px;display:block}
.tag{display:inline-block;background:#eff8f3;color:#076b51;border-radius:999px;padding:5px 12px;font-size:13px;font-weight:700;margin-bottom:10px}
.row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid #eef2f0;font-size:15px}.row b{text-align:right}
.bar{height:8px;background:#eef2f0;border-radius:99px;overflow:hidden;margin:14px 0 6px}.bar i{display:block;height:100%;background:#076b51}
.small{font-size:13px;color:#7a8780}
a.btn,button{display:grid;place-items:center;width:100%;height:50px;border-radius:14px;font-weight:700;text-decoration:none;font-size:15px;border:0;cursor:pointer;margin-top:10px}
.primary{background:#076b51;color:#fff}.secondary{border:1px solid #cfe1da;color:#076b51;background:#fff}
input{width:100%;height:50px;border-radius:14px;border:1px solid #cfe1da;padding:0 14px;font-size:15px;margin-top:10px}
.note{font-size:14px;margin-top:10px;color:#076b51;font-weight:600}`;

function layout(title: string, body: string, description: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} | Eki</title>
  <meta name="description" content="${esc(description)}" />
  <meta name="robots" content="noindex" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <style>${STYLES}</style>
</head>
<body><main class="card"><div class="logo">eki</div>${body}</main></body>
</html>`;
}

const STORE_BUTTONS = `<a class="btn secondary" href="https://apps.apple.com/app/id6776307497">Download on the App Store</a>
<a class="btn secondary" href="https://play.google.com/store/apps/details?id=com.ekiapp.mobile">Get it on Google Play</a>`;

function unavailable(): string {
  return layout(
    "Community Buy",
    `<h1>This Community Buy isn't available</h1><p>It may have ended or the link may be wrong. You can find others in the Eki app.</p>${STORE_BUTTONS}`,
    "Buy together in bulk from verified suppliers.",
  );
}

type PublicCampaign = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  currency: string | null;
  pricePerShareMinor: number | null;
  minimumShares: number | null;
  goalShares: number | null;
  confirmedShares: number;
  deadline: Date | null;
  imageUrl: string | null;
  paymentMode: string;
};

function renderDetails(c: PublicCampaign): string {
  return `${c.imageUrl ? `<img src="${esc(c.imageUrl)}" alt="" />` : ""}
<h1>${esc(c.title)}</h1>
${c.description ? `<p>${esc(c.description)}</p>` : ""}
<div class="row"><span>Price per share</span><b>${esc(money(c.pricePerShareMinor, c.currency))}</b></div>
${c.minimumShares ? `<div class="row"><span>Minimum</span><b>${c.minimumShares} shares</b></div>` : ""}
${c.goalShares ? `<div class="row"><span>Goal</span><b>${c.goalShares} shares</b></div>` : ""}
${c.deadline ? `<div class="row"><span>Deadline</span><b>${esc(daysLeft(c.deadline))}</b></div>` : ""}`;
}

function renderJoinable(c: PublicCampaign): string {
  const target = c.minimumShares ?? c.goalShares ?? 0;
  const percent = target > 0 ? Math.min(100, Math.round((c.confirmedShares / target) * 100)) : 0;
  const paymentLine = c.paymentMode === "AUTHORISE_THEN_CAPTURE"
    ? "No payment is taken when you join. A temporary hold is placed shortly before the deadline, and you're only charged if the Community Buy goes ahead."
    : "You only pay once the Community Buy reaches its minimum.";
  return layout(
    c.title,
    `<span class="tag">Community Buy</span>${renderDetails(c)}
<div class="bar"><i style="width:${percent}%"></i></div>
<p class="small">${c.confirmedShares} of ${target} confirmed shares</p>
<p>${esc(paymentLine)}</p>
<a class="btn primary" href="ekiapp://community-buy/${encodeURIComponent(c.id)}">Join in the Eki app</a>
${STORE_BUTTONS}`,
    "Buy together in bulk from verified suppliers.",
  );
}

function renderComingSoon(c: PublicCampaign): string {
  return layout(
    `${c.title} (coming soon)`,
    `<span class="tag">Coming soon</span>${renderDetails(c)}
<p>This Community Buy isn't open yet. Leave your email and we'll tell you when you can join. There's no payment, and we only use your email for this.</p>
<form id="interest">
  <input id="email" type="email" required autocomplete="email" placeholder="Your email" aria-label="Your email" />
  <button class="primary" type="submit">Tell me when it opens</button>
</form>
<p class="note" id="result" role="status"></p>
${STORE_BUTTONS}
<script>
document.getElementById("interest").addEventListener("submit", async function (event) {
  event.preventDefault();
  var result = document.getElementById("result");
  var button = event.target.querySelector("button");
  button.disabled = true;
  try {
    var response = await fetch("/api/community-buy/campaigns/${encodeURIComponent(c.id)}/interest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: document.getElementById("email").value }),
    });
    result.textContent = response.ok ? "Thanks. We'll email you when it opens." : "We couldn't save that. Check your email address and try again.";
  } catch (error) {
    result.textContent = "We couldn't save that. Check your connection and try again.";
  }
  button.disabled = false;
});
</script>`,
    "Buy together in bulk from verified suppliers.",
  );
}

/** Demo campaigns are never public: their links read as unavailable. */
async function loadPublicCampaign(id: string): Promise<PublicCampaign | null> {
  const campaign = await prisma.communityCampaign.findUnique({
    where: { id },
    select: {
      id: true, title: true, description: true, status: true, currency: true, pricePerShareMinor: true, minimumShares: true,
      goalShares: true, confirmedShares: true, deadline: true, images: true, paymentMode: true,
      organiser: { select: { user: { select: { isTest: true } } } },
    },
  });
  if (!campaign || campaign.organiser.user.isTest) return null;
  return { ...campaign, imageUrl: campaign.images[0] ?? null };
}

export async function getPublicCommunityBuyPage(request: Request, response: Response): Promise<void> {
  const campaign = await loadPublicCampaign(String(request.params.id ?? ""));
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
  if (campaign && JOINABLE.has(campaign.status)) {
    response.status(200).send(renderJoinable(campaign));
  } else if (campaign && COMING_SOON.has(campaign.status)) {
    response.status(200).send(renderComingSoon(campaign));
  } else {
    response.status(404).send(unavailable());
  }
}

/** Interest from someone without an account. Only for a campaign that isn't open yet. */
export async function registerPublicCampaignInterest(campaignId: string, rawEmail: unknown): Promise<{ registered: true }> {
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (!EMAIL_PATTERN.test(email) || email.length > 254) throw new AppError("Enter a valid email address.", 400, undefined, "INVALID_EMAIL");
  const campaign = await loadPublicCampaign(campaignId);
  if (!campaign || !COMING_SOON.has(campaign.status)) throw new AppError("Campaign not found", 404);
  await prisma.campaignInterest.upsert({
    where: { campaignId_email: { campaignId, email } },
    create: { campaignId, email },
    update: {},
  });
  return { registered: true };
}
