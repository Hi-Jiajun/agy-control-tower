#!/usr/bin/env python3
"""SessionStart hook for control-tower: active controller brief only; silent for all others."""

import json
import sys

import ctlib


def main() -> int:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        if not isinstance(payload, dict):
            payload = {}
    except Exception:
        print("{}")
        return 0

    conv_id = str(payload.get("conversationId") or "").strip()
    ws_paths = payload.get("workspacePaths") or []
    reg_path = ctlib.find_registry_path(ws_paths)
    if not conv_id or not reg_path:
        print("{}")
        return 0

    try:
        parsed = ctlib.parse_registry(reg_path.read_text(encoding="utf-8"))
    except OSError:
        print("{}")
        return 0

    if not ctlib.is_active_controller(conv_id, parsed):
        print("{}")
        return 0

    lease_status = ((parsed.get("lease") or {}).get("lockStatus") or "未知").strip()
    active_count = len(parsed.get("activeSessions") or [])
    msg = (
        f"[control-tower 总控就位] 已核验当前会话为工作区现役总控。"
        f"台账: {reg_path} | 独占锁状态: {lease_status} | 活跃专职会话: {active_count} 个。"
    )
    print(json.dumps({"injectSteps": [{"systemMessage": {"systemMessage": msg}}]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
