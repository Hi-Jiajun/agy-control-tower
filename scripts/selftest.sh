#!/usr/bin/env bash
# control-tower 隔离沙箱自检入口（零污染真实 ~/.gemini/config 与 ~/.gemini/antigravity）
# 用法: bash scripts/selftest.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "错误: 未找到 node 运行时" >&2
  exit 1
fi

"$NODE_BIN" --test tests/*.test.mjs
"$NODE_BIN" scripts/ct-replay.mjs
"$NODE_BIN" scripts/ct-skill-eval.mjs
if command -v google-chrome-stable >/dev/null 2>&1 || command -v google-chrome >/dev/null 2>&1 || command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1; then
  "$NODE_BIN" scripts/ct-ui-smoke.mjs --require-browser
else
  "$NODE_BIN" scripts/ct-ui-smoke.mjs
fi
echo "----"
echo "ALL PASS"
