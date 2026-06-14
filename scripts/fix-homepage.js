const fs = require('fs');
let c = fs.readFileSync('src/modules/public-site/public-site.page.ts','utf8');

// Simplify home page - clean hero with phone mockup only
const newHome = `function renderHomeLayout(page: PageDefinition): string {
  const today = new Date().toLocaleDateString('en-GB',{month:'short',day:'numeric',year:'numeric'});
  return \`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="theme-color" content="#164F3F">
<title>\${escape(page.title)}</title><meta name="description" content="\${escape(page.description)}" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" />
<style>
*,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:0}
body{background:#FAFBFA;color:#111;font-family:'Inter',sans-serif;-webkit-font-smoothing:antialiased}a{color:inherit;text-decoration:none}
.hero-wrap{background:linear-gradient(135deg,#0C3B2E,#164F3F 50%,#1B6B4E);color:#fff;overflow:hidden;position:relative}
.shell{width:min(1160px,calc(100% - 40px));margin:0 auto;position:relative;z-index:1}
.topbar{height:52px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,.06)}
.brand{font-weight:800;font-size:18px;color:#fff;display:flex;align-items:center;gap:8px}.brand-dot{width:10px;height:10px;border-radius:3px;background:#2DBB74;display:inline-block}
.nav{display:flex;align-items:center;gap:20px;color:rgba(255,255,255,.65);font-size:13px;font-weight:500}.nav a:hover{color:#fff}
.nav-dl{height:34px;padding:0 16px;border-radius:8px;background:#2DBB74;color:#fff;font-size:12px;font-weight:700;display:inline-flex;align-items:center;margin-left:8px}
.hero{display:grid;grid-template-columns:1fr 1fr;align-items:center;gap:48px;padding:28px 0 48px;min-height:480px}
h1{margin:0;font-size:50px;line-height:1.04;letter-spacing:-.045em;font-weight:900;max-width:480px}.sub{margin:14px 0 0;max-width:440px;color:rgba(255,255,255,.72);font-size:15px;line-height:1.5}
.btns{display:flex;gap:10px;margin-top:24px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:8px;height:46px;padding:0 18px;border-radius:10px;font-size:13px;font-weight:700;transition:all .2s}
.btn-ap{background:#fff;color:#0C3B2E}.btn-ap:hover{transform:translateY(-2px);box-shadow:0 12px 28px rgba(0,0,0,.2)}
.btn-gp{background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(255,255,255,.15)}.btn-gp:hover{background:rgba(255,255,255,.18);transform:translateY(-2px)}
.btn-lg{font-size:14px;font-weight:700}
.phone-stage{display:flex;align-items:center;justify-content:center;position:relative;min-height:440px}
.phone{width:270px;background:#1C1C1E;border-radius:44px;padding:10px;box-shadow:0 40px 80px rgba(0,0,0,.5);position:relative;transition:transform .3s}.phone:hover{transform:scale(1.02) translateY(-4px)}
.phone-di{position:absolute;top:18px;left:50%;transform:translateX(-50%);z-index:3;background:#0D0D0D;padding:3px 12px;border-radius:18px;height:22px;display:flex;align-items:center;gap:5px}
.phone-scr{background:#F7F8F6;border-radius:34px;overflow:hidden}
.phone-st{display:flex;justify-content:space-between;padding:18px 20px 2px;font-size:9px;font-weight:700;color:#111;background:#fff}
.phone-hdr{background:#164F3F;color:#fff;padding:8px 14px 12px;display:flex;justify-content:space-between;align-items:center}
.phone-hl{display:flex;flex-direction:column;gap:1px}.phone-hg{font-size:10px;font-weight:600;opacity:.8}.phone-hd{font-size:7px;opacity:.5}
.phone-av{width:24px;height:24px;border-radius:12px;background:rgba(255,255,255,.12);display:grid;place-items:center;font-weight:700;font-size:9px}
.phone-bal{background:#164F3F;padding:0 14px 10px;color:#fff}
.phone-bl{font-size:7px;text-transform:uppercase;opacity:.5;letter-spacing:.04em;font-weight:600}
.phone-bv{font-size:20px;font-weight:800;margin-top:1px;letter-spacing:-.03em}
.phone-bs{font-size:7px;opacity:.4;margin-top:1px}
.phone-gr{padding:8px;display:grid;grid-template-columns:1fr 1fr;gap:5px}
.phone-ti{background:#fff;border-radius:10px;padding:8px 10px;box-shadow:0 1px 3px rgba(0,0,0,.03)}
.phone-ti-dk{background:#164F3F;color:#fff}
.phone-tl{font-size:7px;font-weight:700;opacity:.45;text-transform:uppercase;letter-spacing:.04em}
.phone-tv{font-size:13px;font-weight:800;margin-top:1px;letter-spacing:-.02em}
.phone-ts{font-size:6px;opacity:.4;margin-top:1px}
.phone-tag{font-size:9px;font-weight:800;padding:6px 10px 2px;color:#111}
.phone-ins{display:grid;grid-template-columns:1fr 1fr;gap:5px;padding:0 8px 6px}
.phone-in{background:#fff;border-radius:8px;padding:6px 8px;display:flex;align-items:center;gap:5px;box-shadow:0 1px 2px rgba(0,0,0,.02)}
.phone-in-txt{font-size:7px;font-weight:600;color:#555}
.phone-tabs{display:flex;justify-content:space-around;padding:4px 4px 2px;background:#fff;border-top:1px solid #f0f0f0}
.phone-tab{display:flex;flex-direction:column;align-items:center;gap:1px;font-size:6px;font-weight:700;color:#999}
.phone-tab.act{color:#164F3F}.phone-tab-ic{width:14px;height:14px;border-radius:4px;background:#e8ece9;display:grid;place-items:center;font-size:7px;color:#777}
.phone-tab.act .phone-tab-ic{background:#164F3F;color:#fff}
.phone-home{height:2.5px;width:80px;background:#ddd;border-radius:2px;margin:2px auto}
.deco{position:absolute;pointer-events:none;z-index:0}
.deco-1{width:44px;height:44px;border:1.5px solid rgba(255,255,255,.1);border-radius:14px;transform:rotate(20deg);top:2%;left:-18%}
.deco-2{width:22px;height:22px;background:rgba(255,255,255,.06);border-radius:50%;top:15%;right:-12%}
.deco-3{width:64px;height:64px;border:1px solid rgba(255,255,255,.06);border-radius:50%;bottom:10%;left:-15%}
.deco-4{width:16px;height:16px;background:rgba(255,255,255,.08);border-radius:3px;transform:rotate(45deg);bottom:18%;right:-10%}
.footer{background:#fff;border-top:1px solid #eee;padding:16px 0;font-size:12px;color:#999}
.footer .shell{display:flex;align-items:center;justify-content:space-between}
.fl{display:flex;gap:16px}.fl a:hover{color:#164F3F}
@media(max-width:960px){.hero{grid-template-columns:1fr;text-align:center;min-height:auto;padding:24px 0}h1{max-width:none;font-size:36px}.sub{margin-left:auto;margin-right:auto}.btns{justify-content:center}.phone-stage{min-height:360px}.phone{width:230px}}
@media(max-width:640px){.phone{width:200px}.nav{gap:12px;font-size:11px}}
</style></head><body>
<div class="hero-wrap"><header class="shell topbar">
<div class="brand"><span class="brand-dot"></span>Eki</div>
<nav class="nav"><a href="/store">Vendors</a><a href="/find-order">Track</a><a href="/vendor">Vendor</a><a class="nav-dl" href="https://apps.apple.com/app/id6776307497">Download</a></nav>
</header>
<main class="shell hero">
<div><h1>\${escape(page.heading)}</h1><p class="sub">\${escape(page.intro)}</p>
<div class="btns"><a class="btn btn-ap" href="https://apps.apple.com/app/id6776307497"><span class="btn-lg">App Store</span></a>
<a class="btn btn-gp" href="https://play.google.com/store/apps/details?id=com.ekiapp.mobile"><span class="btn-lg">Google Play</span></a></div></div>
<div class="phone-stage">
<div class="deco deco-1"></div><div class="deco deco-2"></div><div class="deco deco-3"></div><div class="deco deco-4"></div>
<div class="phone"><div class="phone-di"><div style="width:14px;height:4px;border-radius:2px;background:#1A1A1A"></div><div style="width:6px;height:6px;border-radius:50%;background:#333"></div></div>
<div class="phone-scr">
<div class="phone-st"><span>9:41</span><span style="opacity:.4">●●●●○</span></div>
<div class="phone-hdr"><div class="phone-hl"><span class="phone-hg">Good morning</span><span class="phone-hd">\${today}</span></div><div class="phone-av">Q</div></div>
<div class="phone-bal"><div class="phone-bl">Available balance</div><div class="phone-bv">€4,280</div><div class="phone-bs">+€320 this week</div></div>
<div class="phone-gr">
<div class="phone-ti"><div class="phone-tl">Sales today</div><div class="phone-tv">€143</div><div class="phone-ts">+12% vs yesterday</div></div>
<div class="phone-ti phone-ti-dk"><div class="phone-tl">This week</div><div class="phone-tv">€2,456</div><div class="phone-ts" style="opacity:.5">3 pending</div></div>
<div class="phone-ti"><div class="phone-tl">Pending</div><div class="phone-tv">€890</div><div class="phone-ts">After delivery</div></div>
<div class="phone-ti"><div class="phone-tl">This month</div><div class="phone-tv">€8,340</div><div class="phone-ts">12 orders</div></div>
</div>
<div class="phone-tag">Insights</div>
<div class="phone-ins"><div class="phone-in"><div style="width:5px;height:5px;border-radius:2.5px;background:#10b981;flex:0 0 auto"></div><div class="phone-in-txt">Orders (3)</div></div><div class="phone-in"><div style="width:5px;height:5px;border-radius:2.5px;background:#3b82f6;flex:0 0 auto"></div><div class="phone-in-txt">Messages (2)</div></div></div>
<div class="phone-tabs"><div class="phone-tab act"><div class="phone-tab-ic">⬡</div>Home</div><div class="phone-tab"><div class="phone-tab-ic">⊞</div>Orders</div><div class="phone-tab"><div class="phone-tab-ic">◉</div>Shop</div><div class="phone-tab"><div class="phone-tab-ic">✉</div>Inbox</div><div class="phone-tab"><div class="phone-tab-ic">⚙</div>Profile</div></div>
<div class="phone-home"></div></div></div></div></main></div>
<footer class="footer"><div class="shell"><div class="fl"><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/help">Help</a></div><span>© \${new Date().getFullYear()} Eki</span></div></footer>
</body></html>\`;}`;

