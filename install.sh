#!/usr/bin/env bash
# 安装 control-tower 原生插件（默认）或兼容旧全局 Skill，并强制保持两形态互斥。
# 用法:
#   ./install.sh [--dry-run] [--status|--check] [--mode plugin|legacy-skill] [--allow-downgrade] [--force-migrate]
# 环境变量:
#   AGY_CONFIG_DIR（默认 $HOME/.gemini/config）
set -euo pipefail

DRY_RUN=0
STATUS_ONLY=0
MODE="plugin"
ALLOW_DOWNGRADE=0
FORCE_MIGRATE=0

usage() {
  cat <<'EOF'
用法: ./install.sh [选项]
选项:
  --dry-run            仅预览目标路径、版本变化、同步清单与冲突清理动作，不写入任何文件
  --status, --check    只读核查当前配置目录下的插件与旧散装 Skill 状态
  --mode <模式>        安装模式: plugin（默认）或 legacy-skill（兼容回退）
  --allow-downgrade    允许以较低版本覆盖已安装的更高版本
  --force-migrate      允许在目标冲突目录含未知额外文件时强制迁移清理
  -h, --help           显示此帮助信息
环境变量:
  AGY_CONFIG_DIR       目标 Antigravity 配置根目录（默认 $HOME/.gemini/config）
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --status|--check)
      STATUS_ONLY=1
      ;;
    --mode)
      shift
      if [ "$#" -eq 0 ]; then
        echo "错误: --mode 需要参数（plugin 或 legacy-skill）" >&2
        exit 2
      fi
      MODE="$1"
      ;;
    --mode=*)
      MODE="${1#--mode=}"
      ;;
    --allow-downgrade)
      ALLOW_DOWNGRADE=1
      ;;
    --force-migrate)
      FORCE_MIGRATE=1
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

if [ "$MODE" != "plugin" ] && [ "$MODE" != "legacy-skill" ]; then
  echo "不支持的安装模式: $MODE（仅支持 plugin 或 legacy-skill）" >&2
  exit 2
fi

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="${AGY_CONFIG_DIR:-$HOME/.gemini/config}"
PYTHON_BIN="$(command -v python3 || echo /usr/bin/python3)"

exec "$PYTHON_BIN" - "$REPO_DIR" "$CONFIG_DIR" "$MODE" "$DRY_RUN" "$STATUS_ONLY" "$ALLOW_DOWNGRADE" "$FORCE_MIGRATE" <<'PY'
import json
import os
import pathlib
import re
import shutil
import sys

repo_dir = pathlib.Path(sys.argv[1]).resolve()
config_dir = pathlib.Path(os.path.expanduser(sys.argv[2])).resolve()
mode = sys.argv[3]
dry_run = sys.argv[4] == "1"
status_only = sys.argv[5] == "1"
allow_downgrade = sys.argv[6] == "1"
force_migrate = sys.argv[7] == "1"

plugin_dir = config_dir / "plugins" / "control-tower"
legacy_dir = config_dir / "skills" / "control-tower"

PLUGIN_FILES = [
    "plugin.json",
    "hooks.json",
    "README.md",
    "LICENSE",
    "assets/logo.svg",
    "skills/control-tower/SKILL.md",
    "skills/control-tower/references/model-routing.md",
    "skills/control-tower/references/templates.md",
    "scripts/ctlib.py",
    "scripts/hook-session-start.py",
    "scripts/hook-pre-invocation.py",
    "sidecars/tower/package.json",
    "sidecars/tower/sidecar.json",
    "sidecars/tower/main.mjs",
    "sidecars/tower/index.html",
    "sidecars/tower/styles.css",
    "sidecars/tower/app.js",
]

LEGACY_MAP = {
    "skills/control-tower/SKILL.md": "SKILL.md",
    "skills/control-tower/references/model-routing.md": "references/model-routing.md",
    "skills/control-tower/references/templates.md": "references/templates.md",
}

KNOWN_LEGACY_FILES = {
    "SKILL.md",
    "references/model-routing.md",
    "references/templates.md",
    ".control-tower-install.json",
}

