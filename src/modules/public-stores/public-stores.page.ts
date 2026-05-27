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
  const stock = product.stock > 0 ? "In stock" : "Sold out";
  const stockClass = product.stock > 0 ? "in-stock" : "out-of-stock";
  return `
  <li class="product">
    <div class="product-image">${imageEl}</div>
    <div class="product-body">
      <h3 class="product-title">${escape(product.title)}</h3>
      <p class="product-price">${escape(formatPrice(product.priceInCents, product.currency))}</p>
      <p class="product-stock ${stockClass}">${stock}</p>
    </div>
  </li>`;
}

function renderStorePage(store: PublicStore, products: PublicProduct[]): string {
  const verifiedBadge =
    store.verificationStatus === "VERIFIED"
      ? `<span class="badge verified" title="Verified vendor">✓ Verified</span>`
      : "";

  const location = [store.city, store.country].filter(Boolean).join(", ");

  const cover = store.coverImage
    ? `<div class="cover" style="background-image:url('${escape(store.coverImage)}')"></div>`
    : `<div class="cover cover-placeholder"></div>`;

  const avatar = store.avatar
    ? `<img class="avatar" src="${escape(store.avatar)}" alt="${escape(store.storeName)}" />`
    : `<div class="avatar avatar-placeholder">${escape(store.storeName.slice(0, 1).toUpperCase())}</div>`;

  const description = store.description
    ? `<p class="description">${escape(store.description)}</p>`
    : "";

  const deliveryCountries =
    store.deliveryCountries.length > 0
      ? `<div class="delivery">
           <span class="label">Delivers to:</span>
           ${store.deliveryCountries.map((c) => `<span class="chip">${escape(c)}</span>`).join("")}
         </div>`
      : "";

  const productsHtml =
    products.length > 0
      ? `<ul class="products">${products.map(renderProduct).join("")}</ul>`
      : `<p class="empty">This store has no products yet.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#0f172a" />
  <title>${escape(store.storeName)} · Waqti</title>
  <meta name="description" content="${escape(store.description ?? store.storeName)}" />
  <meta property="og:title" content="${escape(store.storeName)}" />
  <meta property="og:description" content="${escape(store.description ?? "Discover this store on Waqti.")}" />
  <meta property="og:site_name" content="Waqti" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${escape(store.shareUrl)}" />
  ${store.coverImage ? `<meta property="og:image" content="${escape(store.coverImage)}" />` : ""}
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="canonical" href="${escape(store.shareUrl)}" />
  <style>
    *,*::before,*::after{box-sizing:border-box}
    body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#0f172a;background:#f8fafc;line-height:1.5}
    .container{max-width:1100px;margin:0 auto;padding:0 16px}
    .cover{height:200px;background:#1e293b;background-size:cover;background-position:center}
    .cover-placeholder{background:linear-gradient(135deg,#6366f1,#0ea5e9)}
    .header{margin-top:-48px;padding:0 16px}
    .header-inner{display:flex;gap:16px;align-items:flex-end}
    .avatar{width:96px;height:96px;border-radius:16px;border:4px solid #fff;background:#fff;object-fit:cover;flex-shrink:0;box-shadow:0 4px 16px rgba(15,23,42,.12)}
    .avatar-placeholder{display:flex;align-items:center;justify-content:center;font-size:36px;font-weight:700;color:#6366f1;background:#eef2ff}
    .meta{flex:1;padding-bottom:8px;min-width:0}
    .meta h1{margin:0;font-size:24px;font-weight:700;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .badge{font-size:12px;padding:2px 8px;border-radius:999px;font-weight:600}
    .badge.verified{background:#dbeafe;color:#1d4ed8}
    .location{margin:4px 0 0;color:#64748b;font-size:14px}
    .description{margin:12px 0 0;color:#334155;font-size:15px}
    .delivery{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:12px 0 0}
    .delivery .label{color:#64748b;font-size:13px;margin-right:4px}
    .chip{font-size:12px;padding:2px 8px;border-radius:999px;background:#e2e8f0;color:#0f172a}
    .actions{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 0}
    .btn{padding:10px 16px;border-radius:10px;font-weight:600;font-size:14px;border:none;cursor:pointer;text-decoration:none;display:inline-block}
    .btn-primary{background:#0f172a;color:#fff}
    .btn-secondary{background:#fff;color:#0f172a;border:1px solid #cbd5e1}
    .stats{margin:24px 0;color:#64748b;font-size:14px}
    .products{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
    .product{background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
    .product-image{aspect-ratio:1/1;background:#f1f5f9;overflow:hidden}
    .product-image img{width:100%;height:100%;object-fit:cover;display:block}
    .placeholder{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:13px}
    .product-body{padding:12px}
    .product-title{margin:0;font-size:15px;font-weight:600;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .product-price{margin:6px 0 0;font-weight:700;color:#0f172a;font-size:16px}
    .product-stock{margin:4px 0 0;font-size:12px}
    .in-stock{color:#15803d}
    .out-of-stock{color:#b91c1c}
    .empty{color:#64748b;text-align:center;padding:40px 16px}
    .footer{text-align:center;padding:32px 16px;color:#64748b;font-size:13px}
    @media (max-width:600px){
      .cover{height:140px}
      .header{margin-top:-36px}
      .avatar{width:72px;height:72px;border-radius:12px}
      .meta h1{font-size:20px}
      .products{grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}
      .product-body{padding:10px}
    }
  </style>
</head>
<body>
  ${cover}
  <header class="header container">
    <div class="header-inner">
      ${avatar}
      <div class="meta">
        <h1>${escape(store.storeName)} ${verifiedBadge}</h1>
        ${location ? `<p class="location">${escape(location)}</p>` : ""}
        ${description}
        ${deliveryCountries}
        <div class="actions">
          <button class="btn btn-secondary" id="copy-link" type="button">Copy link</button>
          <a class="btn btn-primary" href="#products">View products</a>
        </div>
      </div>
    </div>
  </header>
  <main class="container">
    <p class="stats">${store.totalProducts} active product${store.totalProducts === 1 ? "" : "s"}</p>
    <section id="products">
      ${productsHtml}
    </section>
  </main>
  <footer class="footer">
    Powered by <strong>Neon</strong>
  </footer>
  <script>
    (function(){
      var btn=document.getElementById('copy-link');
      if(!btn||!navigator.clipboard) return;
      btn.addEventListener('click',function(){
        navigator.clipboard.writeText(${JSON.stringify(store.shareUrl)}).then(function(){
          var prev=btn.textContent;
          btn.textContent='Copied!';
          setTimeout(function(){btn.textContent=prev;},1500);
        });
      });
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
  <title>Store not found · Neon</title>
  <style>
    body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f8fafc;color:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px}
    .card{max-width:420px}
    h1{font-size:48px;margin:0 0 8px;color:#1e293b}
    p{color:#64748b;margin:0 0 16px}
    code{background:#e2e8f0;padding:2px 6px;border-radius:4px;font-family:monospace}
  </style>
</head>
<body>
  <div class="card">
    <h1>404</h1>
    <p>The store <code>${escape(slug)}</code> could not be found or is currently unavailable.</p>
  </div>
</body>
</html>`;
}

function renderError(): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><title>Error · Neon</title>
<style>body{font-family:sans-serif;text-align:center;padding:40px;color:#0f172a}</style>
</head><body><h1>Something went wrong</h1><p>Please try again in a moment.</p></body></html>`;
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
