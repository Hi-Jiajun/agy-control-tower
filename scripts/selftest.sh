#!/usr/bin/env bash
# control-tower 仓库隔离沙箱自检套件（零污染真实 ~/.gemini/config）
# 用法: bash scripts/selftest.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

PYTHON_BIN="$(command -v python3 || echo /usr/bin/python3)"
TMP_BASE="${TMPDIR:-/tmp}"
TMP_CONFIG="$(mktemp -d "$TMP_BASE/agy-ct-selftest.XXXXXX")"

cleanup() {
  "$PYTHON_BIN" - "$TMP_CONFIG" <<'PY'
import shutil, sys
shutil.rmtree(sys.argv[1], ignore_errors=True)
PY
}
trap cleanup EXIT

fails=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; fails=$((fails + 1)); }

# 1) 源码文件清单校验（存在且非空）
if "$PYTHON_BIN" - <<'PY'
import pathlib, sys
required = [
    ".gitignore",
    "AGENTS.md",
    "README.md",
    "install.sh",
    "scripts/selftest.sh",
    "skills/control-tower/SKILL.md",
    "skills/control-tower/references/model-routing.md",
    "skills/control-tower/references/templates.md",
]
for rel in required:
    p = pathlib.Path(rel)
    if not p.is_file() or p.stat().st_size == 0:
        print(f"Missing or empty: {rel}", file=sys.stderr)
        sys.exit(1)
PY
then
  pass "1. 源码目录与核心文件清单完整且非空"
else
  fail "1. 源码目录与核心文件清单完整且非空"
fi

# 2) SKILL.md YAML frontmatter 合法性校验
if "$PYTHON_BIN" - <<'PY'
import pathlib, re, sys
text = pathlib.Path("skills/control-tower/SKILL.md").read_text(encoding="utf-8")
m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
assert m, "SKILL.md missing YAML frontmatter"
fm = m.group(1)
name_m = re.search(r"(?m)^name:\s*(.+?)\s*$", fm)
assert name_m and name_m.group(1).strip("'\"") == "control-tower", "frontmatter name != control-tower"
desc_m = re.search(r"(?m)^description:\s*(.+?)\s*$", fm)
assert desc_m and len(desc_m.group(1).strip()) > 0, "frontmatter description empty"
PY
then
  pass "2. SKILL.md YAML frontmatter（name / description）校验通过"
else
  fail "2. SKILL.md YAML frontmatter（name / description）校验通过"
fi

# 3) SKILL.md 内 Markdown 相对引用链接有效性校验
if "$PYTHON_BIN" - <<'PY'
import pathlib, re, sys
skill_path = pathlib.Path("skills/control-tower/SKILL.md")
text = skill_path.read_text(encoding="utf-8")
links = re.findall(r"\[[^\]]+\]\((\./[^)#]+)\)", text)
expected = {"./references/model-routing.md", "./references/templates.md"}
assert expected.issubset(set(links)), f"Missing expected links: {expected - set(links)}"
for rel in links:
    target = (skill_path.parent / rel).resolve()
    assert target.is_file(), f"Broken relative link: {rel} -> {target}"
PY
then
  pass "3. SKILL.md 内 references 相对链接全部存在且有效"
else
  fail "3. SKILL.md 内 references 相对链接全部存在且有效"
fi

# 4) install.sh 语法检查与 --dry-run 不落盘校验
DRY_DIR="$TMP_CONFIG/dry"
if bash -n "$REPO_ROOT/install.sh" \
   && AGY_CONFIG_DIR="$DRY_DIR" bash "$REPO_ROOT/install.sh" --dry-run >/dev/null \
   && [ ! -e "$DRY_DIR" ]; then
  pass "4. install.sh 语法通过且 --dry-run 未创建目标目录"
else
  fail "4. install.sh 语法通过且 --dry-run 未创建目标目录"
fi

# 5) 沙箱隔离安装及逐文件 SHA256 一致性校验
LIVE_DIR="$TMP_CONFIG/live"
if AGY_CONFIG_DIR="$LIVE_DIR" bash "$REPO_ROOT/install.sh" >/dev/null \
   && "$PYTHON_BIN" - "$REPO_ROOT/skills/control-tower" "$LIVE_DIR/skills/control-tower" <<'PY'
import hashlib, pathlib, sys
src_root = pathlib.Path(sys.argv[1])
dst_root = pathlib.Path(sys.argv[2])
for rel in ("SKILL.md", "references/model-routing.md", "references/templates.md"):
    s = hashlib.sha256((src_root / rel).read_bytes()).hexdigest()
    d = hashlib.sha256((dst_root / rel).read_bytes()).hexdigest()
    assert s == d, f"SHA256 mismatch on {rel}: {s} != {d}"
PY
then
  pass "5. 沙箱隔离安装成功且产物与源码 SHA256 完全一致"
else
  fail "5. 沙箱隔离安装成功且产物与源码 SHA256 完全一致"
fi

# 6) 公开仓库隐私、忽略配置与排版规范校验
if "$PYTHON_BIN" - <<'PY'
import pathlib, re, sys
gi = pathlib.Path(".gitignore").read_text(encoding="utf-8")
assert any(line.strip() == ".agents/" for line in gi.splitlines()), ".agents/ not ignored in .gitignore"

# 动态拼接敏感字面量，避免自检脚本自身误触发匹配
forb_home = "/" + "home" + "/"
forb_users = "/" + "Users" + "/"
forb_ip = "192." + "168."
forb_dot = chr(0x00B7)
uuid_re = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-")

for p in sorted(pathlib.Path(".").rglob("*")):
    if not p.is_file():
        continue
    if ".git" in p.parts or ".agents" in p.parts or "__pycache__" in p.parts:
        continue
    txt = p.read_text(encoding="utf-8")
    assert forb_home not in txt, f"Personal home path in {p}"
    assert forb_users not in txt, f"Personal Users path in {p}"
    assert forb_ip not in txt, f"Private IP in {p}"
    assert not uuid_re.search(txt), f"UUID in {p}"
    assert forb_dot not in txt, f"Middle dot in {p}"
PY
then
  pass "6. 公开仓库隐私脱敏、.agents/ 忽略与零间隔号检查全通过"
else
  fail "6. 公开仓库隐私脱敏、.agents/ 忽略与零间隔号检查全通过"
fi

echo "----"
if [ "$fails" -eq 0 ]; then
  echo "ALL PASS"
  exit 0
else
  echo "FAILED: $fails"
  exit 1
fi