EXEC_FILES = {
    "scripts/hook-session-start.py",
    "scripts/hook-pre-invocation.py",
}


def parse_semver(ver: str) -> tuple[int, int, int]:
    core = (ver or "").strip().lstrip("vV").split("-", 1)[0].split("+", 1)[0]
    parts = core.split(".")
    nums = []
    for i in range(3):
        if i < len(parts) and parts[i].isdigit():
            nums.append(int(parts[i]))
        else:
            nums.append(0)
    return (nums[0], nums[1], nums[2])


def read_json_dict(p: pathlib.Path) -> dict | None:
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def inspect_plugin_dir() -> dict:
    info = {
        "exists": os.path.lexists(plugin_dir),
        "ownership": "absent",
        "version": "",
        "managedFiles": [],
    }
    if not info["exists"]:
        return info
    if plugin_dir.is_symlink() or not plugin_dir.is_dir():
        info["ownership"] = "foreign"
        return info
    pj = read_json_dict(plugin_dir / "plugin.json")
    marker = read_json_dict(plugin_dir / ".control-tower-install.json")
    if pj and pj.get("name") == "control-tower":
        info["ownership"] = "owned"
        info["version"] = str(pj.get("version") or (marker or {}).get("version") or "0.0.0")
    elif marker and marker.get("plugin") == "control-tower":
        info["ownership"] = "owned"
        info["version"] = str(marker.get("version") or "0.0.0")
    else:
        info["ownership"] = "foreign"
    if marker and isinstance(marker.get("managedFiles"), list):
        info["managedFiles"] = [str(x) for x in marker["managedFiles"]]
    return info


def inspect_legacy_dir() -> dict:
    info = {
        "exists": os.path.lexists(legacy_dir),
        "ownership": "absent",
        "version": "",
        "extraFiles": [],
        "managedFiles": [],
    }
    if not info["exists"]:
        return info
    if legacy_dir.is_symlink():
        target = os.readlink(legacy_dir)
        resolved = (legacy_dir.parent / target).resolve()
        if resolved == plugin_dir.resolve() or "control-tower" in str(resolved):
            info["ownership"] = "owned_symlink"
        else:
            info["ownership"] = "foreign"
        return info
    if not legacy_dir.is_dir():
        info["ownership"] = "foreign"
        return info

    skill_md = legacy_dir / "SKILL.md"
    marker = read_json_dict(legacy_dir / ".control-tower-install.json")
    is_ct_skill = False
    if skill_md.is_file():
        txt = skill_md.read_text(encoding="utf-8", errors="ignore")
        m = re.match(r"^---\n(.*?)\n---\n", txt, re.S)
        if m and re.search(r"(?m)^name:\s*['\"]?control-tower['\"]?\s*$", m.group(1)):
            is_ct_skill = True
    if not is_ct_skill and not (marker and marker.get("plugin") == "control-tower"):
        info["ownership"] = "foreign"
        return info

    if marker:
        info["version"] = str(marker.get("version") or "")
        if isinstance(marker.get("managedFiles"), list):
            info["managedFiles"] = [str(x) for x in marker["managedFiles"]]

    extras = []
    for p in sorted(legacy_dir.rglob("*")):
        if p.is_file() or p.is_symlink():
            rel = p.relative_to(legacy_dir).as_posix()
            if rel not in KNOWN_LEGACY_FILES:
                extras.append(rel)
    info["extraFiles"] = extras
    info["ownership"] = "unknown_extra_files" if extras else "owned"
    return info


def remove_target_guarded(target: pathlib.Path, expected: pathlib.Path) -> None:
    if os.path.abspath(str(target)) != os.path.abspath(str(expected)):
        raise RuntimeError(f"Refusing to remove unexpected path: {target}")
    if target.is_symlink() or target.is_file():
        os.unlink(target)
    elif target.is_dir():
        shutil.rmtree(target)


def copy_file(src: pathlib.Path, dst: pathlib.Path, make_exec: bool = False) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.resolve() != dst.resolve():
        shutil.copy2(src, dst)
    if make_exec:
        mode_bits = dst.stat().st_mode | 0o755
        os.chmod(dst, mode_bits)


