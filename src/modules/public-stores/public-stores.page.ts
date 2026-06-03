import type { Request, Response } from "express";

import { publicStoresService } from "./public-stores.service";
import type { PublicProduct, PublicStore, PublicStoreTrackedOrder } from "./public-stores.types";

const PAGE_PRODUCTS_LIMIT = 48;

function escape(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatPrice(priceInCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: currency.toUpperCase() }).format(priceInCents / 100);
  } catch {
    return `${(priceInCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: currency.toUpperCase() }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function formatWeight(weightGrams: number | null | undefined): string {
  if (!weightGrams || weightGrams <= 0) return "500g pack";
  if (weightGrams >= 1000 && weightGrams % 1000 === 0) return `${weightGrams / 1000}kg`;
  if (weightGrams >= 1000) return `${(weightGrams / 1000).toFixed(1)}kg`;
  return `${weightGrams}g`;
}

function productCode(title: string): string {
  const code = title
    .split(/\s+/)
    .map((part) => part.trim().charAt(0))
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return code || "EK";
}

function productImage(product: PublicProduct): string {
  const image = product.images[0];
  if (image) {
    return `<img src="${escape(image)}" alt="${escape(product.title)}" loading="lazy" />`;
  }
  return `<div class="placeholder-pill">${escape(productCode(product.title))}</div>`;
}

function statusSteps(status: PublicStoreTrackedOrder["status"]) {
  const steps = [
    { key: "placed", label: "Order placed", helper: "Order received" },
    { key: "accepted", label: "Vendor confirmed", helper: "Order approved" },
    { key: "preparing", label: "Preparing your order", helper: "In progress..." },
    { key: "dispatched", label: "Dispatched", helper: "Pending" },
    { key: "delivered", label: "Delivered", helper: "Pending" },
  ] as const;

  const order = ["placed", "accepted", "preparing", "dispatched", "delivered"];
  const activeIndex = Math.max(order.indexOf(status), 0);

  return steps.map((step, index) => ({
    ...step,
    complete: index < activeIndex,
    active: index === activeIndex,
  }));
}

function baseStyles(title: string, description: string, extraHead = ""): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#134f3b" />
  <title>${escape(title)}</title>
  <meta name="description" content="${escape(description)}" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" />
  ${extraHead}
  <style>
    *,*::before,*::after{box-sizing:border-box}
    html,body{margin:0;padding:0}
    body{
      font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      background:#f6faf6;
      color:#111827;
      line-height:1.45;
      -webkit-font-smoothing:antialiased;
    }
    a{text-decoration:none;color:inherit}
    button,input{font:inherit}
    button{cursor:pointer}
    .shell{min-height:100vh;background:#fff}
    .topbar{
      background:#134f3b;
      color:#fff;
      min-height:28px;
      border-bottom:1px solid rgba(255,255,255,.12);
    }
    .topbar-inner{
      max-width:1200px;
      margin:0 auto;
      padding:4px 10px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
    }
    .brand{
      display:inline-flex;
      align-items:center;
      min-width:44px;
      height:20px;
      padding:0 10px;
      border-radius:4px;
      background:rgba(255,255,255,.12);
      font-weight:800;
      font-size:12px;
      letter-spacing:-0.02em;
    }
    .mini-copy{
      flex:1;
      text-align:center;
      font-size:8px;
      color:rgba(255,255,255,.85);
      font-weight:600;
    }
    .top-btn{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      min-width:96px;
      min-height:24px;
      padding:0 12px;
      border-radius:6px;
      border:1px solid rgba(255,255,255,.45);
      background:rgba(255,255,255,.08);
      color:#fff;
      font-size:11px;
      font-weight:600;
    }
    .container{max-width:1200px;margin:0 auto;padding:0 10px}
    .store-band{padding:12px 0 10px}
    .store-card{
      display:flex;
      gap:14px;
      align-items:flex-start;
      padding:12px 14px;
      border:1px solid #dbe7dd;
      border-radius:10px;
      background:#fff;
    }
    .avatar{
      width:40px;height:40px;border-radius:8px;background:#134f3b;color:#fff;
      display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;overflow:hidden;flex-shrink:0;
    }
    .avatar img{width:100%;height:100%;object-fit:cover}
    .store-meta h1{margin:0;font-size:21px;line-height:1.1;font-weight:800}
    .badge{
      display:inline-flex;align-items:center;gap:4px;
      padding:2px 7px;border-radius:999px;background:#e4f2e8;color:#16513b;font-size:10px;font-weight:700;
      margin-left:8px;vertical-align:middle;
    }
    .store-meta .sub{
      margin:4px 0 0;color:#6b7280;font-size:11px;
    }
    .store-meta .copy{
      margin:4px 0 0;color:#6b7280;font-size:11px;max-width:780px;
    }
    .trust-strip{
      margin:10px 0 0;
      border:1px solid #d5ead7;
      border-radius:4px;
      padding:6px 10px;
      color:#2d6a4f;
      font-size:10px;
      display:flex;
      justify-content:center;
      gap:28px;
      flex-wrap:wrap;
      background:#f4fbf5;
    }
    .section-head{
      display:flex;justify-content:space-between;align-items:center;
      margin:10px 0 8px;
    }
    .section-head h2{margin:0;font-size:13px;font-weight:800}
    .muted{color:#6b7280;font-size:10px}
    .products{
      display:grid;
      grid-template-columns:repeat(4,minmax(0,1fr));
      gap:10px;
      list-style:none;
      padding:0;
      margin:0;
    }
    .product-card{
      border:1px solid #dbe7dd;
      border-radius:0;
      overflow:hidden;
      background:#fff;
    }
    .product-top{
      display:block;
      position:relative;
      min-height:118px;
      padding:14px;
      background:#eef8ee;
      border:0;
      width:100%;
      text-align:left;
    }
    .product-top img{
      width:100%;
      height:90px;
      object-fit:cover;
      border-radius:8px;
      display:block;
    }
    .placeholder-pill{
      margin:28px auto 0;
      width:max-content;
      min-width:48px;
      padding:7px 12px;
      border-radius:8px;
      background:#d6ecd9;
      color:#2d6a4f;
      font-size:12px;
      font-weight:800;
      letter-spacing:.04em;
      text-align:center;
    }
    .stock-pill{
      position:absolute;
      top:8px;
      right:8px;
      padding:3px 8px;
      border-radius:999px;
      background:#2b7a4b;
      color:#fff;
      font-size:8px;
      font-weight:700;
    }
    .stock-pill.is-sold{background:#64748b}
    .product-body{padding:8px 8px 10px}
    .product-title{
      margin:0 0 2px;
      font-size:11px;
      font-weight:700;
      line-height:1.3;
    }
    .product-meta{
      margin:0;
      font-size:9px;
      color:#6b7280;
    }
    .product-row{
      margin-top:8px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
    }
    .product-price{
      margin:0;
      font-size:12px;
      font-weight:800;
      color:#111827;
    }
    .icon-add{
      width:20px;height:20px;border-radius:4px;border:0;
      background:#134f3b;color:#fff;font-weight:800;font-size:14px;
      display:inline-flex;align-items:center;justify-content:center;
    }
    .sticky-cart{
      position:sticky;
      bottom:0;
      background:#fff;
      border-top:1px solid #dbe7dd;
      margin-top:18px;
    }
    .sticky-cart-inner{
      max-width:1200px;
      margin:0 auto;
      padding:12px 10px;
      display:flex;
      justify-content:space-between;
      align-items:flex-end;
      gap:12px;
    }
    .sticky-copy small{display:block;color:#6b7280;font-size:9px}
    .sticky-copy strong{display:block;font-size:18px;line-height:1.1}
    .cart-btn{
      display:inline-flex;align-items:center;justify-content:center;
      min-width:108px;min-height:32px;padding:0 16px;border:0;border-radius:999px;
      background:#134f3b;color:#fff;font-size:11px;font-weight:700;
    }
    .page-wrap{max-width:1200px;margin:0 auto;padding:0 10px}
    .split{
      display:grid;
      grid-template-columns:minmax(0,58%) minmax(340px,42%);
      min-height:calc(100vh - 28px);
      background:#fff;
    }
    .panel-media{
      background:#eef8ee;
      padding:16px;
      border-right:1px solid #dbe7dd;
      position:relative;
    }
    .back-link{
      width:24px;height:24px;border-radius:999px;border:0;background:#fff;color:#134f3b;
      display:inline-flex;align-items:center;justify-content:center;font-size:16px;font-weight:800;
      box-shadow:0 1px 4px rgba(0,0,0,.08);
    }
    .hero-image{
      height:100%;
      min-height:420px;
      display:flex;
      align-items:center;
      justify-content:center;
      padding:30px;
    }
    .hero-image img{max-width:100%;max-height:420px;border-radius:18px;object-fit:cover}
    .panel-copy{
      padding:18px 22px 22px;
    }
    .inline-badges{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
    .pill{
      display:inline-flex;align-items:center;gap:6px;
      padding:4px 9px;border-radius:999px;background:#e4f2e8;color:#16513b;
      font-size:9px;font-weight:700;
    }
    .crumb{font-size:10px;color:#6b7280}
    .panel-copy h1{margin:8px 0 4px;font-size:21px;line-height:1.15;font-weight:800}
    .lead-row{display:flex;gap:16px;flex-wrap:wrap;color:#6b7280;font-size:10px}
    .desc{
      margin:16px 0 0;
      padding:14px;
      border-radius:4px;
      background:#f7faf7;
      color:#46505a;
      font-size:11px;
    }
    .qty-row{margin-top:16px}
    .qty-row label{display:block;font-size:10px;font-weight:600;margin-bottom:6px}
    .qty-control{
      display:inline-flex;align-items:center;gap:8px;border:1px solid #dbe7dd;border-radius:8px;padding:4px 6px;background:#fff;
    }
    .qty-control button{
      width:24px;height:24px;border:0;background:#f3f5f4;border-radius:6px;color:#134f3b;font-size:14px;font-weight:700;
    }
    .qty-control span{min-width:16px;text-align:center;font-size:12px;font-weight:700}
    .secure-strip{
      margin-top:12px;
      border:1px solid #cfe7d6;
      background:#f4fbf5;
      color:#2d6a4f;
      font-size:10px;
      border-radius:4px;
      padding:6px 10px;
      display:flex;justify-content:center;gap:18px;flex-wrap:wrap;
    }
    .primary-action{
      width:100%;
      min-height:40px;
      margin-top:10px;
      border:0;border-radius:6px;
      background:#134f3b;color:#fff;
      font-size:13px;font-weight:700;
    }
    .page-card{
      max-width:1140px;
      margin:22px auto;
      padding:0 10px;
    }
    .checkout-grid{
      display:grid;
      grid-template-columns:minmax(0,1fr) 320px;
      gap:20px;
      align-items:start;
    }
    .checkout-title{margin:0;font-size:18px;font-weight:800}
    .checkout-sub{margin:4px 0 16px;color:#6b7280;font-size:11px}
    .form-card{
      border:1px solid #e3ece5;
      border-radius:10px;
      background:#fff;
      padding:14px;
      margin-bottom:12px;
    }
    .section-label{
      font-size:9px;
      font-weight:800;
      letter-spacing:.08em;
      color:#6b7280;
      margin:0 0 10px;
      text-transform:uppercase;
    }
    .grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
    .field{display:flex;flex-direction:column;gap:5px}
    .field input{
      width:100%;
      min-height:38px;
      border:1px solid #e3ece5;
      border-radius:6px;
      padding:0 12px;
      background:#fff;
    }
    .field-full{grid-column:1/-1}
    .payment-box{
      display:flex;align-items:center;gap:8px;
      min-height:40px;border:1px solid #c8dbce;border-radius:6px;padding:0 12px;margin-bottom:12px;
    }
    .summary{
      border:1px solid #e3ece5;border-radius:10px;background:#fff;padding:14px;position:sticky;top:44px;
    }
    .summary h3{margin:0 0 10px;font-size:12px;font-weight:800}
    .summary-line,.summary-total{
      display:flex;justify-content:space-between;gap:12px;font-size:11px;
    }
    .summary-line{margin:8px 0;color:#4b5563}
    .summary-total{
      margin-top:10px;padding-top:10px;border-top:1px solid #ecf1ed;
      font-size:18px;font-weight:800;color:#111827;
    }
    .summary-item{
      display:flex;justify-content:space-between;gap:10px;margin:8px 0;font-size:11px;
    }
    .summary-item-name{display:flex;gap:8px}
    .mini-code{
      width:18px;height:18px;border-radius:6px;background:#e4f2e8;color:#16513b;
      display:inline-flex;align-items:center;justify-content:center;font-size:8px;font-weight:800;flex-shrink:0;
    }
    .summary-pay{
      width:100%;min-height:38px;margin-top:14px;border:0;border-radius:8px;background:#134f3b;color:#fff;font-weight:700;
    }
    .foot-note{margin-top:8px;color:#6b7280;font-size:10px;text-align:center}
    .flash{
      margin-bottom:12px;padding:10px 12px;border-radius:8px;border:1px solid #f0d8b0;background:#fff9ef;color:#8a5a11;font-size:11px;
    }
    .confirm-shell{max-width:680px;margin:26px auto 0;padding:0 10px;text-align:center}
    .confirm-badge{
      display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:999px;border:2px solid #9ad0ac;color:#134f3b;font-size:26px;font-weight:800;
    }
    .confirm-shell h1{margin:14px 0 6px;font-size:18px;font-weight:800}
    .confirm-sub{margin:0;color:#6b7280;font-size:11px}
    .order-chip{
      display:inline-flex;align-items:center;justify-content:center;margin-top:10px;padding:4px 10px;border-radius:999px;background:#edf7ef;color:#2d6a4f;font-size:10px;font-weight:700;
    }
    .confirm-card{
      margin:18px auto 0;max-width:400px;border-radius:16px;background:#134f3b;color:#fff;padding:14px 14px 0;text-align:left;
    }
    .confirm-card h2{margin:6px 0;font-size:18px}
    .confirm-list{list-style:none;padding:0;margin:10px 0 0}
    .confirm-list li{display:flex;gap:8px;align-items:flex-start;font-size:11px;margin-top:8px}
    .confirm-list li::before{content:"✓";font-weight:700}
    .white-btn{
      width:100%;min-height:38px;margin-top:16px;border:0;border-radius:10px;background:#fff;color:#134f3b;font-weight:700;
    }
    .ghost-link{
      display:inline-flex;align-items:center;justify-content:center;min-width:200px;min-height:34px;margin-top:14px;border:1px solid #e3ece5;border-radius:999px;background:#fff;color:#6b7280;font-size:11px;font-weight:600;
    }
    .track-shell{max-width:1200px;margin:0 auto;padding:20px 10px 30px}
    .track-shell h1{margin:0;text-align:center;font-size:20px;font-weight:800}
    .track-chip{display:block;width:max-content;margin:10px auto 18px;padding:4px 10px;border-radius:999px;background:#edf7ef;color:#2d6a4f;font-size:10px;font-weight:700}
    .track-grid{
      display:grid;
      grid-template-columns:minmax(0,1fr) 240px;
      gap:16px;
      align-items:start;
    }
    .track-card,.side-card{
      border:1px solid #e3ece5;border-radius:10px;background:#fff;padding:16px;
    }
    .track-card h2,.side-card h2{margin:0 0 10px;font-size:12px;font-weight:800}
    .timeline{display:flex;flex-direction:column;gap:14px;margin-top:10px}
    .step{display:grid;grid-template-columns:20px 1fr;gap:10px;align-items:start}
    .step-dot{
      width:20px;height:20px;border-radius:999px;border:2px solid #d9e5dd;background:#fff;
      display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#134f3b;
    }
    .step.complete .step-dot{background:#2d6a4f;border-color:#2d6a4f;color:#fff}
    .step.active .step-dot{border-color:#2d6a4f}
    .step h3{margin:0;font-size:12px;font-weight:700}
    .step p{margin:2px 0 0;font-size:10px;color:#6b7280}
    .bottom-banner{
      margin-top:16px;padding:14px;border-radius:10px;background:#134f3b;color:#fff;display:flex;justify-content:space-between;align-items:center;gap:12px;
    }
    .bottom-banner p{margin:0;font-size:11px;color:rgba(255,255,255,.84)}
    .bottom-banner .open-app{
      min-width:110px;min-height:34px;border:0;border-radius:8px;background:#fff;color:#134f3b;font-weight:700;
    }
    .download-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
    .download-btn{
      display:inline-flex;flex-direction:column;justify-content:center;
      min-width:116px;min-height:46px;padding:8px 14px;border-radius:8px;background:#2b7a4b;color:#fff;font-size:10px;font-weight:500;
    }
    .download-btn.is-light{background:#fff;color:#111827}
    .download-btn strong{font-size:18px;line-height:1.05}
    .hero{
      background:#134f3b;color:#fff;
    }
    .hero-inner{
      max-width:1200px;margin:0 auto;padding:48px 10px 30px;
      display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:26px;align-items:center;
    }
    .hero h1{margin:0 0 12px;font-size:34px;line-height:1.1;font-weight:800;max-width:520px}
    .hero p{margin:0 0 20px;color:rgba(255,255,255,.84);max-width:560px}
    .device{
      height:232px;border-radius:14px;background:#2b7a4b;display:flex;align-items:center;justify-content:center;
      box-shadow:inset 0 0 0 1px rgba(255,255,255,.1);
      font-size:28px;
    }
    .why{
      padding:18px 10px 0;max-width:1200px;margin:0 auto;text-align:center;
    }
    .why h2{margin:0 0 16px;font-size:20px;font-weight:800}
    .why-grid{
      display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;
    }
    .why-card{
      text-align:left;border:1px solid #dbe7dd;border-radius:12px;background:#eef8ee;padding:18px;
    }
    .why-card h3{margin:14px 0 8px;font-size:13px;font-weight:700}
    .why-card p{margin:0;color:#6b7280;font-size:11px}
    .find-strip{
      margin-top:24px;padding:14px 0 20px;background:#eef8ee;border-top:1px solid #dde8df;
    }
    .find-strip-inner{
      max-width:1200px;margin:0 auto;padding:0 10px;display:flex;justify-content:center;align-items:center;gap:18px;flex-wrap:wrap;
    }
    .find-link{
      min-width:180px;min-height:38px;border-radius:8px;border:1px solid #134f3b;background:#fff;color:#134f3b;font-weight:700;display:inline-flex;align-items:center;justify-content:center;
    }
    .empty-state{
      border:1px solid #dbe7dd;border-radius:12px;background:#fff;padding:30px;text-align:center;color:#6b7280;
    }
    @media (max-width: 980px){
      .products,.why-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
      .split,.checkout-grid,.track-grid,.hero-inner{grid-template-columns:1fr}
      .summary{position:static}
      .device{height:180px}
    }
    @media (max-width: 640px){
      .topbar-inner,.header-row,.sticky-cart-inner,.store-card,.bottom-banner,.find-strip-inner{flex-direction:column;align-items:stretch}
      .mini-copy{text-align:left}
      .products,.why-grid,.grid-2{grid-template-columns:1fr}
      .hero h1{font-size:28px}
      .store-meta h1,.panel-copy h1{font-size:24px}
      .top-btn,.cart-btn,.find-link,.download-btn{width:100%}
    }
  </style>
</head>
<body>`;
}

