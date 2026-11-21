#!/usr/bin/env bash
# 只读审计指定目录中残留的旧全局 Skill 路径引用（skills/control-tower）
# 自动排除原生插件合法路径（plugins/control-tower/skills/control-tower 与 plugin/skills/control-tower）
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

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "错误: 未找到 node 运行时" >&2
  exit 2
fi

exec "$NODE_BIN" - "$FAIL_ON_MATCH" "${DIRS[@]}" <<'JS'
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const failOnMatch = process.argv[2] === '1';
const roots = process.argv.slice(3).map((p) => resolve(p));

const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'dist', 'build', 'target']);
const OLD_TOKEN = 'skills/control-tower';
const VALID_TOKENS = [
  'plugins/control-tower/skills/control-tower',
  'plugin/skills/control-tower',
];

const hits = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(full);
      continue;
    }
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    let raw;
    try {
      raw = readFileSync(full);
    } catch {
      continue;
    }
    if (raw.includes(0)) continue;
    const text = raw.toString('utf8');
    if (!text.includes(OLD_TOKEN)) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      let cleaned = lines[i];
      for (const tok of VALID_TOKENS) {
        cleaned = cleaned.split(tok).join('').split(tok.replace(/\//g, '\\')).join('');
      }
      if (cleaned.includes(OLD_TOKEN)) {
        hits.push({ file: full, line: i + 1, content: lines[i].trim() });
      }
    }
  }
}

for (const root of roots) walk(root);

if (hits.length === 0) {
  console.log('OK: 未检出残留旧路径 skills/control-tower 引用。');
  process.exit(0);
}

console.log(`检出 ${hits.length} 处旧路径引用（请更新为 control-tower 原生技能引用或 plugins/control-tower/skills/control-tower/）：`);
for (const h of hits) {
  console.log(`  ${h.file}:${h.line}: ${h.content}`);
}
process.exit(failOnMatch ? 1 : 0);
JS
