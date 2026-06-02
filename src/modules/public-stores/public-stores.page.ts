import type { Request, Response } from "express";

import { publicStoresService } from "./public-stores.service";
import type { PublicProduct, PublicStore } from "./public-stores.types";

const PAGE_PRODUCTS_LIMIT = 24;

/**
 * Minimal HTML escaping for untrusted user-supplied content rendered in
 * server-side templates. Prevents XSS via vendor-controlled fields like
 * storeName, description, etc.
 */
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
  const amount = priceInCents / 100;
  const code = currency.toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${code}`;
  }
}

function renderProduct(product: PublicProduct): string {
  const image = product.images[0];
  const imageEl = image
    ? `<img src="${escape(image)}" alt="${escape(product.title)}" loading="lazy" />`
    : `<div class="placeholder">No image</div>`;
  const inStock = product.stock > 0;
  const stockBadge = inStock
    ? ""
    : `<span class="product-soldout">Sold out</span>`;
  return `
  <li class="product${inStock ? "" : " is-soldout"}">
    <button class="product-image product-open" type="button" data-product="${escape(product.id)}">
      ${imageEl}
      ${stockBadge}
    </button>
    <div class="product-body">
      <button class="product-copy product-open" type="button" data-product="${escape(product.id)}">
        <h3 class="product-title">${escape(product.title)}</h3>
      </button>
      <p class="product-meta">${escape(product.category || "Foodstuff")} · ${inStock ? "Ready to order" : "Currently unavailable"}</p>
      <p class="product-price">${escape(formatPrice(product.priceInCents, product.currency))}</p>
      <div class="product-actions">
        <button class="btn btn-card product-open" type="button" data-product="${escape(product.id)}">View product</button>
        ${
          inStock
            ? `<button class="btn btn-primary product-add" type="button" data-product="${escape(product.id)}">Add to cart</button>`
            : `<button class="btn btn-disabled" type="button" disabled>Sold out</button>`
        }
      </div>
    </div>
  </li>`;
}

function renderStorePage(store: PublicStore, products: PublicProduct[]): string {
  const verifiedBadge =
    store.verificationStatus === "VERIFIED"
      ? `<span class="badge badge-verified" title="Verified vendor">
           <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
             <path fill="currentColor" d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm3.78 6.28-4.5 4.5a.75.75 0 0 1-1.06 0l-2-2a.75.75 0 1 1 1.06-1.06L6.75 9.19l3.97-3.97a.75.75 0 1 1 1.06 1.06z"/>
           </svg>
           Verified
         </span>`
      : "";

  const location = [store.city, store.country].filter(Boolean).join(", ");
  const productCount = store.totalProducts;
  const locationLabel = escape(location || store.country || "United Kingdom");
  const serializedProducts = JSON.stringify(products);

  const cover = store.coverImage
    ? `<div class="cover" style="background-image:url('${escape(store.coverImage)}')"></div>`
    : `<div class="cover cover-placeholder"></div>`;

  const avatar = store.avatar
    ? `<img class="avatar" src="${escape(store.avatar)}" alt="${escape(store.storeName)}" />`
    : `<div class="avatar avatar-placeholder">${escape(store.storeName.slice(0, 1).toUpperCase())}</div>`;

  const description = store.description
    ? `<p class="description">${escape(store.description)}</p>`
    : `<p class="description">Authentic foodstuff ready for secure browser ordering and quick order tracking.</p>`;

  const deliveryCountries =
    store.deliveryCountries.length > 0
      ? `<div class="delivery">
           <span class="delivery-label">Ships to</span>
           <div class="chips">
             ${store.deliveryCountries.map((c) => `<span class="chip">${escape(c)}</span>`).join("")}
           </div>
         </div>`
      : "";

  const productsHtml =
    products.length > 0
      ? `<ul class="products">${products.map(renderProduct).join("")}</ul>`
      : `<div class="empty">
           <p class="empty-title">No products yet</p>
           <p class="empty-sub">This store is just getting set up. Check back soon.</p>
         </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#1F4D40" />
  <title>${escape(store.storeName)} - Culinary Tales</title>
  <meta name="description" content="${escape(store.description ?? store.storeName)}" />
  <meta property="og:title" content="${escape(store.storeName)}" />
  <meta property="og:description" content="${escape(store.description ?? "Discover this store on Culinary Tales.")}" />
  <meta property="og:site_name" content="Culinary Tales" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${escape(store.shareUrl)}" />
  ${store.coverImage ? `<meta property="og:image" content="${escape(store.coverImage)}" />` : ""}
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="canonical" href="${escape(store.shareUrl)}" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap" />
  <style>
    *,*::before,*::after{box-sizing:border-box}
    :root{
      --bg:#FAF7F2;
      --surface:#FFFFFF;
      --surface-2:#F4EFE6;
      --border:#E8E0D2;
      --border-soft:#EFE8DA;
      --text:#1F1B16;
      --text-muted:#6B6256;
      --accent:#1F4D40;
      --accent-hover:#163A30;
      --accent-soft:#E8F1ED;
      --gold:#B89968;
      --danger:#B5363A;
    }
    html,body{margin:0;padding:0}
    body{
      font-family:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      color:var(--text);
      background:var(--bg);
      line-height:1.55;
      font-size:16px;
      -webkit-font-smoothing:antialiased;
      -moz-osx-font-smoothing:grayscale;
    }
    .serif{font-family:'Fraunces',Georgia,'Times New Roman',serif;letter-spacing:-0.01em}
    .container{max-width:1120px;margin:0 auto;padding:0 24px}

    /* Top nav strip */
    .topbar{
      background:var(--surface);
      border-bottom:1px solid var(--border-soft);
      position:sticky;top:0;z-index:10;
      backdrop-filter:saturate(180%) blur(12px);
    }
    .topbar-inner{
      display:flex;align-items:center;justify-content:space-between;
      height:56px;
    }
    .brand{
      display:inline-flex;align-items:center;gap:8px;
      font-family:'Fraunces',Georgia,serif;
      font-weight:700;font-size:20px;letter-spacing:-0.02em;
      color:var(--text);text-decoration:none;
    }
    .brand-dot{
      width:8px;height:8px;border-radius:50%;
      background:var(--accent);
      display:inline-block;
    }
    .topbar-actions{display:flex;gap:8px;align-items:center}

    /* Cover */
    .cover{
      height:280px;
      background-color:var(--surface-2);
      background-size:cover;background-position:center;
      border-bottom:1px solid var(--border-soft);
    }
    .cover-placeholder{
      background:radial-gradient(120% 120% at 50% 0%,#2D6B59 0%,#1F4D40 55%,#163A30 100%);
    }

    /* Header card */
    .header{margin-top:-72px;position:relative;z-index:1}
    .header-card{
      background:var(--surface);
      border:1px solid var(--border);
      border-radius:20px;
      padding:32px 36px 28px;
      box-shadow:0 8px 32px rgba(31,27,22,.06);
    }
    .header-row{display:flex;gap:24px;align-items:flex-start}
    .avatar{
      width:104px;height:104px;border-radius:18px;
      border:3px solid var(--surface);
      background:var(--surface);
      object-fit:cover;flex-shrink:0;
      box-shadow:0 4px 16px rgba(31,27,22,.08);
      margin-top:-56px;
    }
    .avatar-placeholder{
      display:flex;align-items:center;justify-content:center;
      font-family:'Fraunces',Georgia,serif;
      font-size:42px;font-weight:700;
      color:var(--accent);
      background:var(--accent-soft);
    }
    .meta{flex:1;min-width:0}
    .store-name{
      margin:0;font-size:36px;font-weight:600;line-height:1.15;
      letter-spacing:-0.02em;
      display:flex;align-items:center;gap:12px;flex-wrap:wrap;
    }
    .badge{
      display:inline-flex;align-items:center;gap:5px;
      font-size:12px;font-weight:600;
      padding:4px 10px;border-radius:999px;
      vertical-align:middle;white-space:nowrap;
    }
    .badge-verified{
      background:var(--accent-soft);
      color:var(--accent);
    }
    .location{
      margin:8px 0 0;color:var(--text-muted);font-size:14px;
      display:flex;align-items:center;gap:6px;
    }
    .location svg{flex-shrink:0;opacity:.7}
    .description{
      margin:18px 0 0;color:var(--text);font-size:16px;line-height:1.6;
      max-width:64ch;
    }
    .delivery{
      margin:20px 0 0;
      display:flex;flex-wrap:wrap;align-items:center;gap:10px;
    }
    .delivery-label{
      font-size:12px;font-weight:600;color:var(--text-muted);
      text-transform:uppercase;letter-spacing:0.06em;
    }
    .chips{display:flex;flex-wrap:wrap;gap:6px}
    .chip{
      font-size:13px;padding:5px 11px;border-radius:999px;
      background:var(--surface-2);color:var(--text);
      border:1px solid var(--border);
    }
    .actions{
      display:flex;gap:10px;flex-wrap:wrap;
      margin:24px 0 0;padding-top:24px;
      border-top:1px solid var(--border-soft);
    }
    .stats{
      margin:22px 0 0;
      display:grid;
      grid-template-columns:repeat(3,minmax(0,1fr));
      gap:12px;
    }
    .stat{
      border:1px solid var(--border-soft);
      border-radius:14px;
      background:#FBFAF7;
      padding:14px 16px;
      min-width:0;
    }
    .stat-value{
      display:block;
      color:var(--accent);
      font-weight:700;
      font-size:18px;
      line-height:1.25;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }
    .stat-label{
      display:block;
      color:var(--text-muted);
      font-size:12px;
      margin-top:5px;
    }
    .btn{
      padding:11px 20px;border-radius:12px;
      font-weight:600;font-size:14px;
      border:1px solid transparent;cursor:pointer;
      text-decoration:none;display:inline-flex;align-items:center;gap:8px;
      transition:all .15s ease;
      font-family:inherit;
    }
    .btn-primary{background:var(--accent);color:#fff}
    .btn-primary:hover{background:var(--accent-hover)}
    .btn-card{
      background:var(--surface);color:var(--accent);
      border-color:var(--border);
    }
    .btn-card:hover{background:var(--accent-soft)}
    .btn-disabled{
      background:#EAE6DE;color:#8B8275;border-color:#E0D7C9;cursor:not-allowed;
    }
    .btn-secondary{
      background:var(--surface);color:var(--text);
      border-color:var(--border);
    }
    .btn-secondary:hover{
      background:var(--surface-2);border-color:#D9CFBE;
    }
    .btn svg{width:14px;height:14px}

    /* Products section */
    .section{padding:56px 0 80px}
    .store-layout{
      display:grid;
      grid-template-columns:minmax(0,1fr) 340px;
      gap:28px;
      align-items:start;
    }
    .store-content{min-width:0}
    .cart-panel{
      position:sticky;
      top:88px;
    }
    .cart-card{
      background:var(--surface);
      border:1px solid var(--border);
      border-radius:18px;
      padding:22px;
      box-shadow:0 8px 24px rgba(31,27,22,.05);
    }
    .cart-kicker{
      margin:0;
      color:var(--text-muted);
      font-size:11px;
      font-weight:700;
      text-transform:uppercase;
      letter-spacing:.08em;
    }
    .cart-title{
      margin:10px 0 0;
      font-size:24px;
      line-height:1.15;
      font-weight:600;
    }
    .cart-copy{
      margin:10px 0 0;
      color:var(--text-muted);
      font-size:14px;
      line-height:1.55;
    }
    .cart-items{
      margin-top:20px;
      display:flex;
      flex-direction:column;
      gap:10px;
    }
    .cart-empty{
      border:1px dashed var(--border);
      border-radius:14px;
      padding:18px 16px;
      background:#FBFAF7;
    }
    .cart-empty-title{
      margin:0;
      font-weight:600;
      font-size:15px;
    }
    .cart-empty-copy{
      margin:6px 0 0;
      color:var(--text-muted);
      font-size:13px;
    }
    .cart-item{
      display:flex;
      justify-content:space-between;
      gap:12px;
      border:1px solid var(--border-soft);
      border-radius:14px;
      padding:12px 14px;
      background:#FBFAF7;
    }
    .cart-item-title{
      margin:0;
      font-size:14px;
      font-weight:600;
      line-height:1.4;
    }
    .cart-item-meta{
      margin:5px 0 0;
      color:var(--text-muted);
      font-size:12px;
    }
    .cart-item-actions{
      display:flex;
      align-items:center;
      gap:8px;
      flex-shrink:0;
    }
    .qty-btn{
      width:28px;
      height:28px;
      border-radius:999px;
      border:1px solid var(--border);
      background:var(--surface);
      color:var(--accent);
      font:inherit;
      cursor:pointer;
    }
    .qty-value{
      min-width:14px;
      text-align:center;
      font-size:13px;
      font-weight:700;
    }
    .cart-summary{
      margin-top:18px;
      padding-top:16px;
      border-top:1px solid var(--border-soft);
      display:flex;
      flex-direction:column;
      gap:10px;
    }
    .cart-row{
      display:flex;
      justify-content:space-between;
      gap:16px;
      font-size:14px;
      color:var(--text);
    }
    .cart-panel-actions{
      display:flex;
      flex-direction:column;
      gap:10px;
      margin-top:16px;
    }
    .cart-note{
      margin:12px 0 0;
      color:var(--text-muted);
      font-size:12px;
      line-height:1.55;
    }
    .section-header{
      display:flex;align-items:baseline;justify-content:space-between;
      margin-bottom:28px;gap:16px;flex-wrap:wrap;
    }
    .section-title{
      margin:0;font-size:24px;font-weight:600;
      letter-spacing:-0.01em;
    }
    .section-count{
      color:var(--text-muted);font-size:14px;font-weight:500;
    }
    .products{
      list-style:none;padding:0;margin:0;
      display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:20px;
    }
    .product{
      background:var(--surface);
      border:1px solid var(--border);
      border-radius:14px;
      overflow:hidden;
      display:flex;flex-direction:column;
      transition:transform .18s ease, box-shadow .18s ease, border-color .18s ease;
    }
    .product:hover{
      transform:translateY(-2px);
      box-shadow:0 12px 28px rgba(31,27,22,.08);
      border-color:#D9CFBE;
    }
    .product-copy,
    .product-image{
      appearance:none;
      border:0;
      padding:0;
      margin:0;
      text-align:left;
      background:transparent;
      cursor:pointer;
      width:100%;
      font:inherit;
      color:inherit;
    }
    .product.is-soldout{opacity:.72}
    .product-image{
      aspect-ratio:1/1;background:var(--surface-2);overflow:hidden;
      position:relative;
    }
    .product-image img{
      width:100%;height:100%;object-fit:cover;display:block;
      transition:transform .4s ease;
    }
    .product:hover .product-image img{transform:scale(1.04)}
    .placeholder{
      width:100%;height:100%;display:flex;align-items:center;justify-content:center;
      color:var(--text-muted);font-size:13px;
    }
    .product-soldout{
      position:absolute;top:12px;left:12px;
      background:rgba(31,27,22,.85);color:#fff;
      font-size:11px;font-weight:600;
      padding:4px 10px;border-radius:999px;
      letter-spacing:0.04em;text-transform:uppercase;
      backdrop-filter:blur(4px);
    }
    .product-body{padding:16px 16px 18px}
    .product-title{
      margin:0;font-size:15px;font-weight:500;line-height:1.4;
      color:var(--text);
      display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
      min-height:42px;
    }
    .product-price{
      margin:8px 0 0;font-weight:700;font-size:17px;
      color:var(--text);
      font-family:'Fraunces',Georgia,serif;
      letter-spacing:-0.01em;
    }
    .product-meta{
      margin:6px 0 0;
      color:var(--text-muted);
      font-size:12px;
      line-height:1.45;
    }
    .product-actions{
      margin-top:14px;
      display:flex;
      gap:10px;
      flex-wrap:wrap;
    }

    /* Empty */
    .empty{
      text-align:center;padding:64px 24px;
      background:var(--surface);
      border:1px dashed var(--border);
      border-radius:16px;
    }
    .empty-title{
      margin:0;font-family:'Fraunces',Georgia,serif;
      font-size:20px;font-weight:600;color:var(--text);
    }
    .empty-sub{margin:6px 0 0;color:var(--text-muted);font-size:14px}

    /* Toast */
    .toast{
      position:fixed;bottom:32px;left:50%;transform:translateX(-50%) translateY(8px);
      background:var(--text);color:#fff;
      padding:10px 16px;border-radius:10px;
      font-size:14px;font-weight:500;
      box-shadow:0 12px 28px rgba(0,0,0,.18);
      opacity:0;pointer-events:none;
      transition:opacity .18s ease, transform .18s ease;
      z-index:50;
    }
    .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
    #cart-toast{bottom:88px}

    /* Product modal */
    .product-modal{
      position:fixed;
      inset:0;
      display:none;
      z-index:60;
    }
    .product-modal.show{display:block}
    .product-modal-backdrop{
      position:absolute;
      inset:0;
      background:rgba(15,20,18,.58);
    }
    .product-modal-card{
      position:relative;
      max-width:860px;
      margin:48px auto;
      background:var(--surface);
      border-radius:24px;
      overflow:hidden;
      border:1px solid var(--border);
      box-shadow:0 24px 48px rgba(0,0,0,.18);
    }
    .modal-close{
      position:absolute;
      top:18px;
      right:18px;
      width:40px;
      height:40px;
      border-radius:999px;
      border:0;
      background:rgba(255,255,255,.92);
      font-size:28px;
      line-height:1;
      color:var(--text);
      cursor:pointer;
      z-index:1;
    }
    .product-modal-media{
      height:300px;
      background:var(--surface-2);
    }
    .product-modal-media img{
      width:100%;
      height:100%;
      object-fit:cover;
      display:block;
    }
    .placeholder-modal{
      font-size:15px;
      min-height:300px;
    }
    .product-modal-body{
      padding:24px;
    }
    .modal-eyebrow{
      margin:0;
      color:var(--text-muted);
      font-size:11px;
      font-weight:700;
      text-transform:uppercase;
      letter-spacing:.08em;
    }
    .modal-title{
      margin:10px 0 0;
      font-size:30px;
      line-height:1.15;
      font-weight:600;
    }
    .modal-meta{
      margin:10px 0 0;
      color:var(--text-muted);
      font-size:14px;
    }
    .modal-description{
      margin:14px 0 0;
      font-size:15px;
      line-height:1.65;
    }
    .modal-footer{
      margin-top:22px;
      display:flex;
      justify-content:space-between;
      gap:16px;
      align-items:flex-end;
      flex-wrap:wrap;
    }
    .modal-price{
      margin:0;
      font-family:'Fraunces',Georgia,serif;
      font-size:26px;
      font-weight:700;
      line-height:1.1;
    }
    .modal-stock{
      margin:8px 0 0;
      color:var(--accent);
      font-size:12px;
      font-weight:700;
      text-transform:uppercase;
      letter-spacing:.04em;
    }
    .modal-actions{
      display:flex;
      gap:10px;
      flex-wrap:wrap;
      justify-content:flex-end;
    }

    /* Footer */
    .footer{
      border-top:1px solid var(--border-soft);
      background:var(--surface);
      padding:28px 0;text-align:center;
      color:var(--text-muted);font-size:13px;
    }
    .footer a{color:var(--text);text-decoration:none;font-weight:600}
    .footer a:hover{color:var(--accent)}

    @media (max-width:720px){
      .container{padding:0 16px}
      .cover{height:200px}
      .header{margin-top:-56px}
      .header-card{padding:24px 20px 22px;border-radius:16px}
      .header-row{flex-direction:column;gap:0}
      .avatar{width:88px;height:88px;border-radius:14px;margin-top:-44px}
      .store-name{font-size:28px;margin-top:14px}
      .description{font-size:15px;margin-top:14px}
      .stats{grid-template-columns:1fr}
      .actions{margin-top:20px;padding-top:20px}
      .btn{flex:1;justify-content:center}
      .section{padding:40px 0 56px}
      .store-layout{grid-template-columns:1fr}
      .cart-panel{position:static}
      .section-title{font-size:20px}
      .products{grid-template-columns:repeat(2,1fr);gap:12px}
      .product-body{padding:12px 12px 14px}
      .product-title{font-size:14px;min-height:36px}
      .product-price{font-size:15px}
      .product-modal-card{margin:18px 14px}
      .product-modal-media{height:220px}
      .modal-title{font-size:24px}
      .modal-footer{align-items:stretch}
      .modal-actions{width:100%}
    }
  </style>
</head>
<body>
  <nav class="topbar">
    <div class="container topbar-inner">
      <span class="brand"><span class="brand-dot"></span> Culinary Tales</span>
    </div>
  </nav>

  ${cover}

  <header class="header container">
    <div class="header-card">
      <div class="header-row">
        ${avatar}
        <div class="meta">
          <h1 class="store-name serif">
            ${escape(store.storeName)}${verifiedBadge ? " " + verifiedBadge : ""}
          </h1>
          ${location ? `<p class="location">
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 0a5 5 0 0 0-5 5c0 4.5 5 11 5 11s5-6.5 5-11a5 5 0 0 0-5-5zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>
            ${escape(location)}
          </p>` : ""}
          ${description}
          ${deliveryCountries}
          <div class="stats">
            <div class="stat">
              <span class="stat-value">${products.length}</span>
              <span class="stat-label">Live products</span>
            </div>
            <div class="stat">
              <span class="stat-value">${store.verificationStatus === "VERIFIED" ? "Verified" : "New"}</span>
              <span class="stat-label">Store status</span>
            </div>
            <div class="stat">
              <span class="stat-value">${locationLabel}</span>
              <span class="stat-label">Ships from</span>
            </div>
          </div>
          <div class="actions">
            <button class="btn btn-primary" id="copy-link" type="button">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M9.5 1a.5.5 0 0 0 0 1H13v3.5a.5.5 0 0 0 1 0V1.5a.5.5 0 0 0-.5-.5h-4zM2 2.5A1.5 1.5 0 0 1 3.5 1h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 0-.5.5v10a.5.5 0 0 0 .5.5h6a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 1 1 0v3A1.5 1.5 0 0 1 9.5 14h-6A1.5 1.5 0 0 1 2 12.5v-10z"/><path fill="currentColor" d="M14.354 2.354a.5.5 0 0 0-.708-.708L7.5 7.793 5.354 5.646a.5.5 0 1 0-.708.708l2.5 2.5a.5.5 0 0 0 .708 0l6.5-6.5z"/></svg>
              Copy share link
            </button>
            <a class="btn btn-secondary" href="#products">View products</a>
            <a class="btn btn-secondary" href="#cart-panel">Open cart</a>
          </div>
        </div>
      </div>
    </div>
  </header>

  <main class="container section">
    <div class="store-layout">
      <section class="store-content" id="products">
        <div class="section-header">
          <h2 class="section-title serif">Products</h2>
          <span class="section-count">
            ${productCount} ${productCount === 1 ? "item" : "items"}
          </span>
        </div>
        ${productsHtml}
      </section>

      <aside class="cart-panel" id="cart-panel">
        <div class="cart-card">
          <p class="cart-kicker">Buyer checkout</p>
          <h2 class="cart-title serif">Order from this browser link</h2>
          <p class="cart-copy">Open any product, add it to your cart, then continue with buyer checkout in the app or web flow.</p>
          <div class="cart-items" id="cart-items">
            <div class="cart-empty">
              <p class="cart-empty-title">Your cart is empty</p>
              <p class="cart-empty-copy">Add a product to start your order.</p>
            </div>
          </div>
          <div class="cart-summary">
            <div class="cart-row"><span>Items</span><strong id="cart-count">0</strong></div>
            <div class="cart-row"><span>Subtotal</span><strong id="cart-total">${escape(formatPrice(0, products[0]?.currency || "GBP"))}</strong></div>
          </div>
          <div class="cart-panel-actions">
            <button class="btn btn-primary" type="button" id="checkout-btn" disabled>Continue checkout</button>
            <button class="btn btn-secondary" type="button" id="copy-store-link">Copy store link</button>
          </div>
          <p class="cart-note">For now this shared page keeps buyers on the storefront and prepares the basket cleanly for checkout.</p>
        </div>
      </aside>
    </div>
  </main>

  <footer class="footer">
    <div class="container">
      Powered by <a href="https://culinarytales.app">Culinary Tales</a>
    </div>
  </footer>

  <div class="toast" id="toast">Link copied to clipboard</div>
  <div class="toast" id="cart-toast">Added to cart</div>
  <div class="product-modal" id="product-modal" aria-hidden="true">
    <div class="product-modal-backdrop" data-close-product-modal="true"></div>
    <div class="product-modal-card" role="dialog" aria-modal="true" aria-labelledby="product-modal-title">
      <button class="modal-close" type="button" id="close-product-modal" aria-label="Close product preview">&times;</button>
      <div class="product-modal-media" id="product-modal-image-wrap"></div>
      <div class="product-modal-body">
        <p class="modal-eyebrow">Shared product</p>
        <h3 class="modal-title serif" id="product-modal-title"></h3>
        <p class="modal-meta" id="product-modal-meta"></p>
        <p class="modal-description" id="product-modal-description"></p>
        <div class="modal-footer">
          <div>
            <p class="modal-price" id="product-modal-price"></p>
            <p class="modal-stock" id="product-modal-stock"></p>
          </div>
          <div class="modal-actions">
            <button class="btn btn-secondary" type="button" id="modal-close-secondary">Keep browsing</button>
            <button class="btn btn-primary" type="button" id="modal-add-button">Add to cart</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    (function(){
      var btn=document.getElementById('copy-link');
      var toast=document.getElementById('toast');
      var cartToast=document.getElementById('cart-toast');
      var copyStoreLink=document.getElementById('copy-store-link');
      var modal=document.getElementById('product-modal');
      var closeModalBtn=document.getElementById('close-product-modal');
      var closeModalSecondary=document.getElementById('modal-close-secondary');
      var modalImageWrap=document.getElementById('product-modal-image-wrap');
      var modalTitle=document.getElementById('product-modal-title');
      var modalMeta=document.getElementById('product-modal-meta');
      var modalDescription=document.getElementById('product-modal-description');
      var modalPrice=document.getElementById('product-modal-price');
      var modalStock=document.getElementById('product-modal-stock');
      var modalAddButton=document.getElementById('modal-add-button');
      var cartItemsEl=document.getElementById('cart-items');
      var cartCountEl=document.getElementById('cart-count');
      var cartTotalEl=document.getElementById('cart-total');
      var checkoutBtn=document.getElementById('checkout-btn');
      if(!btn) return;
      var url=${JSON.stringify(store.shareUrl)};
      var products=${serializedProducts};
      var storeName=${JSON.stringify(store.storeName)};
      var storeLocation=${JSON.stringify(locationLabel)};
      var cart={};
      var activeProductId=null;

      function showToast(element){
        if(!element) return;
        element.classList.add('show');
        setTimeout(function(){element.classList.remove('show');},1800);
      }

      btn.addEventListener('click',function(){
        if(navigator.clipboard && navigator.clipboard.writeText){
          navigator.clipboard.writeText(url).then(function(){showToast(toast);},function(){});
        } else {
          var ta=document.createElement('textarea');
          ta.value=url;ta.style.position='fixed';ta.style.opacity='0';
          document.body.appendChild(ta);ta.select();
          try{document.execCommand('copy');showToast(toast);}catch(_){}
          document.body.removeChild(ta);
        }
      });

      if(copyStoreLink){
        copyStoreLink.addEventListener('click',function(){ btn.click(); });
      }

      function money(priceInCents,currency){
        try{
          return new Intl.NumberFormat('en-US',{style:'currency',currency:(currency||'GBP').toUpperCase()}).format((priceInCents||0)/100);
        }catch(_){
          return ((priceInCents||0)/100).toFixed(2)+' '+String(currency||'GBP').toUpperCase();
        }
      }

      function renderCart(){
        var ids=Object.keys(cart);
        if(!cartItemsEl || !cartCountEl || !cartTotalEl || !checkoutBtn) return;
        if(ids.length===0){
          cartItemsEl.innerHTML='<div class="cart-empty"><p class="cart-empty-title">Your cart is empty</p><p class="cart-empty-copy">Add a product to start your order.</p></div>';
          cartCountEl.textContent='0';
          cartTotalEl.textContent=money(0, products[0] && products[0].currency || 'GBP');
          checkoutBtn.disabled=true;
          return;
        }

        var totalCount=0;
        var totalCents=0;
        var currency=products[0] && products[0].currency || 'GBP';

        cartItemsEl.innerHTML=ids.map(function(id){
          var product=products.find(function(item){ return item.id===id; });
          if(!product) return '';
          var qty=cart[id] || 0;
          totalCount+=qty;
          totalCents+=(product.priceInCents||0)*qty;
          currency=product.currency || currency;
          return '<div class="cart-item">'
            + '<div><p class="cart-item-title">'+product.title+'</p><p class="cart-item-meta">Qty '+qty+' · '+money(product.priceInCents,product.currency)+'</p></div>'
            + '<div class="cart-item-actions">'
            + '<button class="qty-btn" type="button" data-cart-dec="'+product.id+'">-</button>'
            + '<span class="qty-value">'+qty+'</span>'
            + '<button class="qty-btn" type="button" data-cart-inc="'+product.id+'">+</button>'
            + '</div></div>';
        }).join('');

        cartCountEl.textContent=String(totalCount);
        cartTotalEl.textContent=money(totalCents,currency);
        checkoutBtn.disabled=false;
      }

      function addToCart(productId){
        var product=products.find(function(item){ return item.id===productId; });
        if(!product) return;
        cart[productId]=(cart[productId]||0)+1;
        renderCart();
        showToast(cartToast);
      }

      function setModalProduct(productId){
        var product=products.find(function(item){ return item.id===productId; });
        if(!product || !modal) return;
        activeProductId=productId;
        if(modalTitle) modalTitle.textContent=product.title || '';
        if(modalMeta) modalMeta.textContent=(product.category || 'Foodstuff')+' · Ships from '+storeLocation;
        if(modalDescription) modalDescription.textContent=product.description || 'Freshly packed and ready for secure checkout.';
        if(modalPrice) modalPrice.textContent=money(product.priceInCents,product.currency);
        if(modalStock) modalStock.textContent=product.stock > 0 ? 'In stock' : 'Sold out';
        if(modalAddButton){
          modalAddButton.disabled=!(product.stock > 0);
          modalAddButton.textContent=product.stock > 0 ? 'Add to cart' : 'Sold out';
        }
        if(modalImageWrap){
          modalImageWrap.innerHTML=product.images && product.images[0]
            ? '<img src="'+product.images[0]+'" alt="'+product.title+'" />'
            : '<div class="placeholder placeholder-modal">No image</div>';
        }
        modal.classList.add('show');
        modal.setAttribute('aria-hidden','false');
        document.body.style.overflow='hidden';
      }

      function closeModal(){
        if(!modal) return;
        modal.classList.remove('show');
        modal.setAttribute('aria-hidden','true');
        document.body.style.overflow='';
      }

      document.querySelectorAll('[data-product]').forEach(function(node){
        node.addEventListener('click',function(){
          var id=node.getAttribute('data-product');
          if(id) setModalProduct(id);
        });
      });

      document.querySelectorAll('.product-add').forEach(function(node){
        node.addEventListener('click',function(event){
          event.stopPropagation();
          var id=node.getAttribute('data-product');
          if(id) addToCart(id);
        });
      });

      document.addEventListener('click',function(event){
        var inc=event.target && event.target.getAttribute && event.target.getAttribute('data-cart-inc');
        var dec=event.target && event.target.getAttribute && event.target.getAttribute('data-cart-dec');
        if(inc){ addToCart(inc); return; }
        if(dec){
          if(cart[dec]) cart[dec]=Math.max(cart[dec]-1,0);
          if(cart[dec]===0) delete cart[dec];
          renderCart();
        }
      });

      if(closeModalBtn) closeModalBtn.addEventListener('click',closeModal);
      if(closeModalSecondary) closeModalSecondary.addEventListener('click',closeModal);
      if(modal){
        modal.addEventListener('click',function(event){
          if(event.target && event.target.getAttribute && event.target.getAttribute('data-close-product-modal')==='true'){
            closeModal();
          }
        });
      }
      if(modalAddButton){
        modalAddButton.addEventListener('click',function(){
          if(activeProductId) addToCart(activeProductId);
          closeModal();
          var cartPanel=document.getElementById('cart-panel');
          if(cartPanel) cartPanel.scrollIntoView({behavior:'smooth',block:'start'});
        });
      }

      if(checkoutBtn){
        checkoutBtn.addEventListener('click',function(){
          showToast(cartToast);
          cartToast.textContent='Checkout flow is being handed over to the buyer order flow.';
          setTimeout(function(){ cartToast.textContent='Added to cart'; },1900);
        });
      }

      renderCart();
    })();
  </script>
</body>
</html>`;
}

function renderNotFound(slug: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Store not found - Culinary Tales</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap" />
  <style>
    *,*::before,*::after{box-sizing:border-box}
    body{
      margin:0;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
      background:#FAF7F2;color:#1F1B16;
      display:flex;align-items:center;justify-content:center;
      min-height:100vh;text-align:center;padding:24px;
    }
    .card{max-width:440px}
    .number{
      font-family:'Fraunces',Georgia,serif;
      font-size:96px;line-height:1;font-weight:700;margin:0 0 8px;
      color:#1F4D40;letter-spacing:-0.04em;
    }
    h1{
      font-family:'Fraunces',Georgia,serif;
      font-size:24px;font-weight:600;margin:8px 0 12px;color:#1F1B16;
    }
    p{color:#6B6256;margin:0 0 24px;line-height:1.55}
    code{
      background:#F4EFE6;padding:3px 8px;border-radius:6px;
      font-family:'SF Mono',Menlo,Consolas,monospace;font-size:14px;
    }
    a{
      display:inline-block;padding:11px 22px;border-radius:12px;
      background:#1F4D40;color:#fff;text-decoration:none;font-weight:600;font-size:14px;
    }
    a:hover{background:#163A30}
  </style>
</head>
<body>
  <div class="card">
    <p class="number">404</p>
    <h1>Store not found</h1>
    <p>The store <code>${escape(slug)}</code> could not be found, or it is currently unavailable.</p>
    <a href="https://culinarytales.app">Back to Culinary Tales</a>
  </div>
</body>
</html>`;
}

function renderError(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Error - Culinary Tales</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Inter:wght@400;500&display=swap" />
  <style>
    body{
      margin:0;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
      background:#FAF7F2;color:#1F1B16;text-align:center;
      min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
    }
    h1{font-family:'Fraunces',Georgia,serif;font-size:28px;font-weight:600;margin:0 0 8px}
    p{color:#6B6256;margin:0}
  </style>
</head>
<body>
  <div>
    <h1>Something went wrong</h1>
    <p>Please try again in a moment.</p>
  </div>
</body>
</html>`;
}

/**
 * GET /store/:slug — server-rendered public storefront page.
 * Loads the public store and the first page of active products and returns
 * fully-rendered HTML so share links work without any client-side JS.
 */
export async function getPublicStorePage(request: Request, response: Response): Promise<void> {
  const slug = String(request.params.slug ?? "")
    .trim()
    .toLowerCase();

  response.setHeader("Content-Type", "text/html; charset=utf-8");
  // Allow short caching at the edge (Vercel) but require revalidation.
  response.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");

  if (!slug || !/^[a-z0-9-]+$/.test(slug) || slug.length > 200) {
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
    if (status === 404) {
      response.status(404).send(renderNotFound(slug));
      return;
    }
    response.status(500).send(renderError());
  }
}
