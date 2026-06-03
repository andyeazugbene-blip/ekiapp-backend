import type { Request, Response } from "express";

import { prisma } from "../../lib/prisma";
import { otpService } from "../auth/otp.service";
import { AppError } from "../../shared/errors/app-error";

const TRACKABLE_ORDER_STATUSES = [
  "PAID",
  "PAYMENT_SECURED",
  "CONFIRMED",
  "VENDOR_CONFIRMED",
  "PROCESSING",
  "DISPATCHED",
  "IN_TRANSIT",
  "DELIVERED",
  "COMPLETED",
] as const;

type PageSection = {
  title: string;
  body?: string[];
  bullets?: string[];
};

type PageDefinition = {
  title: string;
  description: string;
  eyebrow: string;
  heading: string;
  intro: string;
  sections: PageSection[];
};

type PublicTrackedOrder = {
  id: string;
  orderNumber: string;
  createdAt: string;
  buyerEmail: string;
  buyerPhone: string | null;
  currency: string;
  total: number;
  vendorName: string;
  vendorSlug: string;
  vendorCity: string;
  status: string;
  items: {
    productTitle: string;
    quantity: number;
  }[];
};

function escape(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatPrice(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: (currency || "GBP").toUpperCase(),
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${(currency || "GBP").toUpperCase()}`;
  }
}

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return value;
  }
}

function humanizeStatus(status: string): string {
  const value = (status || "").replace(/_/g, " ").toLowerCase();
  if (!value) return "In transit";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function renderOrderPayload(order: PublicTrackedOrder) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    createdAt: order.createdAt,
    createdLabel: formatDate(order.createdAt),
    currency: order.currency,
    total: order.total,
    totalLabel: formatPrice(order.total, order.currency),
    vendorName: order.vendorName,
    vendorSlug: order.vendorSlug,
    vendorCity: order.vendorCity,
    status: order.status,
    statusLabel: humanizeStatus(order.status),
    statusTone:
      order.status === "COMPLETED" || order.status === "DELIVERED"
        ? "delivered"
        : order.status === "DISPATCHED" || order.status === "IN_TRANSIT"
          ? "in-transit"
          : "processing",
    items: order.items,
    itemsLabel: order.items
      .map((item) => `${item.productTitle}${item.quantity > 1 ? ` x${item.quantity}` : ""}`)
      .join(", "),
  };
}

function normalizeLookupContact(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePhoneDigits(value: string): string {
  return value.replace(/\D/g, "");
}

function phoneMatches(inputDigits: string, storedPhone: string | null): boolean {
  const storedDigits = normalizePhoneDigits(storedPhone ?? "");
  if (!inputDigits || !storedDigits) return false;
  if (storedDigits === inputDigits) return true;
  const significantDigits = inputDigits.length >= 8 ? inputDigits.slice(-8) : inputDigits;
  return significantDigits.length >= 6 && storedDigits.endsWith(significantDigits);
}

async function findOrdersByContact(contact: string): Promise<PublicTrackedOrder[]> {
  const normalizedContact = normalizeLookupContact(contact);
  const normalizedPhone = normalizePhoneDigits(contact);
  const isEmail = normalizedContact.includes("@");

  const orders = await prisma.order.findMany({
    where: {
      status: { in: [...TRACKABLE_ORDER_STATUSES] },
      buyer: isEmail
        ? { email: normalizedContact }
        : normalizedPhone
          ? { phone: { not: null } }
          : { email: "__not_found__@eki.app" },
    },
    include: {
      buyer: {
        select: {
          email: true,
          phone: true,
        },
      },
      items: {
        select: {
          productTitle: true,
          quantity: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: isEmail ? 50 : 250,
  });

  const matchedOrders = isEmail
    ? orders
    : orders.filter((order) => phoneMatches(normalizedPhone, order.buyer.phone));

  const vendorIds = Array.from(
    new Set(
      matchedOrders
        .map((order) => order.vendorId)
        .filter((vendorId): vendorId is string => Boolean(vendorId)),
    ),
  );

  const vendors = vendorIds.length
    ? await prisma.vendor.findMany({
        where: { id: { in: vendorIds } },
        select: {
          id: true,
          storeName: true,
          storeSlug: true,
          city: true,
          country: true,
        },
      })
    : [];
  const vendorMap = new Map(vendors.map((vendor) => [vendor.id, vendor]));

  return matchedOrders.map((order) => {
    const vendor = order.vendorId ? vendorMap.get(order.vendorId) : null;
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      createdAt: order.createdAt.toISOString(),
      buyerEmail: order.buyer.email,
      buyerPhone: order.buyer.phone,
      currency: order.currency,
      total: order.totalAmount / 100,
      vendorName: vendor?.storeName ?? "Saved vendor",
      vendorSlug: vendor?.storeSlug ?? "",
      vendorCity: vendor?.city ?? vendor?.country ?? "",
      status: order.status,
      items: order.items.map((item) => ({
        productTitle: item.productTitle,
        quantity: item.quantity,
      })),
    };
  });
}

function maskEmail(email: string): string {
  const [name = "", domain = ""] = email.split("@");
  if (!domain) return "the email linked to that order";
  const head = name.slice(0, 2);
  const tail = name.length > 4 ? name.slice(-1) : "";
  const maskLength = Math.max(2, Math.min(6, name.length - head.length - tail.length));
  return `${head}${"*".repeat(maskLength)}${tail}@${domain}`;
}
async function resolveLookupOtpEmail(contact: string): Promise<string | null> {
  const orders = await findOrdersByContact(contact);
  if (orders.length === 0) {
    return null;
  }
  return orders[0]?.buyerEmail ?? null;
}

function renderLegalSection(section: PageSection): string {
  const body = (section.body ?? [])
    .map((paragraph) => `<p>${escape(paragraph)}</p>`)
    .join("");
  const bullets = section.bullets?.length
    ? `<ul>${section.bullets.map((item) => `<li>${escape(item)}</li>`).join("")}</ul>`
    : "";

  return `
    <section class="legal-card">
      <h2>${escape(section.title)}</h2>
      ${body}
      ${bullets}
    </section>
  `;
}

function renderLegalPage(page: PageDefinition): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escape(page.title)}</title>
  <meta name="description" content="${escape(page.description)}" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" />
  <style>
    *,*::before,*::after{box-sizing:border-box}
    :root{
      --bg:#F7F8F6;
      --surface:#FFFFFF;
      --surface-soft:#F3F7F3;
      --text:#0F1720;
      --muted:#69767A;
      --border:#E5ECE5;
      --accent:#1B5A43;
      --accent-2:#3E8D63;
    }
    html,body{margin:0;padding:0}
    body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text)}
    a{text-decoration:none;color:inherit}
    .nav{height:58px;background:var(--accent);color:#fff;display:flex;align-items:center}
    .wrap{max-width:1100px;margin:0 auto;padding:0 18px}
    .nav-inner{display:flex;align-items:center;justify-content:space-between;gap:18px}
    .brand{display:inline-flex;align-items:center;justify-content:center;min-width:46px;height:22px;padding:0 10px;border-radius:5px;background:#3A845E;font-size:14px;font-weight:800;letter-spacing:-0.03em}
    .nav-links{display:flex;gap:22px;color:rgba(255,255,255,.86);font-size:12px}
    .sign-btn{min-width:72px;height:32px;border-radius:6px;border:1px solid rgba(255,255,255,.6);display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600}
    .hero{padding:56px 0 20px}
    .eyebrow{display:inline-flex;align-items:center;padding:7px 12px;border-radius:999px;background:#DDF0E2;color:var(--accent);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}
    h1{margin:18px 0 12px;font-size:40px;line-height:1.04;letter-spacing:-.04em;max-width:13ch}
    .hero p{max-width:64ch;color:var(--muted);font-size:16px;line-height:1.7;margin:0}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;padding:24px 0 64px}
    .legal-card{background:var(--surface);border:1px solid var(--border);border-radius:18px;padding:22px;box-shadow:0 10px 30px rgba(15,23,32,.04)}
    .legal-card h2{margin:0 0 12px;font-size:22px;line-height:1.18;letter-spacing:-.03em}
    .legal-card p,.legal-card li{color:var(--muted);font-size:14px;line-height:1.65}
    .legal-card ul{margin:10px 0 0 18px;padding:0}
    .foot{padding:22px 0 38px;border-top:1px solid var(--border);font-size:13px;color:var(--muted)}
    @media (max-width: 760px){
      h1{font-size:32px;max-width:none}
      .grid{grid-template-columns:1fr}
      .nav-links{display:none}
    }
  </style>
</head>
<body>
  <header class="nav">
    <div class="wrap nav-inner">
      <a href="/" class="brand">eki</a>
      <nav class="nav-links" aria-label="Public pages">
        <a href="/find-order">Find your order</a>
        <a href="/support">Support</a>
        <a href="/privacy">Privacy</a>
      </nav>
      <a href="/" class="sign-btn">Sign in</a>
    </div>
  </header>
  <main class="wrap">
    <section class="hero">
      <span class="eyebrow">${escape(page.eyebrow)}</span>
      <h1>${escape(page.heading)}</h1>
      <p>${escape(page.intro)}</p>
    </section>
    <section class="grid">
      ${page.sections.map(renderLegalSection).join("")}
    </section>
  </main>
  <footer class="foot">
    <div class="wrap">Questions? Email <a href="mailto:adminandy@eki.app">adminandy@eki.app</a>.</div>
  </footer>
</body>
</html>`;
}

function renderHomePage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#1D5A43" />
  <title>Eki by Culinary Tales</title>
  <meta name="description" content="Track orders, save favourite vendors, confirm deliveries, and reorder in seconds with Eki." />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" />
  <style>
    *,*::before,*::after{box-sizing:border-box}
    :root{
      --bg:#F7F8F6;
      --surface:#FFFFFF;
      --surface-soft:#EEF8F1;
      --surface-green:#245E46;
      --surface-green-2:#3C8A61;
      --text:#132029;
      --muted:#CFE0D5;
      --muted-body:#67757A;
      --border:#E6ECE6;
    }
    html,body{margin:0;padding:0}
    body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text)}
    a{text-decoration:none;color:inherit}
    .page{min-height:100vh}
    .hero-shell{background:#1D5A43;color:#fff}
    .wrap{max-width:1120px;margin:0 auto;padding:0 18px}
    .topbar{height:58px;display:flex;align-items:center}
    .topbar-inner{display:flex;align-items:center;justify-content:space-between;gap:16px;width:100%}
    .brand{display:inline-flex;align-items:center;justify-content:center;min-width:40px;height:22px;padding:0 11px;border-radius:5px;background:#3C8A61;font-size:14px;font-weight:800;letter-spacing:-0.03em}
    .nav-links{display:flex;gap:26px;font-size:12px;color:rgba(255,255,255,.82)}
    .sign-btn{min-width:74px;height:32px;border-radius:6px;border:1px solid rgba(255,255,255,.65);display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600}
    .hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,440px);gap:42px;align-items:center;padding:28px 0 30px;overflow:hidden}
    .hero-copy{padding:22px 0 30px}
    .hero h1{margin:0;font-size:56px;line-height:1.04;letter-spacing:-0.05em;max-width:10.6ch}
    .hero p{margin:18px 0 0;max-width:480px;color:rgba(255,255,255,.85);font-size:15px;line-height:1.55}
    .cta-row{display:flex;gap:14px;flex-wrap:wrap;margin-top:30px}
    .store-btn,.play-btn{display:flex;flex-direction:column;justify-content:center;min-width:116px;height:62px;border-radius:8px;padding:0 14px;border:1px solid transparent}
    .store-btn{background:#fff;color:#122028}
    .play-btn{background:#2E7D57;color:#fff}
    .btn-caption{font-size:10px;line-height:1.1;opacity:.72}
    .btn-title{font-size:22px;font-weight:700;line-height:1.05;letter-spacing:-.03em}
    .qr-copy{margin-top:15px;color:rgba(255,255,255,.68);font-size:12px}
    .phone-stage{display:flex;justify-content:center;align-items:center;min-height:330px;overflow:visible}
    .phone-mockup{display:block;width:min(100%,430px);max-height:500px;object-fit:contain;filter:drop-shadow(0 28px 42px rgba(3,21,16,.28))}
    .hero-bottom{background:#fff;border-top:1px solid var(--border)}
    .love-section{padding:18px 0 28px}
    .love-section h2{margin:0;text-align:center;font-size:20px;line-height:1.2;letter-spacing:-.03em}
    .feature-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:24px;margin-top:26px}
    .feature{background:var(--surface-soft);border:1px solid #E2EEE5;border-radius:10px;padding:18px 14px 16px;min-height:94px}
    .feature-icon{width:34px;height:34px;border-radius:999px;background:#E8F5EA;display:flex;align-items:center;justify-content:center;font-size:15px;margin-bottom:12px}
    .feature h3{margin:0;font-size:13px;line-height:1.35}
    .feature p{margin:6px 0 0;font-size:11px;line-height:1.45;color:#6F7C80}
    .find-row{margin-top:28px;background:#EDF8F0;border:1px solid #DDEEDF;border-radius:0;padding:12px 18px;display:flex;align-items:center;justify-content:center;gap:18px;font-size:12px;color:#647478}
    .find-btn{min-width:162px;height:40px;border-radius:7px;border:1px solid #7BA48D;background:#fff;color:#1D5A43;display:inline-flex;align-items:center;justify-content:center;font-size:14px;font-weight:600}
    .find-btn:hover{background:#F8FCF9}
    @media (max-width: 920px){
      .hero{grid-template-columns:1fr;gap:28px}
      .phone-stage{justify-content:center;min-height:300px}.phone-mockup{max-height:430px}
      .hero h1{font-size:46px;max-width:none}
      .feature-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
    }
    @media (max-width: 640px){
      .nav-links{display:none}
      .hero h1{font-size:38px}
      .feature-grid{grid-template-columns:1fr}
      .find-row{flex-direction:column;align-items:stretch}
      .find-btn{width:100%}
    }
  </style>
</head>
<body>
  <div class="page">
    <section class="hero-shell">
      <div class="wrap">
        <header class="topbar">
          <div class="topbar-inner">
            <a href="/" class="brand">eki</a>
            <nav class="nav-links" aria-label="Top navigation">
              <a href="/store">Vendors</a>
            </nav>
          </div>
        </header>
        <div class="hero">
          <div class="hero-copy">
            <h1>Never lose your vendors again.</h1>
            <p>The Eki app puts your favourite African foodstuff vendors right in your pocket. Track orders live, confirm deliveries with a tap, and reorder in seconds.</p>
            <div class="cta-row">
              <a class="store-btn" href="/">
                <span class="btn-caption">Download on the</span>
                <span class="btn-title">App Store</span>
              </a>
              <a class="play-btn" href="/">
                <span class="btn-caption">Get it on</span>
                <span class="btn-title">Google Play</span>
              </a>
            </div>
            <div class="qr-copy">Or scan the QR code in the app to get started instantly</div>
          </div>
          <div class="phone-stage" aria-hidden="true">
            <img class="phone-mockup" src="/assets/public-site/home-phone-mockup.png" alt="" loading="eager" />
          </div>
        </div>
      </div>
    </section>
    <section class="hero-bottom">
      <div class="wrap love-section">
        <h2>Why thousands love Eki</h2>
        <div class="feature-grid">
          <article class="feature">
            <div class="feature-icon">OK</div>
            <h3>Shop from verified vendors</h3>
            <p>Every vendor is reviewed and verified before listing on Eki.</p>
          </article>
          <article class="feature">
            <div class="feature-icon">TRK</div>
            <h3>Live order tracking</h3>
            <p>Track your foodstuff order from vendor confirmation to dispatch and delivery.</p>
          </article>
          <article class="feature">
            <div class="feature-icon">SEC</div>
            <h3>Secure Eki checkout</h3>
            <p>Your order and payment record are handled securely through Eki.</p>
          </article>
          <article class="feature">
            <div class="feature-icon">RE</div>
            <h3>One-tap reorder</h3>
            <p>Saved your favourite vendors? Reorder last basket in a single tap.</p>
          </article>
        </div>
        <div class="find-row">
          <span>Already have an order?</span>
          <a class="find-btn" href="/find-order">Find your order →</a>
        </div>
      </div>
    </section>
  </div>
</body>
</html>`;
}

function renderFindOrderPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#1D5A43" />
  <title>Find your order | Eki</title>
  <meta name="description" content="Find your Eki order with your checkout email and a one-time code." />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" />
  <style>
    *,*::before,*::after{box-sizing:border-box}
    :root{
      --bg:#F7F8F6;
      --surface:#FFFFFF;
      --surface-soft:#EDF8F0;
      --surface-soft-2:#F6FBF7;
      --accent:#1D5A43;
      --accent-2:#3C8A61;
      --text:#101D24;
      --muted:#798589;
      --border:#E5ECE5;
      --warning:#FFF3DE;
      --warning-border:#E3B970;
      --warning-text:#A46A16;
      --reward:#FFF3E4;
      --reward-border:#D89A4E;
      --reward-text:#8F4D0D;
      --success:#2D8A56;
    }
    html,body{margin:0;padding:0}
    body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text)}
    a{text-decoration:none;color:inherit}
    button,input{font:inherit}
    .nav{height:58px;background:var(--surface);border-bottom:1px solid var(--border)}
    .wrap{max-width:1120px;margin:0 auto;padding:0 18px}
    .nav-inner{display:flex;align-items:center;justify-content:space-between;gap:16px;height:100%}
    .brand{display:inline-flex;align-items:center;justify-content:center;min-width:40px;height:22px;padding:0 11px;border-radius:5px;background:#1D5A43;color:#fff;font-size:14px;font-weight:800;letter-spacing:-0.03em}
    .nav-links{display:flex;gap:26px;font-size:12px;color:#6A7478}
    .sign-btn{min-width:72px;height:32px;border-radius:6px;background:#1D5A43;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:600}
    .main{padding:28px 0 54px}
    .center-panel{max-width:390px;margin:0 auto;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:28px 30px 26px;box-shadow:0 10px 30px rgba(18,29,36,.04)}
    .step-icon{width:52px;height:52px;border-radius:999px;background:#E6F5E9;color:#3F8C62;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;margin:0 auto 16px}
    .panel-title{margin:0;text-align:center;font-size:37px;line-height:1.02;letter-spacing:-0.05em}
    .panel-title.small{font-size:34px}
    .panel-subtitle{margin:10px 0 0;text-align:center;color:var(--muted);font-size:12px;line-height:1.5}
    .field{margin-top:20px}
    .field input{width:100%;height:44px;border-radius:6px;border:1px solid var(--border);padding:0 14px;background:#fff;color:var(--text)}
    .field input:focus{outline:none;border-color:#7EA790;box-shadow:0 0 0 3px rgba(61,138,97,.12)}
    .primary-btn{width:100%;height:40px;border-radius:6px;border:0;background:var(--accent);color:#fff;font-size:12px;font-weight:700;cursor:pointer;margin-top:12px}
    .primary-btn:hover{background:#164735}
    .hint-box{margin-top:12px;padding:12px 14px;border-radius:6px;background:var(--warning);border:1px solid var(--warning-border);font-size:11px;line-height:1.45;color:var(--warning-text)}
    .foot-copy{margin-top:16px;text-align:center;font-size:10px;color:#9AA3A7;line-height:1.45}
    .otp-lead{margin-top:10px;text-align:center;color:var(--muted);font-size:11px}
    .otp-grid{display:flex;justify-content:center;gap:10px;margin:18px 0 8px}
    .otp-grid input{width:36px;height:40px;border-radius:6px;border:1px solid var(--border);text-align:center;font-size:20px;font-weight:700;padding:0}
    .otp-grid input.is-active{border-color:#1D5A43;box-shadow:0 0 0 2px rgba(29,90,67,.1)}
    .inline-actions{display:flex;align-items:center;justify-content:center;gap:18px;margin-top:12px;font-size:11px;color:var(--muted)}
    .inline-actions button{border:0;background:transparent;color:#1D5A43;font-weight:600;cursor:pointer;padding:0}
    .expiry{margin-top:10px;text-align:center;font-size:10px;color:#B0B7BA}
    .warning-inline{margin-top:12px;padding:8px 12px;border-radius:6px;background:#FFF7E7;color:#B47516;font-size:10px}
    .hidden{display:none !important}
    .order-shell{display:flex;flex-direction:column;gap:16px}
    .order-banner{background:#1D5A43;color:#fff;border-radius:10px;padding:14px 18px;display:flex;align-items:flex-start;gap:12px}
    .order-banner-icon{width:20px;height:20px;border-radius:999px;background:#2E8C57;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;flex-shrink:0;margin-top:1px}
    .order-banner h2{margin:0;font-size:24px;line-height:1.1;letter-spacing:-.04em}
    .order-banner p{margin:4px 0 0;color:rgba(255,255,255,.82);font-size:12px}
    .order-banner .order-chip{display:inline-flex;margin-top:8px;padding:5px 10px;border-radius:999px;background:#2E8C57;font-size:11px;font-weight:700}
    .cards{display:grid;grid-template-columns:1.15fr 1fr 1fr;gap:14px}
    .top-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px}
    .top-card.reward{background:var(--reward);border-color:var(--reward-border);color:var(--reward-text)}
    .top-card-row{display:flex;align-items:center;gap:10px}
    .top-icon{width:20px;height:20px;border-radius:999px;background:#E7F4EA;color:#2D8A56;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;flex-shrink:0}
    .reward .top-icon{background:#B96C1A;color:#fff}
    .top-card h3{margin:0;font-size:13px;line-height:1.3}
    .top-card p{margin:4px 0 0;color:#7A8488;font-size:11px;line-height:1.45}
    .reward p{color:#8F4D0D}
    .card-btn{display:inline-flex;align-items:center;justify-content:center;min-width:116px;height:34px;border-radius:6px;background:#1D5A43;color:#fff;font-size:11px;font-weight:700;margin-top:14px}
    .reward .card-btn{background:#A85F1B}
    .history-title{margin:4px 0 0;font-size:12px;font-weight:700;color:#1D2730}
    .history-list{display:flex;flex-direction:column;gap:12px}
    .history-item{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:18px;align-items:center;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px}
    .history-item h4{margin:0;font-size:13px;line-height:1.2}
    .history-meta{margin:6px 0 0;color:#6F7A7E;font-size:11px;line-height:1.45}
    .history-total{font-size:12px;font-weight:600;color:#18222A;white-space:nowrap}
    .history-actions{display:flex;flex-direction:column;align-items:flex-end;gap:8px}
    .status-pill{display:inline-flex;align-items:center;justify-content:center;min-width:76px;height:24px;border-radius:999px;font-size:10px;font-weight:700;text-transform:capitalize}
    .status-pill.delivered{background:#E6F4EA;color:#2A8651}
    .status-pill.in-transit{background:#E7F0FF;color:#3169B6}
    .status-pill.processing{background:#EEF3EF;color:#5E6B62}
    .ghost-btn{display:inline-flex;align-items:center;justify-content:center;min-width:74px;height:30px;border-radius:6px;background:#1D5A43;color:#fff;font-size:11px;font-weight:700}
    .save-bar{display:flex;align-items:center;justify-content:space-between;gap:16px;background:#EEF8F0;border:1px solid #DCEBDD;border-radius:8px;padding:12px 14px;color:#667478;font-size:12px}
    .save-bar .ghost-btn{min-width:154px}
    .status-message{margin-top:12px;text-align:center;font-size:11px;line-height:1.45;color:#7A8588}
    .status-message.error{color:#B14A3A}
    .status-message.success{color:#2A8651}
    .back-link{display:inline-flex;align-items:center;gap:8px;color:#6B777B;font-size:12px;font-weight:600;margin-bottom:18px}
    @media (max-width: 900px){
      .cards{grid-template-columns:1fr}
      .history-item{grid-template-columns:1fr}
      .history-actions{align-items:flex-start}
    }
    @media (max-width: 640px){
      .nav-links{display:none}
      .center-panel{padding:24px 18px}
      .panel-title,.panel-title.small{font-size:28px}
      .otp-grid{gap:8px}
      .otp-grid input{width:34px}
      .order-banner h2{font-size:21px}
      .save-bar{flex-direction:column;align-items:flex-start}
      .save-bar .ghost-btn{width:100%}
    }
  </style>
</head>
<body>
  <header class="nav">
    <div class="wrap nav-inner">
      <a href="/" class="brand">eki</a>
      <nav class="nav-links" aria-label="Top navigation">
        <a href="/store">Vendors</a>
      </nav>
    </div>
  </header>
  <main class="main">
    <div class="wrap">
      <a href="/" class="back-link">← Back home</a>

      <section id="step-find" class="center-panel">
        <div class="step-icon">sea</div>
        <h1 class="panel-title small">Find your order.</h1>
        <p class="panel-subtitle">Enter the phone number or email you used at checkout.</p>
        <div class="field">
          <input id="lookup-email" type="text" placeholder="Phone or email address" autocomplete="email" />
        </div>
        <button id="lookup-request" class="primary-btn" type="button">Continue</button>
        <div class="hint-box">No password needed. We will send a one-time code to verify it is you.</div>
        <p class="foot-copy">Orders placed as a guest still work here. Just enter your order contact details.</p>
        <div id="lookup-request-status" class="status-message"></div>
      </section>

      <section id="step-otp" class="center-panel hidden">
        <div class="step-icon">OTP</div>
        <h1 class="panel-title small">Enter your code.</h1>
        <p id="otp-lead" class="otp-lead">We sent a 6-digit code to your email.</p>
        <div class="otp-grid">
          <input class="otp-input is-active" maxlength="1" inputmode="numeric" />
          <input class="otp-input" maxlength="1" inputmode="numeric" />
          <input class="otp-input" maxlength="1" inputmode="numeric" />
          <input class="otp-input" maxlength="1" inputmode="numeric" />
          <input class="otp-input" maxlength="1" inputmode="numeric" />
          <input class="otp-input" maxlength="1" inputmode="numeric" />
        </div>
        <button id="lookup-verify" class="primary-btn" type="button">Verify and continue</button>
        <div class="inline-actions">
          <span>Didn’t get a code?</span>
          <button id="lookup-resend" type="button">Resend code</button>
        </div>
        <div class="expiry">Code expires in 10:00</div>
        <div class="warning-inline">You have 5 attempts remaining.</div>
        <div id="lookup-verify-status" class="status-message"></div>
      </section>

      <section id="step-results" class="order-shell hidden">
        <div class="order-banner">
          <div class="order-banner-icon">OK</div>
          <div>
            <h2>Your order is now in Eki.</h2>
            <p>Order history, vendor saving, and quick reorder are ready.</p>
            <span id="order-chip" class="order-chip"></span>
          </div>
        </div>

        <div class="cards">
          <article class="top-card">
            <div class="top-card-row">
              <div class="top-icon">↗</div>
              <div>
                <h3>Track your order</h3>
                <p id="track-copy">Preparing your order. Est. today by 6 PM.</p>
              </div>
            </div>
            <a id="open-app-link" class="card-btn" href="/">Open order in Eki app</a>
          </article>
          <article class="top-card">
            <div class="top-card-row">
              <div class="top-icon">●</div>
              <div>
                <h3 id="save-vendor-title">Save your vendor</h3>
                <p id="save-vendor-copy">Get notified when your favourite vendor restocks or goes live.</p>
              </div>
            </div>
            <a id="save-vendor-link" class="card-btn" href="/">Save vendor</a>
          </article>
          <article class="top-card reward">
            <div class="top-card-row">
              <div class="top-icon">5%</div>
              <div>
                <h3>App rewards unlocked</h3>
                <p>5% off your next reorder. Claimed in the Eki app.</p>
              </div>
            </div>
            <a class="card-btn" href="/">Claim in Eki app</a>
          </article>
        </div>

        <div>
          <p class="history-title">Your order history</p>
          <div id="history-list" class="history-list"></div>
        </div>

        <div class="save-bar">
          <span>Create a free Eki account to manage all your orders, save vendors and unlock rewards.</span>
          <a class="ghost-btn" href="/">Save my orders with a free Eki app</a>
        </div>
      </section>
    </div>
  </main>

  <script>
    (function () {
      var requestPath = "/api/public/order-lookup/request";
      var verifyPath = "/api/public/order-lookup/verify";
      var lookupEmail = document.getElementById("lookup-email");
      var requestBtn = document.getElementById("lookup-request");
      var resendBtn = document.getElementById("lookup-resend");
      var verifyBtn = document.getElementById("lookup-verify");
      var requestStatus = document.getElementById("lookup-request-status");
      var verifyStatus = document.getElementById("lookup-verify-status");
      var otpLead = document.getElementById("otp-lead");
      var orderChip = document.getElementById("order-chip");
      var trackCopy = document.getElementById("track-copy");
      var historyList = document.getElementById("history-list");
      var saveVendorTitle = document.getElementById("save-vendor-title");
      var saveVendorCopy = document.getElementById("save-vendor-copy");
      var saveVendorLink = document.getElementById("save-vendor-link");
      var openAppLink = document.getElementById("open-app-link");
      var panels = {
        find: document.getElementById("step-find"),
        otp: document.getElementById("step-otp"),
        results: document.getElementById("step-results")
      };
      var otpInputs = Array.prototype.slice.call(document.querySelectorAll(".otp-input"));
      var currentContact = "";

      function setPanel(name) {
        Object.keys(panels).forEach(function (key) {
          if (!panels[key]) return;
          if (key === name) {
            panels[key].classList.remove("hidden");
          } else {
            panels[key].classList.add("hidden");
          }
        });
      }

      function setStatus(node, message, tone) {
        if (!node) return;
        node.textContent = message || "";
        node.className = "status-message" + (tone ? " " + tone : "");
      }

      function postJson(path, payload) {
        return fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }).then(function (response) {
          return response.json().catch(function () { return {}; }).then(function (data) {
            if (!response.ok) {
              throw new Error(data && data.message ? data.message : "Request failed");
            }
            return data;
          });
        });
      }

      function escapeHtml(value) {
        return String(value == null ? "" : value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      function joinOtp() {
        return otpInputs.map(function (input) { return input.value.trim(); }).join("");
      }

      function renderResults(orders) {
        if (!orders || !orders.length) {
          historyList.innerHTML = "";
          return;
        }
        var firstOrder = orders[0];
        if (orderChip) {
          orderChip.textContent = "Order " + (firstOrder.orderNumber || "");
        }
        if (trackCopy) {
          trackCopy.textContent = humanizeStatus(firstOrder.status) + " - " + firstOrder.vendorName;
        }
        if (saveVendorTitle) {
          saveVendorTitle.textContent = "Save " + firstOrder.vendorName;
        }
        if (saveVendorCopy) {
          saveVendorCopy.textContent = "Get notified when " + firstOrder.vendorName + " restocks or goes live.";
        }
        if (saveVendorLink) {
          saveVendorLink.href = firstOrder.vendorSlug ? "/store/" + firstOrder.vendorSlug : "/";
        }
        if (openAppLink) {
          openAppLink.href = firstOrder.vendorSlug ? "/store/" + firstOrder.vendorSlug : "/";
        }

        historyList.innerHTML = orders.map(function (order) {
          var itemLines = Array.isArray(order.items) ? order.items.map(function (item) {
            return item.productTitle + (item.quantity > 1 ? " x" + item.quantity : "");
          }).join(", ") : "";
          return '<article class="history-item">'
            + '<div>'
            + '<h4>' + escapeHtml(order.orderNumber) + '</h4>'
            + '<p class="history-meta">' + escapeHtml(order.createdLabel || "") + '<br />' + escapeHtml(itemLines) + '</p>'
            + '</div>'
            + '<div class="history-total">' + escapeHtml(order.totalLabel || "") + '</div>'
            + '<div class="history-actions">'
            + '<span class="status-pill ' + escapeHtml(order.statusTone || "processing") + '">' + escapeHtml(order.statusLabel || "") + '</span>'
            + '<a class="ghost-btn" href="' + escapeHtml(order.vendorSlug ? "/store/" + order.vendorSlug : "/") + '">Reorder</a>'
            + '</div>'
            + '</article>';
        }).join("");
      }

      function humanizeStatus(value) {
        var text = String(value || "").replace(/_/g, " ").toLowerCase();
        return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Processing";
      }

      otpInputs.forEach(function (input, index) {
        input.addEventListener("input", function () {
          input.value = input.value.replace(/\\D/g, "").slice(0, 1);
          otpInputs.forEach(function (field) { field.classList.remove("is-active"); });
          if (input.value && otpInputs[index + 1]) {
            otpInputs[index + 1].classList.add("is-active");
            otpInputs[index + 1].focus();
          } else {
            input.classList.add("is-active");
          }
        });
        input.addEventListener("keydown", function (event) {
          if (event.key === "Backspace" && !input.value && otpInputs[index - 1]) {
            otpInputs[index - 1].focus();
            otpInputs[index - 1].classList.add("is-active");
          }
        });
      });

      function requestCode() {
        var contact = lookupEmail && lookupEmail.value ? String(lookupEmail.value).trim() : "";
        if (!contact) {
          setStatus(requestStatus, "Enter the phone number or email you used when you checked out.", "error");
          return;
        }
        currentContact = contact;
        requestBtn.disabled = true;
        setStatus(requestStatus, "Sending your one-time code...", "");
        postJson(requestPath, { contact: contact })
          .then(function (data) {
            if (data && data.found === false) {
              setStatus(requestStatus, data.message || "No order found for this email or phone number.", "error");
              return;
            }
            setStatus(requestStatus, "", "");
            if (otpLead) {
              otpLead.textContent = "We sent a 6-digit code to " + (data && data.emailHint ? data.emailHint : "the email linked to that order") + ".";
            }
            otpInputs.forEach(function (input, inputIndex) {
              input.value = "";
              input.classList.toggle("is-active", inputIndex === 0);
            });
            setPanel("otp");
            if (otpInputs[0]) otpInputs[0].focus();
          })
          .catch(function (error) {
            setStatus(requestStatus, error && error.message ? error.message : "Could not send your code right now.", "error");
          })
          .finally(function () {
            requestBtn.disabled = false;
          });
      }

      function verifyCode() {
        var code = joinOtp();
        if (!currentContact) {
          setPanel("find");
          setStatus(requestStatus, "Enter your checkout phone number or email first.", "error");
          return;
        }
        if (!/^\\d{6}$/.test(code)) {
          setStatus(verifyStatus, "Enter the full 6-digit code.", "error");
          return;
        }
        verifyBtn.disabled = true;
        setStatus(verifyStatus, "Checking your code...", "");
        postJson(verifyPath, { contact: currentContact, code: code })
          .then(function (data) {
            var orders = Array.isArray(data.orders) ? data.orders : [];
            if (!orders.length) {
              setStatus(verifyStatus, "No tracked orders were found for that contact.", "error");
              return;
            }
            renderResults(orders);
            setStatus(verifyStatus, "", "");
            setPanel("results");
          })
          .catch(function (error) {
            setStatus(verifyStatus, error && error.message ? error.message : "We could not verify that code.", "error");
          })
          .finally(function () {
            verifyBtn.disabled = false;
          });
      }

      if (requestBtn) requestBtn.addEventListener("click", requestCode);
      if (resendBtn) resendBtn.addEventListener("click", function () {
        if (!currentContact) {
          setPanel("find");
          return;
        }
        postJson(requestPath, { contact: currentContact })
          .then(function () {
            setStatus(verifyStatus, "We sent a new code to the email linked to that order.", "success");
          })
          .catch(function (error) {
            setStatus(verifyStatus, error && error.message ? error.message : "Could not resend your code.", "error");
          });
      });
      if (verifyBtn) verifyBtn.addEventListener("click", verifyCode);
      if (lookupEmail) {
        lookupEmail.addEventListener("keydown", function (event) {
          if (event.key === "Enter") requestCode();
        });
      }
    })();
  </script>
</body>
</html>`;
}

const helpPage: PageDefinition = {
  title: "Help | Eki",
  description: "Support information for Eki buyers and vendors.",
  eyebrow: "Support",
  heading: "Get help with orders, payouts, OTP and support.",
  intro:
    "Use these pages when you need help with guest order lookup, delivery updates, payouts, delivery confirmation, or account questions.",
  sections: [
    {
      title: "Fastest support route",
      bullets: [
        "Email adminandy@eki.app with your order number or checkout email.",
        "Guest buyers can use the public Find your order flow before contacting support.",
        "Vendors should include their store name and payout request ID for payout questions.",
      ],
    },
    {
      title: "Order help",
      bullets: [
        "Payment confirmation may take a short moment while providers confirm the transaction.",
        "Escrow-style deliveries may require additional confirmation before release.",
        "Disputes and refund reviews are handled by the admin team.",
      ],
    },
  ],
};

const supportPage: PageDefinition = {
  title: "Support | Eki",
  description: "Customer support information for Eki.",
  eyebrow: "Support",
  heading: "Reach support and resolve order issues quickly.",
  intro:
    "For order, vendor, payout, or OTP help, contact support with your email address and any order number you have available.",
  sections: [
    {
      title: "Contact",
      bullets: [
        "Email: adminandy@eki.app",
        "Public order lookup: /find-order",
        "Privacy: /privacy",
        "Terms: /terms",
      ],
    },
    {
      title: "What to include",
      bullets: [
        "Checkout email used for the order",
        "Order number if available",
        "Vendor/store name",
        "Screenshots for payment or UI issues",
      ],
    },
  ],
};

const privacyPage: PageDefinition = {
  title: "Privacy | Eki",
  description: "Privacy summary for Eki by Culinary Tales.",
  eyebrow: "Privacy",
  heading: "How Eki handles buyer, vendor, and order data.",
  intro:
    "Eki processes account, order, delivery, payment, notification, and support data to power the marketplace and order tracking flows.",
  sections: [
    {
      title: "Data processed",
      bullets: [
        "Account information such as name, email and phone number",
        "Order records, delivery address and order status",
        "Vendor storefront content and uploaded media",
        "Operational logs, notifications and support messages",
      ],
    },
    {
      title: "Why we process it",
      bullets: [
        "To authenticate users and protect accounts",
        "To process checkout, order tracking, payouts, disputes and refunds",
        "To deliver OTPs, notifications and transactional support email",
      ],
    },
  ],
};

const termsPage: PageDefinition = {
  title: "Terms | Eki",
  description: "Marketplace terms for Eki by Culinary Tales.",
  eyebrow: "Terms",
  heading: "Marketplace rules for buyers and vendors.",
  intro:
    "Eki provides shared storefronts, secure checkout, tracking, notifications, and platform tooling for buyers and vendors.",
  sections: [
    {
      title: "Buyer expectations",
      bullets: [
        "Provide accurate checkout and delivery information.",
        "Use the registered checkout email for guest order lookup.",
        "Respect delivery confirmation and dispute rules where escrow applies.",
      ],
    },
    {
      title: "Vendor expectations",
      bullets: [
        "Publish accurate product details, stock and pricing.",
        "Fulfill and manage orders through the platform.",
        "Maintain compliant store behavior to avoid suspension.",
      ],
    },
  ],
};

const accountDeletionPage: PageDefinition = {
  title: "Account deletion | Eki",
  description: "How account deletion works on Eki.",
  eyebrow: "Account deletion",
  heading: "Delete your account and understand what may remain.",
  intro:
    "Authenticated users can request account deletion from inside the app. Some financial and audit records may be retained where required.",
  sections: [
    {
      title: "What deletion removes",
      bullets: [
        "Access to the account and active sessions",
        "Profile access in the mobile app",
        "Access to buyer or vendor tools after deletion completes",
      ],
    },
    {
      title: "What may be retained",
      bullets: [
        "Order and payout records for compliance",
        "Security and audit logs for fraud review",
        "Records tied to unresolved disputes or refunds until closure",
      ],
    },
  ],
};

function sendHtml(response: Response, html: string): void {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "public, max-age=120, s-maxage=300");
  response.status(200).send(html);
}

function validateLookupContact(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("Invalid request body", 400);
  }
  const raw = body as Record<string, unknown>;
  const contact = typeof raw.contact === "string"
    ? raw.contact.trim()
    : typeof raw.email === "string"
      ? raw.email.trim()
      : "";
  if (!contact) {
    throw new AppError("Phone or email is required", 400);
  }
  return contact;
}

function validateVerification(body: unknown): { contact: string; code: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("Invalid request body", 400);
  }
  const raw = body as Record<string, unknown>;
  const contact = validateLookupContact(body);
  if (typeof raw.code !== "string" || !/^\d{6}$/.test(raw.code.trim())) {
    throw new AppError("Code must be a 6-digit number", 400);
  }
  return { contact, code: raw.code.trim() };
}

export async function getPublicHomePage(_request: Request, response: Response): Promise<void> {
  sendHtml(response, renderHomePage());
}

export async function getPublicFindOrderPage(_request: Request, response: Response): Promise<void> {
  sendHtml(response, renderFindOrderPage());
}

export async function requestPublicOrderLookup(request: Request, response: Response): Promise<void> {
  const contact = validateLookupContact(request.body);
  const otpEmail = await resolveLookupOtpEmail(contact);

  if (!otpEmail) {
    response.status(200).json({
      found: false,
      message: "No order found for this email or phone number.",
    });
    return;
  }

  await otpService.sendOtp(otpEmail, "guest_order_lookup");
  response.status(200).json({
    found: true,
    emailHint: maskEmail(otpEmail),
    message: "Verification code sent.",
  });
}

export async function verifyPublicOrderLookup(request: Request, response: Response): Promise<void> {
  const { contact, code } = validateVerification(request.body);
  const otpEmail = await resolveLookupOtpEmail(contact);
  if (!otpEmail) {
    throw new AppError("No matching orders found for that contact", 404);
  }
  await otpService.verifyOtp(otpEmail, code, "guest_order_lookup");
  const orders = await findOrdersByContact(contact);
  response.status(200).json({ orders: orders.map(renderOrderPayload) });
}

export async function getPublicHelpPage(_request: Request, response: Response): Promise<void> {
  sendHtml(response, renderLegalPage(helpPage));
}

export async function getPublicSupportPage(_request: Request, response: Response): Promise<void> {
  sendHtml(response, renderLegalPage(supportPage));
}

export async function getPublicPrivacyPage(_request: Request, response: Response): Promise<void> {
  sendHtml(response, renderLegalPage(privacyPage));
}

export async function getPublicTermsPage(_request: Request, response: Response): Promise<void> {
  sendHtml(response, renderLegalPage(termsPage));
}

export async function getPublicAccountDeletionPage(_request: Request, response: Response): Promise<void> {
  sendHtml(response, renderLegalPage(accountDeletionPage));
}


