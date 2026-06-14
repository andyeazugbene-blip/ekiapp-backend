import type { Request, Response } from "express";

function escape(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type PageSection = { title: string; body?: string[]; bullets?: string[] };
type PageAction = { href: string; label: string; variant?: "primary" | "secondary" };
type PageDefinition = { title: string; description: string; eyebrow: string; heading: string; intro: string; actions?: PageAction[]; sections: PageSection[]; variant?: "home" };

function renderSection(section: PageSection): string {
  const body = (section.body ?? []).map((p) => `<p>${escape(p)}</p>`).join("");
  const bullets = section.bullets?.length ? `<ul>${section.bullets.map((i) => `<li>${escape(i)}</li>`).join("")}</ul>` : "";
  return `<section class="card"><h2>${escape(section.title)}</h2>${body}${bullets}</section>`;
}

function renderLayout(page: PageDefinition): string {
  if (page.variant === "home") return renderHomeLayout(page);
  const actions = (page.actions ?? []).map((a) => `<a class="button ${a.variant === "secondary" ? "button-secondary" : "button-primary"}" href="${escape(a.href)}">${escape(a.label)}</a>`).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><meta name="theme-color" content="#1F4D40"/><title>${escape(page.title)}</title><meta name="description" content="${escape(page.description)}"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap"/><style>*,*::before,*::after{box-sizing:border-box}:root{--bg:#FAF7F2;--surface:#FFFFFF;--surface-soft:#F4EFE6;--border:#E8E0D2;--text:#1F1B16;--muted:#6B6256;--accent:#1F4D40;--accent-hover:#163A30}html,body{margin:0;padding:0}body{background:var(--bg);color:var(--text);font-family:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.6;-webkit-font-smoothing:antialiased}a{color:inherit}.shell{max-width:1040px;margin:0 auto;padding:0 20px}.topbar{background:#FFFFFFCC;backdrop-filter:saturate(180%) blur(12px);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:10}.topbar-inner{min-height:60px;display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{display:inline-flex;align-items:center;gap:8px;text-decoration:none;color:var(--text);font-family:'Fraunces',Georgia,serif;font-weight:700;font-size:22px;letter-spacing:-0.02em}.brand-dot{width:10px;height:10px;border-radius:999px;background:var(--accent);display:inline-block}.nav{display:flex;flex-wrap:wrap;gap:14px}.nav a{text-decoration:none;color:var(--muted);font-size:14px;font-weight:600}.nav a:hover{color:var(--accent)}.hero{padding:56px 0 28px}.eyebrow{display:inline-block;background:#E8F1ED;color:var(--accent);padding:6px 12px;border-radius:999px;font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase}h1{font-family:'Fraunces',Georgia,serif;font-size:48px;line-height:1.08;letter-spacing:-0.03em;margin:16px 0 16px;max-width:12ch}.intro{max-width:64ch;color:var(--muted);font-size:17px;margin:0}.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}.button{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:0 18px;border-radius:14px;text-decoration:none;font-size:14px;font-weight:700;border:1px solid transparent}.button-primary{background:var(--accent);color:#FFFFFF;transition:transform 0.2s cubic-bezier(0.34,1.56,0.64,1),box-shadow 0.2s ease,background 0.2s ease}.button-primary:hover{background:var(--accent-hover);transform:translateY(-2px) scale(1.02);box-shadow:0 12px 28px rgba(31,77,64,0.2)}.button-primary:active{transform:translateY(0) scale(0.98)}.button-secondary{background:#FFFFFF;color:var(--text);border-color:var(--border);transition:transform 0.2s cubic-bezier(0.34,1.56,0.64,1),border-color 0.2s ease,box-shadow 0.2s ease}.button-secondary:hover{border-color:var(--accent);transform:translateY(-1px);box-shadow:0 8px 20px rgba(31,27,22,0.08)}.button-secondary:active{transform:translateY(0)}.grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:18px;padding:18px 0 72px}.card{grid-column:span 6;background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:22px;box-shadow:0 10px 30px rgba(31,27,22,0.05)}.card h2{margin:0 0 12px;font-family:'Fraunces',Georgia,serif;font-size:26px;line-height:1.15;letter-spacing:-0.02em}.card p{margin:0 0 12px;color:var(--muted);font-size:15px}.card ul{margin:10px 0 0 18px;padding:0;color:var(--muted);font-size:15px}.card li+li{margin-top:8px}.foot{border-top:1px solid var(--border);background:#FFFFFF;padding:22px 0 36px;color:var(--muted);font-size:13px}.foot a{color:var(--text);text-decoration:none;font-weight:700}@media (max-width: 780px){.hero{padding-top:34px}h1{font-size:36px;max-width:none}.intro{font-size:15px}.card{grid-column:span 12;padding:18px}.topbar-inner{padding:6px 0}.nav{gap:12px}}</style></head><body><header class="topbar"><div class="shell topbar-inner"><a class="brand" href="/"><span class="brand-dot"></span>Eki</a><nav class="nav" aria-label="Public pages"><a href="/help">Help</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav></div></header><main class="shell"><section class="hero"><span class="eyebrow">${escape(page.eyebrow)}</span><h1>${escape(page.heading)}</h1><p class="intro">${escape(page.intro)}</p>${actions ? `<div class="actions">${actions}</div>` : ""}</section><section class="grid">${page.sections.map(renderSection).join("")}</section></main><footer class="foot"><div class="shell">Eki public storefront and support pages. For order-specific help, email <a href="mailto:adminandy@eki.app">adminandy@eki.app</a>.</div></footer></body></html>`;
}

function renderHomeLayout(page: PageDefinition): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#FAFBFA" />
  <title>${escape(page.title)}</title>
  <meta name="description" content="${escape(page.description)}" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" />
  <style>
    *,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:0}
    body{background:#FAFBFA;color:#111;font-family:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
    a{color:inherit;text-decoration:none}

    /* Top nav */
    .top{height:52px;display:flex;align-items:center;justify-content:space-between;padding:0 max(16px,calc((100vw - 1160px)/2))}
    .logo{font-weight:800;font-size:20px;letter-spacing:-.03em;color:#111;display:flex;align-items:center;gap:6px}
    .logo-dot{width:8px;height:8px;border-radius:2px;background:#164F3F;display:inline-block}
    .top-nav{display:flex;align-items:center;gap:20px;font-size:13px;font-weight:600;color:#555}
    .top-nav a:hover{color:#164F3F}
    .top-sign{height:34px;padding:0 18px;border:1.5px solid #ddd;border-radius:8px;display:inline-flex;align-items:center;font-size:12px;font-weight:700;color:#333;margin-left:4px;transition:border .15s}
    .top-sign:hover{border-color:#164F3F;color:#164F3F}

    /* Hero */
    .hero{display:grid;grid-template-columns:1fr 1fr;gap:40px;padding:24px max(16px,calc((100vw - 1160px)/2)) 0;max-width:1160px;margin:0 auto}
    .hero h1{margin:0;font-size:44px;line-height:1.06;font-weight:900;letter-spacing:-.045em;max-width:480px}
    .hero-sub{margin:14px 0 0;color:#666;font-size:15px;line-height:1.5;max-width:430px}
    .hero-badges{display:flex;gap:14px;margin-top:14px;flex-wrap:wrap}
    .hero-badge{font-size:13px;font-weight:600;color:#333;display:flex;align-items:center;gap:5px}
    .hero-categories{display:flex;gap:8px;margin-top:18px;flex-wrap:wrap}
    .cat-pill{height:36px;padding:0 16px;border-radius:999px;background:#fff;border:1.5px solid #e8e8e8;display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#444;transition:all .15s}
    .cat-pill:hover{border-color:#164F3F;color:#164F3F}

    /* Phone area */
    .phone-area{display:flex;align-items:center;justify-content:center;position:relative;min-height:480px}
    .phone{width:280px;background:#1C1C1E;border-radius:44px;padding:10px;box-shadow:0 40px 80px rgba(0,0,0,.35);position:relative;transition:transform .3s}
    .phone:hover{transform:scale(1.02) translateY(-4px)}
    .phone-di{position:absolute;top:18px;left:50%;transform:translateX(-50%);z-index:3;background:#0D0D0D;padding:3px 12px;border-radius:18px;height:22px;display:flex;align-items:center;gap:5px}
    .phone-screen{background:#fff;border-radius:34px;overflow:hidden}

    /* Phone content */
    .p-status{display:flex;justify-content:space-between;padding:14px 16px 0;font-size:9px;font-weight:700;color:#333}
    .p-search{display:flex;align-items:center;margin:8px 12px 4px;background:#F5F5F5;border-radius:10px;padding:6px 10px;gap:6px}
    .p-search-icon{font-size:10px;color:#999}
    .p-search-txt{font-size:8px;color:#bbb;font-weight:500}
    .p-cat{display:flex;gap:4px;padding:4px 10px;overflow-x:auto}
    .p-cat-item{font-size:7px;font-weight:700;padding:3px 8px;border-radius:999px;background:#F0F5F2;color:#164F3F;white-space:nowrap}
    .p-fav{margin:4px 10px 0;font-size:9px;font-weight:800;color:#111;display:flex;justify-content:space-between;align-items:center}
    .p-fav-more{font-size:7px;color:#999;font-weight:600}
    .p-store{background:#164F3F;color:#fff;margin:6px 10px 0;border-radius:10px;padding:8px}
    .p-store-top{display:flex;justify-content:space-between;align-items:center;font-size:8px}
    .p-store-name{font-weight:800;font-size:10px;display:flex;align-items:center;gap:4px}
    .p-store-rating{color:rgba(255,255,255,.7)}
    .p-store-loc{font-size:7px;opacity:.6;margin-top:1px}
    .p-store-prods{display:flex;gap:4px;margin-top:6px}
    .p-prod{flex:1;background:rgba(255,255,255,.1);border-radius:8px;padding:6px;text-align:center}
    .p-prod-label{font-size:6px;opacity:.7}
    .p-prod-price{font-size:9px;font-weight:800;margin-top:2px}
    .p-prod-unit{font-size:6px;opacity:.5}
    .p-prod-group{display:flex;gap:4px;margin:6px 10px 0}
    .p-prod-card{flex:1;background:#F7F9F8;border-radius:10px;padding:6px;text-align:center}
    .p-prod-card .p-prod-price{color:#164F3F}
    .p-prod-card .p-prod-label{color:#888;font-size:7px}
    .p-order{margin:6px 10px 0;background:#164F3F;border-radius:10px;padding:8px;color:#fff;display:flex;justify-content:space-between;align-items:center}
    .p-order-txt{font-size:7px;opacity:.8}
    .p-order-num{font-size:9px;font-weight:800}
    .p-order-time{font-size:7px;opacity:.6;margin-top:1px}
    .p-order-badge{background:rgba(255,255,255,.15);border-radius:6px;padding:4px 8px;font-size:7px;font-weight:700}
    .p-reorder{background:#F0F5F2;margin:6px 10px 0;border-radius:10px;padding:8px;display:flex;justify-content:space-between;align-items:center}
    .p-reorder-txt{font-size:8px;font-weight:700;color:#164F3F}
    .p-reorder-btn{font-size:7px;color:#164F3F;font-weight:700;display:flex;align-items:center;gap:3px}
    .p-footer{background:#F7F9F8;margin:6px 10px 0;border-radius:10px;padding:6px;display:flex;justify-content:space-around;font-size:6px;font-weight:600;color:#888}
    .p-footer-item{display:flex;flex-direction:column;align-items:center;gap:2px}
    .p-footer-item.active{color:#164F3F}
    .p-home-indicator{height:2.5px;width:80px;background:#ddd;border-radius:2px;margin:4px auto 2px}

    /* Deco */
    .deco{position:absolute;pointer-events:none;z-index:0}
    .deco-1{top:5%;left:-15%;width:36px;height:36px;border:2px solid rgba(255,255,255,.12);border-radius:12px;transform:rotate(20deg)}
    .deco-2{top:20%;right:-12%;width:20px;height:20px;background:rgba(255,255,255,.06);border-radius:50%}
    .deco-3{bottom:12%;left:-12%;width:50px;height:50px;border:1px solid rgba(255,255,255,.06);border-radius:50%}
    .deco-4{bottom:20%;right:-8%;width:14px;height:14px;background:rgba(255,255,255,.08);border-radius:3px;transform:rotate(45deg)}

    /* Store buttons */
    .store-btns{display:flex;gap:12px;margin-top:20px;flex-wrap:wrap}
    .store-btn{display:inline-flex;align-items:center;justify-content:center;height:46px;padding:0 20px;border-radius:10px;font-size:13px;font-weight:700;transition:all .2s;text-decoration:none}
    .store-btn-ap{background:#111;color:#fff;gap:8px}.store-btn-ap:hover{transform:translateY(-2px);box-shadow:0 12px 24px rgba(0,0,0,.15)}
    .store-btn-gp{background:#fff;color:#111;border:1.5px solid #ddd;gap:8px}.store-btn-gp:hover{border-color:#999;transform:translateY(-2px)}
    .store-btn-label{font-size:8px;opacity:.65;display:block}
    .store-btn-name{font-size:14px;font-weight:800;display:block}

    /* Features */
    .features-wrap{background:#fff;padding:48px max(16px,calc((100vw - 1160px)/2)) 52px;margin-top:32px}
    .features-title{font-size:24px;font-weight:900;letter-spacing:-.03em;text-align:center;margin-bottom:32px}
    .features{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;max-width:1160px;margin:0 auto}
    .feat{background:#F7F9F8;border-radius:16px;padding:20px;border:1px solid #eee}
    .feat-icon{width:36px;height:36px;border-radius:10px;background:#E8F0EC;display:grid;place-items:center;font-size:16px;margin-bottom:10px}
    .feat-title{font-size:14px;font-weight:800;letter-spacing:-.01em}
    .feat-body{margin:4px 0 0;color:#777;font-size:12px;line-height:1.5}

    /* Reorder strip */
    .reorder-strip{background:#164F3F;color:#fff;padding:14px max(16px,calc((100vw - 1160px)/2));display:flex;align-items:center;justify-content:space-between;gap:16px}
    .reorder-txt{font-size:13px;font-weight:700}
    .reorder-btn{height:38px;padding:0 20px;background:rgba(255,255,255,.12);border-radius:8px;font-size:12px;font-weight:700;color:#fff;display:inline-flex;align-items:center;gap:6px;text-decoration:none;transition:background .15s}
    .reorder-btn:hover{background:rgba(255,255,255,.2)}

    /* Trust strip */
    .trust-strip{background:#FAFBFA;padding:24px max(16px,calc((100vw - 1160px)/2));display:flex;align-items:center;justify-content:center;gap:24px;flex-wrap:wrap;font-size:13px;font-weight:600;color:#555}

    /* Footer */
    .footer{background:#111;color:rgba(255,255,255,.6);padding:20px max(16px,calc((100vw - 1160px)/2));display:flex;align-items:center;justify-content:space-between;gap:16px;font-size:12px;flex-wrap:wrap}
    .footer-links{display:flex;gap:18px}
    .footer-links a:hover{color:#fff}
    .order-link{color:#164F3F;font-weight:700;font-size:14px;text-decoration:none;display:inline-flex;align-items:center;gap:6px}

    @media(max-width:960px){.hero{grid-template-columns:1fr;padding-bottom:20px}.hero h1{font-size:34px;max-width:none}.phone-area{min-height:400px}.phone{width:240px}.phone:hover{transform:none}.features{grid-template-columns:1fr 1fr}.top-nav{display:none}.top-sign{display:none}}
    @media(max-width:640px){.phone{width:220px;transform:scale(.85)}.phone-area{min-height:340px}.features{grid-template-columns:1fr}.store-btn{flex:1;justify-content:center}.store-btns{gap:8px}}
  </style>
</head>
<body>
  <div class="top">
    <a class="logo" href="/"><span class="logo-dot"></span> eki</a>
    <div class="top-nav">
      <a href="/find-order">Find order</a>
      <a href="/vendor">Vendors</a>
      <a href="/privacy">Privacy</a>
      <a class="top-sign" href="/vendor">Sign in</a>
    </div>
  </div>

  <div class="hero">
    <div>
      <h1>Find. Order. Track.</h1>
      <p class="hero-sub">Your favourite foodstuff vendors. One trusted app.</p>
      <div class="hero-badges">
        <span class="hero-badge">✅ Verified vendor</span>
        <span class="hero-badge">📍 Live tracking</span>
      </div>
      <div class="hero-categories">
        <span class="cat-pill">🌾 Grains</span>
        <span class="cat-pill">🥣 Soups</span>
        <span class="cat-pill">🛢️ Oils</span>
        <span class="cat-pill">🐟 Seafood</span>
        <span class="cat-pill">🌶️ Spices</span>
      </div>
      <div class="store-btns">
        <a class="store-btn store-btn-ap" href="https://apps.apple.com/app/id6776307497"><span><span class="store-btn-label">Download on the</span><span class="store-btn-name">App Store</span></span></a>
        <a class="store-btn store-btn-gp" href="https://play.google.com/store/apps/details?id=com.ekiapp.mobile"><span><span class="store-btn-label">Get it on</span><span class="store-btn-name">Google Play</span></span></a>
      </div>
    </div>
    <div class="phone-area">
      <div class="deco deco-1"></div><div class="deco deco-2"></div><div class="deco deco-3"></div><div class="deco deco-4"></div>
      <div class="phone">
        <div class="phone-di"><div style="width:14px;height:4px;border-radius:2px;background:#1A1A1A"></div><div style="width:6px;height:6px;border-radius:50%;background:#333"></div></div>
        <div class="phone-screen">
          <div class="p-status"><span>9:41</span><span>📶 🔋</span></div>
          <div class="p-search"><span class="p-search-icon">🔍</span><span class="p-search-txt">Search for foodstuff</span></div>
          <div class="p-cat">
            <span class="p-cat-item">🌾 Grains</span>
            <span class="p-cat-item">🥣 Soups</span>
            <span class="p-cat-item">🛢️ Oils</span>
            <span class="p-cat-item">🐟 Seafood</span>
          </div>
          <div class="p-fav"><span>⭐ Favourites</span><span class="p-fav-more">See all →</span></div>
          <div class="p-store">
            <div class="p-store-top"><span class="p-store-name">🦐 Mama Chioma Store</span><span class="p-store-rating">★ 4.9</span></div>
            <div class="p-store-loc">Lagos Island • Verified</div>
            <div class="p-store-prods">
              <div class="p-prod"><div class="p-prod-label">CRAYFISH</div><div class="p-prod-price">₦3,500</div><div class="p-prod-unit">200g</div></div>
              <div class="p-prod"><div class="p-prod-label">GARRI</div><div class="p-prod-price">₦2,800</div><div class="p-prod-unit">5kg bag</div></div>
            </div>
          </div>
          <div class="p-prod-group">
            <div class="p-prod-card"><div class="p-prod-label">🥣 EGUSI</div><div class="p-prod-price">₦2,800</div><div class="p-prod-label">500g bag</div></div>
            <div class="p-prod-card"><div class="p-prod-label">🫙 PALM OIL</div><div class="p-prod-price">₦3,500</div><div class="p-prod-label">1 litre</div></div>
          </div>
          <div class="p-order"><div><div class="p-order-txt">📦 Order #1042</div><div class="p-order-num">In transit</div><div class="p-order-time">Arriving today by 4pm</div></div><span class="p-order-badge">LIVE</span></div>
          <div class="p-reorder"><span class="p-reorder-txt">🔄 Reorder from last week</span><span class="p-reorder-btn">One tap →</span></div>
          <div class="p-footer">
            <span class="p-footer-item active">🏠<br>Home</span>
            <span class="p-footer-item">🔍<br>Search</span>
            <span class="p-footer-item">👤<br>Profile</span>
          </div>
          <div class="p-home-indicator"></div>
        </div>
      </div>
    </div>
  </div>

  <div class="features-wrap">
    <div class="features-title">Everything buyers need in one app.</div>
    <div class="features">
      <div class="feat"><div class="feat-icon">🛒</div><div class="feat-title">Find trusted vendors</div><div class="feat-body">Discover foodstuff sellers with clear profiles, listings, locations and trust signals.</div></div>
      <div class="feat"><div class="feat-icon">📦</div><div class="feat-title">Live order tracking</div><div class="feat-body">See when your order is accepted, packed, dispatched and delivered.</div></div>
      <div class="feat"><div class="feat-icon">🔐</div><div class="feat-title">Secure checkout</div><div class="feat-body">No random transfers. No lost screenshots. Pay by card or wallet.</div></div>
      <div class="feat"><div class="feat-icon">🔁</div><div class="feat-title">One-tap reorder</div><div class="feat-body">Your favourite vendors, always within reach. Reorder in seconds.</div></div>
    </div>
  </div>

  <div class="reorder-strip">
    <span class="reorder-txt">🐟 From garri and egusi to crayfish, palm oil, spices and more.</span>
    <a class="reorder-btn" href="/find-order">Find your order →</a>
  </div>

  <div class="trust-strip">🔐 Secure checkout · No random transfers · Trusted by foodstuff buyers</div>

  <div class="footer">
    <span>© ${new Date().getFullYear()} Eki marketplace</span>
    <div class="footer-links"><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/help">Help</a><a href="/find-order">Find order</a></div>
  </div>
</body>
</html>`;
}

function renderFindOrderLayout(): string { return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="theme-color" content="#164F3F">
<title>Find your order | Eki</title>
<meta name="description" content="Find and track an Eki order with your checkout email address." />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" />
<style>
*,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:0}
body{min-height:100vh;background:#F6F8F7;color:#111827;font-family:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
a{color:inherit;text-decoration:none}.topbar{height:44px;background:#FFFFFF;border-bottom:1px solid #E5E7EB}
.shell{width:min(1120px,calc(100% - 32px));margin:0 auto}.topbar .shell{height:100%;display:flex;align-items:center;justify-content:space-between;gap:18px}
.brand{display:inline-flex;align-items:center;justify-content:center;min-width:46px;height:24px;border-radius:4px;background:#164F3F;color:#FFFFFF;font-weight:800;font-size:13px;letter-spacing:-.03em}
.nav{display:flex;align-items:center;gap:26px;font-size:12px;color:#374151;font-weight:600}.signin{min-width:56px;height:24px;border-radius:4px;background:#164F3F;color:#FFFFFF;display:grid;place-items:center}
main{padding:58px 0 72px}.lookup-card{width:min(100%,420px);margin:0 auto;border:1px solid #E5E7EB;border-radius:12px;background:#FFFFFF;padding:30px 32px 32px;box-shadow:0 12px 36px rgba(15,23,42,.04)}
.badge{width:58px;height:58px;margin:0 auto 18px;border-radius:999px;background:#DCF5E4;color:#238154;display:grid;place-items:center;font-weight:800;text-transform:lowercase}
h1{margin:0;text-align:center;font-size:22px;line-height:1.15;letter-spacing:-.04em}
.sub{margin:8px auto 22px;max-width:280px;text-align:center;color:#6B7280;font-size:12px;line-height:1.45}
label{display:block;font-size:11px;font-weight:700;color:#374151;margin:0 0 7px}
input{width:100%;height:42px;border:1px solid #DCE3E0;border-radius:5px;padding:0 12px;font:inherit;font-size:13px;outline:none;background:#FFFFFF;color:#111827}
input:focus{border-color:#164F3F;box-shadow:0 0 0 3px rgba(22,79,63,.1)}
button{width:100%;height:38px;border:0;border-radius:5px;background:#164F3F;color:#FFFFFF;font:inherit;font-size:12px;font-weight:800;cursor:pointer;margin-top:12px}
button:disabled{opacity:.62;cursor:not-allowed}
.notice{margin-top:16px;border-radius:6px;border:1px solid #F2B56B;background:#FFF7E7;color:#9A4B09;padding:12px 13px;font-size:11px;line-height:1.45}
.notice.ok{border-color:#BFE5CD;background:#F0FFF5;color:#155F3B}.notice.error{border-color:#F2B6B6;background:#FFF1F1;color:#9F1D1D}
.helper{margin:22px auto 0;text-align:center;color:#87918D;font-size:11px}
.otp-row{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-top:8px}
.otp-row input{text-align:center;font-weight:800;font-size:16px;padding:0}
.secondary-action{border:1px solid #DCE3E0;background:#FFFFFF;color:#164F3F;margin-top:10px}
.results{width:min(100%,920px);margin:0 auto}.result-head{background:#164F3F;color:#FFFFFF;padding:20px 0;margin:-58px calc((100vw - min(1120px,calc(100vw - 32px))) / -2) 24px}
.result-head .shell{display:flex;align-items:center;justify-content:center;gap:12px}
.ok-dot{width:34px;height:34px;border-radius:999px;background:#2E8658;display:grid;place-items:center;font-weight:800}
.result-title{font-size:18px;font-weight:800;letter-spacing:-.03em}.result-sub{font-size:12px;color:rgba(255,255,255,.78);margin-top:2px}
.orders{display:grid;gap:12px}.order-card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:center;background:#FFFFFF;border:1px solid #E5E7EB;border-radius:9px;padding:16px}
.order-number{font-weight:800;font-size:13px;color:#111827}.order-meta{margin-top:5px;color:#6B7280;font-size:12px;line-height:1.45}
.order-total{font-weight:800;color:#164F3F;font-size:13px;text-align:right}
.status{display:inline-flex;margin-top:8px;border-radius:999px;background:#DDF4E7;color:#17623F;padding:4px 9px;font-size:11px;font-weight:800;text-transform:capitalize}
.track-link{display:inline-flex;align-items:center;justify-content:center;height:30px;border-radius:5px;background:#164F3F;color:#FFFFFF;padding:0 12px;font-size:11px;font-weight:800;margin-top:8px}
.hidden{display:none!important}
@media(max-width:620px){.nav{gap:14px}.nav a:nth-child(2){display:none}main{padding-top:36px}.lookup-card{padding:24px 20px}.order-card{grid-template-columns:1fr}.order-total{text-align:left}.result-head{margin-top:-36px}}
</style></head><body>
<header class="topbar"><div class="shell">
<a class="brand" href="/">eki</a><nav class="nav" aria-label="Main navigation"><a href="/store">Vendors</a><a href="/help">Help</a></nav><a class="signin" href="/">Home</a>
</div></header>
<main>
<section id="lookupPanel" class="lookup-card"><div class="badge">seal</div><h1>Find your order.</h1><p class="sub">Enter the checkout email address used when the order was placed.</p>
<form id="lookupForm"><label for="contact">Email address</label><input id="contact" autocomplete="email" inputmode="email" type="email" placeholder="Email address used at checkout" /><button id="lookupButton" type="submit">Continue</button></form>
<div id="lookupMessage" class="notice">No password needed. If an order exists, we will send a one-time code to the checkout email.</div>
<p class="helper">Orders placed as a guest still work here. Use the details entered at checkout.</p></section>
<section id="otpPanel" class="lookup-card hidden"><div class="badge">OTP</div><h1>Enter your code.</h1><p id="otpIntro" class="sub">We sent a 6-digit code to your checkout email.</p>
<form id="otpForm"><label for="otp0">Verification code</label><div class="otp-row" id="otpInputs"><input id="otp0" inputmode="numeric" maxlength="1"/><input inputmode="numeric" maxlength="1"/><input inputmode="numeric" maxlength="1"/><input inputmode="numeric" maxlength="1"/><input inputmode="numeric" maxlength="1"/><input inputmode="numeric" maxlength="1"/></div>
<button id="verifyButton" type="submit">Verify and continue</button><button class="secondary-action" id="changeContact" type="button">Use another email</button></form>
<div id="otpMessage" class="notice ok">Check your email inbox for the latest code.</div></section>
<section id="resultsPanel" class="results hidden"><div class="result-head"><div class="shell"><div class="ok-dot">OK</div><div><div class="result-title">Your order is now in Eki.</div><div id="resultSubtitle" class="result-sub">Track, reorder, or open the vendor store.</div></div></div></div>
<div class="orders" id="ordersList"></div><button class="secondary-action" id="findAnother" type="button">Find another order</button></section>
</main>
<script>
const lookupPanel=document.getElementById('lookupPanel'),otpPanel=document.getElementById('otpPanel'),resultsPanel=document.getElementById('resultsPanel'),lookupForm=document.getElementById('lookupForm'),otpForm=document.getElementById('otpForm'),contactInput=document.getElementById('contact'),lookupButton=document.getElementById('lookupButton'),verifyButton=document.getElementById('verifyButton'),lookupMessage=document.getElementById('lookupMessage'),otpMessage=document.getElementById('otpMessage'),otpIntro=document.getElementById('otpIntro'),otpInputs=Array.from(document.querySelectorAll('#otpInputs input')),ordersList=document.getElementById('ordersList'),resultSubtitle=document.getElementById('resultSubtitle');let activeContact='';
function show(p){lookupPanel.classList.toggle('hidden',p!=='lookup');otpPanel.classList.toggle('hidden',p!=='otp');resultsPanel.classList.toggle('hidden',p!=='results')}
function setMsg(n,t,k){n.textContent=t;n.className='notice '+(k||'')}
function esc(v){return String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c])}
function fmt(o){const a=Number(o.total||0),c=o.currency||'GBP';try{return new Intl.NumberFormat('en-GB',{style:'currency',currency:c}).format(a)}catch{return c+' '+a.toFixed(2)}}
function cv(){return otpInputs.map(i=>i.value.replace(/\\D/g,'')).join('')}
otpInputs.forEach((i,idx)=>{i.addEventListener('input',()=>{i.value=i.value.replace(/\\D/g,'').slice(0,1);if(i.value&&otpInputs[idx+1])otpInputs[idx+1].focus()});i.addEventListener('keydown',e=>{if(e.key==='Backspace'&&!i.value&&otpInputs[idx-1])otpInputs[idx-1].focus()})});
lookupForm.addEventListener('submit',async e=>{e.preventDefault();const c=contactInput.value.trim().toLowerCase();if(!c||!c.includes('@')){setMsg(lookupMessage,'Enter the email address used at checkout.','error');return}lookupButton.disabled=true;setMsg(lookupMessage,'Checking...','ok');try{const r=await fetch('/api/public/stores/order-lookup/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:c})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.message||'Unable to check this order right now.');if(!d.found){setMsg(lookupMessage,d.message||'No order found for this email address.','error');return}activeContact=c;otpInputs.forEach(i=>{i.value=''});otpIntro.textContent='We sent a 6-digit code to '+(d.emailHint||'your checkout email')+'.';setMsg(otpMessage,'Check your email inbox for the latest code.','ok');show('otp');otpInputs[0].focus()}catch(err){setMsg(lookupMessage,err.message||'Unable to check this order right now.','error')}finally{lookupButton.disabled=false}});
otpForm.addEventListener('submit',async e=>{e.preventDefault();const c=cv();if(c.length!==6){setMsg(otpMessage,'Enter the full 6-digit code from your email.','error');return}verifyButton.disabled=true;setMsg(otpMessage,'Verifying...','ok');try{const r=await fetch('/api/public/stores/order-lookup/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:activeContact,code:c})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.message||'Invalid or expired code.');const orders=Array.isArray(d.orders)?d.orders:[];renderOrders(orders);resultSubtitle.textContent=orders.length+' order'+(orders.length===1?'':'s')+' found for your checkout email.';show('results')}catch(err){setMsg(otpMessage,err.message||'Invalid or expired code.','error')}finally{verifyButton.disabled=false}});
function renderOrders(orders){if(!orders.length){ordersList.innerHTML='<article class="order-card"><div><div class="order-number">No active order found</div><div class="order-meta">Please contact support if you believe this is a mistake.</div></div></article>';return}ordersList.innerHTML=orders.map(o=>{const items=Array.isArray(o.items)?o.items.map(i=>esc(i.name)+' x'+Number(i.quantity||0)).join(', '):'';const storeUrl='/store/'+encodeURIComponent(o.vendorSlug||'');return '<article class="order-card"><div><div class="order-number">'+esc(o.orderNumber||o.id)+'</div><div class="order-meta">'+esc(o.vendorName||'Vendor')+'<br />'+esc(items||'Order items')+'</div><span class="status">'+esc(o.status||'placed').replace(/_/g,' ')+'</span><br /><a class="track-link" href="'+storeUrl+'">Open vendor store</a></div><div class="order-total">'+esc(fmt(o))+'</div></article>'}).join('')}
document.getElementById('changeContact').addEventListener('click',()=>show('lookup'));
document.getElementById('findAnother').addEventListener('click',()=>show('lookup'));
</script>
</body></html>`; }

function sendPage(response: Response, page: PageDefinition): void { response.setHeader("Content-Type","text/html; charset=utf-8"); response.setHeader("Cache-Control","public, max-age=300, s-maxage=900"); response.status(200).send(renderLayout(page)); }

function renderVendorPortalLayout(): string { return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="theme-color" content="#164F3F">
<title>Vendor Portal | Eki</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" />
<style>
*,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:0}
body{background:#F5F6F5;color:#111;font-family:'Inter',sans-serif}
a{color:inherit;text-decoration:none}.shell{width:min(1120px,calc(100% - 24px));margin:0 auto}
.topbar{height:48px;background:#fff;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;padding:0 max(12px,calc((100vw - 1120px)/2))}
.brand{font-weight:800;font-size:14px;color:#164F3F;display:flex;align-items:center;gap:6px}.brand-dot{width:8px;height:8px;border-radius:4px;background:#164F3F;display:inline-block}
.toplinks{display:flex;gap:16px;font-size:12px;font-weight:600;color:#666}
.btn{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 16px;border-radius:8px;font-weight:700;font-size:12px;border:0;cursor:pointer}
.btn-primary{background:#164F3F;color:#fff}.input{width:100%;height:42px;border:1px solid #dce3e0;border-radius:8px;padding:0 12px;font-size:13px;outline:none}
.input:focus{border-color:#164F3F;box-shadow:0 0 0 3px rgba(22,79,63,.1)}
.msg{display:none;padding:10px 12px;border-radius:8px;font-size:12px;margin-bottom:12px}
.msg.err{display:block;background:#fff0f0;border:1px solid #f3caca;color:#a62e2e}
.hidden{display:none!important}.loading{text-align:center;padding:40px;color:#999;font-size:13px}
.grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.stat-card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:14px}
.stat-label{font-size:11px;color:#999;font-weight:600;text-transform:uppercase}
.stat-value{font-size:24px;font-weight:800;margin-top:3px;color:#111}
.stat-sub{font-size:11px;color:#aaa;margin-top:2px}
.login-page{min-height:100vh;display:grid;place-items:center;padding:24px}
.login-card{width:min(100%,380px);background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:28px;box-shadow:0 8px 24px rgba(0,0,0,.06)}
.login-logo{width:40px;height:40px;border-radius:10px;background:#164F3F;color:#fff;display:grid;place-items:center;font-weight:800;margin-bottom:18px}
.login-title{font-size:22px;font-weight:800}.login-sub{color:#999;font-size:13px;margin:4px 0 18px}
.form-group{margin-bottom:14px}.form-group label{display:block;font-size:12px;font-weight:700;margin-bottom:5px;color:#444}
.dash-grid{display:grid;grid-template-columns:1fr 280px;gap:18px;padding:18px 0}
.phone-frame{width:100%;background:#1C1C1E;border-radius:32px;padding:8px;box-shadow:0 8px 32px rgba(0,0,0,.15)}
.phone-screen{background:#F7F8F6;border-radius:24px;overflow:hidden}
.phone-hdr{background:#164F3F;color:#fff;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;font-size:10px}
.phone-body{padding:10px}
.phone-row{display:flex;justify-content:space-between;font-size:10px;padding:6px 0;border-bottom:1px solid #eee}
.phone-lbl{color:#999}.phone-val{font-weight:700;color:#111}
@media(max-width:768px){.dash-grid{grid-template-columns:1fr}.grid-4{grid-template-columns:1fr 1fr}}
@media(max-width:480px){.grid-4{grid-template-columns:1fr 1fr;gap:8px}.stat-value{font-size:18px}}
</style></head><body>
<div id="app">
<div class="login-page" id="loginScreen">
  <div class="login-card"><div class="login-logo">eki</div>
    <div class="login-title">Vendor Portal</div><div class="login-sub">Sign in to view your store analytics.</div>
    <div id="loginMsg" class="msg"></div>
    <form id="loginForm">
      <div class="form-group"><label>Email</label><input id="email" class="input" type="email" placeholder="vendor@eki.app" /></div>
      <div class="form-group"><label>Password</label><input id="pass" class="input" type="password" /></div>
      <button class="btn btn-primary" style="width:100%;margin-top:6px" id="loginBtn">Sign In</button>
    </form>
  </div>
</div>
<div id="dashScreen" class="hidden">
  <div class="topbar"><a class="brand" href="/"><span class="brand-dot"></span> Eki Vendor</a><div class="toplinks"><a href="#" id="logoutBtn" style="color:#e55353">Sign out</a></div></div>
  <div class="shell dash-grid" id="dashContent">
    <div><div id="tabAnalytics"><div class="loading">Sign in to view</div></div></div>
    <div class="phone-frame"><div class="phone-screen"><div class="phone-hdr"><span>My Store</span></div><div class="phone-body" id="storePreview"><div style="text-align:center;padding:24px;color:#999;font-size:11px">Sign in first</div></div></div></div>
  </div>
</div></div>
<script>const API='https://ekiapp-backend.vercel.app';let T='';
function $(id){return document.getElementById(id)}
async function loadDash(){$('tabAnalytics').innerHTML='<div class="loading">Loading...</div>';try{const r=await fetch(API+'/api/vendors/me/earnings',{headers:{'Authorization':'Bearer '+T}});const d=await r.json();const e=d.earnings||d||{};$('tabAnalytics').innerHTML='<div class="grid-4">'+'<div class="stat-card"><div class="stat-label">Today</div><div class="stat-value">'+fmt(e.salesToday||0,e.currency)+'</div><div class="stat-sub">Sales</div></div>'+'<div class="stat-card"><div class="stat-label">Week</div><div class="stat-value">'+fmt(e.salesThisWeek||0,e.currency)+'</div><div class="stat-sub">Sales</div></div>'+'<div class="stat-card"><div class="stat-label">Month</div><div class="stat-value">'+fmt(e.salesThisMonth||0,e.currency)+'</div><div class="stat-sub">Sales</div></div>'+'<div class="stat-card"><div class="stat-label">Available</div><div class="stat-value">'+fmt(e.availableBalance||0,e.currency)+'</div><div class="stat-sub">Payout</div></div></div>';$('storePreview').innerHTML='<div style="font-weight:800;font-size:13px;margin-bottom:6px">'+($('email').value)+'</div>'+'<div class="phone-row"><span class="phone-lbl">Revenue</span><span class="phone-val">'+fmt(e.salesThisMonth||0,e.currency)+'</span></div>'+'<div class="phone-row"><span class="phone-lbl">Available</span><span class="phone-val">'+fmt(e.availableBalance||0,e.currency)+'</span></div>'+'<div class="phone-row" style="border-bottom:0"><span class="phone-lbl">Pending</span><span class="phone-val">'+fmt(e.pendingPayout||0,e.currency)+'</span></div>'}catch(e){$('tabAnalytics').innerHTML='<div class="msg err" style="display:block">'+e.message+'</div>'}}
function fmt(n,c){return new Intl.NumberFormat('en-GB',{style:'currency',currency:c||'EUR',maximumFractionDigits:0}).format((n||0)/100)}
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();$('loginBtn').disabled=true;const r=await fetch(API+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:$('email').value.trim(),password:$('pass').value})});const d=await r.json();$('loginBtn').disabled=false;if(!r.ok||!d.token){$('loginMsg').textContent=d.message||'Invalid';$('loginMsg').className='msg err';return}T=d.token;$('loginScreen').className='hidden';$('dashScreen').className='';loadDash()});
$('logoutBtn').addEventListener('click',e=>{e.preventDefault();T='';$('dashScreen').className='hidden';$('loginScreen').className=''});
</script></body></html>`; }

function renderBuyerCartLayout(): string { return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="theme-color" content="#164F3F">
<title>My Cart | Eki</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" />
<style>
body{margin:0;background:#F5F6F5;color:#111;font-family:'Inter',sans-serif}
.shell{width:min(960px,calc(100% - 24px));margin:0 auto}.topbar{height:48px;background:#fff;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;padding:0 max(12px,calc((100vw - 960px)/2))}
.brand{font-weight:800;font-size:14px;color:#164F3F;display:flex;align-items:center;gap:6px}.brand-dot{width:8px;height:8px;border-radius:4px;background:#164F3F;display:inline-block}
.toplinks{display:flex;gap:14px;font-size:12px;font-weight:600;color:#666}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:18px;box-shadow:0 1px 6px rgba(0,0,0,.04)}
.btn{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 16px;border-radius:8px;font-weight:700;font-size:12px;border:0;cursor:pointer;background:#164F3F;color:#fff;text-decoration:none}
</style></head><body>
<div class="topbar"><a class="brand" href="/"><span class="brand-dot"></span> Eki</a><div class="toplinks"><a href="/store">Store</a><a href="/">Home</a></div></div>
<div class="shell" style="padding:40px 0;text-align:center">
<div style="font-size:48px;margin-bottom:16px">🛒</div>
<h1 style="font-size:24px;font-weight:800;margin:0">Your Cart</h1>
<p style="color:#999;font-size:13px;margin:8px 0 24px">Add items using the Eki app, then come here to review.</p>
<div class="card" style="max-width:400px;margin:0 auto;text-align:left;font-size:13px;line-height:1.6">
<strong>How it works:</strong><ol style="margin:10px 0 0;padding-left:18px;color:#666"><li>Browse vendors and add items in the <strong>Eki app</strong></li><li>Review your cart and checkout</li><li>Pay by card or wallet — track delivery live</li></ol>
<a href="/store" class="btn" style="margin-top:14px;width:100%;display:flex">Browse Vendors</a>
</div></div></body></html>`; }

export async function getPublicVendorPortalPage(_request: Request, response: Response): Promise<void> {
  response.setHeader("Content-Type","text/html; charset=utf-8"); response.setHeader("Cache-Control","no-cache");
  response.status(200).send(renderVendorPortalLayout());
}

export async function getPublicBuyerCartPage(_request: Request, response: Response): Promise<void> {
  response.setHeader("Content-Type","text/html; charset=utf-8"); response.setHeader("Cache-Control","public, max-age=120, s-maxage=300");
  response.status(200).send(renderBuyerCartLayout());
}

export async function getPublicHomePage(_request: Request, response: Response): Promise<void> {
  response.setHeader("Content-Type","text/html; charset=utf-8"); response.setHeader("Cache-Control","public, max-age=300, s-maxage=900");
  response.status(200).send(renderHomeLayout(homePage));
}

export async function getPublicFindOrderPage(_request: Request, response: Response): Promise<void> {
  response.setHeader("Content-Type","text/html; charset=utf-8"); response.setHeader("Cache-Control","public, max-age=120, s-maxage=300");
  response.status(200).send(renderFindOrderLayout());
}

export async function getPublicHelpPage(_request: Request, response: Response): Promise<void> { sendPage(response, helpPage); }
export async function getPublicPrivacyPage(_request: Request, response: Response): Promise<void> { sendPage(response, privacyPage); }
export async function getPublicTermsPage(_request: Request, response: Response): Promise<void> { sendPage(response, termsPage); }
export async function getPublicAccountDeletionPage(_request: Request, response: Response): Promise<void> { sendPage(response, accountDeletionPage); }
export async function getPublicInvitePage(request: Request, response: Response): Promise<void> {
  response.setHeader("Content-Type","text/html; charset=utf-8"); response.setHeader("Cache-Control","public, max-age=300, s-maxage=900");
  response.status(200).send(renderReferralInviteLayout(String(request.params.code ?? "")));
}
export async function getPublicVendorSubscriptionPage(_request: Request, response: Response): Promise<void> {
  response.setHeader("Content-Type","text/html; charset=utf-8"); response.setHeader("Cache-Control","public, max-age=120, s-maxage=300");
  response.status(200).send(renderVendorSubscriptionLayout());
}

const homePage: PageDefinition = {
  title: "Eki",
  description: "Eki helps buyers keep favorite African foodstuff vendors close, track orders, and reorder quickly.",
  eyebrow: "Eki",
  heading: "Never lose your vendors again.",
  intro: "The Eki app puts your favourite African foodstuff vendors right in your pocket. Track orders live, confirm deliveries with a tap, and reorder in seconds.",
  actions: [{ href: "/store/mama-chi-foodstuff", label: "Open live store example" },{ href: "/help", label: "Help and support", variant: "secondary" }],
  variant: "home",
  sections: [
    { title: "What Eki handles", bullets: ["Vendor storefront pages shared by direct link","Secure checkout through connected payment providers","Order tracking, guest order lookup, and buyer notifications","Escrow-style order states, disputes, and refund handling"] },
    { title: "For buyers", body: ["You can browse vendor products, add items to cart, pay securely, and track eligible orders after checkout.","If you checked out as a guest, the order lookup flow uses your checkout email address and a one-time code."] },
    { title: "For vendors", body: ["Vendors manage products, storefront links, orders, payouts, messaging, and analytics from the app.","Shared store links point to public storefront pages that can be opened without installing the app first."] },
    { title: "Support links", bullets: ["Help: /help","Privacy: /privacy","Terms: /terms","Email: adminandy@eki.app"] },
  ],
};
const helpPage: PageDefinition = { title:"Help and support | Eki", description:"Public support and order-help information for Eki buyers and vendors.", eyebrow:"Support", heading:"Get help with orders, payouts, OTP, and disputes.", intro:"For support, contact adminandy@eki.app. The support team aims to respond within 24 hours, and order-specific issues may require the order number or checkout email used during purchase.", actions:[{href:"mailto:adminandy@eki.app",label:"Email support"},{href:"/terms",label:"Read terms",variant:"secondary"}], sections:[{title:"Response times",bullets:["First support response target: within 24 hours","Refund requests are reviewed within 24 hours","Approved refunds are processed within 3 business days","Complex disputes may require admin review before resolution"]},{title:"Order help",bullets:["If payment succeeded but your order is still pending, the system may still be waiting on webhook confirmation.","Guest buyers can use the public order lookup flow with their checkout email and one-time code.","If an escrow order was shipped and something is wrong, open a dispute before funds are released."]},{title:"OTP and account access",bullets:["If you do not receive an OTP email, check your spam folder first.","Repeated failed login attempts may temporarily lock the account for security.","For buyer account recovery, contact support from the email used to place the order or register the account."]},{title:"Vendor support",bullets:["Vendors can manage products, public store links, payouts, notifications, and buyer messages in the app.","Payout availability depends on order status, escrow rules, and any active dispute or refund review."]}]};
const privacyPage: PageDefinition = { title:"Privacy policy | Eki", description:"How Eki handles account, order, payment, support, and operational data.", eyebrow:"Privacy", heading:"How Eki handles your data.", intro:"This page summarizes the operational privacy posture of Eki based on the current product and backend implementation. It explains what data we process, why we process it, and the user controls currently available in the product.", actions:[{href:"mailto:adminandy@eki.app",label:"Privacy questions"},{href:"/help",label:"Support",variant:"secondary"}], sections:[{title:"Data we process",bullets:["Account details such as name, email address, phone number, role, and authentication state","Order and delivery details such as products ordered, totals, delivery address, and order status","Payment-related metadata needed to verify and reconcile transactions through Stripe or Paystack","Vendor storefront content such as product listings, descriptions, pricing, and uploaded images","Operational records such as notifications, audit logs, and support messages"]},{title:"Why we process it",bullets:["To authenticate users and secure access to buyer, vendor, and admin functions","To process orders, order tracking, escrow states, disputes, refunds, and payouts","To detect abuse, enforce security controls, and investigate platform incidents","To deliver transactional emails, OTP codes, notifications, and operational support"]},{title:"Infrastructure and subprocessors",bullets:["Vercel for hosting and server execution","Neon for PostgreSQL database storage","Stripe for international payments","Paystack for supported domestic payments and payout rails","Cloudflare R2 for file storage","Sentry for error monitoring","Resend for transactional email delivery"]},{title:"Your controls",bullets:["Authenticated users can export account data through the data-export endpoint","Authenticated users can request account deletion, with financial records retained where legally required","Order and payment records may be retained for compliance, fraud prevention, and accounting obligations","For privacy requests or correction requests, contact adminandy@eki.app"]}]};
const termsPage: PageDefinition = { title:"Terms of service | Eki", description:"Platform rules for buyers, vendors, payments, disputes, and support on Eki.", eyebrow:"Terms", heading:"Platform rules for buyers and vendors.", intro:"These terms summarize how Eki operates as a marketplace platform for vendor storefronts, secure checkout, order tracking, escrow-sensitive flows, and support. By using the platform, buyers and vendors agree to follow these platform rules.", actions:[{href:"/privacy",label:"Read privacy policy",variant:"secondary"},{href:"mailto:adminandy@eki.app",label:"Contact support"}], sections:[{title:"Marketplace role",bullets:["Eki provides the software platform, storefront links, checkout flows, messaging, notifications, and support tooling used by buyers and vendors.","Product availability, pricing, fulfillment timing, and listing accuracy remain the vendor's responsibility."]},{title:"Buyer rules",bullets:["Buyers must provide accurate delivery and contact details at checkout.","A guest order lookup requires access to the checkout email address used when the order was placed.","If an OTP-confirmed escrow delivery is completed, the transaction may become final under the platform's escrow rules."]},{title:"Vendor rules",bullets:["Vendors must publish accurate product information, pricing, and stock availability.","Vendors must ship and manage orders through the platform in line with delivery, escrow, and dispute states.","Eki may suspend storefronts or accounts for fraud, prohibited listings, abuse, or repeated operational failures."]},{title:"Payments, refunds, and disputes",bullets:["Payments are processed by connected payment providers such as Stripe and Paystack.","Refund requests are reviewed within 24 hours, and approved refunds are processed within 3 business days.","Disputes may freeze order funds until review is complete.","Partial refunds may require additional admin approval."]},{title:"Support and policy changes",bullets:["Support is available at adminandy@eki.app.","Operational policies may change as the platform matures, including payout, support, and fraud-prevention controls.","If you do not agree with a platform change, stop using the service and contact support for account assistance."]}]};
const accountDeletionPage: PageDefinition = { title:"Account deletion | Eki", description:"How to delete an Eki account and what data may be retained.", eyebrow:"Data deletion", heading:"Delete your Eki account.", intro:"Signed-in users can request account deletion inside the Eki app. If you cannot access the app, contact support from the email address on your account.", actions:[{href:"mailto:adminandy@eki.app",label:"Email support"},{href:"/privacy",label:"Privacy policy",variant:"secondary"}], sections:[{title:"In-app deletion",bullets:["Open Eki and sign in to the buyer or vendor account you want to delete.","Go to Profile or Settings, then open Delete Account.","Review the deletion information and confirm the request."]},{title:"What is deleted",bullets:["Account access is removed after the backend accepts the deletion request.","Profile data that can legally be erased is deleted or anonymized.","Uploaded images owned by the account may be removed where they are no longer required for an active order or compliance record."]},{title:"What may be retained",bullets:["Order, payment, payout, tax, fraud-prevention, and dispute records may be retained where required by law or platform safety obligations.","Active orders, unresolved disputes, or payout obligations can block deletion until they are resolved."]},{title:"Manual request",body:["If you cannot access your account, email adminandy@eki.app from the registered email address and include the account role, buyer or vendor."]}]};
function renderReferralInviteLayout(code: string): string {
  const safeCode = escape(code.trim().toUpperCase());
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Join Eki | Referral invite</title><meta name="description" content="Join Eki using a referral invite."/><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f8f7;color:#111827;font-family:Inter,Arial,sans-serif}.card{width:min(92vw,460px);background:#fff;border:1px solid #dde7e2;border-radius:24px;padding:30px;box-shadow:0 20px 50px rgba(10,43,33,.08);text-align:center}.logo{display:inline-grid;place-items:center;width:52px;height:52px;border-radius:14px;background:#076b51;color:#fff;font-weight:800;margin-bottom:18px}h1{margin:0;font-size:30px;letter-spacing:-.04em}.code{margin:20px 0;padding:14px;border-radius:14px;background:#eff8f3;color:#076b51;font-weight:800;letter-spacing:.08em}p{color:#5f6b66;line-height:1.55}.actions{display:grid;gap:10px;margin-top:22px}a{display:grid;place-items:center;height:50px;border-radius:14px;text-decoration:none;font-weight:800}.primary{background:#076b51;color:#fff}.secondary{border:1px solid #cfe1da;color:#076b51;background:#fff}</style></head><body><main class="card"><div class="logo">eki</div><h1>You were invited to Eki.</h1><p>Use this referral code when creating your buyer account. Rewards are credited after the invited buyer completes a first paid order.</p><div class="code">${safeCode || "REFERRAL"}</div><div class="actions"><a class="primary" href="/">Open Eki website</a><a class="secondary" href="/help">Need help?</a></div></main></body></html>`;
}
function renderVendorSubscriptionLayout(): string { return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Vendor subscriptions | Eki</title><meta name="description" content="Choose and pay for an Eki vendor subscription on the web."/><style>*{box-sizing:border-box}body{margin:0;background:#f7faf8;color:#0d1b16;font-family:Arial,sans-serif}a{color:inherit;text-decoration:none}.nav{height:64px;padding:0 24px;display:flex;align-items:center;justify-content:space-between;max-width:1180px;margin:auto}.logo{background:#076b51;color:#fff;border-radius:7px;padding:8px 18px;font-weight:800}.home{font-size:14px;font-weight:700;color:#076b51}.layout{max-width:1180px;margin:32px auto 56px;padding:0 24px;display:grid;grid-template-columns:minmax(0,1fr) 430px;gap:28px}.intro{min-height:560px;padding:42px;border-radius:24px;background:#0d1b16;color:#fff;display:flex;flex-direction:column;justify-content:center}.eyebrow{color:#9be0bc;font-size:13px;font-weight:700}h1{margin:14px 0 0;font-size:48px;line-height:1.08;max-width:560px}.intro p{margin:18px 0 0;color:rgba(255,255,255,.78);font-size:17px;line-height:1.55;max-width:600px}.trust{margin-top:28px;padding:14px;border:1px solid rgba(255,255,255,.16);border-radius:14px;background:rgba(255,255,255,.08);font-size:14px;color:rgba(255,255,255,.82)}.panel{padding:24px;border:1px solid #dde7e2;border-radius:24px;background:#fff;box-shadow:0 14px 32px rgba(10,43,33,.08)}h2{margin:0;font-size:26px}.sub{margin:7px 0 20px;color:#66736d;font-size:14px;line-height:1.45}label{display:block;margin:18px 0 8px;font-size:13px;font-weight:700}input{width:100%;height:52px;padding:0 14px;border:1px solid #dde7e2;border-radius:13px;color:#0d1b16;outline:none}input:focus{border-color:#076b51;box-shadow:0 0 0 3px rgba(7,107,81,.1)}.plans{display:grid;gap:12px;margin-top:16px}.plan{width:100%;padding:16px;text-align:left;border:1px solid #dde7e2;border-radius:16px;background:#fff;cursor:pointer}.plan.active{border-color:#076b51;background:#f1faf5}.plan-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.plan-name{font-size:18px;font-weight:800}.fee{margin-top:5px;color:#66736d;font-size:12px}.price{margin-top:14px;color:#076b51;font-size:28px;font-weight:800}.price small{color:#66736d;font-size:13px;font-weight:400}.features{margin:12px 0 0;padding:0;list-style:none;color:#34423c;font-size:13px;line-height:1.6}.features li:before{content:"✓";color:#076b51;font-weight:800;margin-right:8px}.radio{width:23px;height:23px;border:1px solid #b7c6bf;border-radius:50%;display:grid;place-items:center;color:#fff}.active .radio{background:#076b51;border-color:#076b51}.status{display:none;margin:16px 0 0;padding:12px;border-radius:12px;font-size:13px;line-height:1.4}.status.ok{display:block;background:#eaf8ef;border:1px solid #cbeed9;color:#076b51}.status.warn{display:block;background:#fff7e8;border:1px solid #f2d399;color:#8d5100}.status.error{display:block;background:#fff0f0;border:1px solid #f3caca;color:#a62e2e}.summary{margin-top:18px;padding:14px;border-radius:13px;background:#f6f8f7;font-size:13px;color:#66736d}.summary strong{display:block;margin-top:4px;color:#0d1b16;font-size:15px}.checkout{width:100%;height:56px;margin-top:18px;border:0;border-radius:15px;background:#076b51;color:#fff;font-weight:800;cursor:pointer}.checkout:disabled{opacity:.6;cursor:not-allowed}@media(max-width:820px){.layout{grid-template-columns:1fr;margin-top:12px}.intro{min-height:auto;padding:30px}h1{font-size:38px}.panel{max-width:none}}@media(max-width:520px){.nav,.layout{padding-left:14px;padding-right:14px}.intro,.panel{border-radius:18px}.intro{padding:24px}h1{font-size:32px}.panel{padding:18px}}</style></head><body><nav class="nav"><a class="logo" href="/">eki</a><a class="home" href="/">Home →</a></nav><main class="layout"><section class="intro"><span class="eyebrow">Vendor subscriptions</span><h1>Upgrade your store on the web.</h1><p>Enter the same email used for your Eki vendor account. After Stripe confirms payment, your plan changes from Free to Growth or Pro automatically.</p><div class="trust">Secure website checkout. Subscription payments are not processed inside the Eki mobile app.</div></section><section class="panel"><h2>Choose your plan</h2><p class="sub">Billing starts on Stripe after you confirm checkout.</p><div id="notice" class="status"></div><form id="checkout-form"><label for="email">Vendor account email</label><input id="email" name="email" type="email" autocomplete="email" placeholder="vendor@eki.app" required/><div id="plans" class="plans"><div class="sub">Loading plans...</div></div><div id="summary" class="summary" hidden>Selected<strong></strong></div><div id="error" class="status"></div><button id="checkout-button" class="checkout" type="submit" disabled>Continue to Stripe</button></form></section></main><script>
const plansNode=document.getElementById('plans'),notice=document.getElementById('notice'),errorNode=document.getElementById('error'),summary=document.getElementById('summary'),summaryValue=summary.querySelector('strong'),emailInput=document.getElementById('email'),checkoutButton=document.getElementById('checkout-button'),form=document.getElementById('checkout-form');let plans=[],selected='GROWTH';
const params=new URLSearchParams(location.search);emailInput.value=params.get('email')||'';
if(params.get('success')==='true')show(notice,'Payment received. Open the Eki app and refresh your plan status.','ok');
else if(params.get('cancelled')==='true')show(notice,'Checkout was cancelled. You can start again when ready.','warn');
function show(node,text,type){node.textContent=text;node.className='status '+type}
function clear(node){node.textContent='';node.className='status'}
function esc(v){return String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c])}
function money(plan){return new Intl.NumberFormat('en-GB',{style:'currency',currency:plan.currency||'GBP',maximumFractionDigits:0}).format(Number(plan.monthlyPriceCents||0)/100)}
function planId(plan){const v=String(plan.plan||plan.id||'').toUpperCase();return v==='GROWTH'||v==='PRO'?v:null}
function render(){plansNode.innerHTML=plans.map(plan=>{const id=planId(plan),active=id===selected,features=[plan.maxProducts===-1?'Unlimited active products':plan.maxProducts+' active products',plan.analytics?'Analytics access':'Basic dashboard',plan.discounts?'Discount campaigns':'Standard listings',plan.prioritySupport?'Priority support':'Standard support'];return '<button type="button" class="plan '+(active?'active':'')+'" data-plan="'+id+'"><div class="plan-head"><div><div class="plan-name">'+esc(plan.name||id)+'</div><div class="fee">'+esc(((Number(plan.platformFeeBps||0)/100).toFixed(2).replace(/\\.00$/,'')+'%')+' platform fee per order')+'</div></div><span class="radio">'+(active?'✓':'')+'</span></div><div class="price">'+esc(money(plan))+' <small>/ month</small></div><ul class="features">'+features.map(item=>'<li>'+esc(item)+'</li>').join('')+'</ul></button>'}).join('');plansNode.querySelectorAll('[data-plan]').forEach(b=>b.addEventListener('click',()=>{selected=b.dataset.plan;render()}));const active=plans.find(p=>planId(p)===selected);summary.hidden=!active;if(active)summaryValue.textContent=(active.name||selected)+' - '+money(active)+'/month';checkoutButton.disabled=!active}
fetch('/api/subscriptions/plans').then(r=>r.json()).then(d=>{plans=(Array.isArray(d.plans)?d.plans:[]).filter(p=>planId(p));if(!plans.some(p=>planId(p)===selected)&&plans[0])selected=planId(plans[0]);render();if(!plans.length)show(errorNode,'No paid plans are currently available.','error')}).catch(e=>{plansNode.innerHTML='';show(errorNode,e.message||'Unable to load plans.','error')});
form.addEventListener('submit',async e=>{e.preventDefault();clear(errorNode);const email=emailInput.value.trim().toLowerCase();if(!email){show(errorNode,'Enter the email used by your Eki vendor account.','error');return}checkoutButton.disabled=true;checkoutButton.textContent='Opening secure checkout...';try{const r=await fetch('/api/subscriptions/web-checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,plan:selected})});const d=await r.json();if(!r.ok)throw new Error(d.message||'Could not start checkout.');if(!d.checkoutUrl)throw new Error('Checkout URL was not returned.');location.assign(d.checkoutUrl)}catch(err){show(errorNode,err.message||'Could not start checkout.','error');checkoutButton.disabled=false;checkoutButton.textContent='Continue to Stripe'}});
</script></body></html>`; }