function renderTopbar(right: string): string {
  return `
  <div class="topbar">
    <div class="topbar-inner">
      <a class="brand" href="/">eki.</a>
      <div class="mini-copy">+ Auto-synced from Eki app</div>
      <div>${right}</div>
    </div>
  </div>`;
}

function renderStoreHeader(store: PublicStore): string {
  const avatar = store.avatar
    ? `<div class="avatar"><img src="${escape(store.avatar)}" alt="${escape(store.storeName)}" /></div>`
    : `<div class="avatar">${escape(store.storeName.slice(0, 2).toUpperCase())}</div>`;

  return `
    <div class="store-band">
      <div class="container">
        <div class="store-card">
          ${avatar}
          <div class="store-meta">
            <h1>${escape(store.storeName)} <span class="badge">Verified Vendor</span></h1>
            <p class="sub">${escape([store.city, store.country].filter(Boolean).join(", ") || "Birmingham, UK")} · ${escape(`${store.rating ?? 4.9}`)} ★</p>
            <p class="copy">${escape(store.description || "Authentic African foodstuff delivered to your door. Order securely without sending DMs.")}</p>
          </div>
        </div>
        <div class="trust-strip">
          <span>Secure checkout</span>
          <span>Instant confirmation</span>
          <span>Track in Eki</span>
        </div>
      </div>
    </div>`;
}

