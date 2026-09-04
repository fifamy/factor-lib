#!/usr/bin/env python3
"""校验 Supabase 私密跟踪表；可选执行会自动清理的写入/隔离/更新测试。"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import secrets
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend" if (ROOT / "frontend" / "app.js").exists() else ROOT
APP_JS = FRONTEND / "app.js"


def load_supabase_config(source: str) -> tuple[str, str]:
    url_match = re.search(r'const SUPABASE_URL = "([^"]+)";', source)
    key_match = re.search(r'const SUPABASE_ANON_KEY = "([^"]+)";', source)
    if not url_match or not key_match:
        raise ValueError("frontend/app.js 缺少 SUPABASE_URL 或 SUPABASE_ANON_KEY")
    return url_match.group(1).rstrip("/"), key_match.group(1)


def request_json(
    url: str,
    key: str,
    path: str,
    *,
    tracking_key: str,
    method: str = "GET",
    payload: object | None = None,
    prefer: str = "",
) -> tuple[int, object | None]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "x-tracking-key": tracking_key,
    }
    if prefer:
        headers["Prefer"] = prefer
    request = urllib.request.Request(
        f"{url}{path}", data=body, method=method, headers=headers
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read().decode("utf-8")
            return int(response.status), json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            parsed = {"message": raw[:500]}
        return int(exc.code), parsed


def run_read_check(url: str, key: str) -> dict[str, object]:
    probe_key = "factorlib-read-probe-" + secrets.token_urlsafe(32)
    status, payload = request_json(
        url, key, "/rest/v1/tracking_combos?select=id&limit=1",
        tracking_key=probe_key,
    )
    return {
        "tracking_table_readable": status == 200,
        "tracking_table_status": status,
        "probe_rows_visible": len(payload) if isinstance(payload, list) else None,
        "write_tested": False,
    }


def run_write_check(url: str, key: str) -> dict[str, object]:
    tracking_key = "factorlib-write-probe-" + secrets.token_urlsafe(40)
    wrong_key = "factorlib-wrong-probe-" + secrets.token_urlsafe(40)
    digest = hashlib.sha256(tracking_key.encode("utf-8")).hexdigest()
    query = f"/rest/v1/tracking_combos?tracking_key_hash=eq.{digest}"
    created = False
    result: dict[str, object] = {
        "write_tested": True,
        "probe_created": False,
        "same_key_readable": False,
        "wrong_key_blocked": False,
        "same_key_updateable": False,
        "probe_deleted": False,
    }
    try:
        status, _ = request_json(
            url,
            key,
            "/rest/v1/tracking_combos?on_conflict=tracking_key_hash",
            tracking_key=tracking_key,
            method="POST",
            prefer="resolution=merge-duplicates,return=minimal",
            payload=[{
                "tracking_key_hash": digest,
                "combo_payload": {"preflight": True, "revision": 1},
            }],
        )
        created = status in {200, 201, 204}
        result["probe_created"] = created
        status, payload = request_json(
            url, key, query + "&select=combo_payload", tracking_key=tracking_key
        )
        result["same_key_readable"] = (
            status == 200 and isinstance(payload, list) and len(payload) == 1
            and payload[0].get("combo_payload", {}).get("revision") == 1
        )
        wrong_status, wrong_payload = request_json(
            url, key, query + "&select=id", tracking_key=wrong_key
        )
        result["wrong_key_blocked"] = (
            wrong_status == 200 and isinstance(wrong_payload, list) and not wrong_payload
        )
        patch_status, _ = request_json(
            url,
            key,
            query,
            tracking_key=tracking_key,
            method="PATCH",
            prefer="return=minimal",
            payload={"combo_payload": {"preflight": True, "revision": 2}},
        )
        verify_status, verify_payload = request_json(
            url, key, query + "&select=combo_payload", tracking_key=tracking_key
        )
        result["same_key_updateable"] = (
            patch_status in {200, 204}
            and verify_status == 200
            and isinstance(verify_payload, list)
            and len(verify_payload) == 1
            and verify_payload[0].get("combo_payload", {}).get("revision") == 2
        )
    finally:
        if created:
            delete_status, _ = request_json(
                url, key, query, tracking_key=tracking_key, method="DELETE",
                prefer="return=minimal",
            )
            cleanup_status, cleanup_payload = request_json(
                url, key, query + "&select=id", tracking_key=tracking_key
            )
            result["probe_deleted"] = (
                delete_status in {200, 204}
                and cleanup_status == 200
                and isinstance(cleanup_payload, list)
                and not cleanup_payload
            )
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--write-test",
        action="store_true",
        help="创建随机探针，验证同码读写、错码隔离后立即删除",
    )
    args = parser.parse_args()
    url, key = load_supabase_config(APP_JS.read_text(encoding="utf-8"))
    result = run_read_check(url, key)
    if args.write_test and result["tracking_table_readable"]:
        result.update(run_write_check(url, key))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    required = [result["tracking_table_readable"]]
    if args.write_test:
        required.extend(
            result.get(field) is True for field in (
                "probe_created", "same_key_readable", "wrong_key_blocked",
                "same_key_updateable", "probe_deleted",
            )
        )
    if not all(required):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
