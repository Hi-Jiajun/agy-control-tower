#!/usr/bin/env python3
"""PreInvocation hook for control-tower: bare-ID tail peek & anti-aging alert for active controller."""

import json
import pathlib
import sys

import ctlib


def _resolve_self_transcript(payload: dict, conv_id: str) -> pathlib.Path | None:
    tp = str(payload.get("transcriptPath") or "").strip()
    if tp:
        p = pathlib.Path(tp).expanduser()
        if p.is_file():
            return p
    status, resolved = ctlib.resolve_brain_transcript(conv_id)
    if status == "ok" and isinstance(resolved, pathlib.Path):
        return resolved
    return None


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

    inject_steps = []

    # 1) Bare-ID intake: if user sends a single-line session ID / 8+ prefix, pre-read its head/tail
    last_input = str(payload.get("lastUserInput") or "").strip()
    if last_input and ctlib.ID_RE.match(last_input):
        status, found = ctlib.resolve_brain_transcript(last_input)
        if status == "ok" and isinstance(found, pathlib.Path):
            info = ctlib.inspect_transcript(found)
            step_label = info["maxStepIndex"] or info["lineCount"]
            goal = info["goal"] or "(未捕获首条用户输入)"
            model = info["lastModel"] or "未知"
            updated = info["lastUpdatedAt"] or "未知"
            st = info["lastStatus"] or "未知"
            err = f" | 最近报错: {info['lastError']}" if info["lastError"] else ""
            note = (
                f"[control-tower 裸ID速查] 会话 {found.parents[2].name} | 目标: {goal} | "
                f"步数: {step_label} (记录 {info['lineCount']} 条) | 模型: {model} | "
                f"更新: {updated} | 状态: {st} | 压缩次数: {info['compactions']}{err}"
            )
            inject_steps.append({"systemMessage": {"systemMessage": note}})
        elif status == "ambiguous" and isinstance(found, list):
            preview = ", ".join(found[:4])
            note = f"[control-tower 裸ID速查] 前缀 {last_input} 匹配多个会话 ({preview})，请补全更长 ID 后再入账。"
            inject_steps.append({"systemMessage": {"systemMessage": note}})

    # 2) Anti-aging handover warning when controller has >= 2 compactions (deduped via hook-state.json)
    self_tp = _resolve_self_transcript(payload, conv_id)
    if self_tp:
        self_info = ctlib.inspect_transcript(self_tp)
        comps = self_info.get("compactions", 0)
        if comps >= 2:
            state = ctlib.load_hook_state()
            entry = state.get(conv_id) if isinstance(state.get(conv_id), dict) else {}
            last_warned = entry.get("last_warned_compactions", 0)
            if not isinstance(last_warned, int) or comps > last_warned:
                warn = (
                    f"[control-tower 换届提醒] 当前现役总控会话已累计 {comps} 次上下文自动压缩（>= 2 次阈值）。"
                    f"请先将 {reg_path} 同步到最新稳态并归档本届记录，再按 references/templates.md 输出不超过 25 行的《总控换届交接卡》。"
                )
                inject_steps.append({"systemMessage": {"systemMessage": warn}})
                state[conv_id] = {"last_warned_compactions": comps}
                try:
                    ctlib.save_hook_state(state)
                except OSError:
                    pass

    if not inject_steps:
        print("{}")
        return 0

    print(json.dumps({"injectSteps": inject_steps}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
