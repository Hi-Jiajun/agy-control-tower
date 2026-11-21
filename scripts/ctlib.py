#!/usr/bin/env python3
"""Shared read/parse helpers for control-tower Antigravity hooks."""

import json
import os
import pathlib
import re
from urllib.parse import unquote, urlparse

REGISTRY_CANDIDATES = (
    ".agents/SESSION-REGISTRY.md",
    "research/SESSION-REGISTRY.md",
    "SESSION-REGISTRY.md",
)

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$")
CONV_LINK_RE = re.compile(r"conversation://([A-Za-z0-9][A-Za-z0-9_-]{3,127})")
BACKTICK_RE = re.compile(r"`([^`\n]+)`")
PLACEHOLDER_RE = re.compile(r"^(\[.*\]|<.*>|暂无|-+|NONE|IDLE|ONLINE|OFFLINE)$", re.I)


def get_data_dir() -> pathlib.Path:
    """Resolve persistent data directory without creating it on read."""
    override = os.environ.get("AGY_CONTROL_TOWER_DATA_DIR") or os.environ.get("PLUGIN_DATA")
    if override:
        return pathlib.Path(override).expanduser()
    return pathlib.Path.home() / ".local" / "share" / "agy-control-tower"


def get_app_data_dir() -> pathlib.Path:
    """Resolve Antigravity app data directory."""
    override = os.environ.get("ANTIGRAVITY_APP_DATA_DIR")
    if override:
        return pathlib.Path(override).expanduser()
    return pathlib.Path.home() / ".gemini" / "antigravity"


def _normalize_ws_path(raw: str) -> pathlib.Path | None:
    if not raw or not isinstance(raw, str):
        return None
    text = raw.strip()
    if text.startswith("file://"):
        parsed = urlparse(text)
        text = unquote(parsed.path or "")
    if not text:
        return None
    p = pathlib.Path(text).expanduser()
    try:
        return p.resolve()
    except OSError:
        return p


def find_registry_path(workspace_paths) -> pathlib.Path | None:
    """Return the first existing SESSION-REGISTRY.md across workspace roots."""
    if not workspace_paths:
        return None
    for ws in workspace_paths:
        root = _normalize_ws_path(ws)
        if not root or not root.is_dir():
            continue
        for rel in REGISTRY_CANDIDATES:
            candidate = root / rel
            if candidate.is_file():
                return candidate
    return None


def extract_conv_id(cell: str) -> str:
    """Extract conversation ID from markdown link, backticks, or plain token."""
    if not cell:
        return ""
    m = CONV_LINK_RE.search(cell)
    if m:
        return m.group(1).strip()
    for token in BACKTICK_RE.findall(cell):
        t = token.strip()
        if not t or PLACEHOLDER_RE.match(t):
            continue
        if re.match(r"^[A-Za-z0-9][A-Za-z0-9_-]{3,127}$", t):
            return t
    stripped = re.sub(r"[`*_\s]", "", cell)
    if stripped and not PLACEHOLDER_RE.match(stripped) and re.match(r"^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$", stripped):
        return stripped
    return ""


def _split_md_row(line: str) -> list[str]:
    s = line.strip()
    if not s.startswith("|") or not s.endswith("|"):
        return []
    inner = s[1:-1]
    parts = [p.strip() for p in inner.split("|")]
    return parts


def _is_separator_row(cells: list[str]) -> bool:
    if not cells:
        return False
    return all(re.match(r"^:?-{2,}:?$", c.replace(" ", "")) for c in cells)


def _strip_md(text: str) -> str:
    s = text.strip()
    if s.startswith("**") and s.endswith("**") and len(s) > 4:
        s = s[2:-2].strip()
    if s.startswith("`") and s.endswith("`") and len(s) > 2:
        s = s[1:-1].strip()
    return s