function renderStorePage(store: PublicStore, products: PublicProduct[]): string {
  const productsHtml = products.map((product) => {
    const productHref = `/store/${encodeURIComponent(store.storeSlug)}/product/${encodeURIComponent(product.id)}`;
    const stock = product.stock > 0 ? `${product.stock} in stock` : "No stock";
    return `
      <li class="product-card">
        <a class="product-top" href="${productHref}">
          <span class="stock-pill${product.stock > 0 ? "" : " is-sold"}">${escape(stock)}</span>
          ${productImage(product)}
        </a>
        <div class="product-body">
          <a href="${productHref}">
            <h3 class="product-title">${escape(product.title)}</h3>
            <p class="product-meta">${escape(formatWeight(product.weightGrams))} · 2-4 days</p>
          </a>
          <div class="product-row">
            <p class="product-price">${escape(formatPrice(product.priceInCents, product.currency))}</p>
            <button class="icon-add add-to-cart" type="button" data-product-id="${escape(product.id)}" aria-label="Add ${escape(product.title)}">+</button>
          </div>
        </div>
      </li>`;
  }).join("");

  return `${baseStyles(`${store.storeName} | Eki`, store.description ?? store.storeName)}
  <div class="shell">
    ${renderTopbar(`<a class="top-btn" id="top-cart-button" href="/store/${encodeURIComponent(store.storeSlug)}/checkout">View Cart (0)</a>`)}
    ${renderStoreHeader(store)}
    <div class="container">
      <div class="section-head">
        <h2>All Products</h2>
        <span class="muted">${products.length} items</span>
      </div>
      <ul class="products">${productsHtml}</ul>
    </div>
    <div class="sticky-cart" id="sticky-cart">
      <div class="sticky-cart-inner">
        <div class="sticky-copy">
          <small id="cart-copy">0 items in cart</small>
          <strong id="cart-total">${escape(formatPrice(0, products[0]?.currency ?? "EUR"))}</strong>
        </div>
        <a class="cart-btn" id="bottom-cart-button" href="/store/${encodeURIComponent(store.storeSlug)}/checkout">View Cart →</a>
      </div>
    </div>
  </div>
  <script>
    (function(){
      var storeSlug = ${JSON.stringify(store.storeSlug)};
      var cartKey = 'eki_public_store_cart_' + storeSlug;
      var products = JSON.parse(${JSON.stringify(JSON.stringify(products.map((product) => ({
        id: product.id,
        title: product.title,
        priceInCents: product.priceInCents,
        currency: product.currency,
      }))))});
      function readCart(){
        try {
          var parsed = JSON.parse(localStorage.getItem(cartKey) || '[]');
          return Array.isArray(parsed) ? parsed : [];
        } catch (_error) {
          return [];
        }
      }
      function writeCart(cart){
        localStorage.setItem(cartKey, JSON.stringify(cart));
      }
      function formatPrice(amount, currency){
        try { return new Intl.NumberFormat('en-GB', { style:'currency', currency:String(currency || 'EUR').toUpperCase() }).format(amount / 100); }
        catch (_error) { return (amount / 100).toFixed(2) + ' ' + String(currency || 'EUR').toUpperCase(); }
      }
      function updateCartUi(){
        var cart = readCart();
        var count = cart.reduce(function(sum, item){ return sum + Number(item.quantity || 0); }, 0);
        var total = cart.reduce(function(sum, item){
          var product = products.find(function(entry){ return entry.id === item.productId; });
          return sum + (product ? product.priceInCents * Number(item.quantity || 0) : 0);
        }, 0);
        var currency = (products[0] && products[0].currency) || 'EUR';
        var topBtn = document.getElementById('top-cart-button');
        var bottomBtn = document.getElementById('bottom-cart-button');
        var copy = document.getElementById('cart-copy');
        var totalEl = document.getElementById('cart-total');
        if(topBtn) topBtn.textContent = 'View Cart (' + count + ')';
        if(bottomBtn) bottomBtn.textContent = 'View Cart →';
        if(copy) copy.textContent = count + ' item' + (count === 1 ? '' : 's') + ' in cart';
        if(totalEl) totalEl.textContent = formatPrice(total, currency);
      }
      function addProduct(productId){
        var cart = readCart();
        var existing = cart.find(function(item){ return item.productId === productId; });
        if(existing){ existing.quantity += 1; } else { cart.push({ productId: productId, quantity: 1 }); }
        writeCart(cart);
        updateCartUi();
      }
      document.querySelectorAll('.add-to-cart').forEach(function(button){
        button.addEventListener('click', function(event){
          event.preventDefault();
          event.stopPropagation();
          addProduct(String(button.getAttribute('data-product-id') || ''));
        });
      });
      updateCartUi();
    })();
  </script>
</body>
</html>`;
}

