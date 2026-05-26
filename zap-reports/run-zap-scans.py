"""
Drive an OWASP ZAP daemon (started separately) to perform a passive baseline
scan + an OpenAPI passive scan against a remote target, then dump alerts
to JSON + HTML reports.

This mirrors what the official zap-baseline.py / zap-api-scan.py scripts do:
  baseline:
    - spider the target
    - run passive scanners over the spidered traffic
    - dump alerts
  api scan:
    - import the OpenAPI spec (gives ZAP a list of endpoints)
    - run passive scanners over the imported requests
    - dump alerts

Active scanners are intentionally NOT invoked. This is a non-destructive,
production-safe baseline.

Prerequisites:
  - ZAP started on http://localhost:8090 with -daemon -config api.disablekey=true
  - pip install zaproxy

Usage:
  python run-zap-scans.py <target> <openapi-url>
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from zapv2 import ZAPv2

ZAP_API = "http://localhost:8090"
TIMEOUT_SPIDER_SECONDS = 240
TIMEOUT_PASSIVE_SECONDS = 360
SPIDER_MAX_DEPTH = 5
SPIDER_MAX_DURATION = 4  # minutes


def wait_for_zap(zap: ZAPv2, timeout: int = 60) -> None:
    print(f"Waiting up to {timeout}s for ZAP daemon at {ZAP_API}...", flush=True)
    for i in range(timeout):
        try:
            v = zap.core.version
            print(f"ZAP {v} reachable after {i}s", flush=True)
            return
        except Exception:
            time.sleep(1)
    raise SystemExit("ZAP daemon not reachable")


def baseline_scan(zap: ZAPv2, target: str) -> None:
    print(f"\n=== BASELINE: spider {target} ===", flush=True)
    scan_id = zap.spider.scan(target, maxchildren=200, recurse=True, contextname=None, subtreeonly=False)
    start = time.time()
    while int(zap.spider.status(scan_id)) < 100:
        if time.time() - start > TIMEOUT_SPIDER_SECONDS:
            print(f"  spider timeout at {zap.spider.status(scan_id)}%", flush=True)
            zap.spider.stop(scan_id)
            break
        time.sleep(2)
    print(f"  spider done ({zap.spider.status(scan_id)}%, {len(zap.core.urls())} urls)", flush=True)

    print(f"=== BASELINE: passive scan ===", flush=True)
    start = time.time()
    while int(zap.pscan.records_to_scan) > 0:
        if time.time() - start > TIMEOUT_PASSIVE_SECONDS:
            print(f"  passive scan timeout, {zap.pscan.records_to_scan} records left", flush=True)
            break
        time.sleep(2)
    print(f"  passive scan done", flush=True)


def api_scan(zap: ZAPv2, openapi_url: str, target_host: str) -> None:
    print(f"\n=== API SCAN: import OpenAPI from {openapi_url} ===", flush=True)
    res = zap.openapi.import_url(openapi_url, hostoverride=target_host)
    print(f"  import_url result: {res}", flush=True)

    # Wait for any imported endpoints to be passively scanned
    time.sleep(3)
    print(f"=== API SCAN: passive scan over imported endpoints ===", flush=True)
    start = time.time()
    while int(zap.pscan.records_to_scan) > 0:
        if time.time() - start > TIMEOUT_PASSIVE_SECONDS:
            print(f"  passive scan timeout, {zap.pscan.records_to_scan} records left", flush=True)
            break
        time.sleep(2)
    print(f"  passive scan done", flush=True)


def dump_reports(zap: ZAPv2, prefix: str, target: str) -> None:
    out_dir = Path(__file__).parent
    json_path = out_dir / f"{prefix}-report.json"
    html_path = out_dir / f"{prefix}-report.html"
    md_path = out_dir / f"{prefix}-summary.md"

    alerts = zap.core.alerts(baseurl=target)
    counts: dict[str, int] = {"High": 0, "Medium": 0, "Low": 0, "Informational": 0}
    by_name: dict[str, dict] = {}
    for a in alerts:
        risk = a.get("risk", "Informational")
        counts[risk] = counts.get(risk, 0) + 1
        key = a.get("name") or "unknown"
        existing = by_name.setdefault(key, {
            "name": key,
            "risk": risk,
            "confidence": a.get("confidence"),
            "cwe": a.get("cweid"),
            "wasc": a.get("wascid"),
            "description": a.get("description"),
            "solution": a.get("solution"),
            "reference": a.get("reference"),
            "instances": [],
        })
        existing["instances"].append({
            "url": a.get("url"),
            "param": a.get("param"),
            "evidence": (a.get("evidence") or "")[:300],
            "method": a.get("method"),
        })

    json_path.write_text(json.dumps({"target": target, "counts": counts, "alerts": list(by_name.values())}, indent=2), encoding="utf-8")
    print(f"  wrote {json_path}", flush=True)

    # HTML report from ZAP itself
    try:
        html = zap.core.htmlreport()
        html_path.write_text(html, encoding="utf-8")
        print(f"  wrote {html_path}", flush=True)
    except Exception as e:
        print(f"  html report error: {e}", flush=True)

    # Markdown summary
    lines = [f"# {prefix} ZAP Summary", "", f"Target: {target}", "", "## Counts", ""]
    for risk in ("High", "Medium", "Low", "Informational"):
        lines.append(f"- {risk}: {counts.get(risk, 0)}")
    lines.append("")
    lines.append("## Findings (deduplicated by alert name)")
    lines.append("")
    for f in sorted(by_name.values(), key=lambda x: ["High", "Medium", "Low", "Informational"].index(x["risk"])):
        lines.append(f"### [{f['risk']}/{f['confidence']}] {f['name']}")
        lines.append(f"- CWE: {f['cwe']}, WASC: {f['wasc']}")
        lines.append(f"- Instances: {len(f['instances'])}")
        for inst in f["instances"][:5]:
            lines.append(f"  - {inst['method']} {inst['url']}")
            if inst.get("param"):
                lines.append(f"    param: {inst['param']}")
            if inst.get("evidence"):
                lines.append(f"    evidence: `{inst['evidence']}`")
        lines.append("")
    md_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"  wrote {md_path}", flush=True)


def main() -> None:
    if len(sys.argv) < 3:
        print("Usage: run-zap-scans.py <target> <openapi-url>")
        raise SystemExit(2)
    target = sys.argv[1].rstrip("/")
    openapi_url = sys.argv[2]
    target_host = target.replace("https://", "").replace("http://", "").split("/")[0]

    zap = ZAPv2(proxies={"http": ZAP_API, "https": ZAP_API}, apikey="")
    wait_for_zap(zap)

    # Make sure passive scanners are enabled
    zap.pscan.enable_all_scanners()

    # 1. baseline scan
    zap.core.new_session(name="baseline", overwrite=True)
    zap.core.access_url(target)
    time.sleep(2)
    baseline_scan(zap, target)
    dump_reports(zap, "zap-baseline", target)

    # 2. OpenAPI scan in a fresh session
    zap.core.new_session(name="api", overwrite=True)
    api_scan(zap, openapi_url, target_host)
    dump_reports(zap, "zap-api", target)

    print("\nAll scans complete.", flush=True)


if __name__ == "__main__":
    main()
