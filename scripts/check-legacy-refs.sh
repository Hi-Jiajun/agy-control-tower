#!/usr/bin/env bash
# 只读审计指定目录中残留的旧全局 Skill 路径引用（skills/control-tower）
# 自动排除已迁移的原生插件新路径（plugins/control-tower/skills/control-tower）
# 用法: bash scripts/check-legacy-refs.sh [--fail-on-match] <目录1> [目录2 ...]
set -euo pipefail

FAIL_ON_MATCH=0
DIRS=()

usage() {
  cat <<'EOF'
用法: bash scripts/check-legacy-refs.sh [--fail-on-match] <目录1> [目录2 ...]
选项:
  --fail-on-match  当检测到旧路径残留时返回非零退出码（1）
  -h, --help       显示此帮助信息
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --fail-on-match)
      FAIL_ON_MATCH=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "未知参数: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      DIRS+=("$1")
      ;;
  esac
  shift
done

if [ "${#DIRS[@]}" -eq 0 ]; then
  echo "错误: 请至少提供一个待扫描目录" >&2
  usage >&2
  exit 2
fi

for d in "${DIRS[@]}"; do
  if [ ! -d "$d" ]; then
    echo "错误: 目录不存在: $d" >&2
    exit 2
  fi
done

PYTHON_BIN="$(command -v python3 || echo /usr/bin/python3)"

"$PYTHON_BIN" - "$FAIL_ON_MATCH" "${DIRS[@]}" <<'PY'
import os
import pathlib
import sys

fail_on_match = sys.argv[1] == "1"
roots = [pathlib.Path(p).resolve() for p in sys.argv[2:]]

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "dist", "build", "target"}
OLD_TOKEN = "skills/control-tower"
NEW_TOKEN = "plugins/control-tower/skills/control-tower"

hits = []

for root in roots:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in sorted(dirnames) if d not in SKIP_DIRS]
        for fname in sorted(filenames):
            fpath = pathlib.Path(dirpath) / fname
            if fpath.is_symlink() or not fpath.is_file():
                continue
            try:
                raw = fpath.read_bytes()
            except OSError:
                continue
            if b"\x00" in raw:
                continue
            text = raw.decode("utf-8", errors="ignore")
            if OLD_TOKEN not in text:
                continue
            for idx, line in enumerate(text.splitlines(), start=1):
                stripped_new = line.replace(NEW_TOKEN, "").replace(NEW_TOKEN.replace("/", "\\"), "")
                if OLD_TOKEN in stripped_new:
                    hits.append((str(fpath), idx, line.strip()))

if not hits:
    print("OK: 未检出残留旧路径 skills/control-tower 引用。")
    sys.exit(0)

print(f"检出 {len(hits)} 处旧路径引用（请更新为 ~/.gemini/config/plugins/control-tower/skills/control-tower/）：")
for fpath, lineno, content in hits:
    print(f"  {fpath}:{lineno}: {content}")

sys.exit(1 if fail_on_match else 0)
PY