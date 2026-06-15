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

type PageSection = {
  title: string;
  body?: string[];
  bullets?: string[];
};

type PageAction = {
  href: string;
  label: string;
  variant?: "primary" | "secondary";
};

type PageDefinition = {
  title: string;
  description: string;
  eyebrow: string;
  heading: string;
  intro: string;
  actions?: PageAction[];
  sections: PageSection[];
  variant?: "home";
};

function renderSection(section: PageSection): string {
  const body = (section.body ?? [])
    .map((paragraph) => `<p>${escape(paragraph)}</p>`)
    .join("");
  const bullets = section.bullets?.length
    ? `<ul>${section.bullets.map((item) => `<li>${escape(item)}</li>`).join("")}</ul>`
    : "";

  return `
    <section class="card">
      <h2>${escape(section.title)}</h2>
      ${body}
      ${bullets}
    </section>
  `;
}

function renderLayout(page: PageDefinition): string {
  if (page.variant === "home") {
    return renderHomeLayout(page);
  }

  const actions = (page.actions ?? [])
    .map(
      (action) => `
        <a class="button ${action.variant === "secondary" ? "button-secondary" : "button-primary"}" href="${escape(action.href)}">
          ${escape(action.label)}
        </a>
      `,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#1F4D40" />
  <title>${escape(page.title)}</title>
  <meta name="description" content="${escape(page.description)}" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap" />
  <style>
    *,*::before,*::after{box-sizing:border-box}
    :root{
      --bg:#FAF7F2;
      --surface:#FFFFFF;
      --surface-soft:#F4EFE6;
      --border:#E8E0D2;
      --text:#1F1B16;
      --muted:#6B6256;
      --accent:#1F4D40;
      --accent-hover:#163A30;
    }
    html,body{margin:0;padding:0}
    body{
      background:var(--bg);
      color:var(--text);
      font-family:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      line-height:1.6;
      -webkit-font-smoothing:antialiased;
      -moz-osx-font-smoothing:grayscale;
    }
    a{color:inherit}
    .shell{max-width:1040px;margin:0 auto;padding:0 20px}
    .topbar{
      background:#FFFFFFCC;
      backdrop-filter:saturate(180%) blur(12px);
      border-bottom:1px solid var(--border);
      position:sticky;
      top:0;
      z-index:10;
    }
    .topbar-inner{
      min-height:60px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:16px;
    }
    .brand{
      display:inline-flex;
      align-items:center;
      gap:8px;
      text-decoration:none;
      color:var(--text);
      font-family:'Fraunces',Georgia,serif;
      font-weight:700;
      font-size:22px;
      letter-spacing:-0.02em;
    }
    .brand-dot{
      width:10px;
      height:10px;
      border-radius:999px;
      background:var(--accent);
      display:inline-block;
    }
    .nav{
      display:flex;
      flex-wrap:wrap;
      gap:14px;
    }
    .nav a{
      text-decoration:none;
      color:var(--muted);
      font-size:14px;
      font-weight:600;
    }
    .nav a:hover{color:var(--accent)}
    .hero{
      padding:56px 0 28px;
    }
    .eyebrow{
      display:inline-block;
      background:#E8F1ED;
      color:var(--accent);
      padding:6px 12px;
      border-radius:999px;
      font-size:12px;
      font-weight:700;
      letter-spacing:0.04em;
      text-transform:uppercase;
    }
    h1{
      font-family:'Fraunces',Georgia,serif;
      font-size:48px;
      line-height:1.08;
      letter-spacing:-0.03em;
      margin:16px 0 16px;
      max-width:12ch;
    }
    .intro{
      max-width:64ch;
      color:var(--muted);
      font-size:17px;
      margin:0;
    }
    .actions{
      display:flex;
      flex-wrap:wrap;
      gap:12px;
      margin-top:24px;
    }
    .button{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      min-height:46px;
      padding:0 18px;
      border-radius:14px;
      text-decoration:none;
      font-size:14px;
      font-weight:700;
      border:1px solid transparent;
    }
    .button-primary{
      background:var(--accent);
      color:#FFFFFF;
      transition:transform 0.2s cubic-bezier(0.34,1.56,0.64,1),box-shadow 0.2s ease,background 0.2s ease;
    }
    .button-primary:hover{
      background:var(--accent-hover);
      transform:translateY(-2px) scale(1.02);
      box-shadow:0 12px 28px rgba(31,77,64,0.2);
    }
    .button-primary:active{transform:translateY(0) scale(0.98)}
    .button-secondary{
      background:#FFFFFF;
      color:var(--text);
      border-color:var(--border);
      transition:transform 0.2s cubic-bezier(0.34,1.56,0.64,1),border-color 0.2s ease,box-shadow 0.2s ease;
    }
    .button-secondary:hover{
      border-color:var(--accent);
      transform:translateY(-1px);
      box-shadow:0 8px 20px rgba(31,27,22,0.08);
    }
    .button-secondary:active{transform:translateY(0)}
    .grid{
      display:grid;
      grid-template-columns:repeat(12,minmax(0,1fr));
      gap:18px;
      padding:18px 0 72px;
    }
    .card{
      grid-column:span 6;
      background:var(--surface);
      border:1px solid var(--border);
      border-radius:20px;
      padding:22px;
      box-shadow:0 10px 30px rgba(31,27,22,0.05);
    }
    .card h2{
      margin:0 0 12px;
      font-family:'Fraunces',Georgia,serif;
      font-size:26px;
      line-height:1.15;
      letter-spacing:-0.02em;
    }
    .card p{
      margin:0 0 12px;
      color:var(--muted);
      font-size:15px;
    }
    .card ul{
      margin:10px 0 0 18px;
      padding:0;
      color:var(--muted);
      font-size:15px;
    }
    .card li + li{
      margin-top:8px;
    }
    .foot{
      border-top:1px solid var(--border);
      background:#FFFFFF;
      padding:22px 0 36px;
      color:var(--muted);
      font-size:13px;
    }
    .foot a{
      color:var(--text);
      text-decoration:none;
      font-weight:700;
    }
    @media (max-width: 780px){
      .hero{padding-top:34px}
      h1{font-size:36px;max-width:none}
      .intro{font-size:15px}
      .card{grid-column:span 12;padding:18px}
      .topbar-inner{padding:6px 0}
      .nav{gap:12px}
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="shell topbar-inner">
      <a class="brand" href="/">
        <span class="brand-dot"></span>
        Eki
      </a>
      <nav class="nav" aria-label="Public pages">
        <a href="/help">Help</a>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
      </nav>
    </div>
  </header>

  <main class="shell">
    <section class="hero">
      <span class="eyebrow">${escape(page.eyebrow)}</span>
      <h1>${escape(page.heading)}</h1>
      <p class="intro">${escape(page.intro)}</p>
      ${actions ? `<div class="actions">${actions}</div>` : ""}
    </section>

    <section class="grid">
      ${page.sections.map(renderSection).join("")}
    </section>
  </main>

  <footer class="foot">
    <div class="shell">
      Eki public storefront and support pages. For order-specific help, email <a href="mailto:adminandy@eki.app">adminandy@eki.app</a>.
    </div>
  </footer>
</body>
</html>`;
}

function renderHomeLayout(page: PageDefinition): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#134f3b" />
  <title>${escape(page.title)}</title>
  <meta name="description" content="${escape(page.description)}" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" />
  <style>
    *,*::before,*::after{box-sizing:border-box}
    html,body{margin:0;padding:0;scroll-behavior:smooth}
    body{
      background:#fff;
      color:#111827;
      font-family:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      -webkit-font-smoothing:antialiased;
      -moz-osx-font-smoothing:grayscale;
      line-height:1.5;
    }
    a{color:inherit;text-decoration:none}
    img{display:block;max-width:100%}

    .shell{width:min(1200px,calc(100% - 48px));margin:0 auto}

    /* ─── Topbar ─── */
    .topbar{
      position:sticky;top:0;z-index:50;
      background:rgba(255,255,255,.98);
      backdrop-filter:saturate(180%) blur(16px);
      border-bottom:1px solid #e8f0eb;
    }
    .topbar-inner{
      display:flex;align-items:center;justify-content:space-between;
      min-height:64px;gap:20px;
    }
    .brand{
      display:inline-flex;align-items:center;gap:6px;
      font-weight:800;font-size:18px;color:#134f3b;
      letter-spacing:-0.02em;
    }
    .brand-dot{
      width:10px;height:10px;border-radius:999px;
      background:#4ade80;display:inline-block;
    }
    .topnav{display:flex;align-items:center;gap:28px}
    .topnav a{
      font-size:14px;font-weight:600;color:#374151;
      transition:color .15s ease;
    }
    .topnav a:hover{color:#134f3b}
    .topnav .nav-cta{
      display:inline-flex;align-items:center;justify-content:center;
      min-height:40px;padding:0 20px;border-radius:10px;
      background:#134f3b;color:#fff;font-weight:700;font-size:14px;
      transition:transform .2s cubic-bezier(.34,1.56,.64,1),box-shadow .2s ease,background .2s ease;
    }
    .topnav .nav-cta:hover{
      background:#0f4030;
      transform:translateY(-1px);
      box-shadow:0 8px 20px rgba(19,79,59,.2);
    }

    /* ─── Hero ─── */
    .hero-wrap{
      background:linear-gradient(135deg,#134f3b 0%,#1a6b4f 50%,#134f3b 100%);
      color:#fff;overflow:hidden;
    }
    .hero{
      display:grid;
      grid-template-columns:minmax(0,1fr) minmax(360px,500px);
      align-items:center;
      gap:32px;
      padding:64px 0 40px;
      min-height:auto;
    }
    .hero-copy{max-width:540px}
    .hero-badge{
      display:inline-flex;align-items:center;gap:6px;
      padding:6px 16px;border-radius:999px;
      background:rgba(255,255,255,.12);
      color:rgba(255,255,255,.9);
      font-size:12px;font-weight:700;
      letter-spacing:0.04em;text-transform:uppercase;
      margin-bottom:24px;
      border:1px solid rgba(255,255,255,.15);
    }
    .hero-badge-dot{
      width:6px;height:6px;border-radius:999px;
      background:#4ade80;display:inline-block;
    }
    h1{
      margin:0;font-size:clamp(30px,4vw,48px);
      line-height:1.08;letter-spacing:-0.04em;font-weight:800;
    }
    .hero-intro{
      margin:18px 0 0;max-width:440px;
      color:rgba(255,255,255,.82);
      font-size:16px;line-height:1.6;
    }
    .hero-actions{
      display:flex;gap:14px;margin-top:28px;flex-wrap:wrap;
    }
    .btn-app{
      display:inline-flex;flex-direction:column;justify-content:center;
      min-width:160px;height:54px;padding:0 20px;border-radius:12px;
      background:#fff;color:#134f3b;text-decoration:none;
      box-shadow:0 16px 36px rgba(0,0,0,.12);
      transition:transform .25s cubic-bezier(.34,1.56,.64,1),box-shadow .25s ease;
    }
    .btn-app:hover{
      transform:translateY(-3px) scale(1.03);
      box-shadow:0 22px 44px rgba(0,0,0,.18);
    }
    .btn-app:active{transform:translateY(0) scale(.98)}
    .btn-app.google{
      background:#2b7a4b;color:#fff;
      transition:transform .25s cubic-bezier(.34,1.56,.64,1),box-shadow .25s ease,background .25s ease;
    }
    .btn-app.google:hover{background:#33995c;transform:translateY(-3px) scale(1.03);box-shadow:0 22px 44px rgba(0,0,0,.18)}
    .btn-small{font-size:10px;font-weight:600;opacity:.7}
    .btn-main{font-size:15px;font-weight:800;margin-top:2px}
    .hero-trust{
      margin-top:18px;
      font-size:13px;color:rgba(255,255,255,.6);
    }

    /* ─── Phone + Floating Cards ─── */
    .hero-showcase{
      position:relative;
      display:grid;
      grid-template-columns:1fr auto 1fr;
      gap:12px;
      align-items:center;
      justify-items:center;
      padding:36px 0 24px;
      min-height:420px;
    }
    .showcase-cards{
      display:flex;
      flex-direction:column;
      gap:14px;
      width:100%;
      max-width:180px;
    }
    .showcase-cards.right{
      align-items:flex-end;
    }
    .float-card{
      display:flex;
      align-items:center;
      gap:10px;
      padding:12px 14px;
      border-radius:14px;
      background:#fff;
      box-shadow:0 8px 28px rgba(0,0,0,.1);
      border:1px solid rgba(255,255,255,.6);
      transition:transform .25s ease,box-shadow .25s ease;
      width:100%;
    }
    .float-card:hover{
      transform:translateY(-3px) scale(1.03);
      box-shadow:0 14px 36px rgba(0,0,0,.15);
    }
    .float-card-icon{
      width:40px;height:40px;border-radius:10px;
      display:flex;align-items:center;justify-content:center;
      font-size:18px;flex-shrink:0;
    }
    .float-card-icon.c1{background:#fef3c7}
    .float-card-icon.c2{background:#fce7f3}
    .float-card-icon.c3{background:#d1fae5}
    .float-card-icon.c4{background:#dbeafe}
    .float-card-icon.c5{background:#ede9fe}
    .float-card-icon.c6{background:#ffedd5}
    .float-card-text h4{margin:0;font-size:12px;font-weight:800;color:#111;line-height:1.2}
    .float-card-text p{margin:1px 0 0;font-size:10px;color:#6b7280;line-height:1.2}

    /* ─── Features ─── */
    .features-band{
      padding:80px 0 64px;
      background:#fff;
    }
    .features-header{
      text-align:center;margin-bottom:48px;
    }
    .features-header h2{
      margin:0;
      font-size:clamp(26px,4vw,36px);
      font-weight:800;letter-spacing:-.03em;
      line-height:1.15;
      color:#111;
    }
    .features-header p{
      margin:12px 0 0;color:#6b7280;font-size:16px;max-width:520px;
      margin-left:auto;margin-right:auto;
    }
    .features-grid{
      display:grid;
      grid-template-columns:repeat(4,minmax(0,1fr));
      gap:20px;
    }
    .feature-card{
      background:#fff;
      border:1px solid #e5e7eb;
      border-radius:16px;
      padding:28px 24px;
      transition:transform .2s ease,box-shadow .2s ease,border-color .2s ease;
    }
    .feature-card:hover{
      transform:translateY(-3px);
      box-shadow:0 14px 32px rgba(19,79,59,.08);
      border-color:#b8d4c3;
    }
    .feature-icon{
      width:48px;height:48px;border-radius:12px;
      background:#eef8f2;color:#134f3b;
      display:flex;align-items:center;justify-content:center;
      font-size:22px;margin-bottom:16px;
    }
    .feature-card h3{
      margin:0 0 8px;font-size:16px;font-weight:800;letter-spacing:-.02em;
      color:#111;
    }
    .feature-card p{
      margin:0;color:#6b7280;font-size:14px;line-height:1.55;
    }

    /* ─── Footer ─── */
    .footer{
      background:#0d2a20;color:rgba(255,255,255,.72);
      padding:48px 0 32px;
    }
    .footer-grid{
      display:grid;
      grid-template-columns:minmax(0,1.2fr) repeat(3,minmax(0,1fr));
      gap:32px;
      padding-bottom:32px;
      border-bottom:1px solid rgba(255,255,255,.08);
    }
    .footer-brand{
      display:inline-flex;align-items:center;gap:8px;margin-bottom:12px;
      font-weight:800;font-size:16px;color:#fff;
      letter-spacing:-.03em;
    }
    .footer-brand .brand-dot{
      width:10px;height:10px;border-radius:999px;
      background:#4ade80;display:inline-block;
    }
    .footer p{font-size:13px;line-height:1.55;margin:0;color:rgba(255,255,255,.6)}
    .footer h4{
      margin:0 0 12px;font-size:11px;font-weight:700;
      color:#fff;text-transform:uppercase;letter-spacing:.06em;
    }
    .footer-links{display:flex;flex-direction:column;gap:8px}
    .footer-links a{
      font-size:13px;color:rgba(255,255,255,.6);
      transition:color .15s ease;
    }
    .footer-links a:hover{color:#fff}
    .footer-bottom{
      padding-top:24px;
      display:flex;justify-content:space-between;align-items:center;
      flex-wrap:wrap;gap:12px;font-size:12px;
    }
    .footer-bottom a{color:rgba(255,255,255,.6);transition:color .15s ease}
    .footer-bottom a:hover{color:#fff}

    /* ─── Phone Mockup ─── */
    .phone-mockup{
      width:260px;
      background:#1a1a1a;
      border-radius:32px;
      padding:8px;
      box-shadow:0 40px 80px rgba(0,0,0,.35),0 0 0 2px rgba(255,255,255,.08);
      position:relative;z-index:2;
    }
    .phone-notch{
      position:absolute;top:8px;left:50%;transform:translateX(-50%);
      width:90px;height:22px;background:#1a1a1a;border-radius:0 0 14px 14px;z-index:2;
    }
    .phone-screen{
      background:#f8f9f7;
      border-radius:24px;
      overflow:hidden;
      min-height:460px;
      position:relative;
    }
    .phone-header{
      background:#134f3b;
      color:#fff;
      padding:30px 14px 14px;
      display:flex;justify-content:space-between;align-items:center;
    }
    .phone-header-title{font-weight:700;font-size:13px}
    .phone-header-icons{display:flex;gap:8px;font-size:13px}
    .phone-search{
      padding:10px 14px;
      display:flex;gap:8px;align-items:center;
    }
    .phone-search-box{
      flex:1;background:#fff;border-radius:8px;padding:6px 10px;
      display:flex;align-items:center;gap:6px;
      font-size:10px;color:#999;
      box-shadow:0 1px 3px rgba(0,0,0,.06);
    }
    .phone-categories{
      display:flex;gap:6px;padding:0 14px 10px;
      overflow-x:auto;
    }
    .phone-cat{
      padding:5px 12px;border-radius:20px;
      font-size:10px;font-weight:600;white-space:nowrap;
    }
    .phone-cat.active{background:#134f3b;color:#fff}
    .phone-cat:not(.active){background:#fff;color:#555;border:1px solid #e5e7eb}
    .phone-section{padding:0 14px 10px}
    .phone-section-title{font-size:12px;font-weight:700;color:#111;margin-bottom:8px}
    .phone-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .phone-card{
      border-radius:12px;padding:10px;
      position:relative;min-height:90px;
      display:flex;flex-direction:column;justify-content:space-between;
    }
    .phone-card-img{
      width:36px;height:36px;border-radius:8px;
      display:flex;align-items:center;justify-content:center;
      font-size:18px;
    }
    .phone-card-tag{
      position:absolute;top:8px;right:8px;
      font-size:8px;font-weight:700;padding:2px 6px;border-radius:4px;
    }
    .phone-card-name{font-size:11px;font-weight:700;color:#111;margin-top:4px}
    .phone-card-price{font-size:10px;font-weight:600;color:#555}
    .phone-card-yellow{background:#fef3c7}
    .phone-card-yellow .phone-card-img{background:#fde68a}
    .phone-card-yellow .phone-card-tag{background:#f59e0b;color:#fff}
    .phone-card-pink{background:#fce7f3}
    .phone-card-pink .phone-card-img{background:#fbcfe8}
    .phone-card-pink .phone-card-tag{background:#ec4899;color:#fff}
    .phone-card-green{background:#d1fae5}
    .phone-card-green .phone-card-img{background:#a7f3d0}
    .phone-card-green .phone-card-tag{background:#10b981;color:#fff}
    .phone-card-blue{background:#dbeafe}
    .phone-card-blue .phone-card-img{background:#bfdbfe}
    .phone-card-blue .phone-card-tag{background:#3b82f6;color:#fff}
    .phone-card-purple{background:#ede9fe}
    .phone-card-purple .phone-card-img{background:#ddd6fe}
    .phone-card-purple .phone-card-tag{background:#8b5cf6;color:#fff}
    .phone-card-orange{background:#ffedd5}
    .phone-card-orange .phone-card-img{background:#fed7aa}
    .phone-card-orange .phone-card-tag{background:#f97316;color:#fff}
    .phone-bottom-nav{
      position:absolute;bottom:0;left:0;right:0;
      background:#fff;border-top:1px solid #e5e7eb;
      display:flex;justify-content:space-around;padding:8px 0;
    }
    .phone-nav-item{
      display:flex;flex-direction:column;align-items:center;gap:1px;
      font-size:8px;color:#999;
    }
    .phone-nav-item.active{color:#134f3b}
    .phone-nav-icon{font-size:14px}
    .phone-fab{
      position:absolute;bottom:52px;right:14px;
      width:38px;height:38px;border-radius:50%;
      background:#134f3b;color:#fff;
      display:flex;align-items:center;justify-content:center;
      font-size:18px;box-shadow:0 4px 12px rgba(19,79,59,.3);
    }

    /* ─── Sticky bottom bar ─── */
    .sticky-bar{
      position:sticky;bottom:0;z-index:40;
      background:rgba(255,255,255,.98);
      backdrop-filter:saturate(180%) blur(16px);
      border-top:1px solid #e8f0eb;
    }
    .sticky-bar-inner{
      display:flex;align-items:center;justify-content:center;gap:20px;
      padding:14px 0;min-height:56px;
    }
    .sticky-bar a{
      display:inline-flex;align-items:center;gap:8px;
      font-size:14px;font-weight:700;color:#134f3b;text-decoration:none;
      padding:10px 22px;border-radius:10px;
      background:#f0f9f4;
      transition:background .15s ease,transform .15s ease;
    }
    .sticky-bar a:hover{background:#d4eddf;transform:translateY(-1px)}
    .sticky-bar .sticky-icon{font-size:18px}

    /* ─── Responsive ─── */
    @media (max-width:1020px){
      .hero{grid-template-columns:1fr;gap:24px;padding:36px 0 0}
      .hero-showcase{min-height:auto;padding:24px 0 0;display:flex;flex-direction:column}
      .showcase-cards{display:none}
      .phone-mockup{margin:0 auto}
      h1{font-size:34px}
      .features-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
      .footer-grid{grid-template-columns:1fr 1fr;gap:24px}
    }
    @media (max-width:600px){
      .shell{width:min(100% - 24px,1200px)}
      .topnav{gap:16px}
      .topnav a:not(.nav-cta):not(.always-visible){display:none}
      .hero{padding:32px 0 40px}
      h1{font-size:30px}
      .hero-intro{font-size:15px;line-height:1.5}
      .hero-actions{gap:10px}
      .btn-app{min-width:0;flex:1;height:50px}
      .features-grid{grid-template-columns:1fr}
      .features-header h2{font-size:26px}
      .footer-grid{grid-template-columns:1fr}
      .footer-bottom{flex-direction:column;text-align:center}
    }
  </style>
</head>
<body>

<!-- ─── TOPBAR ─── -->
<header class="topbar">
  <div class="shell topbar-inner">
    <a class="brand" href="/">
      <span class="brand-dot"></span>eki.
    </a>
    <nav class="topnav" aria-label="Main">
      <a href="/store">Buyers</a>
      <a href="/store">Vendors</a>
      <a href="/vendor" class="always-visible">Vendor Portal</a>
      <a class="nav-cta" href="/store">Get Started</a>
    </nav>
  </div>
</header>

<!-- ─── HERO ─── -->
<main>
  <section class="hero-wrap">
    <div class="shell hero">
      <div class="hero-copy">
        <div class="hero-badge">
          <span class="hero-badge-dot"></span> Now live in the UK
        </div>
        <h1>Your favourite foodstuff vendors. One trusted app.</h1>
        <p class="hero-intro">All in one place for Africans, Caribbeans, and people who love authentic foodstuff. Buy, sell, and receive your favourites in one app.</p>
        <div class="hero-actions">
          <a class="btn-app" href="https://apps.apple.com/app/id" aria-label="Download Eki on the App Store">
            <span class="btn-small">Download on the</span>
            <span class="btn-main">App Store</span>
          </a>
          <a class="btn-app google" href="https://play.google.com/store/apps/details?id=com.ekiapp.mobile" aria-label="Get Eki on Google Play">
            <span class="btn-small">Get it on</span>
            <span class="btn-main">Google Play</span>
          </a>
        </div>
        <div class="hero-trust">
          Free app. No spam. No fees. Just great foodstuff and more. Get started today.
        </div>
      </div>
      <div class="hero-showcase" aria-label="Eki app preview">
        <!-- Left column - 3 floating cards -->
        <div class="showcase-cards">
          <div class="float-card">
            <div class="float-card-icon c1">🛢️</div>
            <div class="float-card-text">
              <h4>Palm Oil</h4>
              <p>Popular · £8.50</p>
            </div>
          </div>
          <div class="float-card">
            <div class="float-card-icon c3">🥬</div>
            <div class="float-card-text">
              <h4>Bitter Leaf</h4>
              <p>Fresh · £3.50</p>
            </div>
          </div>
          <div class="float-card">
            <div class="float-card-icon c5">🍠</div>
            <div class="float-card-text">
              <h4>Yam Tubers</h4>
              <p>Sale · £6.99</p>
            </div>
          </div>
        </div>

        <!-- Center phone mockup -->
        <div class="phone-mockup">
          <div class="phone-notch"></div>
          <div class="phone-screen">
            <div class="phone-header">
              <span class="phone-header-title">Home</span>
              <div class="phone-header-icons">☰ 🔔</div>
            </div>
            <div class="phone-search">
              <div class="phone-search-box">🔍 Search foodstuff...</div>
              <div style="font-size:14px">⚡</div>
            </div>
            <div class="phone-categories">
              <span class="phone-cat active">All</span>
              <span class="phone-cat">Grains</span>
              <span class="phone-cat">Spices</span>
              <span class="phone-cat">Oil</span>
              <span class="phone-cat">Frozen</span>
            </div>
            <div class="phone-section">
              <div class="phone-section-title">Popular</div>
              <div class="phone-grid">
                <div class="phone-card phone-card-yellow">
                  <span class="phone-card-tag">Hot</span>
                  <div class="phone-card-img">🛢️</div>
                  <div class="phone-card-name">Palm Oil</div>
                  <div class="phone-card-price">£8.50</div>
                </div>
                <div class="phone-card phone-card-pink">
                  <span class="phone-card-tag">New</span>
                  <div class="phone-card-img">🌶️</div>
                  <div class="phone-card-name">Pepper Soup</div>
                  <div class="phone-card-price">£5.00</div>
                </div>
                <div class="phone-card phone-card-green">
                  <span class="phone-card-tag">Fresh</span>
                  <div class="phone-card-img">🥬</div>
                  <div class="phone-card-name">Bitter Leaf</div>
                  <div class="phone-card-price">£3.50</div>
                </div>
                <div class="phone-card phone-card-blue">
                  <span class="phone-card-tag">Best</span>
                  <div class="phone-card-img">🐟</div>
                  <div class="phone-card-name">Stockfish</div>
                  <div class="phone-card-price">£12.00</div>
                </div>
              </div>
            </div>
            <div class="phone-bottom-nav">
              <div class="phone-nav-item active">
                <span class="phone-nav-icon">🏠</span>
                <span>Home</span>
              </div>
              <div class="phone-nav-item">
                <span class="phone-nav-icon">🏪</span>
                <span>Store</span>
              </div>
              <div class="phone-nav-item">
                <span class="phone-nav-icon">🛒</span>
                <span>Cart</span>
              </div>
              <div class="phone-nav-item">
                <span class="phone-nav-icon">👤</span>
                <span>Profile</span>
              </div>
            </div>
            <div class="phone-fab">+</div>
          </div>
        </div>

        <!-- Right column - 3 floating cards -->
        <div class="showcase-cards right">
          <div class="float-card">
            <div class="float-card-icon c2">🌶️</div>
            <div class="float-card-text">
              <h4>Pepper Soup</h4>
              <p>New · £5.00</p>
            </div>
          </div>
          <div class="float-card">
            <div class="float-card-icon c4">🐟</div>
            <div class="float-card-text">
              <h4>Stockfish</h4>
              <p>Best · £12.00</p>
            </div>
          </div>
          <div class="float-card">
            <div class="float-card-icon c6">🥜</div>
            <div class="float-card-text">
              <h4>Groundnut</h4>
              <p>Fresh · £4.50</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- ─── FEATURES ─── -->
  <section class="features-band">
    <div class="shell">
      <div class="features-header">
        <h2>Everything Buyers need in one app.</h2>
        <p>Discover, order, track and enjoy your favourite foodstuff from trusted vendors.</p>
      </div>
      <div class="features-grid">
        <article class="feature-card">
          <div class="feature-icon">🔍</div>
          <h3>Find your favourite foodstuff</h3>
          <p>Browse verified African and Caribbean vendors. Search by product, category, or vendor name.</p>
        </article>
        <article class="feature-card">
          <div class="feature-icon">🚚</div>
          <h3>Live order tracking</h3>
          <p>Follow your order from checkout to delivery. Get real-time updates at every step.</p>
        </article>
        <article class="feature-card">
          <div class="feature-icon">🛡️</div>
          <h3>Secure checkout</h3>
          <p>Pay safely by card or wallet. Every transaction is protected and recorded on Eki.</p>
        </article>
        <article class="feature-card">
          <div class="feature-icon">🔄</div>
          <h3>One tap reorder</h3>
          <p>Save your favourites and reorder in seconds from your history. No need to search again.</p>
        </article>
      </div>
    </div>
  </section>

</main>

<!-- ─── STICKY BAR ─── -->
<div class="sticky-bar">
  <div class="shell sticky-bar-inner">
    <span>Already have an order?</span>
    <a href="/find-order"><span class="sticky-icon">🔍</span> Find your order</a>
  </div>
</div>

<!-- ─── FOOTER ─── -->
<footer class="footer">
  <div class="shell">
    <div class="footer-grid">
      <div>
        <div class="footer-brand">
          <span class="brand-dot"></span>eki.
        </div>
        <p>Your favourite foodstuff vendors, all in one trusted app. Buy, sell, and receive authentic African and Caribbean foodstuff.</p>
      </div>
      <div>
        <h4>Platform</h4>
        <div class="footer-links">
          <a href="/store">Browse vendors</a>
          <a href="/find-order">Find order</a>
          <a href="#">Features</a>
        </div>
      </div>
      <div>
        <h4>Support</h4>
        <div class="footer-links">
          <a href="/help">Help centre</a>
          <a href="mailto:adminandy@eki.app">Contact support</a>
        </div>
      </div>
      <div>
        <h4>Legal</h4>
        <div class="footer-links">
          <a href="/privacy">Privacy policy</a>
          <a href="/terms">Terms of service</a>
          <a href="/account-deletion">Account deletion</a>
        </div>
      </div>
    </div>
    <div class="footer-bottom">
      <span>© ${new Date().getFullYear()} Eki. All rights reserved.</span>
      <span>Built for your favourite foodstuff vendors.</span>
    </div>
  </div>
</footer>

</body>
</html>`;
}
function renderFindOrderLayout(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#164F3F" />
  <title>Find your order | Eki</title>
  <meta name="description" content="Find and track an Eki order with your checkout email address." />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" />
  <style>
    *,*::before,*::after{box-sizing:border-box}
    html,body{margin:0;padding:0}
    body{min-height:100vh;background:#F6F8F7;color:#111827;font-family:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
    a{color:inherit;text-decoration:none}
    .topbar{height:44px;background:#FFFFFF;border-bottom:1px solid #E5E7EB}
    .shell{width:min(1120px,calc(100% - 32px));margin:0 auto}
    .topbar .shell{height:100%;display:flex;align-items:center;justify-content:space-between;gap:18px}
    .brand{display:inline-flex;align-items:center;justify-content:center;min-width:46px;height:24px;border-radius:4px;background:#164F3F;color:#FFFFFF;font-weight:800;font-size:13px;letter-spacing:-.03em}
    .nav{display:flex;align-items:center;gap:26px;font-size:12px;color:#374151;font-weight:600}
    .signin{min-width:56px;height:24px;border-radius:4px;background:#164F3F;color:#FFFFFF;display:grid;place-items:center}
    main{padding:58px 0 72px}
    .lookup-card{width:min(100%,420px);margin:0 auto;border:1px solid #E5E7EB;border-radius:12px;background:#FFFFFF;padding:30px 32px 32px;box-shadow:0 12px 36px rgba(15,23,42,.04)}
    .badge{width:58px;height:58px;margin:0 auto 18px;border-radius:999px;background:#DCF5E4;color:#238154;display:grid;place-items:center;font-weight:800;text-transform:lowercase}
    h1{margin:0;text-align:center;font-size:22px;line-height:1.15;letter-spacing:-.04em}
    .sub{margin:8px auto 22px;max-width:280px;text-align:center;color:#6B7280;font-size:12px;line-height:1.45}
    label{display:block;font-size:11px;font-weight:700;color:#374151;margin:0 0 7px}
    input{width:100%;height:42px;border:1px solid #DCE3E0;border-radius:5px;padding:0 12px;font:inherit;font-size:13px;outline:none;background:#FFFFFF;color:#111827}
    input:focus{border-color:#164F3F;box-shadow:0 0 0 3px rgba(22,79,63,.1)}
    button{width:100%;height:38px;border:0;border-radius:5px;background:#164F3F;color:#FFFFFF;font:inherit;font-size:12px;font-weight:800;cursor:pointer;margin-top:12px}
    button:disabled{opacity:.62;cursor:not-allowed}
    .notice{margin-top:16px;border-radius:6px;border:1px solid #F2B56B;background:#FFF7E7;color:#9A4B09;padding:12px 13px;font-size:11px;line-height:1.45}
    .notice.ok{border-color:#BFE5CD;background:#F0FFF5;color:#155F3B}
    .notice.error{border-color:#F2B6B6;background:#FFF1F1;color:#9F1D1D}
    .helper{margin:22px auto 0;text-align:center;color:#87918D;font-size:11px}
    .otp-row{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-top:8px}
    .otp-row input{text-align:center;font-weight:800;font-size:16px;padding:0}
    .secondary-action{border:1px solid #DCE3E0;background:#FFFFFF;color:#164F3F;margin-top:10px}
    .results{width:min(100%,920px);margin:0 auto}
    .result-head{background:#164F3F;color:#FFFFFF;padding:20px 0;margin:-58px calc((100vw - min(1120px,calc(100vw - 32px))) / -2) 24px}
    .result-head .shell{display:flex;align-items:center;justify-content:center;gap:12px}
    .ok-dot{width:34px;height:34px;border-radius:999px;background:#2E8658;display:grid;place-items:center;font-weight:800}
    .result-title{font-size:18px;font-weight:800;letter-spacing:-.03em}
    .result-sub{font-size:12px;color:rgba(255,255,255,.78);margin-top:2px}
    .orders{display:grid;gap:12px}
    .order-card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:center;background:#FFFFFF;border:1px solid #E5E7EB;border-radius:9px;padding:16px}
    .order-number{font-weight:800;font-size:13px;color:#111827}
    .order-meta{margin-top:5px;color:#6B7280;font-size:12px;line-height:1.45}
    .order-total{font-weight:800;color:#164F3F;font-size:13px;text-align:right}
    .status{display:inline-flex;margin-top:8px;border-radius:999px;background:#DDF4E7;color:#17623F;padding:4px 9px;font-size:11px;font-weight:800;text-transform:capitalize}
    .track-link{display:inline-flex;align-items:center;justify-content:center;height:30px;border-radius:5px;background:#164F3F;color:#FFFFFF;padding:0 12px;font-size:11px;font-weight:800;margin-top:8px}
    .hidden{display:none!important}
    @media(max-width:620px){.nav{gap:14px}.nav a:nth-child(2){display:none}main{padding-top:36px}.lookup-card{padding:24px 20px}.order-card{grid-template-columns:1fr}.order-total{text-align:left}.result-head{margin-top:-36px}}
  </style>
</head>
<body>
  <header class="topbar">
    <div class="shell">
      <a class="brand" href="/">eki</a>
      <nav class="nav" aria-label="Main navigation">
        <a href="/store">Vendors</a>
        <a href="/help">Help</a>
      </nav>
      <a class="signin" href="/">Home</a>
    </div>
  </header>
  <main>
    <section id="lookupPanel" class="lookup-card">
      <div class="badge">seal</div>
      <h1>Find your order.</h1>
      <p class="sub">Enter the checkout email address used when the order was placed.</p>
      <form id="lookupForm">
        <label for="contact">Email address</label>
        <input id="contact" autocomplete="email" inputmode="email" type="email" placeholder="Email address used at checkout" />
        <button id="lookupButton" type="submit">Continue</button>
      </form>
      <div id="lookupMessage" class="notice">No password needed. If an order exists, we will send a one-time code to the checkout email.</div>
      <p class="helper">Orders placed as a guest still work here. Use the details entered at checkout.</p>
    </section>
    <section id="otpPanel" class="lookup-card hidden">
      <div class="badge">OTP</div>
      <h1>Enter your code.</h1>
      <p id="otpIntro" class="sub">We sent a 6-digit code to your checkout email.</p>
      <form id="otpForm">
        <label for="otp0">Verification code</label>
        <div class="otp-row" id="otpInputs">
          <input id="otp0" inputmode="numeric" maxlength="1" />
          <input inputmode="numeric" maxlength="1" />
          <input inputmode="numeric" maxlength="1" />
          <input inputmode="numeric" maxlength="1" />
          <input inputmode="numeric" maxlength="1" />
          <input inputmode="numeric" maxlength="1" />
        </div>
        <button id="verifyButton" type="submit">Verify and continue</button>
        <button class="secondary-action" id="changeContact" type="button">Use another email</button>
      </form>
      <div id="otpMessage" class="notice ok">Check your email inbox for the latest code.</div>
    </section>
    <section id="resultsPanel" class="results hidden">
      <div class="result-head">
        <div class="shell">
          <div class="ok-dot">OK</div>
          <div>
            <div class="result-title">Your order is now in Eki.</div>
            <div id="resultSubtitle" class="result-sub">Track, reorder, or open the vendor store.</div>
          </div>
        </div>
      </div>
      <div class="orders" id="ordersList"></div>
      <button class="secondary-action" id="findAnother" type="button">Find another order</button>
    </section>
  </main>
  <script>
    const lookupPanel = document.getElementById('lookupPanel');
    const otpPanel = document.getElementById('otpPanel');
    const resultsPanel = document.getElementById('resultsPanel');
    const lookupForm = document.getElementById('lookupForm');
    const otpForm = document.getElementById('otpForm');
    const contactInput = document.getElementById('contact');
    const lookupButton = document.getElementById('lookupButton');
    const verifyButton = document.getElementById('verifyButton');
    const lookupMessage = document.getElementById('lookupMessage');
    const otpMessage = document.getElementById('otpMessage');
    const otpIntro = document.getElementById('otpIntro');
    const otpInputs = Array.from(document.querySelectorAll('#otpInputs input'));
    const ordersList = document.getElementById('ordersList');
    const resultSubtitle = document.getElementById('resultSubtitle');
    let activeContact = '';
    function show(panel){lookupPanel.classList.toggle('hidden',panel!=='lookup');otpPanel.classList.toggle('hidden',panel!=='otp');resultsPanel.classList.toggle('hidden',panel!=='results')}
    function setMessage(node,text,kind){node.textContent=text;node.className='notice '+(kind||'')}
    function escapeHtml(value){return String(value||'').replace(/[&<>"']/g,function(char){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]})}
    function formatMoney(order){const amount=Number(order.total||0);const currency=order.currency||'GBP';try{return new Intl.NumberFormat('en-GB',{style:'currency',currency}).format(amount)}catch{return currency+' '+amount.toFixed(2)}}
    function codeValue(){return otpInputs.map((input)=>input.value.replace(/\\D/g,'')).join('')}
    otpInputs.forEach((input,index)=>{input.addEventListener('input',()=>{input.value=input.value.replace(/\\D/g,'').slice(0,1);if(input.value&&otpInputs[index+1])otpInputs[index+1].focus()});input.addEventListener('keydown',(event)=>{if(event.key==='Backspace'&&!input.value&&otpInputs[index-1])otpInputs[index-1].focus()})});
    lookupForm.addEventListener('submit',async(event)=>{event.preventDefault();const contact=contactInput.value.trim().toLowerCase();if(!contact||!contact.includes('@')){setMessage(lookupMessage,'Enter the email address used at checkout.','error');return}lookupButton.disabled=true;setMessage(lookupMessage,'Checking for matching orders...','ok');try{const response=await fetch('/api/public/stores/order-lookup/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:contact})});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.message||'Unable to check this order right now.');if(!data.found){setMessage(lookupMessage,data.message||'No order found for this email address.','error');return}activeContact=contact;otpInputs.forEach((input)=>{input.value=''});otpIntro.textContent='We sent a 6-digit code to '+(data.emailHint||'your checkout email')+'.';setMessage(otpMessage,'Check your email inbox for the latest code.','ok');show('otp');otpInputs[0].focus()}catch(error){setMessage(lookupMessage,error.message||'Unable to check this order right now.','error')}finally{lookupButton.disabled=false}});
    otpForm.addEventListener('submit',async(event)=>{event.preventDefault();const code=codeValue();if(code.length!==6){setMessage(otpMessage,'Enter the full 6-digit code from your email.','error');return}verifyButton.disabled=true;setMessage(otpMessage,'Verifying your code...','ok');try{const response=await fetch('/api/public/stores/order-lookup/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:activeContact,code})});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.message||'Invalid or expired code.');const orders=Array.isArray(data.orders)?data.orders:[];renderOrders(orders);resultSubtitle.textContent=orders.length+' order'+(orders.length===1?'':'s')+' found for your checkout email.';show('results')}catch(error){setMessage(otpMessage,error.message||'Invalid or expired code.','error')}finally{verifyButton.disabled=false}});
    function renderOrders(orders){if(!orders.length){ordersList.innerHTML='<article class="order-card"><div><div class="order-number">No active order found</div><div class="order-meta">Please contact support if you believe this is a mistake.</div></div></article>';return}ordersList.innerHTML=orders.map((order)=>{const items=Array.isArray(order.items)?order.items.map((item)=>escapeHtml(item.name)+' x'+Number(item.quantity||0)).join(', '):'';const storeUrl='/store/'+encodeURIComponent(order.vendorSlug||'');return '<article class="order-card"><div><div class="order-number">'+escapeHtml(order.orderNumber||order.id)+'</div><div class="order-meta">'+escapeHtml(order.vendorName||'Vendor')+'<br />'+escapeHtml(items||'Order items')+'</div><span class="status">'+escapeHtml(order.status||'placed').replace(/_/g,' ')+'</span><br /><a class="track-link" href="'+storeUrl+'">Open vendor store</a></div><div class="order-total">'+escapeHtml(formatMoney(order))+'</div></article>'}).join('')}
    document.getElementById('changeContact').addEventListener('click',()=>show('lookup'));
    document.getElementById('findAnother').addEventListener('click',()=>show('lookup'));
  </script>
</body>
</html>`;
}

const homePage: PageDefinition = {
  title: "Eki",
  description: "Eki helps buyers keep favorite African foodstuff vendors close, track orders, and reorder quickly.",
  eyebrow: "Eki",
  heading: "Never lose your vendors again.",
  intro:
    "The Eki app puts your favourite African foodstuff vendors right in your pocket. Track orders live, confirm deliveries with a tap, and reorder in seconds.",
  actions: [
    { href: "/store/mama-chi-foodstuff", label: "Open live store example" },
    { href: "/help", label: "Help and support", variant: "secondary" },
  ],
  variant: "home",
  sections: [
    {
      title: "What Eki handles",
      bullets: [
        "Vendor storefront pages shared by direct link",
        "Secure checkout through connected payment providers",
        "Order tracking, guest order lookup, and buyer notifications",
        "Escrow-style order states, disputes, and refund handling",
      ],
    },
    {
      title: "For buyers",
      body: [
        "You can browse vendor products, add items to cart, pay securely, and track eligible orders after checkout.",
        "If you checked out as a guest, the order lookup flow uses your checkout email address and a one-time code.",
      ],
    },
    {
      title: "For vendors",
      body: [
        "Vendors manage products, storefront links, orders, payouts, messaging, and analytics from the app.",
        "Shared store links point to public storefront pages that can be opened without installing the app first.",
      ],
    },
    {
      title: "Support links",
      bullets: [
        "Help: /help",
        "Privacy: /privacy",
        "Terms: /terms",
        "Email: adminandy@eki.app",
      ],
    },
  ],
};

const helpPage: PageDefinition = {
  title: "Help and support | Eki",
  description: "Public support and order-help information for Eki buyers and vendors.",
  eyebrow: "Support",
  heading: "Get help with orders, payouts, OTP, and disputes.",
  intro:
    "For support, contact adminandy@eki.app. The support team aims to respond within 24 hours, and order-specific issues may require the order number or checkout email used during purchase.",
  actions: [
    { href: "mailto:adminandy@eki.app", label: "Email support" },
    { href: "/terms", label: "Read terms", variant: "secondary" },
  ],
  sections: [
    {
      title: "Response times",
      bullets: [
        "First support response target: within 24 hours",
        "Refund requests are reviewed within 24 hours",
        "Approved refunds are processed within 3 business days",
        "Complex disputes may require admin review before resolution",
      ],
    },
    {
      title: "Order help",
      bullets: [
        "If payment succeeded but your order is still pending, the system may still be waiting on webhook confirmation.",
        "Guest buyers can use the public order lookup flow with their checkout email and one-time code.",
        "If an escrow order was shipped and something is wrong, open a dispute before funds are released.",
      ],
    },
    {
      title: "OTP and account access",
      bullets: [
        "If you do not receive an OTP email, check your spam folder first.",
        "Repeated failed login attempts may temporarily lock the account for security.",
        "For buyer account recovery, contact support from the email used to place the order or register the account.",
      ],
    },
    {
      title: "Vendor support",
      bullets: [
        "Vendors can manage products, public store links, payouts, notifications, and buyer messages in the app.",
        "Payout availability depends on order status, escrow rules, and any active dispute or refund review.",
      ],
    },
  ],
};

const privacyPage: PageDefinition = {
  title: "Privacy policy | Eki",
  description: "How Eki handles account, order, payment, support, and operational data.",
  eyebrow: "Privacy",
  heading: "How Eki handles your data.",
  intro:
    "This page summarizes the operational privacy posture of Eki based on the current product and backend implementation. It explains what data we process, why we process it, and the user controls currently available in the product.",
  actions: [
    { href: "mailto:adminandy@eki.app", label: "Privacy questions" },
    { href: "/help", label: "Support", variant: "secondary" },
  ],
  sections: [
    {
      title: "Data we process",
      bullets: [
        "Account details such as name, email address, phone number, role, and authentication state",
        "Order and delivery details such as products ordered, totals, delivery address, and order status",
        "Payment-related metadata needed to verify and reconcile transactions through Stripe or Paystack",
        "Vendor storefront content such as product listings, descriptions, pricing, and uploaded images",
        "Operational records such as notifications, audit logs, and support messages",
      ],
    },
    {
      title: "Why we process it",
      bullets: [
        "To authenticate users and secure access to buyer, vendor, and admin functions",
        "To process orders, order tracking, escrow states, disputes, refunds, and payouts",
        "To detect abuse, enforce security controls, and investigate platform incidents",
        "To deliver transactional emails, OTP codes, notifications, and operational support",
      ],
    },
    {
      title: "Infrastructure and subprocessors",
      bullets: [
        "Vercel for hosting and server execution",
        "Neon for PostgreSQL database storage",
        "Stripe for international payments",
        "Paystack for supported domestic payments and payout rails",
        "Cloudflare R2 for file storage",
        "Sentry for error monitoring",
        "Resend for transactional email delivery",
      ],
    },
    {
      title: "Your controls",
      bullets: [
        "Authenticated users can export account data through the data-export endpoint",
        "Authenticated users can request account deletion, with financial records retained where legally required",
        "Order and payment records may be retained for compliance, fraud prevention, and accounting obligations",
        "For privacy requests or correction requests, contact adminandy@eki.app",
      ],
    },
  ],
};

const termsPage: PageDefinition = {
  title: "Terms of service | Eki",
  description: "Platform rules for buyers, vendors, payments, disputes, and support on Eki.",
  eyebrow: "Terms",
  heading: "Platform rules for buyers and vendors.",
  intro:
    "These terms summarize how Eki operates as a marketplace platform for vendor storefronts, secure checkout, order tracking, escrow-sensitive flows, and support. By using the platform, buyers and vendors agree to follow these platform rules.",
  actions: [
    { href: "/privacy", label: "Read privacy policy", variant: "secondary" },
    { href: "mailto:adminandy@eki.app", label: "Contact support" },
  ],
  sections: [
    {
      title: "Marketplace role",
      bullets: [
        "Eki provides the software platform, storefront links, checkout flows, messaging, notifications, and support tooling used by buyers and vendors.",
        "Product availability, pricing, fulfillment timing, and listing accuracy remain the vendor's responsibility.",
      ],
    },
    {
      title: "Buyer rules",
      bullets: [
        "Buyers must provide accurate delivery and contact details at checkout.",
        "A guest order lookup requires access to the checkout email address used when the order was placed.",
        "If an OTP-confirmed escrow delivery is completed, the transaction may become final under the platform's escrow rules.",
      ],
    },
    {
      title: "Vendor rules",
      bullets: [
        "Vendors must publish accurate product information, pricing, and stock availability.",
        "Vendors must ship and manage orders through the platform in line with delivery, escrow, and dispute states.",
        "Eki may suspend storefronts or accounts for fraud, prohibited listings, abuse, or repeated operational failures.",
      ],
    },
    {
      title: "Payments, refunds, and disputes",
      bullets: [
        "Payments are processed by connected payment providers such as Stripe and Paystack.",
        "Refund requests are reviewed within 24 hours, and approved refunds are processed within 3 business days.",
        "Disputes may freeze order funds until review is complete.",
        "Partial refunds may require additional admin approval.",
      ],
    },
    {
      title: "Support and policy changes",
      bullets: [
        "Support is available at adminandy@eki.app.",
        "Operational policies may change as the platform matures, including payout, support, and fraud-prevention controls.",
        "If you do not agree with a platform change, stop using the service and contact support for account assistance.",
      ],
    },
  ],
};

const accountDeletionPage: PageDefinition = {
  title: "Account deletion | Eki",
  description: "How to delete an Eki account and what data may be retained.",
  eyebrow: "Data deletion",
  heading: "Delete your Eki account.",
  intro:
    "Signed-in users can request account deletion inside the Eki app. If you cannot access the app, contact support from the email address on your account.",
  actions: [
    { href: "mailto:adminandy@eki.app", label: "Email support" },
    { href: "/privacy", label: "Privacy policy", variant: "secondary" },
  ],
  sections: [
    {
      title: "In-app deletion",
      bullets: [
        "Open Eki and sign in to the buyer or vendor account you want to delete.",
        "Go to Profile or Settings, then open Delete Account.",
        "Review the deletion information and confirm the request.",
      ],
    },
    {
      title: "What is deleted",
      bullets: [
        "Account access is removed after the backend accepts the deletion request.",
        "Profile data that can legally be erased is deleted or anonymized.",
        "Uploaded images owned by the account may be removed where they are no longer required for an active order or compliance record.",
      ],
    },
    {
      title: "What may be retained",
      bullets: [
        "Order, payment, payout, tax, fraud-prevention, and dispute records may be retained where required by law or platform safety obligations.",
        "Active orders, unresolved disputes, or payout obligations can block deletion until they are resolved.",
      ],
    },
    {
      title: "Manual request",
      body: [
        "If you cannot access your account, email adminandy@eki.app from the registered email address and include the account role, buyer or vendor.",
      ],
    },
  ],
};

function renderReferralInviteLayout(code: string): string {
  const safeCode = escape(code.trim().toUpperCase());
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Join Eki | Referral invite</title>
  <meta name="description" content="Join Eki using a referral invite." />
  <style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f8f7;color:#111827;font-family:Inter,Arial,sans-serif}
    .card{width:min(92vw,460px);background:#fff;border:1px solid #dde7e2;border-radius:24px;padding:30px;box-shadow:0 20px 50px rgba(10,43,33,.08);text-align:center}
    .logo{display:inline-grid;place-items:center;width:52px;height:52px;border-radius:14px;background:#076b51;color:#fff;font-weight:800;margin-bottom:18px}
    h1{margin:0;font-size:30px;letter-spacing:-.04em}.code{margin:20px 0;padding:14px;border-radius:14px;background:#eff8f3;color:#076b51;font-weight:800;letter-spacing:.08em}
    p{color:#5f6b66;line-height:1.55}.actions{display:grid;gap:10px;margin-top:22px}a{display:grid;place-items:center;height:50px;border-radius:14px;text-decoration:none;font-weight:800}
    .primary{background:#076b51;color:#fff}.secondary{border:1px solid #cfe1da;color:#076b51;background:#fff}
  </style>
</head>
<body>
  <main class="card">
    <div class="logo">eki</div>
    <h1>You were invited to Eki.</h1>
    <p>Use this referral code when creating your buyer account. Rewards are credited after the invited buyer completes a first paid order.</p>
    <div class="code">${safeCode || "REFERRAL"}</div>
    <div class="actions">
      <a class="primary" href="/">Open Eki website</a>
      <a class="secondary" href="/help">Need help?</a>
    </div>
  </main>
</body>
</html>`;
}

function renderVendorSubscriptionLayout(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Vendor subscriptions | Eki</title>
  <meta name="description" content="Choose and pay for an Eki vendor subscription on the web." />
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#f7faf8;color:#0d1b16;font-family:Arial,sans-serif}
    button,input{font:inherit}
    a{color:inherit;text-decoration:none}
    .nav{height:64px;padding:0 24px;display:flex;align-items:center;justify-content:space-between;max-width:1180px;margin:auto}
    .logo{background:#076b51;color:#fff;border-radius:7px;padding:8px 18px;font-weight:800}
    .home{font-size:14px;font-weight:700;color:#076b51}
    .layout{max-width:1180px;margin:32px auto 56px;padding:0 24px;display:grid;grid-template-columns:minmax(0,1fr) 430px;gap:28px}
    .intro{min-height:560px;padding:42px;border-radius:24px;background:#0d1b16;color:#fff;display:flex;flex-direction:column;justify-content:center}
    .eyebrow{color:#9be0bc;font-size:13px;font-weight:700}
    h1{margin:14px 0 0;font-size:48px;line-height:1.08;max-width:560px}
    .intro p{margin:18px 0 0;color:rgba(255,255,255,.78);font-size:17px;line-height:1.55;max-width:600px}
    .trust{margin-top:28px;padding:14px;border:1px solid rgba(255,255,255,.16);border-radius:14px;background:rgba(255,255,255,.08);font-size:14px;color:rgba(255,255,255,.82)}
    .panel{padding:24px;border:1px solid #dde7e2;border-radius:24px;background:#fff;box-shadow:0 14px 32px rgba(10,43,33,.08)}
    h2{margin:0;font-size:26px}.sub{margin:7px 0 20px;color:#66736d;font-size:14px;line-height:1.45}
    label{display:block;margin:18px 0 8px;font-size:13px;font-weight:700}
    input{width:100%;height:52px;padding:0 14px;border:1px solid #dde7e2;border-radius:13px;color:#0d1b16;outline:none}
    input:focus{border-color:#076b51;box-shadow:0 0 0 3px rgba(7,107,81,.1)}
    .plans{display:grid;gap:12px;margin-top:16px}.plan{width:100%;padding:16px;text-align:left;border:1px solid #dde7e2;border-radius:16px;background:#fff;cursor:pointer}
    .plan.active{border-color:#076b51;background:#f1faf5}.plan-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
    .plan-name{font-size:18px;font-weight:800}.fee{margin-top:5px;color:#66736d;font-size:12px}.price{margin-top:14px;color:#076b51;font-size:28px;font-weight:800}.price small{color:#66736d;font-size:13px;font-weight:400}
    .features{margin:12px 0 0;padding:0;list-style:none;color:#34423c;font-size:13px;line-height:1.6}.features li:before{content:"âœ“";color:#076b51;font-weight:800;margin-right:8px}
    .radio{width:23px;height:23px;border:1px solid #b7c6bf;border-radius:50%;display:grid;place-items:center;color:#fff}.active .radio{background:#076b51;border-color:#076b51}
    .status{display:none;margin:16px 0 0;padding:12px;border-radius:12px;font-size:13px;line-height:1.4}.status.ok{display:block;background:#eaf8ef;border:1px solid #cbeed9;color:#076b51}.status.warn{display:block;background:#fff7e8;border:1px solid #f2d399;color:#8d5100}.status.error{display:block;background:#fff0f0;border:1px solid #f3caca;color:#a62e2e}
    .summary{margin-top:18px;padding:14px;border-radius:13px;background:#f6f8f7;font-size:13px;color:#66736d}.summary strong{display:block;margin-top:4px;color:#0d1b16;font-size:15px}
    .checkout{width:100%;height:56px;margin-top:18px;border:0;border-radius:15px;background:#076b51;color:#fff;font-weight:800;cursor:pointer}.checkout:disabled{opacity:.6;cursor:not-allowed}
    @media(max-width:820px){.layout{grid-template-columns:1fr;margin-top:12px}.intro{min-height:auto;padding:30px}h1{font-size:38px}.panel{max-width:none}}
    @media(max-width:520px){.nav,.layout{padding-left:14px;padding-right:14px}.intro,.panel{border-radius:18px}.intro{padding:24px}h1{font-size:32px}.panel{padding:18px}}
  </style>
</head>
<body>
  <nav class="nav"><a class="logo" href="/">eki</a><a class="home" href="/">Home â†’</a></nav>
  <main class="layout">
    <section class="intro">
      <span class="eyebrow">Vendor subscriptions</span>
      <h1>Upgrade your store on the web.</h1>
      <p>Enter the same email used for your Eki vendor account. After Stripe confirms payment, your plan changes from Free to Growth or Pro automatically.</p>
      <div class="trust">Secure website checkout. Subscription payments are not processed inside the Eki mobile app.</div>
    </section>
    <section class="panel">
      <h2>Choose your plan</h2>
      <p class="sub">Billing starts on Stripe after you confirm checkout.</p>
      <div id="notice" class="status"></div>
      <form id="checkout-form">
        <label for="email">Vendor account email</label>
        <input id="email" name="email" type="email" autocomplete="email" placeholder="vendor@eki.app" required />
        <div id="plans" class="plans"><div class="sub">Loading plans...</div></div>
        <div id="summary" class="summary" hidden>Selected<strong></strong></div>
        <div id="error" class="status"></div>
        <button id="checkout-button" class="checkout" type="submit" disabled>Continue to Stripe</button>
      </form>
    </section>
  </main>
  <script>
    const plansNode=document.getElementById('plans'),notice=document.getElementById('notice'),errorNode=document.getElementById('error'),summary=document.getElementById('summary'),summaryValue=summary.querySelector('strong'),emailInput=document.getElementById('email'),checkoutButton=document.getElementById('checkout-button'),form=document.getElementById('checkout-form');
    let plans=[],selected='GROWTH';
    const params=new URLSearchParams(location.search);emailInput.value=params.get('email')||'';
    if(params.get('success')==='true')show(notice,'Payment received. Open the Eki app and refresh your plan status.','ok');
    else if(params.get('cancelled')==='true')show(notice,'Checkout was cancelled. You can start again when ready.','warn');
    function show(node,text,type){node.textContent=text;node.className='status '+type}
    function clear(node){node.textContent='';node.className='status'}
    function esc(value){return String(value||'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char])}
    function money(plan){return new Intl.NumberFormat('en-GB',{style:'currency',currency:plan.currency||'GBP',maximumFractionDigits:0}).format(Number(plan.monthlyPriceCents||0)/100)}
    function planId(plan){const value=String(plan.plan||plan.id||'').toUpperCase();return value==='GROWTH'||value==='PRO'?value:null}
    function render(){plansNode.innerHTML=plans.map(plan=>{const id=planId(plan),active=id===selected,features=[plan.maxProducts===-1?'Unlimited active products':plan.maxProducts+' active products',plan.analytics?'Analytics access':'Basic dashboard',plan.discounts?'Discount campaigns':'Standard listings',plan.prioritySupport?'Priority support':'Standard support'];return '<button type="button" class="plan '+(active?'active':'')+'" data-plan="'+id+'"><div class="plan-head"><div><div class="plan-name">'+esc(plan.name||id)+'</div><div class="fee">'+esc(((Number(plan.platformFeeBps||0)/100).toFixed(2).replace(/\\.00$/,'')+'%'))+' platform fee per order</div></div><span class="radio">'+(active?'âœ“':'')+'</span></div><div class="price">'+esc(money(plan))+' <small>/ month</small></div><ul class="features">'+features.map(item=>'<li>'+esc(item)+'</li>').join('')+'</ul></button>'}).join('');plansNode.querySelectorAll('[data-plan]').forEach(button=>button.addEventListener('click',()=>{selected=button.dataset.plan;render()}));const active=plans.find(plan=>planId(plan)===selected);summary.hidden=!active;if(active)summaryValue.textContent=(active.name||selected)+' - '+money(active)+'/month';checkoutButton.disabled=!active}
    fetch('/api/subscriptions/plans').then(response=>response.json().then(data=>({response,data}))).then(({response,data})=>{if(!response.ok)throw new Error(data.message||'Unable to load plans.');plans=(Array.isArray(data.plans)?data.plans:[]).filter(plan=>planId(plan));if(!plans.some(plan=>planId(plan)===selected)&&plans[0])selected=planId(plans[0]);render();if(!plans.length)show(errorNode,'No paid plans are currently available.','error')}).catch(error=>{plansNode.innerHTML='';show(errorNode,error.message||'Unable to load plans.','error')});
    form.addEventListener('submit',async event=>{event.preventDefault();clear(errorNode);const email=emailInput.value.trim().toLowerCase();if(!email){show(errorNode,'Enter the email used by your Eki vendor account.','error');return}checkoutButton.disabled=true;checkoutButton.textContent='Opening secure checkout...';try{const response=await fetch('/api/subscriptions/web-checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,plan:selected})});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.message||'Could not start checkout.');if(!data.checkoutUrl)throw new Error('Checkout URL was not returned.');location.assign(data.checkoutUrl)}catch(error){show(errorNode,error.message||'Could not start checkout.','error');checkoutButton.disabled=false;checkoutButton.textContent='Continue to Stripe'}});
  </script>
</body>
</html>`;
}

function sendPage(response: Response, page: PageDefinition): void {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "public, max-age=300, s-maxage=900");
  response.status(200).send(renderLayout(page));
}

export async function getPublicHomePage(_request: Request, response: Response): Promise<void> {
  sendPage(response, homePage);
}

export async function getPublicFindOrderPage(_request: Request, response: Response): Promise<void> {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "public, max-age=120, s-maxage=300");
  response.status(200).send(renderFindOrderLayout());
}

export async function getPublicHelpPage(_request: Request, response: Response): Promise<void> {
  sendPage(response, helpPage);
}

export async function getPublicPrivacyPage(_request: Request, response: Response): Promise<void> {
  sendPage(response, privacyPage);
}

export async function getPublicTermsPage(_request: Request, response: Response): Promise<void> {
  sendPage(response, termsPage);
}

export async function getPublicAccountDeletionPage(_request: Request, response: Response): Promise<void> {
  sendPage(response, accountDeletionPage);
}

export async function getPublicInvitePage(request: Request, response: Response): Promise<void> {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "public, max-age=300, s-maxage=900");
  response.status(200).send(renderReferralInviteLayout(String(request.params.code ?? "")));
}

export async function getPublicVendorSubscriptionPage(_request: Request, response: Response): Promise<void> {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "public, max-age=120, s-maxage=300");
  response.status(200).send(renderVendorSubscriptionLayout());
}function renderVendorPortalLayout(): string { return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="theme-color" content="#134f3b">
<title>Vendor Portal | Eki</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" />
<style>
*,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:0}
body{background:#f6faf6;color:#111;font-family:'Inter',sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
.shell{width:min(1200px,calc(100% - 40px));margin:0 auto}

.topbar{background:rgba(255,255,255,.98);backdrop-filter:saturate(180%) blur(16px);border-bottom:1px solid #e8f0eb;position:sticky;top:0;z-index:50}
.topbar-inner{display:flex;align-items:center;justify-content:space-between;min-height:64px;gap:20px}
.brand{display:inline-flex;align-items:center;gap:6px;font-weight:800;font-size:18px;color:#134f3b;letter-spacing:-0.02em}
.brand-dot{width:10px;height:10px;border-radius:999px;background:#4ade80;display:inline-block}
.topnav{display:flex;align-items:center;gap:20px}
.topnav a{font-size:13px;font-weight:600;color:#374151;transition:color .15s ease}
.topnav a:hover{color:#134f3b}
.topnav .logout{color:#e55353;font-size:12px;font-weight:700}
.topnav .logout:hover{color:#c03939}

.login-page{min-height:100vh;display:grid;place-items:center;padding:24px;background:linear-gradient(135deg,#134f3b 0%,#1a6b4f 50%,#134f3b 100%)}
.login-card{width:min(100%,400px);background:#fff;border-radius:20px;padding:36px 32px;box-shadow:0 24px 60px rgba(0,0,0,.2)}
.login-logo{width:48px;height:48px;border-radius:12px;background:#134f3b;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:18px;margin-bottom:20px}
.login-title{font-size:24px;font-weight:800;letter-spacing:-.03em}
.login-sub{color:#6b7280;font-size:13px;margin:6px 0 24px}
.form-group{margin-bottom:16px}
.form-group label{display:block;font-size:12px;font-weight:700;margin-bottom:5px;color:#374151}
.input{width:100%;height:46px;border:1px solid #dbe7dd;border-radius:10px;padding:0 14px;font-size:14px;outline:none;background:#fff;color:#111}
.input:focus{border-color:#134f3b;box-shadow:0 0 0 3px rgba(19,79,59,.1)}
.btn{display:inline-flex;align-items:center;justify-content:center;height:46px;padding:0 22px;border-radius:10px;font-weight:700;font-size:14px;border:0;cursor:pointer;transition:transform .15s ease,box-shadow .15s ease}
.btn-primary{width:100%;background:#134f3b;color:#fff;margin-top:6px}
.btn-primary:hover{background:#0f4030;transform:translateY(-1px);box-shadow:0 8px 20px rgba(19,79,59,.2)}
.btn:disabled{opacity:.6;cursor:not-allowed;transform:none}
.msg{display:none;padding:10px 12px;border-radius:8px;font-size:12px;margin-bottom:12px}
.msg.err{display:block;background:#fff0f0;border:1px solid #f3caca;color:#a62e2e}
.hidden{display:none!important}
.loading{text-align:center;padding:48px;color:#6b7280;font-size:13px}

.dash-layout{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:24px;padding:28px 0 48px;align-items:start}
.dash-main{display:flex;flex-direction:column;gap:20px}
.dash-side{display:flex;flex-direction:column;gap:16px}

.greeting{margin:0;font-size:22px;font-weight:800;letter-spacing:-.03em;color:#111}
.greeting-store{font-size:13px;color:#6b7280;margin-top:2px}

.alerts-row{display:flex;gap:10px;flex-wrap:wrap}
.alert-chip{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:999px;font-size:12px;font-weight:700;transition:transform .15s ease}
.alert-chip.order{background:#eef8f2;color:#134f3b}
.alert-chip.low_stock{background:#fef3c7;color:#92400e}
.alert-chip.message{background:#dbeafe;color:#1e40af}
.alert-chip.payout{background:#f3e8ff;color:#6d28d9}
.alert-chip:hover{transform:scale(1.04)}
.alert-chip .count{margin-left:4px;min-width:18px;height:18px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;background:rgba(0,0,0,.08);padding:0 5px}

.stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.stat-card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:18px}
.stat-label{font-size:11px;color:#6b7280;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.stat-value{font-size:22px;font-weight:800;margin-top:6px;color:#111}
.stat-sub{font-size:11px;color:#6b7280;margin-top:2px}

.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden}
.card-header{display:flex;justify-content:space-between;align-items:center;padding:18px 20px 0}
.card-header h3{margin:0;font-size:13px;font-weight:800;letter-spacing:-.02em}
.card-header a{font-size:11px;color:#134f3b;font-weight:700}
.card-body{padding:18px 20px}

.insight-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.insight-item{border:1px solid #e5e7eb;border-radius:10px;padding:14px;background:#fafbfa}
.insight-item .icon{font-size:18px;margin-bottom:6px}
.insight-item h4{margin:0 0 2px;font-size:12px;font-weight:800;color:#111}
.insight-item p{margin:0;font-size:11px;color:#6b7280;line-height:1.4}
.insight-item .action{display:inline-block;margin-top:8px;font-size:11px;font-weight:700;color:#134f3b;padding:4px 10px;border-radius:6px;background:#eef8f2}

.funnel-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.funnel-step{text-align:center;padding:14px 10px}
.funnel-num{font-size:20px;font-weight:800;color:#111}
.funnel-label{font-size:11px;color:#6b7280;margin-top:3px}
.funnel-bar{height:4px;margin-top:6px;border-radius:2px;background:#e5e7eb;overflow:hidden}
.funnel-bar-fill{height:100%;border-radius:2px;background:#134f3b}

.products-table{width:100%;border-collapse:collapse;font-size:12px}
.products-table th{padding:8px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280;border-bottom:1px solid #e5e7eb;letter-spacing:.04em}
.products-table td{padding:10px 12px;border-bottom:1px solid #ecf1ed;color:#374151}
.products-table tr:last-child td{border-bottom:0}
.products-table .prod-name{font-weight:700;color:#111}
.products-table .prod-revenue{font-weight:700;color:#111;text-align:right}

.phone-preview{background:#1a1a1a;border-radius:28px;padding:7px;box-shadow:0 20px 50px rgba(0,0,0,.12)}
.phone-screen{background:#f8f9f7;border-radius:21px;overflow:hidden}
.phone-header{background:#134f3b;color:#fff;padding:24px 12px 10px;display:flex;justify-content:space-between;align-items:center}
.phone-hl{font-weight:700;font-size:11px}
.phone-hr{font-size:11px}
.phone-body{padding:10px}
.phone-metric{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee;font-size:10px}
.phone-metric:last-child{border-bottom:0}
.phone-lbl{color:#999}.phone-val{font-weight:700;color:#111}
.phone-store-name{font-weight:800;font-size:12px;margin-bottom:8px;color:#111}
.phone-orders-item{font-size:10px;padding:6px 0;border-bottom:1px solid #f0f0f0;display:flex;justify-content:space-between}
.phone-orders-item:last-child{border-bottom:0}
.phone-side-label{color:#6b7280}
.phone-side-val{font-weight:700;color:#111}
.phone-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:8px;font-weight:700}
.phone-badge.green{background:#d1fae5;color:#065f46}
.phone-badge.yellow{background:#fef3c7;color:#92400e}

@media(max-width:1020px){.dash-layout{grid-template-columns:1fr}.dash-side{display:none}}
@media(max-width:768px){.stats-grid{grid-template-columns:1fr 1fr}.insight-grid{grid-template-columns:1fr}}
@media(max-width:600px){.stats-grid{grid-template-columns:1fr 1fr;gap:8px}.stat-card{padding:14px}.stat-value{font-size:18px}.funnel-grid{grid-template-columns:1fr 1fr}}
</style></head><body>
<div id="app">
<div class="login-page" id="loginScreen">
  <form class="login-card" id="loginForm" novalidate>
    <div class="login-logo">eki</div>
    <div class="login-title">Vendor Portal</div>
    <div class="login-sub">Sign in to view your store analytics and manage your business.</div>
    <div id="loginMsg" class="msg"></div>
    <div class="form-group">
      <label for="loginEmail">Email</label>
      <input id="loginEmail" class="input" type="email" placeholder="vendor@eki.app" autocomplete="email" required />
    </div>
    <div class="form-group">
      <label for="loginPass">Password</label>
      <input id="loginPass" class="input" type="password" autocomplete="current-password" required />
    </div>
    <button class="btn btn-primary" id="loginBtn" type="submit">Sign In</button>
  </form>
</div>

<div id="dashScreen" class="hidden">
  <header class="topbar">
    <div class="shell topbar-inner">
      <a class="brand" href="/"><span class="brand-dot"></span>eki.</a>
      <nav class="topnav" aria-label="Vendor navigation">
        <a href="#" id="tabDashboard" class="active" onclick="switchTab('dashboard')">Dashboard</a>
        <a href="#" id="tabAnalyticsLink" onclick="switchTab('analytics')">Analytics</a>
        <a href="javascript:void(0)" onclick="window.open('/store/'+encodeURIComponent(storeSlug),'_blank')">Preview Store</a>
        <a href="#" id="logoutBtn" class="logout">Sign out</a>
      </nav>
    </div>
  </header>

  <main class="shell dash-layout" id="dashLayout">
    <div class="dash-main">
      <div id="tabContentDashboard">
        <div class="loading">Sign in to view your dashboard.</div>
      </div>
      <div id="tabContentAnalytics" class="hidden">
        <div class="loading">Loading analytics...</div>
      </div>
    </div>
    <aside class="dash-side" id="sidePanel">
      <div class="card">
        <div class="card-header"><h3>Store Preview</h3></div>
        <div class="card-body" style="padding:10px">
          <div class="phone-preview">
            <div class="phone-screen">
              <div class="phone-header">
                <span class="phone-hl">My Store</span>
                <span class="phone-hr">•••</span>
              </div>
              <div class="phone-body" id="phonePreview">
                <div style="text-align:center;padding:20px 0;color:#999;font-size:10px">Sign in first</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><h3>Quick Links</h3></div>
        <div class="card-body" style="padding:14px 18px;display:flex;flex-direction:column;gap:8px">
          <a href="/" style="font-size:12px;color:#134f3b;font-weight:700">← Eki Homepage</a>
          <a href="/store" style="font-size:12px;color:#134f3b;font-weight:700">Browse all stores</a>
          <a href="/find-order" style="font-size:12px;color:#134f3b;font-weight:700">Find an order</a>
        </div>
      </div>
    </aside>
  </main>
</div></div>
<script>
const API='https://ekiapp-backend.vercel.app';let T='',storeSlug='',currency='EUR';
const weekDays=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function $(id){return document.getElementById(id)}
function esc(v){return String(v||'').replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]})}
function fmt(n,c){c=c||currency||'EUR';try{return new Intl.NumberFormat('en-GB',{style:'currency',currency:c,maximumFractionDigits:0}).format((n||0)/100)}catch(e){return c+' '+(n/100).toFixed(2)}}
function pct(v){return (Math.round((v||0)*10)/10)+'%'}

function switchTab(name){
  document.querySelectorAll('[id^=tabContent]').forEach(function(el){el.classList.add('hidden')});
  document.querySelectorAll('[id^=tab]').forEach(function(el){el.classList.remove('active')});
  $('tabContent' + name.charAt(0).toUpperCase() + name.slice(1)).classList.remove('hidden');
  $('tab' + name.charAt(0).toUpperCase() + name.slice(1) + 'Link').classList.add('active');
}

function renderAlerts(alerts){
  if(!alerts||!alerts.length)return '';
  return '<div class="alerts-row">'+alerts.map(function(a){
    var color=a.type==='order_action'?'order':a.type==='low_stock'?'low_stock':a.type==='message'?'message':'payout';
    return '<span class="alert-chip '+color+'">'+
      (a.type==='order_action'?'📦':a.type==='low_stock'?'⚠️':a.type==='message'?'💬':'💰')+' '+
      esc(a.label||'')+
      (a.count>0?'<span class="count">'+a.count+'</span>':'')+
    '</span>';
  }).join('')+'</div>';
}

async function loadDashboard(){
  $('tabContentDashboard').innerHTML='<div class="loading">Loading...</div>';
  try{
    const r=await fetch(API+'/api/vendors/me/dashboard',{headers:{'Authorization':'Bearer '+T}});
    if(r.status===401||r.status===403){$('loginMsg').textContent='Session expired. Sign in again.';$('loginMsg').className='msg err';T='';$('dashScreen').className='hidden';$('loginScreen').className='';return}
    const d=await r.json();const data=d.dashboard||d||{};storeSlug=data.storeSlug||'';
    const e=data.earnings||{};currency=e.currency||'EUR';
    $('tabContentDashboard').innerHTML=
      '<h2 class="greeting">'+(data.greeting||'Welcome back')+'</h2>'+
      '<p class="greeting-store">'+(data.storeName||'Your store')+'</p>'+
      renderAlerts(data.alerts)+
      '<div class="stats-grid">'+
        '<div class="stat-card"><div class="stat-label">Sales Today</div><div class="stat-value">'+(e.salesToday?fmt(e.salesToday,e.currency):'—')+'</div><div class="stat-sub">Live</div></div>'+
        '<div class="stat-card"><div class="stat-label">This Week</div><div class="stat-value">'+(e.salesThisWeek?fmt(e.salesThisWeek,e.currency):'—')+'</div><div class="stat-sub">7 days</div></div>'+
        '<div class="stat-card"><div class="stat-label">This Month</div><div class="stat-value">'+(e.salesThisMonth?fmt(e.salesThisMonth,e.currency):'—')+'</div><div class="stat-sub">Monthly</div></div>'+
        '<div class="stat-card"><div class="stat-label">Available</div><div class="stat-value">'+(e.availableBalance?fmt(e.availableBalance,e.currency):'—')+'</div><div class="stat-sub">For payout</div></div>'+
      '</div>'+
      (data.insights?'<div class="card"><div class="card-header"><h3>Insights</h3></div><div class="card-body"><div class="insight-grid">'+
        (data.insights.bestSellingProduct?'<div class="insight-item"><div class="icon">🏆</div><h4>Best Seller</h4><p>'+esc(data.insights.bestSellingProduct)+'</p></div>':'')+
        '<div class="insight-item"><div class="icon">📦</div><h4>'+data.insights.totalOrders+' Orders</h4><p>'+data.insights.totalProducts+' active products</p></div>'+
      '</div></div></div>':'');
    updatePhonePreview(data);
  }catch(e){$('tabContentDashboard').innerHTML='<div class="msg err" style="display:block">'+e.message+'</div>'}
}
function updatePhonePreview(data){
  var name=data.storeName||'Your Store';var e=data.earnings||{};
  var html='<div class="phone-store-name">'+esc(name)+'</div>'+
    '<div class="phone-metric"><span class="phone-lbl">Monthly Revenue</span><span class="phone-val">'+fmt(e.salesThisMonth,e.currency)+'</span></div>'+
    '<div class="phone-metric"><span class="phone-lbl">Balance</span><span class="phone-val">'+fmt(e.availableBalance,e.currency)+'</span></div>'+
    '<div class="phone-metric"><span class="phone-lbl">Pending</span><span class="phone-val">'+fmt(e.pendingPayout,e.currency)+'</span></div>'+
    '<div class="phone-metric"><span class="phone-lbl">Today</span><span class="phone-val">'+fmt(e.salesToday,e.currency)+'</span></div>';
  $('phonePreview').innerHTML=html;
}

async function loadAnalytics(){
  $('tabContentAnalytics').innerHTML='<div class="loading">Loading...</div>';
  try{
    const r=await fetch(API+'/api/vendors/me/analytics?range=month',{headers:{'Authorization':'Bearer '+T}});
    if(!r.ok)throw new Error('Failed to load analytics');
    const d=await r.json();const a=d.analytics||{};const s=a.summary||{};const f=a.salesFunnel||{};const c=a.customerInsights||{};const tp=a.topProducts||[];const ins=a.insights||[];
    currency=s.currency||'EUR';
    var funnelMax=Math.max(f.storeVisits||1,f.checkoutStarted||1,f.ordersCompleted||1);
    $('tabContentAnalytics').innerHTML=
      '<h2 class="greeting">Analytics</h2><p class="greeting-store">Last 30 days</p>'+
      '<div class="stats-grid">'+
        '<div class="stat-card"><div class="stat-label">Total Revenue</div><div class="stat-value">'+fmt(s.totalRevenue,s.currency)+'</div></div>'+
        '<div class="stat-card"><div class="stat-label">Available</div><div class="stat-value">'+fmt(s.availableForPayout,s.currency)+'</div></div>'+
        '<div class="stat-card"><div class="stat-label">Pending</div><div class="stat-value">'+fmt(s.pendingBalance,s.currency)+'</div></div>'+
        '<div class="stat-card"><div class="stat-label">Conversion</div><div class="stat-value">'+pct(f.conversionRate)+'</div><div class="stat-sub">'+f.ordersCompleted+' orders</div></div>'+
      '</div>'+
      '<div class="card"><div class="card-header"><h3>Sales Funnel</h3></div><div class="card-body"><div class="funnel-grid">'+
        funnelStep('👀','Visits',f.storeVisits,funnelMax)+
        funnelStep('📋','Checkout',f.checkoutStarted,funnelMax)+
        funnelStep('✅','Completed',f.ordersCompleted,funnelMax)+
        funnelStep('🔁','Repeat',f.repeatOrders,funnelMax)+
      '</div></div></div>'+
      (c?'<div class="card"><div class="card-header"><h3>Customers</h3></div><div class="card-body"><div class="insight-grid">'+
        '<div class="insight-item"><div class="icon">🆕</div><h4>'+c.newBuyers+' New</h4><p>First-time buyers</p></div>'+
        '<div class="insight-item"><div class="icon">🔄</div><h4>'+c.repeatBuyers+' Returning</h4><p>Previous customers</p></div>'+
      '</div></div></div>':'')+
      (tp.length?'<div class="card"><div class="card-header"><h3>Top Products</h3></div><div class="card-body" style="padding:0"><table class="products-table"><thead><tr><th>Product</th><th>Sold</th><th style="text-align:right">Revenue</th></tr></thead><tbody>'+
        tp.slice(0,6).map(function(p){return '<tr><td class="prod-name">'+esc(p.name)+'</td><td>'+p.unitsSold+' units</td><td class="prod-revenue">'+fmt(p.revenue,currency)+'</td></tr>'}).join('')+
      '</tbody></table></div></div>':'')+
      (ins.length?'<div class="card"><div class="card-header"><h3>Suggestions</h3></div><div class="card-body"><div class="insight-grid">'+
        ins.slice(0,4).map(function(i){
          return '<div class="insight-item"><div class="icon">'+(i.severity==='warning'?'⚠️':i.severity==='success'?'✅':'💡')+'</div><h4>'+esc(i.title)+'</h4><p>'+esc(i.body)+'</p><span class="action">'+esc(i.actionLabel)+'</span></div>'
        }).join('')+
      '</div></div></div>':'')+
      '<div style="text-align:center;padding:12px;color:#6b7280;font-size:11px">Data updates in real time as orders come in.</div>';
    updatePhoneAnalytics(s,f,c,tp);
  }catch(e){$('tabContentAnalytics').innerHTML='<div class="msg err" style="display:block">'+e.message+'</div>'}
}

function funnelStep(icon,label,value,max){
  var p=max>0?(value/max)*100:0;
  return '<div class="funnel-step"><div style="font-size:18px;margin-bottom:4px">'+icon+'</div><div class="funnel-num">'+(value||0)+'</div><div class="funnel-label">'+label+'</div><div class="funnel-bar"><div class="funnel-bar-fill" style="width:'+Math.max(p,5)+'%"></div></div></div>';
}

function updatePhoneAnalytics(summary,funnel,customers,products){
  var html='<div class="phone-store-name">📊 Analytics Snapshot</div>'+
    '<div class="phone-metric"><span class="phone-lbl">Revenue</span><span class="phone-val">'+fmt(summary.totalRevenue,summary.currency)+'</span></div>'+
    '<div class="phone-metric"><span class="phone-lbl">Conversion</span><span class="phone-val">'+(funnel?pct(funnel.conversionRate):'—')+'</span></div>'+
    '<div class="phone-metric"><span class="phone-lbl">Customers</span><span class="phone-val">'+(customers?((customers.newBuyers||0)+(customers.repeatBuyers||0)):'—')+'</span></div>'+
    (products&&products.length?'<div style="margin-top:8px;font-size:10px;font-weight:700;color:#999;border-top:1px solid #eee;padding-top:8px">Top Products</div>'+
      products.slice(0,3).map(function(p){return '<div class="phone-orders-item"><span class="phone-side-label">'+esc(p.name)+'</span><span class="phone-side-val">'+fmt(p.revenue,currency)+'</span></div>'}).join('')
    :'')+
    '<div style="margin-top:8px;padding-top:6px;border-top:1px solid #eee;font-size:8px;color:#999;text-align:center">Eki Vendor Dashboard</div>';
  $('phonePreview').innerHTML=html;
}

$('loginForm').addEventListener('submit',async function(e){e.preventDefault();
  var btn=$('loginBtn');btn.disabled=true;
  try{
    var r=await fetch(API+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:$('loginEmail').value.trim(),password:$('loginPass').value})});
    var d=await r.json();
    if(!r.ok||!d.token){$('loginMsg').textContent=d.message||'Invalid email or password';$('loginMsg').className='msg err';btn.disabled=false;return}
    T=d.token;$('loginScreen').className='hidden';$('dashScreen').className='';loadDashboard();
  }catch(e){$('loginMsg').textContent='Connection error. Please try again.';$('loginMsg').className='msg err';btn.disabled=false}
});

$('logoutBtn').addEventListener('click',function(e){e.preventDefault();T='';$('dashScreen').className='hidden';$('loginScreen').className='';$('loginEmail').value='';$('loginPass').value=''});

var tabs=['dashboard','analytics'];
tabs.forEach(function(t){var el=$('tab' + t.charAt(0).toUpperCase() + t.slice(1) + 'Link');if(el)el.addEventListener('click',function(e){e.preventDefault();if(t==='analytics'&&!T)return;if(t==='analytics')loadAnalytics();switchTab(t)})});
</script></body></html>`; }

function renderBuyerCartLayout(): string { return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="theme-color" content="#164F3F">
<title>My Cart | Eki</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" />
<style>
body{margin:0;background:#F5F6F5;color:#111;font-family:'Inter',sans-serif}
.shell{width:min(960px,calc(100% - 24px));margin:0 auto}
.topbar{height:48px;background:#fff;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;padding:0 max(12px,calc((100vw - 960px)/2))}
.brand{font-weight:800;font-size:14px;color:#164F3F;display:flex;align-items:center;gap:6px}
.brand-dot{width:8px;height:8px;border-radius:4px;background:#164F3F;display:inline-block}
.toplinks{display:flex;gap:14px;font-size:12px;font-weight:600;color:#666}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:18px;box-shadow:0 1px 6px rgba(0,0,0,.04)}
.btn{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 16px;border-radius:8px;font-weight:700;font-size:12px;border:0;cursor:pointer;background:#164F3F;color:#fff;text-decoration:none}
</style></head><body>
<div class="topbar"><a class="brand" href="/"><span class="brand-dot"></span> Eki</a><div class="toplinks"><a href="/store">Store</a><a href="/">Home</a></div></div>
<div class="shell" style="padding:40px 0;text-align:center">
  <div style="font-size:48px;margin-bottom:16px">ðŸ›’</div>
  <h1 style="font-size:24px;font-weight:800;margin:0">Your Cart</h1>
  <p style="color:#999;font-size:13px;margin:8px 0 24px">Add items using the Eki app, then come here to review.</p>
  <div class="card" style="max-width:400px;margin:0 auto;text-align:left;font-size:13px;line-height:1.6">
    <strong>How it works:</strong>
    <ol style="margin:10px 0 0;padding-left:18px;color:#666">
      <li>Browse vendors and add items in the <strong>Eki app</strong></li>
      <li>Review your cart and checkout</li>
      <li>Pay by card or wallet â€” track delivery live</li>
    </ol>
    <a href="/store" class="btn" style="margin-top:14px;width:100%;display:flex">Browse Vendors</a>
  </div>
</div></body></html>`; }

export async function getPublicVendorPortalPage(_request: Request, response: Response): Promise<void> {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache");
  response.status(200).send(renderVendorPortalLayout());
}

export async function getPublicCheckoutPage(_request: Request, response: Response): Promise<void> {
  response.setHeader("Content-Type","text/html; charset=utf-8");
  response.setHeader("Cache-Control","no-cache");
  response.status(200).send(renderCheckoutStandaloneLayout());
}

function renderCheckoutStandaloneLayout(): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="theme-color" content="#164F3F"><title>Checkout | Eki</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin /><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" />
<style>
*,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:0}
body{background:#f6f8f7;color:#111;font-family:'Inter',sans-serif}
.shell{width:min(960px,calc(100% - 24px));margin:0 auto}
.top{height:48px;background:#fff;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;padding:0 max(12px,calc((100vw - 960px)/2))}
.brand{font-weight:800;font-size:14px;color:#164F3F;display:flex;align-items:center;gap:6px}.brand-dot{width:8px;height:8px;border-radius:4px;background:#164F3F;display:inline-block}
.nav a{font-size:12px;font-weight:600;color:#666;text-decoration:none;margin-left:16px}.nav a:hover{color:#164F3F}
.g{display:grid;grid-template-columns:1fr 340px;gap:20px;padding:24px 0 48px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:20px;margin-bottom:14px}
h2{font-size:16px;font-weight:800;margin:0 0 12px}.field{margin-bottom:12px}.field label{display:block;font-size:11px;font-weight:700;color:#444;margin-bottom:4px}
.inp{width:100%;height:40px;border:1px solid #dce3e0;border-radius:6px;padding:0 10px;font-size:13px;outline:none}.inp:focus{border-color:#164F3F;box-shadow:0 0 0 3px rgba(22,79,63,.08)}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.btn{width:100%;height:48px;border:0;border-radius:10px;background:#164F3F;color:#fff;font-weight:700;font-size:14px;cursor:pointer;margin-top:8px}
.item{display:flex;gap:12px;padding:10px 0;border-bottom:1px solid #f0f0f0;align-items:center}
.item-img{width:44px;height:44px;border-radius:8px;background:#e8ece9;flex:0 0 auto}
.item-info{flex:1;min-width:0}.item-name{font-weight:700;font-size:13px}.item-qty{font-size:11px;color:#999;margin-top:2px}
.item-price{font-weight:800;font-size:14px;color:#164F3F;text-align:right;white-space:nowrap}
@media(max-width:768px){.g{grid-template-columns:1fr}}
</style></head><body>
<div class="top"><a class="brand" href="/"><span class="brand-dot"></span> Eki</a><div class="nav"><a href="/store">Stores</a><a href="/cart">Cart</a><a href="/">Home</a></div></div>
<div class="shell"><div class="g"><div><h2 style="font-size:20px;margin-top:24px">Checkout</h2>
<div class="card"><h2>Your details</h2><div class="g2"><div class="field"><label>First name</label><input class="inp" id="cfn" /></div><div class="field"><label>Last name</label><input class="inp" id="cln" /></div></div><div class="field"><label>Email</label><input class="inp" id="cemail" type="email" /></div></div>
<div class="card"><h2>Delivery</h2><div class="field"><label>Address</label><input class="inp" id="caddr" /></div><div class="g2"><div class="field"><label>City</label><input class="inp" id="ccity" /></div><div class="field"><label>Postcode</label><input class="inp" id="czip" /></div></div><div class="field"><label>Country</label><input class="inp" id="ccountry" value="United Kingdom" /></div></div></div>
<div><div class="card"><h2>Cart items</h2><div id="cartItems"></div><div id="totalArea"></div><div id="errorMsg" style="color:#e55353;font-size:12px;display:none;margin:6px 0"></div>
<button class="btn" id="placeOrder">Place Order</button></div></div></div></div>
<script>
var cart=JSON.parse(localStorage.getItem('eki_cart')||'[]');
function loadCart(){var h='',s=0;if(!cart.length){document.getElementById('cartItems').innerHTML='<div style="color:#999;padding:16px 0;text-align:center">Cart empty — <a href="/store" style="color:#164F3F;font-weight:700">Browse stores</a></div>';document.getElementById('totalArea').innerHTML='';return}
for(var i=0;i<cart.length;i++){var item=cart[i];h+='<div class="item"><div class="item-img"></div><div class="item-info"><div class="item-name">'+item.title+'</div><div class="item-qty">Qty: '+(item.qty||1)+'</div></div><div class="item-price">'+fmt((item.price||0)*(item.qty||1),item.currency)+'</div></div>';s+=(item.price||0)*(item.qty||1)}
document.getElementById('cartItems').innerHTML=h;document.getElementById('totalArea').innerHTML='<div style="font-weight:800;font-size:18px;color:#164F3F;padding-top:10px;border-top:1px solid #eee;margin-top:6px">Total: '+fmt(s,cart[0]?cart[0].currency:'EUR')+'</div>'}
function fmt(n,c){try{return new Intl.NumberFormat('en-GB',{style:'currency',currency:c||'EUR'}).format(n/100)}catch{return(c||'€')+' '+(n/100).toFixed(2)}}
loadCart();
function $(id){var e=document.getElementById(id);return e?e.value:''}
document.getElementById('placeOrder').addEventListener('click',async function(){if(!cart.length)return;var data={items:cart.map(function(i){return{productId:i.id,quantity:i.qty||1,storeSlug:i.storeSlug}}),deliveryAddress:($('caddr')+', '+$('ccity')+', '+$('czip')+', '+$('ccountry')).trim(),deliveryCountry:$('ccountry'),email:$('cemail'),name:$('cfn')+' '+$('cln')};if(!data.email||!$('caddr').trim()){alert('Enter email and address');return}
this.disabled=true;this.textContent='Processing...';var em=document.getElementById('errorMsg');em.style.display='none'
try{var r=await fetch('https://ekiapp-backend.vercel.app/api/public/stores/guest-checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});var d=await r.json();if(!r.ok)throw new Error(d.message||'Checkout failed');
if(d.checkoutUrl){window.location.assign(d.checkoutUrl);return}
localStorage.removeItem('eki_cart');alert('Order placed!');cart.length=0;loadCart()}catch(err){em.textContent=err.message;em.style.display='block'}
finally{this.disabled=false;this.textContent='Place Order'}
});
</script></body></html>`; }

export async function getPublicBuyerCartPage(_request: Request, response: Response): Promise<void> {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "public, max-age=120, s-maxage=300");
  response.status(200).send(renderBuyerCartLayout());
}