function renderStoreDirectoryPage(stores: PublicStore[]): string {
  const cards = stores.length > 0
    ? stores.map((store) => `
      <a class="product-card" href="/store/${encodeURIComponent(store.storeSlug)}" style="padding:0">
        <div class="product-top" style="min-height:140px">
          ${store.coverImage ? `<img src="${escape(store.coverImage)}" alt="${escape(store.storeName)}" loading="lazy" />` : `<div class="placeholder-pill">${escape(productCode(store.storeName))}</div>`}
        </div>
        <div class="product-body" style="padding:14px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
            <h3 class="product-title" style="font-size:14px">${escape(store.storeName)}</h3>
            <span class="badge" style="margin-left:0">${escape(store.totalProducts)} items</span>
          </div>
          <p class="product-meta" style="margin-top:6px">${escape([store.city, store.country].filter(Boolean).join(", ") || "United Kingdom")}</p>
          <p class="muted" style="margin:8px 0 0;font-size:11px">${escape(store.description || "Open this vendor storefront to browse products, add to cart and checkout securely.")}</p>
        </div>
      </a>
    `).join("")
    : `<div class="empty-state">No vendor stores are live yet.</div>`;

  return `${baseStyles("Vendors | Eki", "Browse Eki vendor storefronts")}
  <div class="shell">
    ${renderTopbar(`<span class="top-btn">Vendors</span>`)}
    <section class="hero">
      <div class="hero-inner">
        <div>
          <h1>Browse verified vendor stores.</h1>
          <p>Open any Eki vendor storefront, add foodstuff to your cart, pay securely, and track the order on the web or in the app.</p>
        </div>
        <div class="device">🏪</div>
      </div>
    </section>
    <div class="container" style="padding-top:20px;padding-bottom:36px">
      <div class="section-head">
        <h2>All vendor stores</h2>
        <span class="muted">${stores.length} stores</span>
      </div>
      <div class="products">${cards}</div>
    </div>
  </div>
</body>
</html>`;
}

