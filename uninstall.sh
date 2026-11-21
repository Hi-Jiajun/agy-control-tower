#!/usr/bin/env bash
# 安全卸载 control-tower 原生插件（可选清理旧全局 Skill，保留数据目录与工作区台账）
# 用法:
#   ./uninstall.sh [--dry-run] [--include-legacy] [--force]
# 环境变量:
#   AGY_CONFIG_DIR（默认 $HOME/.gemini/config）
set -euo pipefail

DRY_RUN=0
INCLUDE_LEGACY=0
FORCE=0

usage() {
  cat <<'EOF'
用法: ./uninstall.sh [选项]
选项:
  --dry-run         仅预览拟卸载路径，不执行删除
  --include-legacy  同时校验并卸载旧全局 Skill 目录（skills/control-tower）
  --force           跳过目标目录归属校验强制卸载
  -h, --help        显示此帮助信息
环境变量:
  AGY_CONFIG_DIR    目标 Antigravity 配置根目录（默认 $HOME/.gemini/config）
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --include-legacy)
      INCLUDE_LEGACY=1
      ;;
    --force)
      FORCE=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

CONFIG_DIR="${AGY_CONFIG_DIR:-$HOME/.gemini/config}"
PYTHON_BIN="$(command -v python3 || echo /usr/bin/python3)"

exec "$PYTHON_BIN" - "$CONFIG_DIR" "$DRY_RUN" "$INCLUDE_LEGACY" "$FORCE" <<'PY'
import json
import os
import pathlib
import re
import shutil
import sys

config_dir = pathlib.Path(os.path.expanduser(sys.argv[1])).resolve()
dry_run = sys.argv[2] == "1"
include_legacy = sys.argv[3] == "1"
force = sys.argv[4] == "1"

plugin_dir = config_dir / "plugins" / "control-tower"
legacy_dir = config_dir / "skills" / "control-tower"

KNOWN_LEGACY_FILES = {
    "SKILL.md",
    "references/model-routing.md",
    "references/templates.md",
    ".control-tower-install.json",
}


def read_json_dict(p: pathlib.Path) -> dict | None:
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def is_owned_plugin() -> bool:
    if plugin_dir.is_symlink() or not plugin_dir.is_dir():
        return False
    pj = read_json_dict(plugin_dir / "plugin.json")
    if pj and pj.get("name") == "control-tower":
        return True
    marker = read_json_dict(plugin_dir / ".control-tower-install.json")
    return bool(marker and marker.get("plugin") == "control-tower")


def is_owned_legacy() -> bool:
    if legacy_dir.is_symlink():
        target = os.readlink(legacy_dir)
        resolved = (legacy_dir.parent / target).resolve()
        return resolved == plugin_dir.resolve() or "control-tower" in str(resolved)
    if not legacy_dir.is_dir():
        return False
    marker = read_json_dict(legacy_dir / ".control-tower-install.json")
    if marker and marker.get("plugin") == "control-tower":
        return True
    skill_md = legacy_dir / "SKILL.md"
    if not skill_md.is_file():
        return False
    txt = skill_md.read_text(encoding="utf-8", errors="ignore")
    m = re.match(r"^---\n(.*?)\n---\n", txt, re.S)
    if not m or not re.search(r"(?m)^name:\s*['\"]?control-tower['\"]?\s*$", m.group(1)):
        return False
    for p in legacy_dir.rglob("*"):
        if (p.is_file() or p.is_symlink()) and p.relative_to(legacy_dir).as_posix() not in KNOWN_LEGACY_FILES:
            return False
    return True


def remove_guarded(target: pathlib.Path, expected: pathlib.Path) -> None:
    if os.path.abspath(str(target)) != os.path.abspath(str(expected)):
        raise RuntimeError(f"Unexpected uninstall target: {target}")
    if target.is_symlink() or target.is_file():
        os.unlink(target)
    elif target.is_dir():
        shutil.rmtree(target)


targets: list[tuple[str, pathlib.Path, pathlib.Path]] = []

if os.path.lexists(plugin_dir):
    if not is_owned_plugin() and not force:
        print(f"安全阻断: {plugin_dir} 不是 control-tower 插件目录，拒绝卸载（如需覆盖请加 --force）。", file=sys.stderr)
        sys.exit(1)
    targets.append(("原生插件目录", plugin_dir, config_dir / "plugins" / "control-tower"))

if include_legacy and os.path.lexists(legacy_dir):
    if not is_owned_legacy() and not force:
        print(f"安全阻断: {legacy_dir} 含未知内容或非 control-tower 技能，拒绝卸载（如需覆盖请加 --force）。", file=sys.stderr)
        sys.exit(1)
    targets.append(("旧全局 Skill 目录", legacy_dir, config_dir / "skills" / "control-tower"))

if not targets:
    print(f"未检测到已安装的 control-tower（配置目录: {config_dir}），无需卸载。")
    sys.exit(0)

if dry_run:
    for label, target, _ in targets:
        print(f"[DRY-RUN] 计划移除{label}: {target}")
    sys.exit(0)

for label, target, expected in targets:
    remove_guarded(target, expected)
    print(f"已移除{label}: {target}")

print("control-tower 卸载完成（已保留 ~/.local/share/agy-control-tower/、config.json 与所有工作区台账）")
PY