src_pj = read_json_dict(repo_dir / "plugin.json") or {}
src_version = str(src_pj.get("version") or "1.0.0")
p_info = inspect_plugin_dir()
l_info = inspect_legacy_dir()

if status_only:
    print(f"配置目录: {config_dir}")
    print(f"源码版本: {src_version}")
    print(f"原生插件 ({plugin_dir}): {p_info['ownership']} {p_info['version'] or ''}".strip())
    print(f"旧全局 Skill ({legacy_dir}): {l_info['ownership']} {l_info['version'] or ''}".strip())
    if p_info["exists"] and l_info["exists"]:
        print("警告: 检测到原生插件与旧全局 Skill 同时存在，建议运行 ./install.sh 收敛为单一形态。")
    sys.exit(0)

if mode == "plugin":
    for rel in PLUGIN_FILES:
        if not (repo_dir / rel).is_file():
            print(f"缺少源文件: {repo_dir / rel}", file=sys.stderr)
            sys.exit(1)

    if p_info["ownership"] == "foreign":
        print(f"安全阻断: {plugin_dir} 不是 control-tower 托管插件目录，拒绝覆盖。", file=sys.stderr)
        sys.exit(1)

    action = "install"
    obsolete = []
    if p_info["ownership"] == "owned":
        cur_t = parse_semver(p_info["version"])
        new_t = parse_semver(src_version)
        if new_t < cur_t and not allow_downgrade:
            print(
                f"安全阻断: 已安装版本 ({p_info['version']}) 高于源码版本 ({src_version})；"
                "如需降级请传入 --allow-downgrade。",
                file=sys.stderr,
            )
            sys.exit(1)
        if new_t > cur_t:
            action = "upgrade"
        elif new_t < cur_t:
            action = "downgrade"
        else:
            action = "reinstall"
        obsolete = sorted(set(p_info["managedFiles"]) - set(PLUGIN_FILES))

    migrate_legacy = False
    if l_info["exists"]:
        if l_info["ownership"] in ("owned", "owned_symlink"):
            migrate_legacy = True
        elif force_migrate:
            migrate_legacy = True
        else:
            extra_note = f"（含未托管文件: {', '.join(l_info['extraFiles'])}）" if l_info["extraFiles"] else ""
            print(
                f"安全阻断: 检测到旧路径 {legacy_dir} 存在非纯托管内容{extra_note}，"
                "拒绝双份并存或盲目移除。请人工核查后传入 --force-migrate。",
                file=sys.stderr,
            )
            sys.exit(1)

    if dry_run:
        print(f"[DRY-RUN] 模式: plugin ({action})")
        print(f"[DRY-RUN] 源目录: {repo_dir}")
        print(f"[DRY-RUN] 目标插件目录: {plugin_dir} (版本: {p_info['version'] or '未安装'} -> {src_version})")
        for rel in PLUGIN_FILES:
            print(f"[DRY-RUN] 计划同步: {repo_dir / rel} -> {plugin_dir / rel}")
        for rel in obsolete:
            print(f"[DRY-RUN] 计划清理废弃受管文件: {plugin_dir / rel}")
        if migrate_legacy:
            print(f"[DRY-RUN] 计划自动迁移并清理旧全局 Skill（防双重发现）: {legacy_dir}")
        sys.exit(0)

    plugin_dir.mkdir(parents=True, exist_ok=True)
    for rel in PLUGIN_FILES:
        copy_file(repo_dir / rel, plugin_dir / rel, make_exec=(rel in EXEC_FILES))

    plugin_real = plugin_dir.resolve()
    for rel in obsolete:
        cand = (plugin_dir / rel).resolve()
        if cand.is_relative_to(plugin_real) and cand.is_file() and not cand.is_symlink():
            cand.unlink()

    marker = {
        "plugin": "control-tower",
        "mode": "plugin",
        "version": src_version,
        "managedFiles": PLUGIN_FILES,
    }
    marker_tmp = plugin_dir / f".control-tower-install.{os.getpid()}.tmp"
    marker_tmp.write_text(json.dumps(marker, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(marker_tmp, plugin_dir / ".control-tower-install.json")

    if migrate_legacy:
        remove_target_guarded(legacy_dir, config_dir / "skills" / "control-tower")

    print("control-tower 原生插件安装完成:")
    print(f"  动作与版本: {action} ({p_info['version'] or '新装'} -> {src_version})")
    print(f"  配置目录: {config_dir}")
    print(f"  插件路径: {plugin_dir}")
    print(f"  同步文件: {len(PLUGIN_FILES)} 个")
    if migrate_legacy:
        print(f"  已自动清理旧全局 Skill（消除双重发现）: {legacy_dir}")
        print("  后续迁移建议: 运行 bash scripts/check-legacy-refs.sh <业务工作区目录> 审计旧路径引用")
    print("  核验命令: agy plugin list --json | 或在界面打开 [control-tower](customization://control-tower)")
    sys.exit(0)

# legacy-skill mode
for src_rel in LEGACY_MAP:
    if not (repo_dir / src_rel).is_file():
        print(f"缺少源文件: {repo_dir / src_rel}", file=sys.stderr)
        sys.exit(1)

if l_info["ownership"] == "foreign" and not force_migrate:
    print(f"安全阻断: {legacy_dir} 不是 control-tower 技能目录，拒绝覆盖。", file=sys.stderr)
    sys.exit(1)
if l_info["ownership"] == "unknown_extra_files" and not force_migrate:
    print(f"安全阻断: {legacy_dir} 含未托管额外文件，请确认或传入 --force-migrate。", file=sys.stderr)
    sys.exit(1)

if l_info["ownership"] in ("owned", "unknown_extra_files") and l_info["version"]:
    if parse_semver(src_version) < parse_semver(l_info["version"]) and not allow_downgrade:
        print(
            f"安全阻断: 已安装旧 Skill 版本 ({l_info['version']}) 高于源码版本 ({src_version})；"
            "如需降级请传入 --allow-downgrade。",
            file=sys.stderr,
        )
        sys.exit(1)

migrate_plugin = False
if p_info["exists"]:
    if p_info["ownership"] == "owned" or force_migrate:
        migrate_plugin = True
    else:
        print(f"安全阻断: {plugin_dir} 为非 control-tower 插件目录，拒绝移除。", file=sys.stderr)
        sys.exit(1)

if dry_run:
    print("[DRY-RUN] 模式: legacy-skill")
    print(f"[DRY-RUN] 目标 Skill 目录: {legacy_dir} (版本: {src_version})")
    for src_rel, dst_rel in LEGACY_MAP.items():
        print(f"[DRY-RUN] 计划同步: {repo_dir / src_rel} -> {legacy_dir / dst_rel}")
    if migrate_plugin:
        print(f"[DRY-RUN] 计划移除原生插件目录以保持互斥: {plugin_dir}")
    sys.exit(0)

if l_info["ownership"] == "owned_symlink":
    remove_target_guarded(legacy_dir, config_dir / "skills" / "control-tower")

(legacy_dir / "references").mkdir(parents=True, exist_ok=True)
for src_rel, dst_rel in LEGACY_MAP.items():
    copy_file(repo_dir / src_rel, legacy_dir / dst_rel)

legacy_marker = {
    "plugin": "control-tower",
    "mode": "legacy-skill",
    "version": src_version,
    "managedFiles": list(LEGACY_MAP.values()),
}
l_tmp = legacy_dir / f".control-tower-install.{os.getpid()}.tmp"
l_tmp.write_text(json.dumps(legacy_marker, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
os.replace(l_tmp, legacy_dir / ".control-tower-install.json")

if migrate_plugin:
    remove_target_guarded(plugin_dir, config_dir / "plugins" / "control-tower")

print("control-tower 兼容全局 Skill 安装完成:")
print(f"  安装路径: {legacy_dir} (版本: {src_version})")
if migrate_plugin:
    print(f"  已移除原插件目录以保持单份互斥: {plugin_dir}")
PY