function renderProductPage(store: PublicStore, product: PublicProduct): string {
  const cartHref = `/store/${encodeURIComponent(store.storeSlug)}/checkout`;
  return `${baseStyles(`${product.title} | ${store.storeName}`, product.description ?? product.title)}
  <div class="shell">
    ${renderTopbar(`<a class="top-btn" id="product-cart-button" href="${cartHref}">View Cart (0)</a>`)}
    <div class="page-wrap">
      <div class="split">
        <div class="panel-media">
          <a class="back-link" href="/store/${encodeURIComponent(store.storeSlug)}">←</a>
          <div class="hero-image">${productImage(product)}</div>
        </div>
        <div class="panel-copy">
          <div class="inline-badges">
            <span class="crumb">← Back to all products</span>
            <span class="pill">Sold by ${escape(store.storeName)}</span>
          </div>
          <h1>${escape(product.title)}</h1>
          <div class="lead-row">
            <span>${escape(formatWeight(product.weightGrams))}</span>
            <span>Ships from ${escape(store.city || store.country || "Birmingham")}</span>
            <span>Delivery 2-4 days</span>
          </div>
          <p class="product-price" style="font-size:34px;margin-top:12px">${escape(formatPrice(product.priceInCents, product.currency))}</p>
          <div class="desc">${escape(product.description || `Freshly packed ${product.title}. Sourced directly from trusted African foodstuff vendors and prepared for fast secure checkout.`)}</div>
          <div class="qty-row">
            <label>Quantity</label>
            <div class="qty-control">
              <button type="button" id="qty-minus">−</button>
              <span id="qty-value">1</span>
              <button type="button" id="qty-plus">+</button>
            </div>
          </div>
          <div class="secure-strip">
            <span>Secure checkout</span>
            <span>Order recorded on Eki</span>
          </div>
          <button class="primary-action" type="button" id="add-product-button">Add to Cart — ${escape(formatPrice(product.priceInCents, product.currency))}</button>
        </div>
      </div>
    </div>
  </div>
  <script>
    (function(){
      var storeSlug = ${JSON.stringify(store.storeSlug)};
      var productId = ${JSON.stringify(product.id)};
      var cartKey = 'eki_public_store_cart_' + storeSlug;
      var quantity = 1;
      function readCart(){
        try { var parsed = JSON.parse(localStorage.getItem(cartKey) || '[]'); return Array.isArray(parsed) ? parsed : []; }
        catch (_error) { return []; }
      }
      function writeCart(cart){ localStorage.setItem(cartKey, JSON.stringify(cart)); }
      function updateQuantity(){
        var value = document.getElementById('qty-value');
        if(value) value.textContent = String(quantity);
      }
      function updateCartButton(){
        var count = readCart().reduce(function(sum, item){ return sum + Number(item.quantity || 0); }, 0);
        var button = document.getElementById('product-cart-button');
        if(button) button.textContent = 'View Cart (' + count + ')';
      }
      function addToCart(){
        var cart = readCart();
        var existing = cart.find(function(item){ return item.productId === productId; });
        if(existing){ existing.quantity += quantity; } else { cart.push({ productId: productId, quantity: quantity }); }
        writeCart(cart);
        updateCartButton();
        window.location.href = '/store/' + encodeURIComponent(storeSlug) + '/checkout';
      }
      document.getElementById('qty-minus')?.addEventListener('click', function(){ quantity = Math.max(1, quantity - 1); updateQuantity(); });
      document.getElementById('qty-plus')?.addEventListener('click', function(){ quantity += 1; updateQuantity(); });
      document.getElementById('add-product-button')?.addEventListener('click', addToCart);
      updateQuantity();
      updateCartButton();
    })();
  </script>
</body>
</html>`;
}