def parse_registry(md_text: str) -> dict:
    """Parse SESSION-REGISTRY.md into structured controller, lease, session, and queue dicts."""
    result = {
        "lease": {
            "lockStatus": "",
            "holder": "",
            "resource": "",
            "since": "",
            "scope": "",
            "releaseCriteria": "",
        },
        "controller": {
            "currentControllerId": "",
            "currentControllerStatus": "",
            "defaultModel": "",
            "handoverHistory": [],
        },
        "activeSessions": [],
        "archivedSessions": [],
        "queue": [],
    }
    section = ""
    subsection = ""
    in_table = False
    table_header: list[str] = []

    for raw_line in md_text.splitlines():
        line = raw_line.strip()
        if line.startswith("## "):
            in_table = False
            table_header = []
            subsection = ""
            if "独占资源租约" in line or "Exclusive Resource Lease" in line:
                section = "lease"
            elif "常驻主交流总控" in line or "Control Tower" in line:
                section = "controller"
            elif "活跃" in line or "挂起" in line:
                section = "active"
            elif "归档" in line:
                section = "archived"
            elif "待调度" in line or "队列" in line:
                section = "queue"
            else:
                section = "other"
            continue

        if line.startswith("### "):
            in_table = False
            table_header = []
            subsection = line[4:].strip()
            continue

        if section == "controller" and line.startswith("- "):
            if "当前现役总控会话" in line:
                cid = extract_conv_id(line)
                result["controller"]["currentControllerId"] = cid
                st_m = re.search(r"状态[：:]\s*`?([A-Za-z0-9_-]+)`?", line)
                if st_m:
                    result["controller"]["currentControllerStatus"] = st_m.group(1)
            elif "常驻模型配置" in line:
                val = re.sub(r"^-\s*\*\*常驻模型配置\*\*[：:]\s*", "", line).strip()
                result["controller"]["defaultModel"] = val
            continue

        cells = _split_md_row(line)
        if not cells:
            if line and not line.startswith(">") and not line.startswith("---"):
                in_table = False
                table_header = []
            continue

        if not in_table:
            table_header = [_strip_md(c) for c in cells]
            in_table = True
            continue

        if _is_separator_row(cells):
            continue

        # Normalize cell count
        while len(cells) < len(table_header):
            cells.append("")

        if section == "lease" and len(cells) >= 2:
            key = _strip_md(cells[0])
            val = _strip_md(cells[1])
            if "锁状态" in key:
                result["lease"]["lockStatus"] = val
            elif "持锁会话" in key:
                result["lease"]["holder"] = val
            elif "独占对象" in key:
                result["lease"]["resource"] = val
            elif "起始时间" in key:
                result["lease"]["since"] = val
            elif "操作范围" in key or "保护现场" in key:
                result["lease"]["scope"] = val
            elif "解锁判据" in key:
                result["lease"]["releaseCriteria"] = val
        elif section == "controller" and "换届历史" in subsection and len(cells) >= 5:
            result["controller"]["handoverHistory"].append({
                "term": _strip_md(cells[0]),
                "conversationId": extract_conv_id(cells[1]) or _strip_md(cells[1]),
                "model": _strip_md(cells[2]),
                "period": _strip_md(cells[3]),
                "summary": _strip_md(cells[4]),
            })
        elif section == "active" and len(cells) >= 6:
            first = _strip_md(cells[0])
            if first in ("暂无", "-", ""):
                continue
            result["activeSessions"].append({
                "rawCell": cells[0],
                "conversationId": extract_conv_id(cells[0]),
                "topic": _strip_md(cells[1]),
                "modelTool": _strip_md(cells[2]),
                "lockStatus": _strip_md(cells[3]),
                "status": _strip_md(cells[4]),
                "paths": _strip_md(cells[5]),
            })
        elif section == "archived" and len(cells) >= 3:
            first = _strip_md(cells[0])
            if first in ("暂无", "-", ""):
                continue
            result["archivedSessions"].append({
                "rawCell": cells[0],
                "conversationId": extract_conv_id(cells[0]),
                "milestone": _strip_md(cells[1]),
                "summary": _strip_md(cells[2]),
            })
        elif section == "queue" and len(cells) >= 4:
            first = _strip_md(cells[0])
            if first in ("暂无", "-", ""):
                continue
            result["queue"].append({
                "id": first,
                "summary": _strip_md(cells[1]),
                "status": _strip_md(cells[2]),
                "route": _strip_md(cells[3]),
            })

    return result


def is_active_controller(conv_id: str, parsed: dict) -> bool:
    """Return True only when conv_id matches the registered active controller."""
    if not conv_id or not parsed:
        return False
    ctrl_id = ((parsed.get("controller") or {}).get("currentControllerId") or "").strip()
    if not ctrl_id or PLACEHOLDER_RE.match(ctrl_id):
        return False
    if conv_id == ctrl_id:
        return True
    if len(conv_id) >= 8 and len(ctrl_id) >= 8:
        return ctrl_id.startswith(conv_id) or conv_id.startswith(ctrl_id)
    return False