// Fix vendor portal - remove OTP, go straight to dashboard
const vendorPortal = `function renderVendorPortalLayout(): string { return \`<!DOCTYPE html>
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
.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:18px;box-shadow:0 1px 6px rgba(0,0,0,.04)}
.btn{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 16px;border-radius:8px;font-weight:700;font-size:12px;border:0;cursor:pointer}
.btn-primary{background:#164F3F;color:#fff}.btn-secondary{border:1px solid #dce3e0;background:#fff;color:#164F3F}
.input{width:100%;height:42px;border:1px solid #dce3e0;border-radius:8px;padding:0 12px;font-size:13px;outline:none}
.input:focus{border-color:#164F3F;box-shadow:0 0 0 3px rgba(22,79,63,.1)}
.msg{display:none;padding:10px 12px;border-radius:8px;font-size:12px;margin-bottom:12px}
.msg.err{display:block;background:#fff0f0;border:1px solid #f3caca;color:#a62e2e}
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
  <div class="login-card">
    <div class="login-logo">eki</div>
    <div class="login-title">Vendor Portal</div>
    <div class="login-sub">Sign in to view your store analytics.</div>
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
  <div class="shell dash-grid" id="dashContent">
    <div><div id="tabAnalytics"><div class="loading">Sign in to view</div></div></div>
    <div class="phone-frame"><div class="phone-screen"><div class="phone-hdr"><span>My Store</span></div><div class="phone-body" id="storePreview"><div style="text-align:center;padding:24px;color:#999;font-size:11px">Sign in first</div></div></div></div>
  </div>
</div></div>
<script>
const API='https://ekiapp-backend.vercel.app';let T='';
function \$(id){return document.getElementById(id)}
async function loadDash(){
  \$('tabAnalytics').innerHTML='<div class="loading">Loading...</div>';
  try{
    const r=await fetch(API+'/api/vendors/me/earnings',{headers:{'Authorization':'Bearer '+T}});
    const d=await r.json();const e=d.earnings||d||{};
    \$('tabAnalytics').innerHTML='<div class="grid-4">'+
      '<div class="stat-card"><div class="stat-label">Sales Today</div><div class="stat-value">'+(e.salesToday?fmt(e.salesToday,e.currency):'€0')+'</div><div class="stat-sub">Live</div></div>'+
      '<div class="stat-card"><div class="stat-label">This Week</div><div class="stat-value">'+(e.salesThisWeek?fmt(e.salesThisWeek,e.currency):'€0')+'</div><div class="stat-sub">7 days</div></div>'+
      '<div class="stat-card"><div class="stat-label">This Month</div><div class="stat-value">'+(e.salesThisMonth?fmt(e.salesThisMonth,e.currency):'€0')+'</div><div class="stat-sub">Monthly</div></div>'+
      '<div class="stat-card"><div class="stat-label">Available</div><div class="stat-value">'+(e.availableBalance?fmt(e.availableBalance,e.currency):'€0')+'</div><div class="stat-sub">For payout</div></div></div>';
    \$('storePreview').innerHTML='<div style="font-weight:800;font-size:13px;margin-bottom:6px">'+(\$('email').value)+'</div>'+
      '<div class="phone-row"><span class="phone-lbl">Revenue</span><span class="phone-val">'+(e.salesThisMonth?fmt(e.salesThisMonth,e.currency):'€0')+'</span></div>'+
      '<div class="phone-row"><span class="phone-lbl">Balance</span><span class="phone-val">'+(e.availableBalance?fmt(e.availableBalance,e.currency):'€0')+'</span></div>'+
      '<div class="phone-row" style="border-bottom:0"><span class="phone-lbl">Pending</span><span class="phone-val">'+(e.pendingPayout?fmt(e.pendingPayout,e.currency):'€0')+'</span></div>';
  }catch(e){\$('tabAnalytics').innerHTML='<div class="msg err" style="display:block">'+e.message+'</div>';console.error(e)}
}
function fmt(n,c){return new Intl.NumberFormat('en-GB',{style:'currency',currency:c||'EUR',maximumFractionDigits:0}).format((n||0)/100)}
\$('loginForm').addEventListener('submit',async e=>{e.preventDefault();
  \$('loginBtn').disabled=true;const r=await fetch(API+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:\$('email').value.trim(),password:\$('pass').value})});
  const d=await r.json();\$('loginBtn').disabled=false;
  if(!r.ok||!d.token){\$('loginMsg').textContent=d.message||'Invalid';\$('loginMsg').className='msg err';return}
  T=d.token;\$('loginScreen').className='hidden';\$('dashScreen').className='';loadDash();
});
\$('logoutBtn').addEventListener('click',e=>{e.preventDefault();T='';\$('dashScreen').className='hidden';\$('loginScreen').className=''});
</script></body></html>\`; }`;

// Find and replace
const homeStart = c.indexOf('function renderHomeLayout(page: PageDefinition): string {');
const homeEnd = c.indexOf('function renderFindOrderLayout(): string {');
if (homeStart >= 0 && homeEnd > homeStart) {
  c = c.substring(0, homeStart) + newHome + '\n\n' + c.substring(homeEnd);
} else { console.log('ERROR: home boundaries not found'); process.exit(1); }

const vendorStart = c.indexOf('function renderVendorPortalLayout(): string { return `');
const vendorEnd = c.indexOf('function renderBuyerCartLayout', vendorStart);
if (vendorStart >= 0 && vendorEnd > vendorStart) {
  c = c.substring(0, vendorStart) + vendorPortal + '\n\n' + c.substring(vendorEnd);
} else { console.log('ERROR: vendor boundaries not found'); process.exit(1); }

fs.writeFileSync('src/modules/public-site/public-site.page.ts', c, 'utf8');
console.log('✅ Home page and vendor portal replaced');