function renderCheckoutPage(store: PublicStore, products: PublicProduct[], cancelled: boolean): string {
  const serializedProducts = JSON.stringify(products.map((product) => ({
    id: product.id,
    title: product.title,
    priceInCents: product.priceInCents,
    currency: product.currency,
    image: product.images[0] ?? null,
    weightLabel: formatWeight(product.weightGrams),
  })));

  return `${baseStyles(`Complete your order | ${store.storeName}`, store.description ?? store.storeName)}
  <div class="shell">
    ${renderTopbar(`<span class="top-btn" style="min-width:140px">🔒 Secure Checkout</span>`)}
    <div class="page-card">
      ${cancelled ? `<div class="flash">Your payment window was cancelled. Your cart is still here, so you can try again.</div>` : ""}
      <div class="checkout-grid">
        <div>
          <h1 class="checkout-title">Complete your order</h1>
          <p class="checkout-sub">No app required. Pay securely and receive confirmation instantly.</p>
          <form id="checkout-form">
            <div class="form-card">
              <p class="section-label">Your details</p>
              <div class="grid-2">
                <label class="field"><span>First name</span><input name="firstName" value="Amara" required /></label>
                <label class="field"><span>Last name</span><input name="lastName" value="Okafor" required /></label>
                <label class="field field-full"><span>Phone number</span><input name="phone" value="+44 7700 900123" required /></label>
                <label class="field field-full"><span>Email</span><input name="email" value="buyer@eki.app" type="email" required /></label>
              </div>
            </div>
            <div class="form-card">
              <p class="section-label">Delivery address</p>
              <div class="grid-2">
                <label class="field field-full"><span>Street address</span><input name="streetAddress" value="14 Broad Street" required /></label>
                <label class="field"><span>City</span><input name="city" value="London" required /></label>
                <label class="field"><span>Postcode</span><input name="postcode" value="E1 6RF" required /></label>
                <label class="field field-full"><span>Country</span><input name="country" value="${escape(store.deliveryCountries[0] || store.country || "United Kingdom")}" required /></label>
              </div>
            </div>
            <div class="form-card">
              <p class="section-label">Payment</p>
              <div class="payment-box">💳 Credit / Debit Card <span class="muted">Visa, Mastercard, Amex</span></div>
              <button class="summary-pay" type="submit" id="checkout-submit">Pay Securely</button>
              <p class="foot-note">Secure checkout powered by Eki</p>
            </div>
          </form>
        </div>
        <aside class="summary">
          <h3>Order Summary</h3>
          <div id="checkout-items"></div>
          <div class="summary-line"><span>Subtotal</span><span id="summary-subtotal">—</span></div>
          <div class="summary-line"><span>Delivery</span><span id="summary-delivery">—</span></div>
          <div class="summary-total"><span>Total</span><span id="summary-total">—</span></div>
        </aside>
      </div>
    </div>
  </div>
  <script>
    (function(){
      var storeSlug = ${JSON.stringify(store.storeSlug)};
      var cartKey = 'eki_public_store_cart_' + storeSlug;
      var products = JSON.parse(${JSON.stringify(serializedProducts)});
      var form = document.getElementById('checkout-form');
      var itemsWrap = document.getElementById('checkout-items');
      function readCart(){
        try { var parsed = JSON.parse(localStorage.getItem(cartKey) || '[]'); return Array.isArray(parsed) ? parsed : []; }
        catch (_error) { return []; }
      }
      function formatPrice(amount, currency){
        try { return new Intl.NumberFormat('en-GB', { style:'currency', currency:String(currency || 'EUR').toUpperCase() }).format(amount / 100); }
        catch (_error) { return (amount / 100).toFixed(2) + ' ' + String(currency || 'EUR').toUpperCase(); }
      }
      function renderSummary(){
        var cart = readCart();
        var subtotal = 0;
        var currency = (products[0] && products[0].currency) || 'EUR';
        if(!cart.length){
          if(itemsWrap) itemsWrap.innerHTML = '<div class="empty-state">Your cart is empty. Go back to the store to add products.</div>';
          document.getElementById('summary-subtotal').textContent = formatPrice(0, currency);
          document.getElementById('summary-delivery').textContent = formatPrice(0, currency);
          document.getElementById('summary-total').textContent = formatPrice(0, currency);
          return;
        }
        if(itemsWrap) itemsWrap.innerHTML = cart.map(function(item){
          var product = products.find(function(entry){ return entry.id === item.productId; });
          if(!product) return '';
          subtotal += product.priceInCents * Number(item.quantity || 0);
          return '<div class="summary-item"><div class="summary-item-name"><span class="mini-code">' + product.title.split(/\\s+/).map(function(part){return part[0] || '';}).join('').slice(0,2).toUpperCase() + '</span><div><strong>' + product.title + '</strong><br><span class="muted">' + product.weightLabel + '</span></div></div><strong>' + formatPrice(product.priceInCents * Number(item.quantity || 0), currency) + '</strong></div>';
        }).join('');
        document.getElementById('summary-subtotal').textContent = formatPrice(subtotal, currency);
        document.getElementById('summary-delivery').textContent = 'Calculated at payment';
        document.getElementById('summary-total').textContent = formatPrice(subtotal, currency);
      }
      form?.addEventListener('submit', function(event){
        event.preventDefault();
        var cart = readCart();
        if(!cart.length){
          alert('Your cart is empty.');
          return;
        }
        var submit = document.getElementById('checkout-submit');
        if(submit) submit.disabled = true;
        var formData = new FormData(form);
        var payload = {
          firstName: String(formData.get('firstName') || '').trim(),
          lastName: String(formData.get('lastName') || '').trim(),
          phone: String(formData.get('phone') || '').trim(),
          email: String(formData.get('email') || '').trim().toLowerCase(),
          streetAddress: String(formData.get('streetAddress') || '').trim(),
          city: String(formData.get('city') || '').trim(),
          postcode: String(formData.get('postcode') || '').trim(),
          country: String(formData.get('country') || '').trim(),
          items: cart
        };
        fetch('/api/public/stores/' + encodeURIComponent(storeSlug) + '/checkout', {
          method:'POST',
          headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify(payload)
        })
          .then(async function(response){
            if(!response.ok){
              var errorBody = await response.json().catch(function(){ return {}; });
              throw new Error(errorBody.message || 'Could not start payment.');
            }
            return response.json();
          })
          .then(function(data){
            if(data && data.checkoutUrl){
              window.location.href = data.checkoutUrl;
            } else {
              throw new Error('Checkout session did not return a payment link.');
            }
          })
          .catch(function(error){
            alert(error && error.message ? error.message : 'Could not start payment.');
          })
          .finally(function(){
            if(submit) submit.disabled = false;
          });
      });
      renderSummary();
    })();
  </script>
</body>
</html>`;
}

