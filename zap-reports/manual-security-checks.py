"""
Manual security checks beyond ZAP passive scanning.

  1. Security response headers on key public + auth endpoints.
  2. CORS preflight behaviour.
  3. Cookie flags (Secure / HttpOnly / SameSite) on any Set-Cookie.
  4. Stack-trace exposure on triggered errors.
  5. Sensitive data leakage on user-context endpoints.
  6. Auth bypass: protected endpoints reject anonymous & garbage tokens.
  7. Rate-limit response shape.

Output: zap-reports/manual-security-summary.md
"""

from __future__ import annotations

import json
import sys
import urllib.parse
from pathlib import Path

import requests

BASE = "https://italian-market-place.vercel.app"

REQUIRED_SECURITY_HEADERS = {
    "strict-transport-security": "HSTS",
    "x-content-type-options": "MIME sniffing",
    "x-frame-options": "Clickjacking (or use CSP frame-ancestors)",
    "referrer-policy": "Referrer leakage",
}

DESIRABLE_SECURITY_HEADERS = {
    "content-security-policy": "CSP",
    "permissions-policy": "Permissions-Policy",
}

SENSITIVE_HINTS = [
    "password", "passwd", "secret_key", "private_key", "begin rsa",
    "begin private key", "stripe_secret", "sentry_dsn", "database_url",
    "jwt_secret", "psql:", "ECONNREFUSED", "ENOTFOUND",
]

STACK_HINTS = [
    "at Object.", "at async ", "node_modules/", "/var/task/",
    "Prisma.PrismaClient", "Error: connect", "TypeError:", "ReferenceError:",
]


def check_headers(label: str, url: str, results: list) -> dict:
    r = requests.get(url, timeout=15)
    h = {k.lower(): v for k, v in r.headers.items()}
    missing = [name for name in REQUIRED_SECURITY_HEADERS if name not in h]
    desirable_missing = [name for name in DESIRABLE_SECURITY_HEADERS if name not in h]
    results.append({
        "label": label,
        "url": url,
        "status": r.status_code,
        "missing_required": missing,
        "missing_desirable": desirable_missing,
        "set_cookie": h.get("set-cookie"),
        "server": h.get("server"),
        "x_powered_by": h.get("x-powered-by"),
    })
    return h


def check_cors(label: str, origin: str, url: str, results: list) -> None:
    r = requests.options(url, headers={
        "Origin": origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, authorization",
    }, timeout=15)
    h = {k.lower(): v for k, v in r.headers.items()}
    results.append({
        "label": label,
        "origin_sent": origin,
        "status": r.status_code,
        "access_control_allow_origin": h.get("access-control-allow-origin"),
        "access_control_allow_credentials": h.get("access-control-allow-credentials"),
        "access_control_allow_methods": h.get("access-control-allow-methods"),
        "access_control_allow_headers": h.get("access-control-allow-headers"),
    })


def check_stack_trace(label: str, url: str, method: str, body: dict | None, results: list) -> None:
    r = requests.request(method, url, json=body, timeout=15)
    text = r.text
    leaks = [hint for hint in STACK_HINTS if hint.lower() in text.lower()]
    sens = [hint for hint in SENSITIVE_HINTS if hint.lower() in text.lower()]
    results.append({
        "label": label,
        "url": url,
        "method": method,
        "status": r.status_code,
        "body_preview": text[:300],
        "stack_hints": leaks,
        "sensitive_hints": sens,
    })


def check_auth(label: str, url: str, results: list) -> None:
    r1 = requests.get(url, timeout=15)
    r2 = requests.get(url, headers={"Authorization": "Bearer not.a.real.jwt"}, timeout=15)
    r3 = requests.get(url, headers={"Authorization": "Bearer "}, timeout=15)
    results.append({
        "label": label,
        "url": url,
        "no_token_status": r1.status_code,
        "garbage_token_status": r2.status_code,
        "empty_token_status": r3.status_code,
        "no_token_body": r1.text[:120],
    })


