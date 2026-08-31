#!/usr/bin/env python3
"""Read-only preflight for the public/admin Supabase access boundary.

The default mode performs GET requests only. It verifies that the public
combination library is readable while anonymous users cannot read the admin
review queue. With ``--credentialed``, it additionally sends an authentication
request using credentials from environment variables and verifies the admin
role plus read access. It never approves, publishes, rejects, or deletes records.
"""

from __future__ import annotations

import argparse
import json
import os
import re
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
    method: str = "GET",
    access_token: str | None = None,
    payload: object | None = None,
) -> tuple[int, object | None]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{url}{path}",
        data=body,
        method=method,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {access_token or key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            body = response.read().decode("utf-8")
            return int(response.status), json.loads(body) if body else None
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8")
        try:
            payload = json.loads(body) if body else None
        except json.JSONDecodeError:
            payload = None
        return int(exc.code), payload


def get_json(
    url: str, key: str, path: str, access_token: str | None = None
) -> tuple[int, object | None]:
    return request_json(url, key, path, access_token=access_token)


def evaluate_credentialed(
    auth_status: int,
    auth_payload: object | None,
    admin_guard_status: int,
    admin_guard_payload: object | None,
    admin_queue_status: int,
    published_status: int,
) -> dict[str, object]:
    token_present = bool(
        isinstance(auth_payload, dict) and auth_payload.get("access_token")
    )
    result = {
        "credentialed_admin_login_succeeded": auth_status == 200 and token_present,
        "credentialed_is_combo_admin": (
            admin_guard_payload if admin_guard_status == 200 else None
        ),
        "credentialed_admin_queue_readable": admin_queue_status == 200,
        "credentialed_published_library_readable": published_status == 200,
        "credentialed_admin_read_flow_tested": False,
        "credentialed_admin_write_flow_tested": False,
        "write_requests_sent": False,
    }
    result["credentialed_admin_read_flow_tested"] = all(
        (
            result["credentialed_admin_login_succeeded"],
            result["credentialed_is_combo_admin"] is True,
            result["credentialed_admin_queue_readable"],
            result["credentialed_published_library_readable"],
        )
    )
    return result


def check_credentialed(url: str, key: str, email: str, password: str) -> dict[str, object]:
    auth_status, auth_payload = request_json(
        url,
        key,
        "/auth/v1/token?grant_type=password",
        method="POST",
        payload={"email": email, "password": password},
    )
    access_token = (
        str(auth_payload.get("access_token"))
        if isinstance(auth_payload, dict) and auth_payload.get("access_token")
        else ""
    )
    if not access_token:
        return evaluate_credentialed(auth_status, auth_payload, 0, None, 0, 0)

    guard_status, guard_payload = get_json(
        url, key, "/rest/v1/rpc/is_combo_admin", access_token
    )
    queue_status, _ = get_json(
        url,
        key,
        "/rest/v1/combo_publish_requests?select=id,status,request_type&order=created_at.desc&limit=1",
        access_token,
    )
    published_status, _ = get_json(
        url,
        key,
        "/rest/v1/published_combos?select=id&order=created_at.desc&limit=1",
        access_token,
    )
    return evaluate_credentialed(
        auth_status,
        auth_payload,
        guard_status,
        guard_payload,
        queue_status,
        published_status,
    )


def evaluate(
    public_status: int,
    admin_queue_status: int,
    admin_queue_payload: object | None,
    admin_guard_status: int,
    admin_guard_payload: object | None,
) -> dict[str, object]:
    visible_rows = len(admin_queue_payload) if isinstance(admin_queue_payload, list) else None
    guard_is_false = admin_guard_status == 200 and admin_guard_payload is False
    queue_hidden = admin_queue_status in {401, 403} or (
        admin_queue_status == 200 and visible_rows == 0 and guard_is_false
    )
    return {
        "public_library_readable": public_status == 200,
        "anonymous_admin_queue_blocked": queue_hidden,
        "public_library_status": public_status,
        "admin_queue_status": admin_queue_status,
        "anonymous_admin_queue_rows_visible": visible_rows,
        "anonymous_is_combo_admin": admin_guard_payload if admin_guard_status == 200 else None,
        "admin_guard_status": admin_guard_status,
        "credentialed_admin_flow_tested": False,
        "write_requests_sent": False,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--credentialed",
        action="store_true",
        help=(
            "从FACTOR_LIB_ADMIN_EMAIL和FACTOR_LIB_ADMIN_PASSWORD读取凭据，"
            "只读验证管理员登录、角色和审核队列访问"
        ),
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    url, key = load_supabase_config(APP_JS.read_text(encoding="utf-8"))
    public_status, _ = get_json(
        url, key, "/rest/v1/published_combos?select=id&limit=1"
    )
    queue_status, queue_payload = get_json(
        url, key, "/rest/v1/combo_publish_requests?select=id&limit=1"
    )
    guard_status, guard_payload = get_json(
        url, key, "/rest/v1/rpc/is_combo_admin"
    )
    result = evaluate(
        public_status,
        queue_status,
        queue_payload,
        guard_status,
        guard_payload,
    )
    if args.credentialed:
        email = os.environ.get("FACTOR_LIB_ADMIN_EMAIL", "").strip()
        password = os.environ.get("FACTOR_LIB_ADMIN_PASSWORD", "")
        if not email or not password:
            raise SystemExit(
                "--credentialed需要环境变量FACTOR_LIB_ADMIN_EMAIL和"
                "FACTOR_LIB_ADMIN_PASSWORD"
            )
        result.update(check_credentialed(url, key, email, password))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if not result["public_library_readable"] or not result["anonymous_admin_queue_blocked"]:
        raise SystemExit(1)
    if args.credentialed and not result["credentialed_admin_read_flow_tested"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