function renderConfirmationPage(store: PublicStore, order: PublicStoreTrackedOrder): string {
  return `${baseStyles(`Order confirmed | ${store.storeName}`, `Order ${order.orderNumber} confirmed.`)}
  <div class="shell">
    ${renderTopbar(`<span class="top-btn" style="min-width:120px">Order confirmed</span>`)}
    <div class="confirm-shell">
      <div class="confirm-badge">✓</div>
      <h1>Order confirmed</h1>
      <p class="confirm-sub">${escape(store.storeName)} received your order.</p>
      <span class="order-chip">${escape(order.orderNumber)}</span>
      <div class="confirm-card">
        <span class="pill" style="background:rgba(255,255,255,.12);color:#fff">Track this order</span>
        <h2>Track this order in the Eki app.</h2>
        <p class="confirm-sub" style="color:rgba(255,255,255,.82)">Get live updates, save this vendor and reorder in seconds.</p>
        <ul class="confirm-list">
          <li>Push notifications for every update</li>
          <li>Save ${escape(store.storeName)} for fast reorder</li>
          <li>Reorder your favourite items in 2 taps</li>
          <li>App-only rewards: $5 off your next order</li>
        </ul>
        <button class="white-btn" type="button" onclick="window.open('https://play.google.com/store','_blank')">Download Eki App</button>
      </div>
      <a class="ghost-link" href="/store/${encodeURIComponent(store.storeSlug)}/track/${encodeURIComponent(order.orderNumber)}">Track on web instead →</a>
    </div>
  </div>
</body>
</html>`;
}

