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
    body{background:#fff;color:#111827;font-family:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;line-height:1.5}
    a{color:inherit;text-decoration:none}
    img{display:block;max-width:100%}
    .shell{width:min(1200px,calc(100% - 48px));margin:0 auto}

    /* ── Header ── */
    .topbar{position:sticky;top:0;z-index:50;background:#134f3b}
    .topbar-inner{display:flex;align-items:center;justify-content:space-between;min-height:64px;gap:20px}
    .brand{display:inline-flex;align-items:center;gap:6px;font-weight:800;font-size:20px;color:#fff;letter-spacing:-0.02em}
    .brand-dot{width:10px;height:10px;border-radius:999px;background:#4ade80;display:inline-block}
    .topnav{display:flex;align-items:center;gap:28px}
    .topnav a{font-size:14px;font-weight:600;color:rgba(255,255,255,.85);transition:color .15s ease}
    .topnav a:hover{color:#fff}
    .topnav .nav-cta{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:0 22px;border-radius:10px;background:#fff;color:#134f3b;font-weight:700;font-size:14px;transition:transform .2s cubic-bezier(.34,1.56,.64,1),box-shadow .2s ease}
    .topnav .nav-cta:hover{transform:translateY(-1px);box-shadow:0 8px 20px rgba(0,0,0,.15)}

    /* ── Hero ── */
    .hero-wrap{background:linear-gradient(135deg,#134f3b 0%,#1a6b4f 50%,#134f3b 100%);color:#fff;overflow:hidden}
    .hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(340px,520px);align-items:center;gap:40px;padding:72px 0 48px}
    .hero-copy{max-width:540px}
    .hero-badge{display:inline-flex;align-items:center;gap:6px;padding:6px 16px;border-radius:999px;background:rgba(255,255,255,.12);color:rgba(255,255,255,.9);font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;margin-bottom:24px;border:1px solid rgba(255,255,255,.15)}
    .hero-badge-dot{width:6px;height:6px;border-radius:999px;background:#4ade80;display:inline-block}
    h1{margin:0;font-size:clamp(32px,4.2vw,52px);line-height:1.06;letter-spacing:-0.04em;font-weight:800}
    .hero-intro{margin:20px 0 0;max-width:440px;color:rgba(255,255,255,.8);font-size:17px;line-height:1.6}
    .hero-actions{display:flex;gap:14px;margin-top:32px;flex-wrap:wrap}
    .btn-app{display:inline-flex;align-items:center;gap:12px;min-width:170px;height:56px;padding:0 22px;border-radius:12px;background:#fff;color:#134f3b;text-decoration:none;box-shadow:0 16px 36px rgba(0,0,0,.12);transition:transform .25s cubic-bezier(.34,1.56,.64,1),box-shadow .25s ease}
    .btn-app:hover{transform:translateY(-3px) scale(1.03);box-shadow:0 22px 44px rgba(0,0,0,.18)}
    .btn-app:active{transform:translateY(0) scale(.98)}
    .btn-app.google{background:#2b7a4b;color:#fff}
    .btn-app.google:hover{background:#33995c}
    .btn-app-icon{font-size:22px;flex-shrink:0}
    .btn-app-text{display:flex;flex-direction:column}
    .btn-small{font-size:10px;font-weight:600;opacity:.7}
    .btn-main{font-size:15px;font-weight:800;margin-top:1px}
    .hero-trust{margin-top:20px;font-size:13px;color:rgba(255,255,255,.55)}

    /* ── Hero showcase ── */
    .hero-showcase{position:relative;min-height:500px;display:flex;align-items:center;justify-content:center}
    .phone-mockup{width:260px;background:#1a1a1a;border-radius:32px;padding:8px;box-shadow:0 40px 80px rgba(0,0,0,.35),0 0 0 2px rgba(255,255,255,.08);position:relative;z-index:2}
    .phone-notch{position:absolute;top:8px;left:50%;transform:translateX(-50%);width:80px;height:20px;background:#1a1a1a;border-radius:0 0 12px 12px;z-index:2}
    .phone-screen{background:#f8f9f7;border-radius:24px;overflow:hidden;min-height:460px;position:relative}
    .phone-top{background:#134f3b;color:#fff;padding:28px 14px 10px;text-align:center}
    .phone-top-brand{font-weight:800;font-size:14px;display:flex;align-items:center;justify-content:center;gap:4px}
    .phone-top-brand .dot{width:6px;height:6px;border-radius:99px;background:#4ade80;display:inline-block}
    .phone-top-sub{font-size:10px;color:rgba(255,255,255,.7);margin-top:2px}
    .phone-cats{display:flex;gap:5px;padding:8px 14px;overflow-x:auto}
    .phone-cat{padding:5px 12px;border-radius:18px;font-size:9px;font-weight:600;white-space:nowrap}
    .phone-cat.active{background:#134f3b;color:#fff}
    .phone-cat:not(.active){background:#fff;color:#555;border:1px solid #e5e7eb}
    .phone-vendor{margin:6px 14px;background:#fff;border-radius:10px;padding:10px;display:flex;align-items:center;gap:10px;box-shadow:0 1px 4px rgba(0,0,0,.06)}
    .phone-vendor-av{width:36px;height:36px;border-radius:8px;background:#fef3c7;display:flex;align-items:center;justify-content:center;font-size:16px}
    .phone-vendor-info{flex:1}
    .phone-vendor-name{font-size:10px;font-weight:800;color:#111}
    .phone-vendor-meta{font-size:8px;color:#6b7280;margin-top:1px}
    .phone-products{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:8px 14px}
    .phone-prod{background:#fff;border-radius:8px;padding:8px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.04)}
    .phone-prod-icon{font-size:20px;margin-bottom:4px}
    .phone-prod-name{font-size:9px;font-weight:700;color:#111}
    .phone-prod-price{font-size:8px;color:#134f3b;font-weight:700;margin-top:1px}
    .phone-prod-old{text-decoration:line-through;color:#999;font-size:7px;margin-left:3px}
    .phone-order{margin:6px 14px;background:#eef8f2;border-radius:8px;padding:8px 10px}
    .phone-order-title{font-size:9px;font-weight:700;color:#111}
    .phone-order-sub{font-size:8px;color:#134f3b;margin-top:1px}
    .phone-reorder{margin:6px 14px;display:flex;align-items:center;justify-content:space-between}
    .phone-reorder-label{font-size:8px;color:#6b7280}
    .phone-reorder-btn{font-size:8px;font-weight:700;color:#fff;background:#134f3b;padding:4px 12px;border-radius:12px}
    .phone-bottom-nav{position:absolute;bottom:0;left:0;right:0;background:#fff;border-top:1px solid #e5e7eb;display:flex;justify-content:space-around;padding:7px 0}
    .phone-nav-item{display:flex;flex-direction:column;align-items:center;gap:1px;font-size:7px;color:#999}
    .phone-nav-item.active{color:#134f3b}
    .phone-nav-icon{font-size:13px}

    /* ── Floating cards ── */
    .fcard{position:absolute;background:#fff;border-radius:14px;padding:10px 14px;box-shadow:0 8px 28px rgba(0,0,0,.12);display:flex;align-items:center;gap:10px;z-index:1;white-space:nowrap;transition:transform .3s ease}
    .fcard:hover{transform:scale(1.05)}
    .fcard-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
    .fcard-text h4{margin:0;font-size:11px;font-weight:800;color:#111}
    .fcard-text p{margin:1px 0 0;font-size:9px;color:#6b7280}
    .fcard-badge{position:absolute;background:#fff;border-radius:12px;padding:8px 14px;box-shadow:0 6px 20px rgba(0,0,0,.1);z-index:1;display:flex;align-items:center;gap:6px;font-size:10px;font-weight:700}
    .fcard-badge .bdot{width:8px;height:8px;border-radius:99px;display:inline-block}
    .fc-tl{top:20px;left:-30px}.fc-ml{top:160px;left:-50px}.fc-bl{bottom:100px;left:-20px}
    .fc-tr{top:20px;right:-30px}.fc-mr{top:180px;right:-50px}.fc-br{bottom:100px;right:-20px}
    .fb-tl{top:70px;left:-70px}.fb-tr{top:50px;right:-80px}.fb-b{bottom:30px;left:50%;transform:translateX(-50%)}

    /* ── Features ── */
    .features-band{padding:80px 0 72px;background:#f9fafb}
    .features-header{text-align:center;margin-bottom:48px}
    .features-header h2{margin:0;font-size:clamp(26px,4vw,38px);font-weight:800;letter-spacing:-.03em;line-height:1.12;color:#111}
    .features-header p{margin:14px auto 0;color:#6b7280;font-size:16px;max-width:480px}
    .features-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px}
    .feature-card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:28px 24px;transition:transform .2s ease,box-shadow .2s ease,border-color .2s ease}
    .feature-card:hover{transform:translateY(-4px);box-shadow:0 16px 36px rgba(19,79,59,.1);border-color:#b8d4c3}
    .feature-icon{width:48px;height:48px;border-radius:12px;background:#eef8f2;color:#134f3b;display:flex;align-items:center;justify-content:center;font-size:22px;margin-bottom:16px}
    .feature-card h3{margin:0 0 8px;font-size:16px;font-weight:800;letter-spacing:-.02em;color:#111}
    .feature-card p{margin:0;color:#6b7280;font-size:14px;line-height:1.55}

    /* ── Pricing ── */
    .pricing-band{padding:80px 0 72px;background:#fff}
    .pricing-header{text-align:center;margin-bottom:48px}
    .pricing-header h2{margin:0;font-size:clamp(26px,4vw,38px);font-weight:800;letter-spacing:-.03em;line-height:1.12;color:#111}
    .pricing-header p{margin:14px auto 0;color:#6b7280;font-size:16px;max-width:560px}
    .pricing-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;max-width:960px;margin:0 auto}
    .pricing-card{background:#fff;border:1px solid #e5e7eb;border-radius:20px;padding:32px 28px;display:flex;flex-direction:column;transition:transform .2s ease,box-shadow .2s ease}
    .pricing-card:hover{transform:translateY(-4px);box-shadow:0 16px 36px rgba(19,79,59,.1)}
    .pricing-card.popular{border-color:#076b51;box-shadow:0 0 0 2px #076b51}
    .pricing-badge{display:inline-block;background:#eef8f2;color:#076b51;font-size:11px;font-weight:700;border-radius:999px;padding:4px 14px;margin-bottom:16px;align-self:flex-start;text-transform:uppercase;letter-spacing:.04em}
    .pricing-name{font-size:22px;font-weight:800;color:#111;margin:0 0 6px}
    .pricing-desc{font-size:13px;color:#6b7280;line-height:1.5;margin:0 0 20px}
    .pricing-price{font-size:36px;font-weight:800;color:#111;margin:0 0 4px}.pricing-price small{font-size:14px;font-weight:400;color:#6b7280}
    .pricing-fee{font-size:12px;color:#6b7280;margin:0 0 20px}
    .pricing-list{list-style:none;padding:0;margin:0 0 24px;flex:1}
    .pricing-list li{padding:7px 0;font-size:13px;color:#374151;display:flex;align-items:center;gap:8px}
    .pricing-list li::before{content:"✓";color:#076b51;font-weight:800;font-size:14px}
    .pricing-cta{display:block;width:100%;height:48px;border:0;border-radius:12px;background:#134f3b;color:#fff;font-weight:700;font-size:14px;cursor:pointer;text-align:center;line-height:48px;text-decoration:none;transition:background .15s ease}
    .pricing-cta:hover{background:#0f4030}
    .pricing-cta.outline{background:transparent;border:1px solid #d1d5db;color:#374151}
    .pricing-cta.outline:hover{border-color:#134f3b;color:#134f3b}
    .pricing-note{text-align:center;margin-top:24px;color:#6b7280;font-size:13px}

    /* ── Order lookup ── */
    .order-band{padding:56px 0;background:#fff;border-top:1px solid #e5e7eb}
    .order-inner{max-width:600px;margin:0 auto;text-align:center}
    .order-inner h2{margin:0 0 8px;font-size:22px;font-weight:800;color:#111;letter-spacing:-.02em}
    .order-inner p{margin:0 0 24px;color:#6b7280;font-size:14px}
    .order-form{display:flex;gap:10px;max-width:480px;margin:0 auto}
    .order-form input{flex:1;height:48px;border:1px solid #d1d5db;border-radius:10px;padding:0 16px;font-size:14px;outline:none;background:#fff;color:#111}
    .order-form input:focus{border-color:#134f3b;box-shadow:0 0 0 3px rgba(19,79,59,.1)}
    .order-form button{height:48px;padding:0 24px;border:0;border-radius:10px;background:#134f3b;color:#fff;font-weight:700;font-size:14px;cursor:pointer;white-space:nowrap;transition:background .15s ease}
    .order-form button:hover{background:#0f4030}

    /* ── Footer ── */
    .footer{background:#0d2a20;color:rgba(255,255,255,.72);padding:48px 0 32px}
    .footer-grid{display:grid;grid-template-columns:minmax(0,1.2fr) repeat(3,minmax(0,1fr));gap:32px;padding-bottom:32px;border-bottom:1px solid rgba(255,255,255,.08)}
    .footer-brand{display:inline-flex;align-items:center;gap:8px;margin-bottom:12px;font-weight:800;font-size:16px;color:#fff;letter-spacing:-.03em}
    .footer-brand .brand-dot{width:10px;height:10px;border-radius:999px;background:#4ade80;display:inline-block}
    .footer p{font-size:13px;line-height:1.55;margin:0;color:rgba(255,255,255,.6)}
    .footer h4{margin:0 0 12px;font-size:11px;font-weight:700;color:#fff;text-transform:uppercase;letter-spacing:.06em}
    .footer-links{display:flex;flex-direction:column;gap:8px}
    .footer-links a{font-size:13px;color:rgba(255,255,255,.6);transition:color .15s ease}
    .footer-links a:hover{color:#fff}
    .footer-bottom{padding-top:24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;font-size:12px}
    .footer-bottom a{color:rgba(255,255,255,.6);transition:color .15s ease}
    .footer-bottom a:hover{color:#fff}

    /* ── Responsive ── */
    @media(max-width:1020px){
      .hero{grid-template-columns:1fr;gap:24px;padding:40px 0 0}
      .hero-showcase{min-height:auto;padding:20px 0}
      .fcard,.fcard-badge{display:none}
      .phone-mockup{margin:0 auto}
      h1{font-size:36px}
      .features-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
      .pricing-grid{grid-template-columns:1fr}
      .pricing-card.popular{order:-1}
      .footer-grid{grid-template-columns:1fr 1fr;gap:24px}
    }
    @media(max-width:600px){
      .shell{width:min(100% - 24px,1200px)}
      .topnav{gap:16px}
      .topnav a:not(.nav-cta){display:none}
      .hero{padding:32px 0 40px}
      h1{font-size:30px}
      .hero-intro{font-size:15px}
      .hero-actions{gap:10px}
      .btn-app{min-width:0;flex:1;height:50px;padding:0 14px}
      .features-grid{grid-template-columns:1fr}
      .features-header h2{font-size:26px}
      .footer-grid{grid-template-columns:1fr}
      .footer-bottom{flex-direction:column;text-align:center}
      .order-form{flex-direction:column}
      .order-form button{width:100%}
    }
  </style>
</head>
<body>

<!-- ── HEADER ── -->
<header class="topbar">
  <div class="shell topbar-inner">
    <a class="brand" href="/">
      <span class="brand-dot"></span>eki
    </a>
    <nav class="topnav" aria-label="Main">
      <a href="/store">Buyers</a>
      <a href="/vendor">Vendors</a>
      <a href="#pricing">Pricing</a>
      <a class="nav-cta" href="/store">Sign In</a>
    </nav>
  </div>
</header>

<!-- ── HERO ── -->
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
          <a class="btn-app" href="https://apps.apple.com/app/id" aria-label="Download on App Store">
            <span class="btn-app-icon">&#xF8FF;</span>
            <span class="btn-app-text">
              <span class="btn-small">Download on the</span>
              <span class="btn-main">App Store</span>
            </span>
          </a>
          <a class="btn-app google" href="https://play.google.com/store/apps/details?id=com.ekiapp.mobile" aria-label="Get it on Google Play">
            <span class="btn-app-icon">&#9654;</span>
            <span class="btn-app-text">
              <span class="btn-small">Get it on</span>
              <span class="btn-main">Google Play</span>
            </span>
          </a>
        </div>
        <div class="hero-trust">Free app · No spam · No hidden fees</div>
      </div>
      <div class="hero-showcase" aria-label="Eki app preview">
        <!-- Floating badge cards -->
        <div class="fcard-badge fb-tl"><span class="bdot" style="background:#4ade80"></span> Verified vendor<br><span style="font-weight:400;font-size:8px;color:#6b7280">Safe to buy from</span></div>
        <div class="fcard-badge fb-tr"><span class="bdot" style="background:#f87171"></span> Live tracking<br><span style="font-weight:400;font-size:8px;color:#6b7280">Know your order status</span></div>
        <div class="fcard-badge fb-b"><span class="bdot" style="background:#fbbf24"></span> Secure checkout<br><span style="font-weight:400;font-size:8px;color:#6b7280">No random transfers</span></div>

        <!-- Floating product cards - left -->
        <div class="fcard fc-tl">
          <div class="fcard-icon" style="background:#fef3c7">🌾</div>
          <div class="fcard-text"><h4>GARRI</h4><p>5kg bag</p></div>
        </div>
        <div class="fcard fc-ml">
          <div class="fcard-icon" style="background:#fce7f3">🛢️</div>
          <div class="fcard-text"><h4>PALM OIL</h4><p>1 litre</p></div>
        </div>
        <div class="fcard fc-bl">
          <div class="fcard-icon" style="background:#fee2e2">🌶️</div>
          <div class="fcard-text"><h4>PEPPERS</h4><p>dried</p></div>
        </div>

        <!-- Floating product cards - right -->
        <div class="fcard fc-tr">
          <div class="fcard-icon" style="background:#fce7f3">🦐</div>
          <div class="fcard-text"><h4>CRAYFISH</h4><p>200g</p></div>
        </div>
        <div class="fcard fc-mr">
          <div class="fcard-icon" style="background:#d1fae5">🥜</div>
          <div class="fcard-text"><h4>EGUSI</h4><p>500g bag</p></div>
        </div>
        <div class="fcard fc-br">
          <div class="fcard-icon" style="background:#dbeafe">🐟</div>
          <div class="fcard-text"><h4>STOCKFISH</h4><p>dried</p></div>
        </div>

        <!-- Center phone -->
        <div class="phone-mockup">
          <div class="phone-notch"></div>
          <div class="phone-screen">
            <div class="phone-top">
              <div class="phone-top-brand"><span class="dot"></span> eki</div>
              <div class="phone-top-sub">Find. Order. Track.</div>
            </div>
            <div class="phone-cats">
              <span class="phone-cat active">Grains</span>
              <span class="phone-cat">Soups</span>
              <span class="phone-cat">Oils</span>
            </div>
            <div class="phone-vendor">
              <div class="phone-vendor-av">🌿</div>
              <div class="phone-vendor-info">
                <div class="phone-vendor-name">Mama Chioma Store</div>
                <div class="phone-vendor-meta">★ 4.9 · Lagos Island · Verified</div>
              </div>
            </div>
            <div class="phone-products">
              <div class="phone-prod">
                <div class="phone-prod-icon">🌾</div>
                <div class="phone-prod-name">Garri 5kg</div>
                <div class="phone-prod-price">₦3,500</div>
              </div>
              <div class="phone-prod">
                <div class="phone-prod-icon">🥜</div>
                <div class="phone-prod-name">Egusi 1kg</div>
                <div class="phone-prod-price">₦2,800</div>
              </div>
            </div>
            <div class="phone-order">
              <div class="phone-order-title">Order #1042 — In transit</div>
              <div class="phone-order-sub">Arriving today by 4pm</div>
            </div>
            <div class="phone-reorder">
              <span class="phone-reorder-label">Reorder from last week</span>
              <span class="phone-reorder-btn">One tap →</span>
            </div>
            <div class="phone-bottom-nav">
              <div class="phone-nav-item active"><span class="phone-nav-icon">🏠</span><span>Home</span></div>
              <div class="phone-nav-item"><span class="phone-nav-icon">🔍</span><span>Search</span></div>
              <div class="phone-nav-item"><span class="phone-nav-icon">🛒</span><span>Cart</span></div>
              <div class="phone-nav-item"><span class="phone-nav-icon">👤</span><span>Profile</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- ── FEATURES ── -->
  <section class="features-band">
    <div class="shell">
      <div class="features-header">
        <h2>Everything buyers need in one app.</h2>
        <p>Discover, order, track, and enjoy your favourite foodstuff from trusted vendors.</p>
      </div>
      <div class="features-grid">
        <article class="feature-card">
          <div class="feature-icon">🔍</div>
          <h3>Find trusted vendors</h3>
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
          <div class="feature-icon">📱</div>
          <h3>One app access</h3>
          <p>Everything in one place — browse, order, pay, track, and chat with your vendor.</p>
        </article>
      </div>
    </div>
  </section>

  <!-- ── PRICING ── -->
  <section class="pricing-band" id="pricing">
    <div class="shell">
      <div class="pricing-header">
        <h2>Vendor services built for growth.</h2>
        <p>Eki provides the tools and infrastructure to help food vendors manage and grow their businesses.</p>
      </div>
      <div id="pricing-grid" class="pricing-grid">
        <div class="pricing-card">
          <div class="pricing-name">Starter</div>
          <p class="pricing-desc">Get started selling on Eki with essential commerce tools.</p>
          <div class="pricing-price">Free</div>
          <p class="pricing-fee">10% platform fee per order</p>
          <ul class="pricing-list">
            <li>Up to 5 active products</li>
            <li>Up to 3 orders</li>
            <li>Store page</li>
            <li>Order management</li>
            <li>Standard support</li>
          </ul>
          <a class="pricing-cta outline" href="/business-portal">Get started</a>
        </div>
      </div>
      <p class="pricing-note">All vendor services are managed securely through the Eki Business Portal.</p>
    </div>
  </section>
  <script>
  (function(){
    var grid=document.getElementById('pricing-grid');
    function esc(v){return String(v||'').replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
    function money(cents,cur){return new Intl.NumberFormat('en-GB',{style:'currency',currency:cur||'GBP',maximumFractionDigits:0}).format(Number(cents||0)/100)}
    function fee(bps){return ((Number(bps||0)/100).toFixed(2).replace(/\\.00$/,''))+'%'}
    function items(p){var a=[];a.push(p.maxProducts===-1?'Unlimited active products':p.maxProducts+' active products');a.push(p.maxOrders==null||p.maxOrders===-1?'Unlimited orders':p.maxOrders+' orders');if(p.analytics)a.push('Analytics dashboard');if(p.discounts)a.push('Discount campaigns');if(p.flashSales)a.push('Flash sales & bundles');if(p.marketingTools)a.push('Marketing tools');a.push(p.prioritySupport?'Priority support':'Standard support');return a}
    fetch('/api/subscriptions/plans').then(function(r){return r.json()}).then(function(d){
      var plans=(Array.isArray(d.plans)?d.plans:[]).filter(function(p){var k=String(p.plan||p.id||'').toUpperCase();return k==='GROWTH'||k==='PRO'});
      plans.sort(function(a,b){return(a.displayOrder||0)-(b.displayOrder||0)});
      plans.forEach(function(p){
        var k=String(p.plan||p.id||'').toUpperCase();
        var popular=k==='GROWTH';
        var card=document.createElement('div');
        card.className='pricing-card'+(popular?' popular':'');
        card.innerHTML=(popular?'<span class="pricing-badge">Most popular</span>':'')+
          '<div class="pricing-name">'+esc(p.name||k)+'</div>'+
          '<p class="pricing-desc">'+(k==='GROWTH'?'Scale your store with more products, analytics, and marketing tools.':'Full commerce infrastructure for high-volume vendors.')+'</p>'+
          '<div class="pricing-price">'+esc(money(p.monthlyPriceCents,p.currency))+' <small>/ month</small></div>'+
          '<p class="pricing-fee">'+esc(fee(p.platformFeeBps||p.defaultPlatformFeeBps))+' platform fee per order</p>'+
          '<ul class="pricing-list">'+items(p).map(function(i){return'<li>'+esc(i)+'</li>'}).join('')+'</ul>'+
          '<a class="pricing-cta" href="/business-portal">Activate '+esc(p.name||k)+'</a>';
        grid.appendChild(card);
      });
    }).catch(function(){});
  })();
  </script>

  <!-- ── Order Lookup ── -->
  <section class="order-band">
    <div class="shell">
      <div class="order-inner">
        <h2>Find your order</h2>
        <p>Enter your order number or checkout email to track your delivery.</p>
        <form class="order-form" onsubmit="event.preventDefault();window.location.href='/find-order'">
          <input type="text" placeholder="Order number or email address" aria-label="Order number or email" />
          <button type="submit">Find Order</button>
        </form>
      </div>
    </div>
  </section>
</main>

<!-- ── FOOTER ── -->
<footer class="footer">
  <div class="shell">
    <div class="footer-grid">
      <div>
        <div class="footer-brand">
          <span class="brand-dot"></span>eki
        </div>
        <p>Your favourite foodstuff vendors, all in one trusted app. Buy, sell, and receive authentic African and Caribbean foodstuff.</p>
      </div>
      <div>
        <h4>Platform</h4>
        <div class="footer-links">
          <a href="/store">Browse vendors</a>
          <a href="/find-order">Find order</a>
          <a href="/vendor">Vendor portal</a>
          <a href="/#pricing">Pricing</a>
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
      <span>&copy; ${new Date().getFullYear()} Eki. All rights reserved.</span>
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
  title: "Privacy Policy | Eki",
  description: "How Eki collects, protects, and uses your personal information.",
  eyebrow: "Privacy",
  heading: "Privacy Policy",
  intro:
    "Ehimare Co respects your privacy and is committed to protecting your personal information. This Privacy Policy explains how we collect, use, store, and protect your information when you use the Eki platform.",
  actions: [
    { href: "mailto:info@culinarytales.app", label: "Privacy questions" },
    { href: "/terms", label: "Terms & Conditions", variant: "secondary" },
  ],
  sections: [
    {
      title: "1. Who We Are",
      body: ["Eki is a technology platform that helps African foodstuff and ingredient vendors manage products, customers, orders, payments, and business operations. This Privacy Policy applies to all users of the Eki platform, including buyers and vendors."],
      bullets: ["Ehimare Co, 5 Marriott Street, Coundon, Coventry, CV6 1BB, United Kingdom"],
    },
    {
      title: "2. Information We Collect",
      bullets: [
        "Account Information: full name, email address, phone number, country of residence, account credentials",
        "Vendor Information: business name, business address, product information, bank or payout information, identity verification information, verification status",
        "Order Information: products purchased, order history, delivery information, transaction records",
        "Communications: messages sent through the Eki platform, customer support enquiries, feedback and reviews",
        "Device Information: device type, operating system, IP address, browser information, app usage data",
      ],
    },
    {
      title: "3. Identity Verification",
      body: ["Where verification is required, Eki may collect and process government-issued identification, selfie or facial verification data, and verification results from third-party verification providers. Verification data may be processed by trusted third-party identity verification providers."],
    },
    {
      title: "4. How We Use Your Information",
      bullets: [
        "Create and manage accounts",
        "Verify user identities",
        "Process orders and transactions",
        "Provide customer support",
        "Improve platform functionality",
        "Detect fraud and suspicious activity",
        "Send service notifications",
        "Manage subscriptions",
        "Enforce our Terms and Conditions",
        "Comply with legal obligations",
      ],
    },
    {
      title: "5. Vendor Marketing Features",
      body: ["Eki provides vendors with tools that may allow them to contact customers who have previously interacted with their business, including promotional offers, product announcements, and customer re-engagement campaigns. Vendors are responsible for using these features lawfully and responsibly."],
    },
    {
      title: "6. Legal Basis For Processing",
      bullets: [
        "Performance of a contract",
        "Compliance with legal obligations",
        "Legitimate business interests",
        "User consent where required",
      ],
    },
    {
      title: "7. Sharing Information",
      body: ["We do not sell personal information."],
      bullets: [
        "Service Providers: cloud hosting, analytics, customer support providers",
        "Payment Providers: to facilitate payments and subscriptions",
        "Identity Verification Providers: to verify user identities",
        "Legal Authorities: where required by law or to protect our rights, users, or platform",
      ],
    },
    {
      title: "8. Data Retention",
      body: ["We retain information only as long as reasonably necessary to operate the platform, fulfil contractual obligations, resolve disputes, and meet legal and regulatory requirements. When information is no longer required, it will be securely deleted or anonymised."],
    },
    {
      title: "9. Security",
      body: ["We use reasonable technical and organisational measures to protect information against unauthorised access, loss, misuse, alteration, and disclosure. However, no online service can guarantee absolute security."],
    },
    {
      title: "10. International Transfers",
      body: ["Your information may be processed in countries outside the United Kingdom. Where international transfers occur, Eki will take reasonable steps to ensure appropriate safeguards are in place."],
    },
    {
      title: "11. Your Rights",
      bullets: [
        "Access your information",
        "Correct inaccurate information",
        "Request deletion of information",
        "Restrict processing",
        "Object to processing",
        "Withdraw consent where applicable",
        "Request data portability",
      ],
    },
    {
      title: "12. Cookies And Analytics",
      body: ["Eki may use cookies and similar technologies to improve user experience, understand platform usage, measure performance, and enhance security. Users may control cookies through browser settings where applicable."],
    },
    {
      title: "13. Children's Privacy",
      body: ["Eki is intended for users aged 18 years and older. We do not knowingly collect information from individuals under the age of 18."],
    },
    {
      title: "14. Changes To This Policy",
      body: ["We may update this Privacy Policy from time to time. Updated versions will be published within the platform and will become effective when posted."],
    },
    {
      title: "15. UK GDPR Rights",
      body: ["If you are located in the United Kingdom, you may also have the right to lodge a complaint with the Information Commissioner's Office (ICO): https://www.ico.org.uk. We encourage users to contact us first so we can attempt to resolve concerns directly."],
    },
    {
      title: "16. Contact Us",
      body: ["Ehimare Co, United Kingdom. Email: info@culinarytales.app"],
    },
  ],
};

const termsPage: PageDefinition = {
  title: "Terms & Conditions | Eki",
  description: "Terms and Conditions governing the use of the Eki platform.",
  eyebrow: "Terms",
  heading: "Terms & Conditions",
  intro:
    "These Terms and Conditions govern the use of the Eki platform, operated by Ehimare Co of 5 Marriott Street, Coundon, Coventry, CV6 1BB, England. By creating an account, accessing, or using Eki, you agree to be bound by these Terms.",
  actions: [
    { href: "/privacy", label: "Privacy Policy", variant: "secondary" },
    { href: "mailto:info@culinarytales.app", label: "Contact support" },
  ],
  sections: [
    {
      title: "1. About Eki",
      body: ["Eki is a technology platform that helps African foodstuff and ingredient vendors manage products, orders, customers, marketing campaigns, and business operations. Eki is not the seller of products listed on the platform. Transactions are conducted between buyers and vendors."],
    },
    {
      title: "2. Eligibility",
      bullets: [
        "Be at least 18 years old",
        "Provide accurate registration information",
        "Comply with all applicable laws and regulations",
        "Complete identity verification where required",
      ],
      body: ["We reserve the right to suspend or terminate accounts that fail verification requirements."],
    },
    {
      title: "3. Vendor Accounts",
      body: ["Vendors may list products, receive orders, manage customers, send promotional offers to previous customers, and access analytics and business tools. Vendors are solely responsible for product quality, descriptions, pricing, packaging, delivery arrangements, and compliance with food safety and import/export laws."],
    },
    {
      title: "4. Buyer Accounts",
      body: ["Buyers may browse products, place orders, make payments, and communicate with vendors through Eki. Buyers must provide accurate information when placing orders."],
    },
    {
      title: "5. Subscription",
      body: ["Eki may provide a limited free usage period. After the free usage period ends, continued access to vendor services may require an active subscription. Subscription fees are non-refundable except where required by law."],
    },
    {
      title: "6. Payments",
      body: ["Eki uses third-party payment providers. Eki does not store payment card details. Payment processing is subject to the terms of the applicable payment provider."],
    },
    {
      title: "7. Africa-Based Vendor Payment Protection",
      bullets: [
        "Funds may be released after delivery confirmation",
        "Funds may be released following successful OTP verification",
        "Funds may be released automatically after the applicable review period",
      ],
      body: ["Eki is not a bank, financial institution, or regulated escrow provider. Any payment protection process is a platform feature intended to facilitate trust between buyers and vendors."],
    },
    {
      title: "8. OTP Delivery Verification",
      bullets: [
        "An OTP may be generated for an order",
        "The OTP may be used to verify successful delivery",
        "Entering the correct OTP may constitute confirmation that goods have been received",
      ],
      body: ["Fraudulent use of OTP verification may result in account suspension."],
    },
    {
      title: "9. Vendor Marketing Features",
      body: ["Vendors may use Eki to send offers and promotional campaigns to customers who have previously interacted with their business. Vendors must use these features responsibly, comply with applicable privacy and marketing laws, and avoid misleading or deceptive communications. Eki may suspend access to marketing features where abuse is detected."],
    },
    {
      title: "10. Messaging",
      body: ["Eki currently supports text-based messaging. Users must not harass others, send abusive content, attempt fraud, distribute illegal material, or circumvent platform restrictions. Eki may monitor platform activity to protect users and enforce these Terms."],
    },
    {
      title: "11. Prohibited Products",
      body: ["The following may not be sold through Eki: illegal products, counterfeit goods, dangerous goods, restricted substances, and products prohibited by applicable laws. Eki may remove listings without notice."],
    },
    {
      title: "12. Account Suspension",
      body: ["We may suspend or terminate accounts where false information is provided, fraud is suspected, verification requirements are not met, or these Terms are violated."],
    },
    {
      title: "13. Intellectual Property",
      body: ["The Eki platform, branding, software, design, and content are owned by Ehimare Co and protected by intellectual property laws. Users may not copy, modify, distribute, or reverse engineer any part of the platform without permission."],
    },
    {
      title: "14. Limitation of Liability",
      body: ["Eki provides a technology platform only. To the maximum extent permitted by law, Eki shall not be liable for vendor conduct, buyer conduct, product quality, delivery delays, loss of profits, or indirect or consequential losses. Users transact at their own risk."],
    },
    {
      title: "15. Indemnity",
      body: ["Users agree to indemnify and hold harmless Ehimare Co from claims arising from their use of the platform, their products, their business activities, or breach of these Terms."],
    },
    {
      title: "16. Privacy",
      body: ["Use of Eki is subject to the Eki Privacy Policy."],
    },
    {
      title: "17. Changes to Terms",
      body: ["We may update these Terms from time to time. Continued use of Eki after updates constitutes acceptance of the revised Terms."],
    },
    {
      title: "18. Governing Law",
      body: ["These Terms shall be governed by and interpreted in accordance with the laws of England and Wales. Any disputes shall be subject to the exclusive jurisdiction of the courts of England and Wales.", "Contact: Ehimare Co, United Kingdom. Email: info@culinarytales.app"],
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

const refundPolicyPage: PageDefinition = {
  title: "Refund & Cancellation Policy | Eki",
  description: "How refunds, cancellations, and disputes are handled on the Eki platform.",
  eyebrow: "Refunds",
  heading: "Refund & Cancellation Policy",
  intro: "This Refund & Cancellation Policy explains how refunds, cancellations, subscriptions, disputes, and payment-related matters are handled on the Eki platform. By using Eki, you agree to this Policy.",
  actions: [
    { href: "/terms", label: "Terms & Conditions", variant: "secondary" },
    { href: "mailto:info@culinarytales.app", label: "Contact support" },
  ],
  sections: [
    { title: "1. About Eki", body: ["Eki is a technology platform operated by Ehimare Co, 5 Marriott Street, Coundon, Coventry, CV6 1BB, United Kingdom. Eki helps African foodstuff and ingredient vendors manage products, customers, orders, and business operations. Eki is not the seller of products listed on the platform. Transactions occur between buyers and vendors."] },
    { title: "2. Subscription Cancellation", body: ["Vendors may cancel their subscription at any time through their Eki account."], bullets: ["The subscription remains active until the end of the current billing period", "No further subscription charges will be made", "Access to vendor services may end when the billing period expires", "Cancelling a subscription does not automatically generate a refund"] },
    { title: "3. Subscription Refunds", body: ["Subscription fees are generally non-refundable."], bullets: ["Refunds may be issued where required by law, in cases of duplicate billing, in cases of proven billing errors, or at Eki's sole discretion", "No refunds for unused subscription periods, partial months, failure to use the platform, business performance expectations, or lack of sales"] },
    { title: "4. Vendor Product Refunds", body: ["Vendors are responsible for determining their own product refund policies, subject to applicable consumer protection laws. Buyers should review vendor policies before purchasing. Eki does not guarantee that refunds will be granted by vendors."] },
    { title: "5. Buyer Order Cancellations", body: ["Buyers may request cancellation before an order has been marked as dispatched by the vendor. If the vendor approves the cancellation, the order will be cancelled and eligible payments may be refunded. Once an order has been marked as dispatched, cancellation may not be possible."] },
    { title: "6. Africa-Based Vendor Transactions", bullets: ["Buyer funds may be temporarily held", "Funds may remain pending until delivery confirmation", "Funds may remain pending until successful OTP verification", "Funds may be released automatically according to platform rules"] },
    { title: "7. OTP Delivery Confirmation", body: ["Once a valid OTP has been entered, the order may be treated as successfully delivered, funds may be released to the vendor, and refund requests may be denied unless fraud or exceptional circumstances are proven."] },
    { title: "8. Non-Delivery Claims", body: ["Where a buyer claims an order was not received, Eki may review delivery status information, OTP verification records, order activity logs, communication history, and supporting evidence provided by both parties."] },
    { title: "9. Fraudulent Claims", body: ["Users must not submit false refund requests, false non-delivery claims, manipulate OTP verification, or misrepresent transaction facts. Fraudulent activity may result in account suspension, termination, restriction of platform access, or referral to relevant authorities."] },
    { title: "10. Failed Deliveries", body: ["Where delivery fails due to incorrect address information, buyer unavailability, or failure to provide necessary delivery information, the vendor may be entitled to payment for reasonable costs incurred."] },
    { title: "11. Platform Service Fees", body: ["Platform fees, transaction fees, and payment processing fees may not be refundable once services have been provided. Where refunds are issued, applicable processing costs may be deducted where permitted by law."] },
    { title: "12. Chargebacks", body: ["Buyers must contact Eki support before initiating a payment chargeback. Repeated abusive chargebacks may result in account suspension."] },
    { title: "13. Dispute Resolution", body: ["Where disputes arise between buyers and vendors, Eki may request evidence from both parties, review platform records, messaging history, and OTP records. Eki may facilitate communication but does not guarantee a particular outcome."] },
    { title: "14. Time Limits", body: ["Refund and dispute requests should be submitted as soon as possible. Eki may decline requests submitted after unreasonable delays where evidence can no longer be reliably verified."] },
    { title: "15. Limitation Of Liability", body: ["To the maximum extent permitted by law, Eki shall not be liable for product quality issues, shipping delays, delivery failures caused by third parties, vendor conduct, buyer conduct, loss of profits, or indirect or consequential losses."] },
    { title: "16. Governing Law", body: ["This Policy shall be governed by the laws of England and Wales. Any disputes shall be subject to the exclusive jurisdiction of the courts of England and Wales.", "Contact: Ehimare Co. Email: info@culinarytales.app"] },
  ],
};

const cookiePolicyPage: PageDefinition = {
  title: "Cookie Policy | Eki",
  description: "How Eki uses cookies and similar technologies.",
  eyebrow: "Cookies",
  heading: "Cookie Policy",
  intro: "This Cookie Policy explains how Ehimare Co uses cookies and similar technologies when you access or use the Eki website, mobile application, and related services.",
  actions: [
    { href: "/privacy", label: "Privacy Policy", variant: "secondary" },
  ],
  sections: [
    { title: "1. About Us", body: ["Ehimare Co, 5 Marriott Street, Coundon, Coventry, CV6 1BB, United Kingdom. Email: info@culinarytales.app"] },
    { title: "2. What Are Cookies?", body: ["Cookies are small text files stored on your device when you visit a website or use an application. Cookies help websites and applications function properly, remember user preferences, improve security, understand how users interact with services, and deliver a better user experience."] },
    { title: "3. How Eki Uses Cookies", bullets: ["Keep users signed in", "Remember user preferences", "Improve platform performance", "Measure usage and engagement", "Detect suspicious or fraudulent activity", "Improve security", "Support customer experience"] },
    { title: "4. Types Of Cookies We Use", bullets: ["Essential Cookies: necessary for authentication, secure sessions, fraud protection, and platform functionality", "Performance And Analytics Cookies: help understand how users interact with Eki, including pages visited, features used, and error reports", "Functionality Cookies: remember language preferences, device preferences, user settings, and personalisation options", "Security Cookies: detect suspicious activity, prevent unauthorised access, and support fraud prevention"] },
    { title: "5. Third-Party Cookies", body: ["Eki may use trusted third-party services that place cookies on your device, including analytics, authentication, payment processing, security, and customer support providers such as Google Analytics, Firebase Analytics, and Stripe."] },
    { title: "6. Mobile Application Technologies", body: ["Where Eki is used through a mobile application, similar technologies may be used instead of browser cookies, including device identifiers, SDKs, analytics technologies, and security technologies."] },
    { title: "7. Managing Cookies", body: ["Most web browsers allow users to view, delete, block, and control cookie preferences. Disabling certain cookies may affect the functionality of Eki."] },
    { title: "8. Do Not Track", body: ["Because there is currently no universally accepted standard for Do Not Track signals, Eki may not respond to Do Not Track requests."] },
    { title: "9. Data Protection", body: ["Information collected through cookies may be processed in accordance with the Eki Privacy Policy."] },
    { title: "10. Governing Law", body: ["This Cookie Policy shall be governed by the laws of England and Wales. Any disputes shall be subject to the exclusive jurisdiction of the courts of England and Wales.", "Contact: Ehimare Co. Email: info@culinarytales.app"] },
  ],
};

const subscriptionPolicyPage: PageDefinition = {
  title: "Subscription, Billing & Refund Policy | Eki",
  description: "Subscription, billing, fees, payments, and refunds on the Eki platform.",
  eyebrow: "Subscription",
  heading: "Subscription, Billing & Refund Policy",
  intro: "This Policy governs subscriptions, billing, fees, payments, and refunds relating to the Eki platform. By subscribing to Eki or using any paid services, you agree to this Policy.",
  actions: [
    { href: "/refund-policy", label: "Refund Policy", variant: "secondary" },
    { href: "mailto:info@culinarytales.app", label: "Contact support" },
  ],
  sections: [
    { title: "1. About Eki", body: ["Eki is a business operating platform designed for African foodstuff and ingredient vendors, providing tools for product management, customer management, order management, marketing, analytics, business automation, and payment facilitation."] },
    { title: "2. Free Vendor Access", body: ["New vendors may receive a limited free access period. Vendors may complete up to three (3) successful orders free of charge. After the free usage limit, a subscription may be required. Eki reserves the right to modify or withdraw free access programmes at any time."] },
    { title: "3. Subscription Plans", body: ["Subscription pricing will be displayed within the Eki platform. Plans may vary by country, vendor type, business category, and promotional offers. All subscription fees are shown before purchase."] },
    { title: "4. Subscription Billing", body: ["Subscriptions are billed in advance. Billing may occur monthly, quarterly, or annually. The subscription renews automatically unless cancelled before the next billing date."] },
    { title: "5. Automatic Renewal", body: ["By purchasing a subscription, you authorise Eki and its payment providers to charge your chosen payment method automatically at each renewal date. You may cancel automatic renewal at any time through your account settings."] },
    { title: "6. Transaction Fees", bullets: ["Payment processing fees", "Platform service fees", "Marketplace fees", "International transaction fees"], body: ["Applicable fees will be displayed before completion of the transaction."] },
    { title: "7. Payment Providers", body: ["Payments may be processed by Stripe and other approved payment processors. Use of payment services may also be subject to the provider's own terms. Eki does not store full payment card details."] },
    { title: "8. Failed Payments", bullets: ["Eki may retry the payment", "Access to vendor services may be restricted", "The subscription may be suspended until payment is successfully completed"], body: ["Eki reserves the right to terminate subscriptions for repeated failed payments."] },
    { title: "9. Refund Policy", body: ["Subscription fees are generally non-refundable once charged. Refunds will only be provided where required by applicable law, at Eki's sole discretion, in cases of duplicate billing, or in cases of verified billing errors. No partial refunds for unused subscription periods, partial months, reduced usage, or failure to use subscribed services."] },
    { title: "10. Vendor Earnings", body: ["Vendor earnings are separate from subscription payments. Subscription fees do not guarantee sales, customers, revenue, or business growth. Eki provides tools and technology only. Business performance remains the responsibility of the vendor."] },
    { title: "11. Africa-Based Vendor Payment Protection", bullets: ["Buyer payments may be temporarily held", "Funds may be released upon successful delivery confirmation", "Funds may be released following OTP verification", "Funds may be released automatically after applicable review periods"] },
    { title: "12. Pricing Changes", body: ["Eki reserves the right to change subscription pricing, introduce new plans, modify plan terms, and discontinue plans. Reasonable notice will be provided before material pricing changes."] },
    { title: "13. Cancellation", body: ["Vendors may cancel their subscription at any time. Access continues until end of current billing period. No further charges will be applied. No refund for unused portion unless required by law."] },
    { title: "14. Suspension And Termination", body: ["Eki may suspend or terminate subscriptions where payments fail repeatedly, fraud is suspected, platform policies are violated, or vendor verification requirements are not met. Suspension or termination does not automatically create entitlement to a refund."] },
    { title: "15. Governing Law", body: ["This Policy shall be governed by the laws of England and Wales. Any disputes shall be subject to the exclusive jurisdiction of the courts of England and Wales.", "Contact: Ehimare Co, United Kingdom. Email: info@culinarytales.app"] },
  ],
};

const acceptableUsePage: PageDefinition = {
  title: "Acceptable Use Policy | Eki",
  description: "Rules and standards for using the Eki platform.",
  eyebrow: "Acceptable Use",
  heading: "Acceptable Use Policy",
  intro: "This Acceptable Use Policy explains the rules and standards that apply when using the Eki platform. Failure to comply may result in suspension, restriction, or termination of your account.",
  actions: [
    { href: "/terms", label: "Terms & Conditions", variant: "secondary" },
  ],
  sections: [
    { title: "1. Purpose", body: ["Eki is designed to help African foodstuff and ingredient vendors manage products, customers, orders, and business operations. Users must use the platform lawfully, honestly, and respectfully."] },
    { title: "2. Prohibited Activities", bullets: ["Commit fraud", "Mislead buyers or vendors", "Impersonate another person or business", "Circumvent platform security measures", "Engage in unlawful activities", "Interfere with the operation of the platform"] },
    { title: "3. Fraud And Deceptive Conduct", bullets: ["Submit false information", "Use stolen identities", "Create fake accounts", "Misrepresent products", "Manipulate transactions", "Attempt to bypass verification requirements"], body: ["Any suspected fraud may result in immediate account suspension."] },
    { title: "4. Prohibited Products", bullets: ["Illegal products", "Counterfeit goods", "Stolen goods", "Dangerous or hazardous materials", "Controlled substances", "Weapons or weapon components", "Products prohibited by applicable law"], body: ["Eki reserves the right to remove listings without notice."] },
    { title: "5. Messaging Rules", body: ["Users must not send abusive messages, threats, harassment, hate speech, discriminatory content, fraudulent messages, or misleading information. Users must communicate respectfully at all times."] },
    { title: "6. Customer Marketing", body: ["Vendors may use Eki marketing tools to contact previous customers. Vendors must not spam customers, send excessive messages, send misleading promotions, use deceptive advertising, or harass customers. Repeated misuse may result in permanent removal of marketing privileges."] },
    { title: "7. Circumvention Of The Platform", body: ["Users may not attempt to manipulate platform fees, interfere with payment processes, exploit platform vulnerabilities, or use automated systems to abuse platform functionality."] },
    { title: "8. Account Security", body: ["Users are responsible for maintaining account security, protecting passwords, and preventing unauthorised access. Users must notify Eki immediately if they suspect unauthorised use of their account."] },
    { title: "9. Intellectual Property", body: ["Users may not copy Eki software, reverse engineer the platform, reproduce Eki branding without permission, or use Eki intellectual property in a misleading manner."] },
    { title: "10. Data Misuse", body: ["Users must not harvest customer data, scrape platform information, collect user information without permission, or use platform data for unlawful purposes."] },
    { title: "11. False Reviews And Manipulation", body: ["Users must not post fake reviews, manipulate ratings, create artificial engagement, or encourage fraudulent reviews."] },
    { title: "12. Enforcement", bullets: ["Content removal", "Listing removal", "Feature restrictions", "Temporary suspension", "Permanent account termination"], body: ["Action may be taken with or without prior notice where necessary to protect users or the platform."] },
    { title: "13. Contact", body: ["Users may report suspected violations through Eki support channels. Eki reserves the right to investigate any report and take appropriate action.", "Contact: Ehimare Co, United Kingdom. Email: info@culinarytales.app"] },
  ],
};

const vendorAgreementPage: PageDefinition = {
  title: "Vendor Agreement | Eki",
  description: "Agreement between Ehimare Co and vendors using the Eki platform.",
  eyebrow: "Vendor Agreement",
  heading: "Vendor Agreement",
  intro: "This Vendor Agreement is entered into between Ehimare Co and the vendor using the Eki platform. By creating a Vendor Account or listing products on Eki, you agree to be bound by this Agreement.",
  actions: [
    { href: "/terms", label: "Terms & Conditions", variant: "secondary" },
    { href: "/subscription-policy", label: "Subscription Policy", variant: "secondary" },
  ],
  sections: [
    { title: "1. Purpose", body: ["Eki provides software and business tools that enable vendors to list products, receive orders, manage customers, send promotional offers, track sales and analytics, and operate their business more efficiently. Eki is a technology platform and is not the seller of products listed by vendors."] },
    { title: "2. Vendor Eligibility", bullets: ["Be at least 18 years old", "Provide accurate information", "Complete identity verification when requested", "Have the legal right to sell the products you list", "Comply with all applicable laws"], body: ["Eki may refuse, suspend, or terminate vendor access at its discretion."] },
    { title: "3. Vendor Verification", body: ["Vendor verification may include government-issued identification, business information, address verification, and additional checks. Verification must be completed before access to certain platform services is granted. Providing false information may result in immediate account suspension."] },
    { title: "4. Vendor Responsibilities", bullets: ["Product quality", "Product descriptions", "Product pricing", "Inventory accuracy", "Packaging", "Shipping", "Customer service", "Compliance with food safety laws", "Compliance with import and export regulations"], body: ["Eki does not inspect or guarantee products listed by vendors."] },
    { title: "5. Product Listings", body: ["Vendors must ensure all listings are accurate, lawful, do not mislead buyers, and contain correct pricing and product information. Eki reserves the right to remove any listing at any time."] },
    { title: "6. Prohibited Products", body: ["Vendors may not sell illegal products, counterfeit products, restricted or controlled substances, dangerous goods prohibited by law, or any item prohibited by Eki policies. Violation may result in immediate removal and account termination."] },
    { title: "7. Orders", body: ["When a buyer places an order, the vendor is responsible for fulfilling the order, shipping or delivering within a reasonable timeframe, and keeping order status updated. Failure to fulfil orders may result in account restrictions."] },
    { title: "8. Africa-Based Vendor Payment Protection", bullets: ["Buyer funds may be temporarily held", "Funds may be released after successful delivery confirmation", "Funds may be released after successful OTP verification", "Funds may be released automatically after the applicable review period"], body: ["The vendor agrees that Eki may delay release of funds while delivery status is being verified."] },
    { title: "9. OTP Delivery Verification", body: ["For transactions using OTP verification, an OTP may be generated by Eki, used to confirm delivery, and successful confirmation may trigger release of funds. Fraudulent attempts to manipulate the OTP process may result in permanent suspension."] },
    { title: "10. Customer Marketing Features", body: ["Eki may provide tools allowing vendors to contact previous buyers, send offers, promote products, and re-engage inactive customers. Vendors agree not to send misleading messages, not to harass customers, not to abuse marketing tools, and to comply with applicable marketing laws."] },
    { title: "11. Vendor Subscription", body: ["Vendors may receive a limited free usage period. Following the free period, continued access may require an active subscription. Subscription fees are billed in advance, are non-refundable except where required by law, and may be changed with reasonable notice."] },
    { title: "12. Platform Fees", body: ["Eki may charge subscription fees, transaction fees, and service fees. Applicable fees will be disclosed within the platform. The Vendor authorises Eki to deduct applicable fees where permitted."] },
    { title: "13. Customer Relationships", body: ["Customers acquired through Eki remain customers of the Vendor. However, Eki retains ownership of the platform, technology and infrastructure. Vendors may not copy, scrape, or misuse platform data."] },
    { title: "14. Vendor Conduct", body: ["Vendors must not engage in fraud, manipulate reviews, mislead buyers, circumvent platform processes, abuse other users, or use Eki for unlawful activities. Violations may result in suspension or termination."] },
    { title: "15. Suspension And Termination", body: ["Eki may suspend or terminate vendor accounts for fraud, verification failures, policy violations, abuse of customers, repeated customer complaints, or non-payment of subscription fees. Termination may result in removal of listings and restricted platform access."] },
    { title: "16. Intellectual Property", body: ["All Eki branding, software, systems, content, and technology remain the property of Ehimare Co. Nothing in this Agreement transfers ownership of Eki intellectual property to vendors."] },
    { title: "17. Limitation Of Liability", body: ["To the maximum extent permitted by law, Eki shall not be liable for lost profits, product defects, shipping delays, customer disputes, business interruption, or indirect or consequential damages. Eki provides software and technology services only."] },
    { title: "18. Indemnity", body: ["The Vendor agrees to indemnify and hold harmless Ehimare Co from claims arising from products sold, vendor conduct, regulatory violations, customer disputes, or breach of this Agreement."] },
    { title: "19. Changes To This Agreement", body: ["Eki may update this Agreement from time to time. Continued use of the platform constitutes acceptance of updated terms."] },
    { title: "20. Governing Law", body: ["This Agreement shall be governed by the laws of England and Wales. Any disputes shall be subject to the exclusive jurisdiction of the courts of England and Wales.", "Contact: Ehimare Co, United Kingdom. Email: info@culinarytales.app"] },
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
  <title>Business Portal | Eki</title>
  <meta name="description" content="Manage your Eki vendor account, billing, and services." />
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
    .terms-row{display:flex;align-items:flex-start;gap:10px;margin-top:18px;font-size:13px;color:#66736d;line-height:1.45}.terms-row input[type=checkbox]{width:18px;height:18px;margin-top:2px;accent-color:#076b51;flex-shrink:0;cursor:pointer}.terms-row a{color:#076b51;text-decoration:underline}
    .checkout{width:100%;height:56px;margin-top:14px;border:0;border-radius:15px;background:#076b51;color:#fff;font-weight:800;cursor:pointer}.checkout:disabled{opacity:.6;cursor:not-allowed}
    @media(max-width:820px){.layout{grid-template-columns:1fr;margin-top:12px}.intro{min-height:auto;padding:30px}h1{font-size:38px}.panel{max-width:none}}
    @media(max-width:520px){.nav,.layout{padding-left:14px;padding-right:14px}.intro,.panel{border-radius:18px}.intro{padding:24px}h1{font-size:32px}.panel{padding:18px}}
  </style>
</head>
<body>
  <nav class="nav"><a class="logo" href="/">eki</a><a class="home" href="/">Home â†’</a></nav>
  <main class="layout">
    <section class="intro">
      <span class="eyebrow">Business Portal</span>
      <h1>Manage your vendor account.</h1>
      <p>Enter the same email used for your Eki vendor account. After payment is confirmed, your vendor services update automatically in the app.</p>
      <div class="trust">Secure billing portal. Vendor account payments are processed through Stripe, not inside the Eki mobile app.</div>
    </section>
    <section class="panel">
      <h2>Choose vendor services</h2>
      <p class="sub">Billing starts on Stripe after you confirm. Your vendor account updates automatically.</p>
      <div id="notice" class="status"></div>
      <form id="checkout-form">
        <label for="email">Vendor account email</label>
        <input id="email" name="email" type="email" autocomplete="email" placeholder="vendor@eki.app" required />
        <div id="plans" class="plans"><div class="sub">Loading plans...</div></div>
        <div id="summary" class="summary" hidden>Selected<strong></strong></div>
        <div id="error" class="status"></div>
        <label class="terms-row"><input type="checkbox" id="terms-check" /><span>I agree to the <a href="/terms" target="_blank">Terms &amp; Conditions</a>, <a href="/subscription-policy" target="_blank">Billing Policy</a>, and <a href="/privacy" target="_blank">Privacy Policy</a>.</span></label>
        <button id="checkout-button" class="checkout" type="submit" disabled>Continue to Stripe</button>
      </form>
    </section>
  </main>
  <script>
    const plansNode=document.getElementById('plans'),notice=document.getElementById('notice'),errorNode=document.getElementById('error'),summary=document.getElementById('summary'),summaryValue=summary.querySelector('strong'),emailInput=document.getElementById('email'),checkoutButton=document.getElementById('checkout-button'),form=document.getElementById('checkout-form'),termsCheck=document.getElementById('terms-check');
    let plans=[],selected='GROWTH';
    const params=new URLSearchParams(location.search);emailInput.value=params.get('email')||'';
    if(params.get('success')==='true')show(notice,'Payment received. Open the Eki app and refresh your vendor account.','ok');
    else if(params.get('cancelled')==='true')show(notice,'Payment was cancelled. You can start again when ready.','warn');
    function show(node,text,type){node.textContent=text;node.className='status '+type}
    function clear(node){node.textContent='';node.className='status'}
    function esc(value){return String(value||'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char])}
    function money(plan){return new Intl.NumberFormat('en-GB',{style:'currency',currency:plan.currency||'GBP',maximumFractionDigits:0}).format(Number(plan.monthlyPriceCents||0)/100)}
    function planId(plan){const value=String(plan.plan||plan.id||'').toUpperCase();return value==='GROWTH'||value==='PRO'?value:null}
    function render(){plansNode.innerHTML=plans.map(plan=>{const id=planId(plan),active=id===selected,features=[plan.maxProducts===-1?'Unlimited active products':plan.maxProducts+' active products',plan.analytics?'Analytics access':'Basic dashboard',plan.discounts?'Discount campaigns':'Standard listings',plan.prioritySupport?'Priority support':'Standard support'];return '<button type="button" class="plan '+(active?'active':'')+'" data-plan="'+id+'"><div class="plan-head"><div><div class="plan-name">'+esc(plan.name||id)+'</div><div class="fee">'+esc(((Number(plan.platformFeeBps||0)/100).toFixed(2).replace(/\\.00$/,'')+'%'))+' platform fee per order</div></div><span class="radio">'+(active?'âœ“':'')+'</span></div><div class="price">'+esc(money(plan))+' <small>/ month</small></div><ul class="features">'+features.map(item=>'<li>'+esc(item)+'</li>').join('')+'</ul></button>'}).join('');plansNode.querySelectorAll('[data-plan]').forEach(button=>button.addEventListener('click',()=>{selected=button.dataset.plan;render()}));const active=plans.find(plan=>planId(plan)===selected);summary.hidden=!active;if(active)summaryValue.textContent=(active.name||selected)+' - '+money(active)+'/month';checkoutButton.disabled=!active||!termsCheck.checked}
    termsCheck.addEventListener('change',render)
    fetch('/api/subscriptions/plans').then(response=>response.json().then(data=>({response,data}))).then(({response,data})=>{if(!response.ok)throw new Error(data.message||'Unable to load plans.');plans=(Array.isArray(data.plans)?data.plans:[]).filter(plan=>planId(plan));if(!plans.some(plan=>planId(plan)===selected)&&plans[0])selected=planId(plans[0]);render();if(!plans.length)show(errorNode,'No paid plans are currently available.','error')}).catch(error=>{plansNode.innerHTML='';show(errorNode,error.message||'Unable to load plans.','error')});
    form.addEventListener('submit',async event=>{event.preventDefault();clear(errorNode);if(!termsCheck.checked){show(errorNode,'You must agree to the Terms & Conditions and Billing Policy to continue.','error');return}const email=emailInput.value.trim().toLowerCase();if(!email){show(errorNode,'Enter the email used by your Eki vendor account.','error');return}checkoutButton.disabled=true;checkoutButton.textContent='Opening secure billing...';try{const response=await fetch('/api/subscriptions/web-checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,plan:selected})});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.message||'Could not start checkout.');if(!data.checkoutUrl)throw new Error('Checkout URL was not returned.');location.assign(data.checkoutUrl)}catch(error){show(errorNode,error.message||'Could not start checkout.','error');checkoutButton.disabled=false;checkoutButton.textContent='Continue to Stripe'}});
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

export async function getPublicRefundPolicyPage(_request: Request, response: Response): Promise<void> {
  sendPage(response, refundPolicyPage);
}

export async function getPublicCookiePolicyPage(_request: Request, response: Response): Promise<void> {
  sendPage(response, cookiePolicyPage);
}

export async function getPublicSubscriptionPolicyPage(_request: Request, response: Response): Promise<void> {
  sendPage(response, subscriptionPolicyPage);
}

export async function getPublicAcceptableUsePage(_request: Request, response: Response): Promise<void> {
  sendPage(response, acceptableUsePage);
}

export async function getPublicVendorAgreementPage(_request: Request, response: Response): Promise<void> {
  sendPage(response, vendorAgreementPage);
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



