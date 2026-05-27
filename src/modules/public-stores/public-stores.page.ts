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
    <div class="product-image">
      ${imageEl}
      ${stockBadge}
    </div>
    <div class="product-body">
      <h3 class="product-title">${escape(product.title)}</h3>
      <p class="product-price">${escape(formatPrice(product.priceInCents, product.currency))}</p>
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
      .actions{margin-top:20px;padding-top:20px}
      .btn{flex:1;justify-content:center}
      .section{padding:40px 0 56px}
      .section-title{font-size:20px}
      .products{grid-template-columns:repeat(2,1fr);gap:12px}
      .product-body{padding:12px 12px 14px}
      .product-title{font-size:14px;min-height:36px}
      .product-price{font-size:15px}
    }
  </style>
</head>
<body>
  <nav class="topbar">
    <div class="container topbar-inner">
      <span class="brand"><span class="brand-dot"></span> Waqti</span>
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
          <div class="actions">
            <button class="btn btn-primary" id="copy-link" type="button">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M9.5 1a.5.5 0 0 0 0 1H13v3.5a.5.5 0 0 0 1 0V1.5a.5.5 0 0 0-.5-.5h-4zM2 2.5A1.5 1.5 0 0 1 3.5 1h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 0-.5.5v10a.5.5 0 0 0 .5.5h6a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 1 1 0v3A1.5 1.5 0 0 1 9.5 14h-6A1.5 1.5 0 0 1 2 12.5v-10z"/><path fill="currentColor" d="M14.354 2.354a.5.5 0 0 0-.708-.708L7.5 7.793 5.354 5.646a.5.5 0 1 0-.708.708l2.5 2.5a.5.5 0 0 0 .708 0l6.5-6.5z"/></svg>
              Copy share link
            </button>
            <a class="btn btn-secondary" href="#products">View products</a>
          </div>
        </div>
      </div>
    </div>
  </header>

  <main class="container section">
    <div class="section-header">
      <h2 class="section-title serif">Products</h2>
      <span class="section-count">
        ${productCount} ${productCount === 1 ? "item" : "items"}
      </span>
    </div>
    <section id="products">
      ${productsHtml}
    </section>
  </main>

  <footer class="footer">
    <div class="container">
      Powered by <a href="https://waqti.pro">Waqti</a>
    </div>
  </footer>

  <div class="toast" id="toast">Link copied to clipboard</div>

  <script>
    (function(){
      var btn=document.getElementById('copy-link');
      var toast=document.getElementById('toast');
      if(!btn) return;
      var url=${JSON.stringify(store.shareUrl)};
      btn.addEventListener('click',function(){
        function showToast(){
          if(!toast) return;
          toast.classList.add('show');
          setTimeout(function(){toast.classList.remove('show');},1800);
        }
        if(navigator.clipboard && navigator.clipboard.writeText){
          navigator.clipboard.writeText(url).then(showToast,function(){});
        } else {
          // Fallback for older browsers
          var ta=document.createElement('textarea');
          ta.value=url;ta.style.position='fixed';ta.style.opacity='0';
          document.body.appendChild(ta);ta.select();
          try{document.execCommand('copy');showToast();}catch(_){}
          document.body.removeChild(ta);
        }
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
  <title>Store not found · Waqti</title>
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
    <a href="https://waqti.pro">Back to Waqti</a>
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
  <title>Error · Waqti</title>
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