function renderTrackPage(store: PublicStore, order: PublicStoreTrackedOrder): string {
  const steps = statusSteps(order.status).map((step) => `
    <div class="step${step.complete ? " complete" : ""}${step.active ? " active" : ""}">
      <div class="step-dot">${step.complete ? "✓" : ""}</div>
      <div>
        <h3>${escape(step.label)}</h3>
        <p>${escape(step.active ? step.helper : (step.complete ? "Completed" : "Pending"))}</p>
      </div>
    </div>
  `).join("");

  const summaryItems = order.items.map((item) => `
    <div class="summary-item">
      <div>${escape(item.name)}</div>
      <strong>${escape(formatMoney(item.price * item.quantity, order.currency))}</strong>
    </div>
  `).join("");

  return `${baseStyles(`Track your order | ${store.storeName}`, `Track order ${order.orderNumber}`)}
  <div class="shell">
    ${renderTopbar(`<a class="top-btn" href="/">Sign in</a>`)}
    <div class="track-shell">
      <h1>Track your order</h1>
      <span class="track-chip">Order ID: ${escape(order.orderNumber)}</span>
      <div class="track-grid">
        <div>
          <div class="track-card">
            <h2>Order Status</h2>
            <p class="muted">Estimated delivery: ${escape(order.estimatedDeliveryLabel)}</p>
            <div class="timeline">${steps}</div>
          </div>
          <div class="bottom-banner">
            <div>
              <strong>Get live updates in the Eki app</strong>
              <p>Order updates, vendor saving and reorder in 2 taps</p>
            </div>
            <button class="open-app" type="button" onclick="window.open('https://play.google.com/store','_blank')">Open in App</button>
          </div>
        </div>
        <div>
          <div class="side-card">
            <h2>Your Order</h2>
            ${summaryItems}
            <div class="summary-line"><span>Subtotal</span><span>${escape(formatMoney(order.subtotal, order.currency))}</span></div>
            <div class="summary-line"><span>Delivery</span><span>${order.delivery === 0 ? "Free" : escape(formatMoney(order.delivery, order.currency))}</span></div>
            <div class="summary-total"><span>Total</span><span>${escape(formatMoney(order.total, order.currency))}</span></div>
          </div>
          <div class="side-card" style="margin-top:12px">
            <h2>Sold by</h2>
            <strong>${escape(store.storeName)}</strong>
            <p class="muted">${escape([store.city, store.country].filter(Boolean).join(", "))}</p>
            <a class="muted" href="/store/${encodeURIComponent(store.storeSlug)}">Contact vendor</a>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function renderNotFound(slug: string): string {
  return `${baseStyles("Store not found | Eki", "Store not found")}
  <div class="shell" style="display:flex;align-items:center;justify-content:center;min-height:100vh">
    <div class="empty-state" style="max-width:460px">
      <h1 style="margin:0 0 10px;font-size:32px">Store not found</h1>
      <p style="margin:0 0 18px">The store <strong>${escape(slug)}</strong> could not be found or is currently unavailable.</p>
      <a class="find-link" href="/">Back to Eki</a>
    </div>
  </div>
</body>
</html>`;
}

function renderError(): string {
  return `${baseStyles("Error | Eki", "Something went wrong")}
  <div class="shell" style="display:flex;align-items:center;justify-content:center;min-height:100vh">
    <div class="empty-state" style="max-width:460px">
      <h1 style="margin:0 0 10px;font-size:32px">Something went wrong</h1>
      <p style="margin:0">Please try again in a moment.</p>
    </div>
  </div>
</body>
</html>`;
}

function parseSlug(request: Request): string {
  return String(request.params.slug ?? "").trim().toLowerCase();
}

function parseProductId(request: Request): string {
  return String(request.params.productId ?? "").trim();
}

function parseOrderNumber(request: Request): string {
  return String(request.params.orderNumber ?? "").trim();
}

export async function getPublicStorePage(request: Request, response: Response): Promise<void> {
  const slug = parseSlug(request);
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");

  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    response.status(404).send(renderNotFound(slug));
    return;
  }

  try {
    const [store, productsResult] = await Promise.all([
      publicStoresService.getStoreBySlug(slug),
      publicStoresService.listStoreProducts(slug, { limit: PAGE_PRODUCTS_LIMIT }),
    ]);
    response.status(200).send(renderStorePage(store, productsResult.items));
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    response.status(status === 404 ? 404 : 500).send(status === 404 ? renderNotFound(slug) : renderError());
  }
}

export async function getPublicStoreDirectoryPage(_request: Request, response: Response): Promise<void> {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");

  try {
    const stores = await publicStoresService.listPublicStores();
    response.status(200).send(renderStoreDirectoryPage(stores));
  } catch {
    response.status(500).send(renderError());
  }
}

export async function getPublicStoreProductPage(request: Request, response: Response): Promise<void> {
  const slug = parseSlug(request);
  const productId = parseProductId(request);
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");

  try {
    const [store, product] = await Promise.all([
      publicStoresService.getStoreBySlug(slug),
      publicStoresService.getStoreProductById(slug, productId),
    ]);
    response.status(200).send(renderProductPage(store, product));
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    response.status(status === 404 ? 404 : 500).send(status === 404 ? renderNotFound(slug) : renderError());
  }
}

export async function getPublicStoreCheckoutPage(request: Request, response: Response): Promise<void> {
  const slug = parseSlug(request);
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");

  try {
    const [store, productsResult] = await Promise.all([
      publicStoresService.getStoreBySlug(slug),
      publicStoresService.listStoreProducts(slug, { limit: PAGE_PRODUCTS_LIMIT }),
    ]);
    response.status(200).send(renderCheckoutPage(store, productsResult.items, request.query.cancelled === "true"));
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    response.status(status === 404 ? 404 : 500).send(status === 404 ? renderNotFound(slug) : renderError());
  }
}

export async function getPublicStoreConfirmedPage(request: Request, response: Response): Promise<void> {
  const slug = parseSlug(request);
  const sessionId = String(request.query.session_id ?? "").trim();
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");

  if (!sessionId) {
    response.status(404).send(renderNotFound(slug));
    return;
  }

  try {
    const [store, order] = await Promise.all([
      publicStoresService.getStoreBySlug(slug),
      publicStoresService.getStoreOrderByCheckoutSession(slug, sessionId),
    ]);
    response.status(200).send(renderConfirmationPage(store, order));
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    response.status(status === 404 ? 404 : 500).send(status === 404 ? renderNotFound(slug) : renderError());
  }
}

export async function getPublicStoreTrackedOrderPage(request: Request, response: Response): Promise<void> {
  const slug = parseSlug(request);
  const orderNumber = parseOrderNumber(request);
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");

  try {
    const [store, order] = await Promise.all([
      publicStoresService.getStoreBySlug(slug),
      publicStoresService.getStoreOrderByNumber(slug, orderNumber),
    ]);
    response.status(200).send(renderTrackPage(store, order));
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    response.status(status === 404 ? 404 : 500).send(status === 404 ? renderNotFound(slug) : renderError());
  }
}
