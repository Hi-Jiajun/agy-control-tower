#!/usr/bin/env bash
# 将 control-tower 全局 Skill 安装至 $AGY_CONFIG_DIR/skills/control-tower/
# 支持:
#   ./install.sh [--dry-run]
#   AGY_CONFIG_DIR=/path/to/config ./install.sh
set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    -h|--help)
      echo "用法: $0 [--dry-run]"
      echo "环境变量: AGY_CONFIG_DIR（默认 \$HOME/.gemini/config）"
      exit 0
      ;;
    *)
      echo "未知参数: $arg" >&2
      exit 2
      ;;
  esac
done

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$REPO_DIR/skills/control-tower"
CONFIG_DIR="${AGY_CONFIG_DIR:-$HOME/.gemini/config}"
DEST_DIR="$CONFIG_DIR/skills/control-tower"

FILES=(
  "SKILL.md"
  "references/model-routing.md"
  "references/templates.md"
)

for rel in "${FILES[@]}"; do
  if [ ! -f "$SRC_DIR/$rel" ]; then
    echo "缺少源文件: $SRC_DIR/$rel" >&2
    exit 1
  fi
done

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[DRY-RUN] 源目录: $SRC_DIR"
  echo "[DRY-RUN] 目标目录: $DEST_DIR"
  for rel in "${FILES[@]}"; do
    echo "[DRY-RUN] 计划同步: $SRC_DIR/$rel -> $DEST_DIR/$rel"
  done
  exit 0
fi

mkdir -p "$DEST_DIR/references"

if [ "$(readlink -f "$SRC_DIR")" != "$(readlink -f "$DEST_DIR")" ]; then
  for rel in "${FILES[@]}"; do
    cp "$SRC_DIR/$rel" "$DEST_DIR/$rel"
  done
else
  echo "源目录与目标目录相同，跳过拷贝: $DEST_DIR"
fi

echo "control-tower Skill 安装完成:"
echo "  配置目录: $CONFIG_DIR"
echo "  安装路径: $DEST_DIR"
for rel in "${FILES[@]}"; do
  echo "  - $DEST_DIR/$rel"
done
