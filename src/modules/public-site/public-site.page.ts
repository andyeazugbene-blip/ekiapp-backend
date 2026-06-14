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
  const today = new Date().toLocaleDateString('en-GB',{month:'short',day:'numeric',year:'numeric'});
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#164F3F" />
  <title>${escape(page.title)}</title>
  <meta name="description" content="${escape(page.description)}" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" />
  <style>
    *,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:0}
    body{background:#FAFBFA;color:#111;font-family:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
    a{color:inherit;text-decoration:none}
    .hero-wrap{background:linear-gradient(135deg,#0C3B2E 0%,#164F3F 40%,#1B6B4E 100%);color:#fff;overflow:hidden;position:relative}
    .hero-wrap::before{content:'';position:absolute;top:-40%;right:-20%;width:600px;height:600px;background:radial-gradient(circle,rgba(255,255,255,.04) 0%,transparent 70%);pointer-events:none}
    .hero-wrap::after{content:'';position:absolute;bottom:-30%;left:-10%;width:500px;height:500px;background:radial-gradient(circle,rgba(46,165,110,.12) 0%,transparent 70%);pointer-events:none}
    .shell{width:min(1160px,calc(100% - 40px));margin:0 auto;position:relative;z-index:1}
    .topbar{height:56px;display:flex;align-items:center;justify-content:space-between;gap:18px;border-bottom:1px solid rgba(255,255,255,.06)}
    .brand{font-weight:800;font-size:18px;letter-spacing:-.02em;color:#fff;display:flex;align-items:center;gap:8px}
    .brand-dot{width:10px;height:10px;border-radius:3px;background:#2DBB74;display:inline-block}
    .toplinks{display:flex;align-items:center;gap:24px;color:rgba(255,255,255,.7);font-size:13px;font-weight:500}
    .toplinks a{transition:color .2s}.toplinks a:hover{color:#fff}.toplinks .active{color:#fff;font-weight:600}
    .btn-header{height:34px;padding:0 16px;border-radius:8px;background:#2DBB74;color:#fff;font-size:12px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;transition:background .2s,transform .15s;margin-left:8px}
    .btn-header:hover{background:#35CC7D;transform:translateY(-1px)}
    .hero{display:grid;grid-template-columns:1fr 1fr;align-items:center;gap:40px;padding:32px 0 60px;min-height:520px}
    .hero-left{max-width:540px}
    .hero-badge{display:inline-flex;align-items:center;gap:6px;background:rgba(45,187,116,.15);border:1px solid rgba(45,187,116,.25);border-radius:999px;padding:5px 12px 5px 8px;font-size:11px;font-weight:600;color:#8AE0B0;margin-bottom:20px}
    .hero-badge-dot{width:6px;height:6px;border-radius:3px;background:#2DBB74}
    h1{margin:0;font-size:52px;line-height:1.04;letter-spacing:-.045em;font-weight:900;max-width:500px}
    h1 span{color:#2DBB74}
    .hero-sub{margin:16px 0 0;max-width:440px;color:rgba(255,255,255,.75);font-size:15px;line-height:1.55}
    .hero-buttons{display:flex;gap:10px;margin-top:28px;flex-wrap:wrap}
    .hero-btn{display:inline-flex;align-items:center;gap:8px;height:48px;padding:0 20px;border-radius:10px;font-size:13px;font-weight:700;transition:all .2s cubic-bezier(.34,1.56,.64,1)}
    .hero-btn-apple{background:#fff;color:#0C3B2E}.hero-btn-apple:hover{transform:translateY(-2px);box-shadow:0 12px 28px rgba(0,0,0,.2)}
    .hero-btn-google{background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(255,255,255,.15)}.hero-btn-google:hover{background:rgba(255,255,255,.16);transform:translateY(-2px)}
    .hero-btn-icon{font-size:18px;line-height:1}
    .hero-btn-text{display:flex;flex-direction:column;line-height:1.2}.hero-btn-small{font-size:8px;font-weight:500;opacity:.65;letter-spacing:.02em}.hero-btn-main{font-size:14px;font-weight:700}
    .hero-right{display:flex;align-items:center;justify-content:center;position:relative;min-height:460px}
    .phone-wrapper{position:relative;transform:scale(1);transition:transform .4s cubic-bezier(.34,1.56,.64,1)}.phone-wrapper:hover{transform:scale(1.02) translateY(-6px)}
    .phone-frame{width:280px;background:#1C1C1E;border-radius:44px;padding:10px;box-shadow:0 40px 80px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.08);position:relative}
    .phone-di{position:absolute;top:18px;left:50%;transform:translateX(-50%);z-index:3;background:#0D0D0D;padding:3px 12px;border-radius:18px;height:22px;min-width:80px;display:flex;align-items:center;gap:5px;justify-content:center}
    .phone-di-camera{width:6px;height:6px;border-radius:50%;background:#333}.phone-di-sensor{width:14px;height:4px;border-radius:2px;background:#1A1A1A}
    .phone-screen{background:#F7F8F6;border-radius:34px;overflow:hidden}
    .phone-status{display:flex;justify-content:space-between;padding:18px 20px 2px;font-size:9px;font-weight:700;color:#111;background:#fff;letter-spacing:.02em}
    .phone-header{background:#164F3F;color:#fff;padding:8px 14px 12px;display:flex;justify-content:space-between;align-items:center}
    .phone-hl{display:flex;flex-direction:column;gap:1px}.phone-hg{font-size:10px;font-weight:600;opacity:.8}.phone-hd{font-size:7px;opacity:.5}
    .phone-avatar{width:24px;height:24px;border-radius:12px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.08);display:grid;place-items:center;font-weight:700;font-size:9px}
    .phone-bal{background:#164F3F;padding:0 14px 12px;color:#fff}
    .phone-bal-label{font-size:7px;font-weight:600;text-transform:uppercase;opacity:.55;letter-spacing:.04em}
    .phone-bal-amt{font-size:20px;font-weight:800;margin-top:1px;letter-spacing:-.03em}
    .phone-bal-chg{font-size:7px;opacity:.45;margin-top:1px}
    .phone-grid{padding:8px 8px 4px;display:grid;grid-template-columns:1fr 1fr;gap:5px}
    .phone-tile{background:#fff;border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,.03)}
    .phone-tile-dk{background:#164F3F;color:#fff}
    .phone-tl{font-size:7px;font-weight:700;opacity:.45;text-transform:uppercase;letter-spacing:.04em}
    .phone-tv{font-size:14px;font-weight:800;margin-top:1px;letter-spacing:-.02em}
    .phone-ts{font-size:6px;opacity:.4;margin-top:1px}
    .phone-tag{font-size:9px;font-weight:800;padding:6px 12px 2px;color:#111}
    .phone-ins{display:grid;grid-template-columns:1fr 1fr;gap:5px;padding:0 8px 6px}
    .phone-in{background:#fff;border-radius:8px;padding:6px 8px;display:flex;align-items:center;gap:5px;box-shadow:0 1px 2px rgba(0,0,0,.02)}
    .phone-in-dot{width:5px;height:5px;border-radius:2.5px}
    .phone-in-txt{font-size:7px;font-weight:600;color:#555;line-height:1.2}
    .phone-tabs{display:flex;justify-content:space-around;padding:4px 4px 2px;background:#fff;border-top:1px solid #f0f0f0}
    .phone-tab{display:flex;flex-direction:column;align-items:center;gap:1px;font-size:6px;font-weight:700;color:#999}.phone-tab.act{color:#164F3F}
    .phone-tab-ic{width:14px;height:14px;border-radius:4px;background:#e8ece9;display:grid;place-items:center;font-size:7px;color:#777}
    .phone-tab.act .phone-tab-ic{background:#164F3F;color:#fff}
    .phone-home{height:2.5px;width:80px;background:#ddd;border-radius:2px;margin:2px auto}
    .phone-deco{position:absolute;pointer-events:none;z-index:0}
    .phone-deco-1{width:44px;height:44px;border:1.5px solid rgba(255,255,255,.1);border-radius:14px;transform:rotate(20deg);top:2%;left:-18%}
    .phone-deco-2{width:22px;height:22px;background:rgba(255,255,255,.06);border-radius:50%;top:15%;right:-12%}
    .phone-deco-3{width:64px;height:64px;border:1px solid rgba(255,255,255,.06);border-radius:50%;bottom:10%;left:-15%}
    .phone-deco-4{width:16px;height:16px;background:rgba(255,255,255,.08);border-radius:3px;transform:rotate(45deg);bottom:18%;right:-10%}
    .phone-deco-5{width:70px;height:1.5px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.04),transparent);bottom:4%;left:50%;transform:translateX(-50%)}
    .phone-deco-6{position:absolute;top:18%;left:55%;width:120px;height:120px;background:radial-gradient(circle,rgba(45,187,116,.06),transparent 70%);border-radius:50%;pointer-events:none}
    .content{background:#FAFBFA;padding:56px 0 72px}
    .ch{text-align:center;margin-bottom:36px}
    .ck{display:inline-flex;align-items:center;gap:6px;background:rgba(22,79,63,.08);border-radius:999px;padding:5px 14px 5px 10px;font-size:11px;font-weight:700;color:#164F3F}
    .ck-dot{width:5px;height:5px;border-radius:2.5px;background:#2DBB74}
    .ct{font-size:32px;font-weight:900;letter-spacing:-.03em;margin:12px 0 0;color:#111}
    .cs{margin:8px 0 0;color:#888;font-size:14px;max-width:520px;margin-left:auto;margin-right:auto}
    .features{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-top:8px}
    .fc{background:#fff;border:1px solid #eef1f0;border-radius:16px;padding:22px;transition:all .25s ease;position:relative;overflow:hidden}
    .fc:hover{border-color:#c5d6ce;box-shadow:0 8px 24px rgba(0,0,0,.04);transform:translateY(-2px)}
    .fc::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#164F3F,#2DBB74);opacity:0;transition:opacity .25s}
    .fc:hover::before{opacity:1}
    .fi{width:40px;height:40px;border-radius:10px;background:#EDF7F1;display:grid;place-items:center;font-size:18px;margin-bottom:14px}
    .ft{font-size:15px;font-weight:800;letter-spacing:-.02em;color:#111}
    .fb{margin:6px 0 0;color:#888;font-size:12px;line-height:1.5}
    .cta{margin-top:44px;background:linear-gradient(135deg,#0C3B2E,#1B6B4E);border-radius:20px;padding:40px 48px;display:flex;align-items:center;justify-content:space-between;gap:24px}
    .cta-l{color:#fff}.cta-t{font-size:22px;font-weight:800;letter-spacing:-.02em}
    .cta-s{margin:6px 0 0;color:rgba(255,255,255,.7);font-size:13px;max-width:400px;line-height:1.5}
    .cta-btn{height:44px;padding:0 24px;border-radius:10px;background:#2DBB74;color:#fff;font-size:13px;font-weight:700;border:0;cursor:pointer;display:inline-flex;align-items:center;gap:6px;text-decoration:none;transition:background .2s,transform .15s;white-space:nowrap}
    .cta-btn:hover{background:#35CC7D;transform:translateY(-1px)}
    .footer{background:#111;color:rgba(255,255,255,.6);padding:24px 0;font-size:12px}
    .fi2{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
    .fl{display:flex;gap:18px}.fl a{transition:color .15s}.fl a:hover{color:#fff}.fb2{font-weight:700;color:rgba(255,255,255,.8)}
    @media(max-width:960px){.hero{grid-template-columns:1fr;text-align:center;padding:32px 0 40px;min-height:auto}.hero-left{max-width:none}.hero-sub{margin-left:auto;margin-right:auto}.hero-buttons{justify-content:center}.hero-right{min-height:400px}.phone-wrapper{transform:scale(.9)}.features{grid-template-columns:1fr 1fr}.cta{flex-direction:column;text-align:center;padding:32px}.cta-s{margin-left:auto;margin-right:auto}}
    @media(max-width:640px){h1{font-size:34px}.hero{padding:24px 0 20px}.hero-right{min-height:340px;overflow:hidden}.phone-wrapper{transform:scale(.72)}.phone-deco-1,.phone-deco-2,.phone-deco-3,.phone-deco-4,.phone-deco-6{display:none}.features{grid-template-columns:1fr}.ct{font-size:26px}.cta{padding:24px;border-radius:14px}}
    @media(max-width:400px){.phone-wrapper{transform:scale(.6)}.hero-right{min-height:300px}}
  </style>
</head>
<body>
  <div class="hero-wrap">
    <header class="shell topbar">
      <a class="brand" href="/"><span class="brand-dot"></span> Eki</a>
      <nav class="toplinks">
        <a href="/store">Vendors</a>
        <a href="/find-order">Track order</a>
        <a href="/vendor">Vendor portal</a>
        <a href="/help">Support</a>
        <a class="btn-header" href="https://apps.apple.com/app/id6776307497">Download</a>
      </nav>
    </header>
    <main class="shell hero">
      <section class="hero-left">
        <div class="hero-badge"><span class="hero-badge-dot"></span> African foodstuff marketplace</div>
        <h1>${escape(page.heading)}</h1>
        <p class="hero-sub">${escape(page.intro)}</p>
        <div class="hero-buttons">
          <a class="hero-btn hero-btn-apple" href="https://apps.apple.com/app/id6776307497">
            <span class="hero-btn-icon">🍎</span>
            <span class="hero-btn-text"><span class="hero-btn-small">Download on the</span><span class="hero-btn-main">App Store</span></span>
          </a>
          <a class="hero-btn hero-btn-google" href="https://play.google.com/store/apps/details?id=com.ekiapp.mobile">
            <span class="hero-btn-icon">▶</span>
            <span class="hero-btn-text"><span class="hero-btn-small">Get it on</span><span class="hero-btn-main">Google Play</span></span>
          </a>
        </div>
      </section>
      <section class="hero-right">
        <div class="phone-deco phone-deco-1"></div><div class="phone-deco phone-deco-2"></div>
        <div class="phone-deco phone-deco-3"></div><div class="phone-deco phone-deco-4"></div>
        <div class="phone-deco phone-deco-5"></div><div class="phone-deco phone-deco-6"></div>
        <div class="phone-wrapper">
          <div class="phone-frame">
            <div class="phone-di"><div class="phone-di-sensor"></div><div class="phone-di-camera"></div></div>
            <div class="phone-screen">
              <div class="phone-status"><span>9:41</span><span style="opacity:.4">●●●●○</span></div>
              <div class="phone-header">
                <div class="phone-hl"><span class="phone-hg">Good morning 👋</span><span class="phone-hd">${today}</span></div>
                <div class="phone-avatar">Q</div>
              </div>
              <div class="phone-bal">
                <div class="phone-bal-label">Available balance</div>
                <div class="phone-bal-amt">€4,280</div>
                <div class="phone-bal-chg">↑ €320 earned this week</div>
              </div>
              <div class="phone-grid">
                <div class="phone-tile"><div class="phone-tl">Sales today</div><div class="phone-tv">€143</div><div class="phone-ts">+12% vs yesterday</div></div>
                <div class="phone-tile phone-tile-dk"><div class="phone-tl">This week</div><div class="phone-tv">€2,456</div><div class="phone-ts" style="opacity:.5">3 orders pending</div></div>
                <div class="phone-tile"><div class="phone-tl">Pending payout</div><div class="phone-tv">€890</div><div class="phone-ts">After delivery</div></div>
                <div class="phone-tile"><div class="phone-tl">This month</div><div class="phone-tv">€8,340</div><div class="phone-ts">12 orders</div></div>
              </div>
              <div class="phone-tag">Business Insights</div>
              <div class="phone-ins">
                <div class="phone-in"><div class="phone-in-dot" style="background:#10b981"></div><div class="phone-in-txt">3 new orders today</div></div>
                <div class="phone-in"><div class="phone-in-dot" style="background:#3b82f6"></div><div class="phone-in-txt">Buyer messages (2)</div></div>
              </div>
              <div class="phone-tabs">
                <div class="phone-tab act"><div class="phone-tab-ic">⬡</div>Home</div>
                <div class="phone-tab"><div class="phone-tab-ic">⊞</div>Orders</div>
                <div class="phone-tab"><div class="phone-tab-ic">◉</div>Shop</div>
                <div class="phone-tab"><div class="phone-tab-ic">✉</div>Inbox</div>
                <div class="phone-tab"><div class="phone-tab-ic">⚙</div>Profile</div>
              </div>
              <div class="phone-home"></div>
            </div>
          </div>
        </div>
      </section>
    </main>
  </div>
  <section class="content"><div class="shell">
    <div class="ch"><div class="ck"><span class="ck-dot"></span> How it works</div>
    <h2 class="ct">Built for African foodstuff vendors</h2>
    <p class="cs">Everything you need to manage your store, track orders, and grow your business from one dashboard.</p></div>
    <div class="features">
      <div class="fc"><div class="fi">🛍️</div><div class="ft">Shop from verified vendors</div><div class="fb">Every vendor reviewed before listing. Buy with confidence knowing each store is vetted.</div></div>
      <div class="fc"><div class="fi">📦</div><div class="ft">Live order tracking</div><div class="fb">Follow every order from confirmation to delivery with real-time push notifications.</div></div>
      <div class="fc"><div class="fi">💳</div><div class="ft">Secure Eki checkout</div><div class="fb">Pay by card or wallet. Your payment is protected until you confirm delivery.</div></div>
      <div class="fc"><div class="fi">⚡</div><div class="ft">One-tap reorder</div><div class="fb">Save favourite vendors and reorder in seconds. No need to re-enter details.</div></div>
    </div>
    <div class="cta"><div class="cta-l"><div class="cta-t">Start selling on Eki today</div><div class="cta-s">Create your vendor profile in minutes. Share your store link, receive orders, and get paid.</div></div><a class="cta-btn" href="/vendor">Open vendor portal →</a></div>
  </div></section>
  <footer class="footer"><div class="shell fi2">
    <span class="fb2">Eki marketplace</span>
    <div class="fl"><a href="/store">Vendors</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/help">Help</a><a href="/find-order">Find order</a></div>
    <span>© ${new Date().getFullYear()} Eki</span>
  </div></footer>
</body></html>`;
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
    .features{margin:12px 0 0;padding:0;list-style:none;color:#34423c;font-size:13px;line-height:1.6}.features li:before{content:"✓";color:#076b51;font-weight:800;margin-right:8px}
    .radio{width:23px;height:23px;border:1px solid #b7c6bf;border-radius:50%;display:grid;place-items:center;color:#fff}.active .radio{background:#076b51;border-color:#076b51}
    .status{display:none;margin:16px 0 0;padding:12px;border-radius:12px;font-size:13px;line-height:1.4}.status.ok{display:block;background:#eaf8ef;border:1px solid #cbeed9;color:#076b51}.status.warn{display:block;background:#fff7e8;border:1px solid #f2d399;color:#8d5100}.status.error{display:block;background:#fff0f0;border:1px solid #f3caca;color:#a62e2e}
    .summary{margin-top:18px;padding:14px;border-radius:13px;background:#f6f8f7;font-size:13px;color:#66736d}.summary strong{display:block;margin-top:4px;color:#0d1b16;font-size:15px}
    .checkout{width:100%;height:56px;margin-top:18px;border:0;border-radius:15px;background:#076b51;color:#fff;font-weight:800;cursor:pointer}.checkout:disabled{opacity:.6;cursor:not-allowed}
    @media(max-width:820px){.layout{grid-template-columns:1fr;margin-top:12px}.intro{min-height:auto;padding:30px}h1{font-size:38px}.panel{max-width:none}}
    @media(max-width:520px){.nav,.layout{padding-left:14px;padding-right:14px}.intro,.panel{border-radius:18px}.intro{padding:24px}h1{font-size:32px}.panel{padding:18px}}
  </style>
</head>
<body>
  <nav class="nav"><a class="logo" href="/">eki</a><a class="home" href="/">Home →</a></nav>
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
    function render(){plansNode.innerHTML=plans.map(plan=>{const id=planId(plan),active=id===selected,features=[plan.maxProducts===-1?'Unlimited active products':plan.maxProducts+' active products',plan.analytics?'Analytics access':'Basic dashboard',plan.discounts?'Discount campaigns':'Standard listings',plan.prioritySupport?'Priority support':'Standard support'];return '<button type="button" class="plan '+(active?'active':'')+'" data-plan="'+id+'"><div class="plan-head"><div><div class="plan-name">'+esc(plan.name||id)+'</div><div class="fee">'+esc(((Number(plan.platformFeeBps||0)/100).toFixed(2).replace(/\\.00$/,'')+'%'))+' platform fee per order</div></div><span class="radio">'+(active?'✓':'')+'</span></div><div class="price">'+esc(money(plan))+' <small>/ month</small></div><ul class="features">'+features.map(item=>'<li>'+esc(item)+'</li>').join('')+'</ul></button>'}).join('');plansNode.querySelectorAll('[data-plan]').forEach(button=>button.addEventListener('click',()=>{selected=button.dataset.plan;render()}));const active=plans.find(plan=>planId(plan)===selected);summary.hidden=!active;if(active)summaryValue.textContent=(active.name||selected)+' - '+money(active)+'/month';checkoutButton.disabled=!active}
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

function renderVendorPortalLayout(): string { return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="theme-color" content="#164F3F">
<title>Vendor Portal | Eki</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" />
<style>
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:#F5F6F5;color:#111;font-family:'Inter',sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
.shell{width:min(1120px,calc(100% - 24px));margin:0 auto}
.topbar{height:48px;background:#fff;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;padding:0 max(12px,calc((100vw - 1120px)/2))}
.brand{font-weight:800;font-size:14px;color:#164F3F;display:flex;align-items:center;gap:6px}
.brand-dot{width:8px;height:8px;border-radius:4px;background:#164F3F;display:inline-block}
.toplinks{display:flex;gap:16px;font-size:12px;font-weight:600;color:#666}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:18px;box-shadow:0 1px 6px rgba(0,0,0,.04)}
.btn{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 16px;border-radius:8px;font-weight:700;font-size:12px;border:0;cursor:pointer}
.btn-primary{background:#164F3F;color:#fff}
.btn-primary:hover{background:#1d664c}
.btn-secondary{background:#fff;color:#164F3F;border:1px solid #dce3e0}
.input{width:100%;height:42px;border:1px solid #dce3e0;border-radius:8px;padding:0 12px;font-size:13px;outline:none}
.input:focus{border-color:#164F3F;box-shadow:0 0 0 3px rgba(22,79,63,.1)}
.msg{display:none;padding:10px 12px;border-radius:8px;font-size:12px;margin-bottom:12px}
.msg.err{display:block;background:#fff0f0;border:1px solid #f3caca;color:#a62e2e}
.msg.ok{display:block;background:#eaf8ef;border:1px solid #cbeed9;color:#076b51}
.hidden{display:none!important}
.loading{text-align:center;padding:40px;color:#999;font-size:13px}
.grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.stat-card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:14px}
.stat-label{font-size:11px;color:#999;font-weight:600;text-transform:uppercase}
.stat-value{font-size:24px;font-weight:800;margin-top:3px;color:#111}
.stat-sub{font-size:11px;color:#aaa;margin-top:2px}
.login-page{min-height:100vh;display:grid;place-items:center;padding:24px}
.login-card{width:min(100%,380px);background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:28px;box-shadow:0 8px 24px rgba(0,0,0,.06)}
.login-logo{width:40px;height:40px;border-radius:10px;background:#164F3F;color:#fff;display:grid;place-items:center;font-weight:800;margin-bottom:18px}
.login-title{font-size:22px;font-weight:800;letter-spacing:-.03em}
.login-sub{color:#999;font-size:13px;margin:4px 0 18px}
.form-group{margin-bottom:14px}
.form-group label{display:block;font-size:12px;font-weight:700;margin-bottom:5px;color:#444}
.dash-grid{display:grid;grid-template-columns:1fr 280px;gap:18px;padding:18px 0}
.preview-phone{width:100%;background:#1C1C1E;border-radius:32px;padding:8px;box-shadow:0 8px 32px rgba(0,0,0,.15)}
.preview-screen{background:#F7F8F6;border-radius:24px;overflow:hidden}
.preview-header{background:#164F3F;color:#fff;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;font-size:10px}
.preview-body{padding:10px}
.products-list{display:grid;gap:8px}
.badge{display:inline-flex;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700}
.badge-green{background:#eaf8ef;color:#076b51}
.badge-blue{background:#e8f0fe;color:#1a56db}
.badge-yellow{background:#fef3e2;color:#a65d00}
.badge-gray{background:#f0f0f0;color:#666}
@media(max-width:768px){.dash-grid{grid-template-columns:1fr}.grid-4{grid-template-columns:1fr 1fr}}
@media(max-width:480px){.grid-4{grid-template-columns:1fr 1fr;gap:8px}.stat-value{font-size:18px}}
</style></head><body>
<div id="app">
<div class="login-page" id="loginScreen">
  <div class="login-card">
    <div class="login-logo">eki</div>
    <div class="login-title">Vendor Portal</div>
    <div class="login-sub">Sign in to view analytics and store preview.</div>
    <div id="loginMsg" class="msg"></div>
    <form id="loginForm">
      <div class="form-group"><label>Email</label><input id="email" class="input" type="email" placeholder="vendor@eki.app" /></div>
      <div class="form-group"><label>Password</label><input id="pass" class="input" type="password" /></div>
      <button class="btn btn-primary" style="width:100%;margin-top:6px" id="loginBtn">Sign In</button>
    </form>
  </div>
</div>
<div id="dashScreen" class="hidden">
  <div class="topbar">
    <a class="brand" href="/"><span class="brand-dot"></span> Eki Vendor</a>
    <div class="toplinks"><a href="#" id="logoutBtn" style="color:#e55353">Sign out</a></div>
  </div>
  <div class="shell dash-grid">
    <div><div id="tabAnalytics"><div class="loading">Sign in to view dashboard</div></div></div>
    <div class="preview-phone" id="storePreviewCol"><div class="preview-screen"><div class="preview-header"><span>My Store</span></div><div class="preview-body" id="storePreview"><div style="text-align:center;padding:24px;color:#999;font-size:11px">Sign in to see store preview</div></div></div></div>
  </div>
</div></div>
<script>const API='https://ekiapp-backend.vercel.app';let T='';
function $(id){return document.getElementById(id)}
$('loginForm').addEventListener('submit',async e=>{e.preventDefault();
  $('loginBtn').disabled=true;const r=await fetch(API+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:$('email').value.trim(),password:$('pass').value})});
  const d=await r.json();$('loginBtn').disabled=false;
  if(!r.ok||!d.token){$('loginMsg').textContent=d.message||'Invalid';$('loginMsg').className='msg err';return}
  T=d.token;$('loginScreen').className='hidden';$('dashScreen').className='';loadDash();
});
async function loadDash(){
  $('tabAnalytics').innerHTML='<div class="loading">Loading...</div>';
  try{
    const r=await fetch(API+'/api/vendors/me/analytics',{headers:{'Authorization':'Bearer '+T}});
    const d=await r.json();
    const a=d.analytics||d;s=a.summary||{};
    $('tabAnalytics').innerHTML='<div class="grid-4">'+
      '<div class="stat-card"><div class="stat-label">Revenue</div><div class="stat-value">'+fmt(s.totalRevenue||0,s.currency)+'</div><div class="stat-sub">All time</div></div>'+
      '<div class="stat-card"><div class="stat-label">Available</div><div class="stat-value">'+fmt(s.availableForPayout||0,s.currency)+'</div><div class="stat-sub">Ready for payout</div></div>'+
      '<div class="stat-card"><div class="stat-label">Pending</div><div class="stat-value">'+fmt(s.pendingBalance||0,s.currency)+'</div><div class="stat-sub">On hold</div></div>'+
      '<div class="stat-card"><div class="stat-label">Profit</div><div class="stat-value">'+fmt(s.estimatedProfit||0,s.currency)+'</div><div class="stat-sub">Estimated</div></div></div>';
      $('storePreview').innerHTML='<div style="font-weight:800;font-size:14px;margin-bottom:8px">'+($('email').value)+'</div>'+
      '<div style="display:flex;justify-content:space-between;font-size:10px;padding:6px 0;border-bottom:1px solid #eee"><span style="color:#999">Revenue</span><span style="font-weight:700">'+fmt(s.totalRevenue||0,s.currency)+'</span></div>'+
      '<div style="display:flex;justify-content:space-between;font-size:10px;padding:6px 0;border-bottom:1px solid #eee"><span style="color:#999">Available</span><span style="font-weight:700">'+fmt(s.availableForPayout||0,s.currency)+'</span></div>'+
      '<div style="display:flex;justify-content:space-between;font-size:10px;padding:6px 0"><span style="color:#999">Pending</span><span style="font-weight:700">'+fmt(s.pendingBalance||0,s.currency)+'</span></div>';
  }catch(e){$('tabAnalytics').innerHTML='<div class="msg err" style="display:block">'+e.message+'</div>'}
}
function fmt(n,c){return new Intl.NumberFormat('en-GB',{style:'currency',currency:c||'EUR',maximumFractionDigits:0}).format((n||0))}
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
  <div style="font-size:48px;margin-bottom:16px">🛒</div>
  <h1 style="font-size:24px;font-weight:800;margin:0">Your Cart</h1>
  <p style="color:#999;font-size:13px;margin:8px 0 24px">Add items using the Eki app, then come here to review.</p>
  <div class="card" style="max-width:400px;margin:0 auto;text-align:left;font-size:13px;line-height:1.6">
    <strong>How it works:</strong>
    <ol style="margin:10px 0 0;padding-left:18px;color:#666">
      <li>Browse vendors and add items in the <strong>Eki app</strong></li>
      <li>Review your cart and checkout</li>
      <li>Pay by card or wallet — track delivery live</li>
    </ol>
    <a href="/store" class="btn" style="margin-top:14px;width:100%;display:flex">Browse Vendors</a>
  </div>
</div></body></html>`; }

export async function getPublicVendorPortalPage(_request: Request, response: Response): Promise<void> {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache");
  response.status(200).send(renderVendorPortalLayout());
}

export async function getPublicBuyerCartPage(_request: Request, response: Response): Promise<void> {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "public, max-age=120, s-maxage=300");
  response.status(200).send(renderBuyerCartLayout());
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
}