def resolve_brain_transcript(id_or_prefix: str, app_data_dir: pathlib.Path | None = None):
    """Safely resolve exact or unique prefix session transcript inside <app_data_dir>/brain."""
    cand = (id_or_prefix or "").strip()
    if not ID_RE.match(cand):
        return ("invalid", None)
    root = ((app_data_dir or get_app_data_dir()) / "brain").resolve()
    if not root.is_dir():
        return ("missing", None)

    exact = root / cand / ".system_generated" / "logs" / "transcript.jsonl"
    try:
        exact_resolved = exact.resolve()
        if exact_resolved.is_relative_to(root) and exact_resolved.is_file():
            return ("ok", exact_resolved)
    except OSError:
        pass

    matches = []
    try:
        for entry in sorted(root.iterdir()):
            if not entry.is_dir() or not entry.name.startswith(cand):
                continue
            tp = entry / ".system_generated" / "logs" / "transcript.jsonl"
            if tp.is_file():
                tp_res = tp.resolve()
                if tp_res.is_relative_to(root):
                    matches.append((entry.name, tp_res))
    except OSError:
        return ("missing", None)

    if len(matches) == 1:
        return ("ok", matches[0][1])
    if len(matches) > 1:
        return ("ambiguous", [m[0] for m in matches])
    return ("missing", None)


def _clean_user_prompt(raw: str) -> str:
    if not isinstance(raw, str):
        return ""
    m = re.search(r"<USER_REQUEST>([\s\S]*?)</USER_REQUEST>", raw)
    text = m.group(1) if m else raw
    text = " ".join(text.split())
    if len(text) > 100:
        return text[:97] + "..."
    return text


def inspect_transcript(path: pathlib.Path) -> dict:
    """Lightweight read of transcript.jsonl for goal, tail state, and compaction count."""
    info = {
        "lineCount": 0,
        "maxStepIndex": 0,
        "goal": "",
        "lastModel": "",
        "lastUpdatedAt": "",
        "lastStatus": "",
        "lastError": "",
        "compactions": 0,
    }
    if not path or not path.is_file():
        return info

    explicit_compactions = 0
    token_drops = 0
    prev_used_by_model: dict[str, int] = {}

    try:
        with path.open("r", encoding="utf-8", errors="ignore") as fh:
            for raw_line in fh:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    step = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(step, dict):
                    continue

                info["lineCount"] += 1
                idx = step.get("step_index")
                if isinstance(idx, int) and idx > info["maxStepIndex"]:
                    info["maxStepIndex"] = idx

                stype = str(step.get("type") or "").upper()
                if not info["goal"] and stype == "USER_INPUT":
                    info["goal"] = _clean_user_prompt(step.get("content") or "")

                model = step.get("model")
                if isinstance(model, str) and model.strip():
                    info["lastModel"] = model.strip()

                created_at = step.get("created_at")
                if isinstance(created_at, str) and created_at.strip():
                    info["lastUpdatedAt"] = created_at.strip()

                status = step.get("status")
                if isinstance(status, str) and status.strip():
                    info["lastStatus"] = status.strip()

                err = step.get("error")
                if isinstance(err, str) and err.strip():
                    info["lastError"] = err.strip()[:120]

                if any(tag in stype for tag in ("CHECKPOINT", "COMPACTION", "CONVERSATION_SUMMARY")) or step.get("is_checkpoint"):
                    explicit_compactions += 1

                if stype == "PLANNER_RESPONSE" or any(k in step for k in ("input_tokens", "cache_read_tokens")):
                    in_tok = step.get("input_tokens") or 0
                    cache_tok = step.get("cache_read_tokens") or 0
                    if isinstance(in_tok, (int, float)) and isinstance(cache_tok, (int, float)):
                        used = int(in_tok) + int(cache_tok)
                        if used > 0:
                            mkey = (model.strip() if isinstance(model, str) and model.strip() else "_default")
                            prev_used = prev_used_by_model.get(mkey, 0)
                            if prev_used > 0 and used < prev_used * 0.72 and (prev_used - used) > 30000:
                                token_drops += 1
                            prev_used_by_model[mkey] = used
    except OSError:
        return info

    info["compactions"] = max(explicit_compactions, token_drops)
    return info


def load_hook_state() -> dict:
    """Read hook-state.json without creating directories."""
    p = get_data_dir() / "hook-state.json"
    if not p.is_file():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_hook_state(state: dict) -> None:
    """Atomically persist hook-state.json inside AGY_CONTROL_TOWER_DATA_DIR."""
    data_dir = get_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    target = data_dir / "hook-state.json"
    tmp = data_dir / f".hook-state.{os.getpid()}.tmp"
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, target)