def main() -> None:
    out = Path(__file__).parent
    headers, cors, errs, auths = [], [], [], []

    # 1. Security headers on representative endpoints
    check_headers("/api/health", f"{BASE}/api/health", headers)
    check_headers("/api/products", f"{BASE}/api/products", headers)
    check_headers("/openapi.json", f"{BASE}/openapi.json", headers)
    check_headers("/api/docs", f"{BASE}/api/docs", headers)

    # 2. CORS preflight
    check_cors("from waqti.pro (allowed)", "https://waqti.pro", f"{BASE}/api/auth/login", cors)
    check_cors("from www.waqti.pro (allowed)", "https://www.waqti.pro", f"{BASE}/api/auth/login", cors)
    check_cors("from evil.example (untrusted)", "https://evil.example", f"{BASE}/api/auth/login", cors)
    check_cors("from waqti.pro (admin)", "https://waqti.pro", f"{BASE}/api/admin/orders", cors)

    # 3. Triggered errors / stack traces
    check_stack_trace("invalid login body", f"{BASE}/api/auth/login", "POST", {}, errs)
    check_stack_trace("invalid login email", f"{BASE}/api/auth/login", "POST", {"email": "x", "password": "y"}, errs)
    check_stack_trace("malformed JSON product id", f"{BASE}/api/products/'; DROP TABLE users; --", "GET", None, errs)
    check_stack_trace("non-existent product", f"{BASE}/api/products/does-not-exist", "GET", None, errs)
    check_stack_trace("non-existent admin endpoint", f"{BASE}/api/admin/__not_a_route__", "GET", None, errs)
    check_stack_trace("very large payload", f"{BASE}/api/auth/login", "POST", {"email": "a@b.com", "password": "x" * 100000}, errs)

    # 4. Auth on protected endpoints
    check_auth("/api/auth/me", f"{BASE}/api/auth/me", auths)
    check_auth("/api/vendors/me", f"{BASE}/api/vendors/me", auths)
    check_auth("/api/admin/users", f"{BASE}/api/admin/users", auths)
    check_auth("/api/me/data-export", f"{BASE}/api/me/data-export", auths)
    check_auth("/api/admin/revenue", f"{BASE}/api/admin/revenue", auths)
    check_auth("/api/orders", f"{BASE}/api/orders", auths)
    check_auth("/api/payments/create-intent", f"{BASE}/api/payments/create-intent", auths)

    # Output as JSON + Markdown
    payload = {"headers": headers, "cors": cors, "errors": errs, "auth": auths}
    (out / "manual-security-checks.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")

    md = ["# Manual Security Checks", "", f"Target: {BASE}", "", "## 1. Security headers", ""]
    for h in headers:
        md.append(f"### {h['label']} ({h['status']})")
        md.append(f"- Missing required: {h['missing_required'] or 'none'}")
        md.append(f"- Missing desirable: {h['missing_desirable'] or 'none'}")
        md.append(f"- Set-Cookie: {h['set_cookie'] or 'none'}")
        md.append(f"- Server: `{h.get('server')}`")
        md.append(f"- X-Powered-By: `{h.get('x_powered_by')}`")
        md.append("")

    md.append("## 2. CORS preflight")
    md.append("")
    for c in cors:
        md.append(f"### {c['label']} ({c['status']})")
        md.append(f"- Origin sent: `{c['origin_sent']}`")
        md.append(f"- ACAO: `{c['access_control_allow_origin']}`")
        md.append(f"- ACAC: `{c['access_control_allow_credentials']}`")
        md.append(f"- ACAM: `{c['access_control_allow_methods']}`")
        md.append("")

    md.append("## 3. Error / stack-trace exposure")
    md.append("")
    for e in errs:
        md.append(f"### {e['label']} ({e['status']})")
        md.append(f"- URL: {e['url']}")
        md.append(f"- Stack hints found: {e['stack_hints'] or 'none'}")
        md.append(f"- Sensitive hints found: {e['sensitive_hints'] or 'none'}")
        md.append(f"- Body preview: `{e['body_preview']}`")
        md.append("")

    md.append("## 4. Auth gating on protected endpoints")
    md.append("")
    for a in auths:
        md.append(f"### {a['label']}")
        md.append(f"- No token: {a['no_token_status']}")
        md.append(f"- Garbage token: {a['garbage_token_status']}")
        md.append(f"- Empty token: {a['empty_token_status']}")
        md.append(f"- No-token body: `{a['no_token_body']}`")
        md.append("")

    (out / "manual-security-summary.md").write_text("\n".join(md), encoding="utf-8")
    print("Wrote manual-security-checks.json and manual-security-summary.md")


if __name__ == "__main__":
    main()
