#!/usr/bin/env bash
# 安全核查并清理旧散装全局 Skill（$AGY_CONFIG_DIR/skills/control-tower），消除与原生插件并存导致的双重发现。
# 绝不触碰 plugins/ 目录、config.json 或任意工作区文件。
# 用法:
#   bash scripts/cleanup-legacy-skill.sh [--status] [--dry-run] [--force]
# 环境变量:
#   AGY_CONFIG_DIR（默认 $HOME/.gemini/config）
set -euo pipefail

DRY_RUN=0
STATUS_ONLY=0
FORCE=0

usage() {
  cat <<'EOF'
用法: bash scripts/cleanup-legacy-skill.sh [选项]
选项:
  --status     仅只读查看旧全局 Skill（skills/control-tower）是否存在及归属状态
  --dry-run    仅预览拟清理路径，不执行移除
  --force      当旧目录含未知自定义文件时强制移除
  -h, --help   显示此帮助信息
环境变量:
  AGY_CONFIG_DIR  目标 Antigravity 配置根目录（默认 $HOME/.gemini/config）
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
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "错误: 未找到 node 运行时" >&2
  exit 2
fi

exec "$NODE_BIN" - "$CONFIG_DIR" "$DRY_RUN" "$STATUS_ONLY" "$FORCE" <<'JS'
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const configDir = resolve(process.argv[2]);
const dryRun = process.argv[3] === '1';
const statusOnly = process.argv[4] === '1';
const force = process.argv[5] === '1';

const legacyDir = join(configDir, 'skills', 'control-tower');
const KNOWN_FILES = new Set([
  'SKILL.md',
  'references/model-routing.md',
  'references/templates.md',
  '.control-tower-install.json',
]);

function inspectLegacy() {
  let lst;
  try {
    lst = lstatSync(legacyDir);
  } catch {
    return { exists: false, ownership: 'absent', extraFiles: [] };
  }

  if (lst.isSymbolicLink()) {
    const target = readlinkSync(legacyDir);
    return {
      exists: true,
      ownership: target.includes('control-tower') ? 'owned_symlink' : 'foreign',
      extraFiles: [],
    };
  }
  if (!lst.isDirectory()) {
    return { exists: true, ownership: 'foreign', extraFiles: [] };
  }

  const markerPath = join(legacyDir, '.control-tower-install.json');
  let markerOwned = false;
  if (existsSync(markerPath)) {
    try {
      const m = JSON.parse(readFileSync(markerPath, 'utf8'));
      if (m && m.plugin === 'control-tower') markerOwned = true;
    } catch {
      // ignore
    }
  }

  const skillPath = join(legacyDir, 'SKILL.md');
  let skillOwned = false;
  if (existsSync(skillPath)) {
    try {
      const txt = readFileSync(skillPath, 'utf8');
      const fm = txt.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
      if (fm && /^name:\s*['"]?control-tower['"]?\s*$/m.test(fm[1])) {
        skillOwned = true;
      }
    } catch {
      // ignore
    }
  }

  if (!markerOwned && !skillOwned) {
    return { exists: true, ownership: 'foreign', extraFiles: [] };
  }

  const extraFiles = [];
  function walk(dir, relBase) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, rel);
      } else if (!KNOWN_FILES.has(rel)) {
        extraFiles.push(rel);
      }
    }
  }
  walk(legacyDir, '');

  return {
    exists: true,
    ownership: extraFiles.length > 0 ? 'unknown_extra_files' : 'owned',
    extraFiles,
  };
}

const info = inspectLegacy();

if (statusOnly) {
  console.log(`配置目录: ${configDir}`);
  console.log(`旧全局 Skill (${legacyDir}): ${info.ownership}`);
  if (info.extraFiles.length > 0) {
    console.log(`未知额外文件: ${info.extraFiles.join(', ')}`);
  }
  process.exit(0);
}

if (!info.exists) {
  console.log(`未检测到旧全局 Skill (${legacyDir})，无需清理。`);
  process.exit(0);
}

if (info.ownership === 'foreign' && !force) {
  console.error(`安全阻断: ${legacyDir} 不是 control-tower 托管目录，拒绝移除（如确认覆盖请传入 --force）。`);
  process.exit(1);
}

if (info.ownership === 'unknown_extra_files' && !force) {
  console.error(
    `安全阻断: ${legacyDir} 包含未托管文件 (${info.extraFiles.join(', ')})，请人工核查后传入 --force。`
  );
  process.exit(1);
}

if (dryRun) {
  console.log(`[DRY-RUN] 计划安全移除旧全局 Skill 目录: ${legacyDir} (归属: ${info.ownership})`);
  process.exit(0);
}

const expected = resolve(configDir, 'skills', 'control-tower');
if (resolve(legacyDir) !== expected) {
  throw new Error(`Refusing unexpected target: ${legacyDir}`);
}

const lst = lstatSync(legacyDir);
if (lst.isSymbolicLink() || lst.isFile()) {
  unlinkSync(legacyDir);
} else {
  rmSync(legacyDir, { recursive: true, force: false });
}

console.log(`已安全清理旧全局 Skill: ${legacyDir}`);
JS
