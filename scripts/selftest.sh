#!/usr/bin/env bash
# control-tower 仓库 12 项隔离沙箱自检套件（零污染真实 ~/.gemini/config 与 ~/.local/share）
# 用法: bash scripts/selftest.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

PYTHON_BIN="$(command -v python3 || echo /usr/bin/python3)"
NODE_BIN="$(command -v node || true)"
AGY_BIN="$(command -v agy || true)"
TMP_BASE="${TMPDIR:-/tmp}"
TMP_CONFIG="$(mktemp -d "$TMP_BASE/agy-ct-selftest.XXXXXX")"
SC_PID=""

cleanup() {
  if [ -n "$SC_PID" ]; then
    kill "$SC_PID" 2>/dev/null || true
    wait "$SC_PID" 2>/dev/null || true
  fi
  "$PYTHON_BIN" - "$TMP_CONFIG" <<'PY'
import shutil, sys
shutil.rmtree(sys.argv[1], ignore_errors=True)
PY
}
trap cleanup EXIT

fails=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; fails=$((fails + 1)); }

# 1) 源码全文件清单完整性校验
if "$PYTHON_BIN" - <<'PY'
import pathlib, sys
required = [
    ".gitignore",
    "AGENTS.md",
    "LICENSE",
    "README.md",
    "plugin.json",
    "hooks.json",
    "install.sh",
    "uninstall.sh",
    "assets/logo.svg",
    "skills/control-tower/SKILL.md",
    "skills/control-tower/references/model-routing.md",
    "skills/control-tower/references/templates.md",
    "scripts/ctlib.py",
    "scripts/hook-session-start.py",
    "scripts/hook-pre-invocation.py",
    "scripts/check-legacy-refs.sh",
    "scripts/selftest.sh",
    "sidecars/tower/package.json",
    "sidecars/tower/sidecar.json",
    "sidecars/tower/main.mjs",
    "sidecars/tower/index.html",
    "sidecars/tower/styles.css",
    "sidecars/tower/app.js",
]
for rel in required:
    p = pathlib.Path(rel)
    if not p.is_file() or p.stat().st_size == 0:
        print(f"Missing or empty: {rel}", file=sys.stderr)
        sys.exit(1)
PY
then
  pass "1. 源码全文件清单（23 个核心与插件资产）完整且非空"
else
  fail "1. 源码全文件清单（23 个核心与插件资产）完整且非空"
fi

# 2) plugin.json / assets/logo.svg / hooks.json / sidecar.json 原生规范校验
if "$PYTHON_BIN" - <<'PY'
import json, pathlib, shlex
pj = json.loads(pathlib.Path("plugin.json").read_text(encoding="utf-8"))
allowed = {"name", "displayName", "version", "description", "author", "homepage", "repository", "logo", "suggestedPrompts", "disabled"}
unknown = set(pj) - allowed
assert not unknown, f"Unknown plugin.json keys: {unknown}"
assert pj.get("name") == "control-tower"
assert pj.get("version") == "1.0.0"
assert pj.get("logo") == "assets/logo.svg" and pathlib.Path(pj["logo"]).is_file()
prompts = pj.get("suggestedPrompts")
assert isinstance(prompts, list) and 1 <= len(prompts) <= 3 and all(isinstance(x, str) and x.strip() for x in prompts)

svg = pathlib.Path("assets/logo.svg").read_text(encoding="utf-8")
assert "<svg" in svg and 'viewBox="0 0 128 128"' in svg

hj = json.loads(pathlib.Path("hooks.json").read_text(encoding="utf-8"))
assert set(hj) == {"control-tower-session-start", "control-tower-pre-invocation"}
for name, spec in hj.items():
    for ev, handlers in spec.items():
        assert ev in {"SessionStart", "PreInvocation"}
        assert isinstance(handlers, list) and handlers
        for h in handlers:
            parts = shlex.split(h.get("command", ""))
            assert parts and pathlib.Path(parts[-1]).is_file(), f"Missing hook script: {parts}"

sj = json.loads(pathlib.Path("sidecars/tower/sidecar.json").read_text(encoding="utf-8"))
assert sj.get("has_web_ui") is True
views = (sj.get("ui_config") or {}).get("views") or []
assert any(v.get("entrypoint") == "SIDECAR_UI_ENTRYPOINT_AUX_PANE" for v in views)
PY
then
  pass "2. plugin.json 白名单字段、logo.svg、hooks.json 与 sidecar.json 校验通过"
else
  fail "2. plugin.json 白名单字段、logo.svg、hooks.json 与 sidecar.json 校验通过"
fi

# 3) SKILL.md frontmatter、相对链接与 templates.md 零裸旧路径校验
if "$PYTHON_BIN" - <<'PY'
import pathlib, re
skill_path = pathlib.Path("skills/control-tower/SKILL.md")
text = skill_path.read_text(encoding="utf-8")
m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
assert m, "SKILL.md missing YAML frontmatter"
fm = m.group(1)
name_m = re.search(r"(?m)^name:\s*(.+?)\s*$", fm)
assert name_m and name_m.group(1).strip("'\"") == "control-tower"
desc_m = re.search(r"(?m)^description:\s*(.+?)\s*$", fm)
assert desc_m and len(desc_m.group(1).strip()) > 0

links = re.findall(r"\[[^\]]+\]\((\./[^)#]+)\)", text)
expected = {"./references/model-routing.md", "./references/templates.md"}
assert expected.issubset(set(links)), f"Missing expected links: {expected - set(links)}"
for rel in links:
    target = (skill_path.parent / rel).resolve()
    assert target.is_file(), f"Broken relative link: {rel}"

for doc_p in (skill_path, pathlib.Path("skills/control-tower/references/templates.md")):
    doc = doc_p.read_text(encoding="utf-8")
    cleaned = doc.replace("plugins/control-tower/skills/control-tower", "")
    assert "skills/control-tower" not in cleaned, f"Legacy bare path leaked in {doc_p}"
PY
then
  pass "3. SKILL.md frontmatter、相对链接与模板原生插件路径迁移校验通过"
else
  fail "3. SKILL.md frontmatter、相对链接与模板原生插件路径迁移校验通过"
fi

# 4) 全脚本语法校验与 --dry-run 零落盘校验
DRY_DIR="$TMP_CONFIG/dry"
PYC_DIR="$TMP_CONFIG/pyc"
mkdir -p "$PYC_DIR"
if bash -n "$REPO_ROOT/install.sh" "$REPO_ROOT/uninstall.sh" "$REPO_ROOT/scripts/check-legacy-refs.sh" "$REPO_ROOT/scripts/selftest.sh" \
   && [ -n "$NODE_BIN" ] && "$NODE_BIN" --check "$REPO_ROOT/sidecars/tower/main.mjs" "$REPO_ROOT/sidecars/tower/app.js" 2>/dev/null \
   && AGY_CONFIG_DIR="$DRY_DIR" bash "$REPO_ROOT/install.sh" --dry-run >/dev/null \
   && AGY_CONFIG_DIR="$DRY_DIR" bash "$REPO_ROOT/uninstall.sh" --dry-run >/dev/null \
   && [ ! -e "$DRY_DIR" ] \
   && "$PYTHON_BIN" - "$PYC_DIR" <<'PY'
import pathlib, py_compile, sys
pyc_dir = pathlib.Path(sys.argv[1])
for src in ("scripts/ctlib.py", "scripts/hook-session-start.py", "scripts/hook-pre-invocation.py"):
    py_compile.compile(src, cfile=str(pyc_dir / (pathlib.Path(src).name + "c")), doraise=True)
PY
then
  pass "4. Bash/Python/Node 语法校验通过且 install/uninstall --dry-run 零落盘"
else
  fail "4. Bash/Python/Node 语法校验或 --dry-run 零落盘校验失败"
fi

# 5) 原生插件隔离安装 SHA256 一致性与纯净边界校验
LIVE_DIR="$TMP_CONFIG/live"
if AGY_CONFIG_DIR="$LIVE_DIR" bash "$REPO_ROOT/install.sh" >/dev/null \
   && AGY_CONFIG_DIR="$LIVE_DIR" bash "$REPO_ROOT/install.sh" --status | grep -q "owned 1.0.0" \
   && "$PYTHON_BIN" - "$REPO_ROOT" "$LIVE_DIR/plugins/control-tower" <<'PY'
import hashlib, json, pathlib, sys
src_root = pathlib.Path(sys.argv[1])
dst_root = pathlib.Path(sys.argv[2])
expected_files = [
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
for rel in expected_files:
    s = hashlib.sha256((src_root / rel).read_bytes()).hexdigest()
    d = hashlib.sha256((dst_root / rel).read_bytes()).hexdigest()
    assert s == d, f"SHA256 mismatch on {rel}"

for forbidden in ("AGENTS.md", "install.sh", "uninstall.sh", "scripts/selftest.sh", "scripts/check-legacy-refs.sh", ".gitignore"):
    assert not (dst_root / forbidden).exists(), f"Dev-only file leaked to runtime plugin: {forbidden}"

marker = json.loads((dst_root / ".control-tower-install.json").read_text(encoding="utf-8"))
assert marker["plugin"] == "control-tower" and marker["mode"] == "plugin" and marker["version"] == "1.0.0"
assert marker["managedFiles"] == expected_files
PY
then
  pass "5. 原生插件隔离安装 SHA256 一致、生成安装标记且零开发脚本泄漏"
else
  fail "5. 原生插件隔离安装或纯净边界校验失败"
fi

# 6) 官方 agy plugin validate --strict --json 校验沙箱安装态
if [ -n "$AGY_BIN" ] && "$AGY_BIN" plugin validate --strict --json "$LIVE_DIR/plugins/control-tower" >"$TMP_CONFIG/validate.json" 2>&1 \
   && "$PYTHON_BIN" - "$TMP_CONFIG/validate.json" <<'PY'
import json, pathlib, sys
raw = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
data = json.loads(raw)
assert data.get("name") == "control-tower", data
assert data.get("findings") == [], f"Unexpected findings: {data.get('findings')}"
c = data.get("components") or {}
assert c.get("skills") == 1, c
assert c.get("hooks") == 2, c
assert c.get("sidecars") == 1, c
assert c.get("rules") == 0, c
assert c.get("mcpServers") == 0, c
PY
then
  pass "6. agy plugin validate --strict --json 零警告零错误通过"
else
  fail "6. agy plugin validate --strict --json 校验失败或缺少 agy"
fi

# 7) 身份归属、SemVer 版本更新与防双重发现互斥矩阵校验
if "$PYTHON_BIN" - "$REPO_ROOT" "$TMP_CONFIG" <<'PY'
import json, pathlib, shutil, subprocess, sys

repo = pathlib.Path(sys.argv[1])
tmp = pathlib.Path(sys.argv[2])
install_sh = str(repo / "install.sh")

def run_inst(cfg, *args):
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(tmp), "AGY_CONFIG_DIR": str(cfg)}
    return subprocess.run(["bash", install_sh, *args], capture_output=True, text=True, env=env)

# 7a) 托管旧全局 Skill 自动迁移并消除双重发现
mig = tmp / "mig_auto"
(mig / "skills" / "control-tower" / "references").mkdir(parents=True)
for rel, dst in (
    ("skills/control-tower/SKILL.md", "SKILL.md"),
    ("skills/control-tower/references/model-routing.md", "references/model-routing.md"),
    ("skills/control-tower/references/templates.md", "references/templates.md"),
):
    shutil.copy2(repo / rel, mig / "skills" / "control-tower" / dst)
r = run_inst(mig)
assert r.returncode == 0, r.stderr
assert (mig / "plugins" / "control-tower" / "plugin.json").is_file()
assert not (mig / "skills" / "control-tower").exists()

# 7b) 含未知额外文件的旧目录默认阻断，加 --force-migrate 放行
blk = tmp / "mig_extra"
(blk / "skills" / "control-tower").mkdir(parents=True)
shutil.copy2(repo / "skills/control-tower/SKILL.md", blk / "skills/control-tower/SKILL.md")
(blk / "skills/control-tower/custom-extra.md").write_text("user custom", encoding="utf-8")
r_blk = run_inst(blk)
assert r_blk.returncode != 0, "Expected block on extra file"
assert not (blk / "plugins" / "control-tower").exists()
assert (blk / "skills/control-tower/custom-extra.md").is_file()
r_force = run_inst(blk, "--force-migrate")
assert r_force.returncode == 0, r_force.stderr
assert not (blk / "skills" / "control-tower").exists()

# 7c) SemVer 升级清理废弃受管文件 + 降级阻断与 --allow-downgrade 放行
upg = tmp / "upg"
pdir = upg / "plugins" / "control-tower"
pdir.mkdir(parents=True)
(pdir / "plugin.json").write_text(json.dumps({"name": "control-tower", "version": "0.9.0"}), encoding="utf-8")
(pdir / "obsolete-file.txt").write_text("old", encoding="utf-8")
(pdir / ".control-tower-install.json").write_text(json.dumps({
    "plugin": "control-tower", "mode": "plugin", "version": "0.9.0",
    "managedFiles": ["plugin.json", "obsolete-file.txt"],
}), encoding="utf-8")
r_upg = run_inst(upg)
assert r_upg.returncode == 0, r_upg.stderr
assert not (pdir / "obsolete-file.txt").exists()
assert json.loads((pdir / "plugin.json").read_text(encoding="utf-8"))["version"] == "1.0.0"

(pdir / "plugin.json").write_text(json.dumps({"name": "control-tower", "version": "2.0.0"}), encoding="utf-8")
r_down_blk = run_inst(upg)
assert r_down_blk.returncode != 0, "Expected downgrade block"
r_down_ok = run_inst(upg, "--allow-downgrade")
assert r_down_ok.returncode == 0, r_down_ok.stderr
assert json.loads((pdir / "plugin.json").read_text(encoding="utf-8"))["version"] == "1.0.0"

# 7d) 无关第三方插件目录安全阻断
fgn = tmp / "foreign_plugin"
(fgn / "plugins" / "control-tower").mkdir(parents=True)
(fgn / "plugins" / "control-tower" / "plugin.json").write_text('{"name":"someone-else"}', encoding="utf-8")
assert run_inst(fgn).returncode != 0

# 7e) --mode legacy-skill 反向互斥迁移
rev = tmp / "rev_legacy"
assert run_inst(rev).returncode == 0
assert run_inst(rev, "--mode", "legacy-skill").returncode == 0
assert (rev / "skills" / "control-tower" / "SKILL.md").is_file()
assert not (rev / "plugins" / "control-tower").exists()
PY
then
  pass "7. 身份归属校验、SemVer 升降级门禁与双模防双重发现互斥全通过"
else
  fail "7. 身份归属校验、SemVer 升降级门禁或互斥迁移校验失败"
fi

# 8) uninstall.sh 身份校验卸载、非本插件阻断与零误伤校验
if "$PYTHON_BIN" - "$REPO_ROOT" "$TMP_CONFIG" <<'PY'
import pathlib, subprocess, sys

repo = pathlib.Path(sys.argv[1])
tmp = pathlib.Path(sys.argv[2])
install_sh = str(repo / "install.sh")
uninstall_sh = str(repo / "uninstall.sh")

def run_cmd(script, cfg, *args):
    env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(tmp), "AGY_CONFIG_DIR": str(cfg)}
    return subprocess.run(["bash", script, *args], capture_output=True, text=True, env=env)

uni = tmp / "uni"
assert run_cmd(install_sh, uni).returncode == 0
(uni / "config.json").write_text('{"keep":true}\n', encoding="utf-8")
(uni / "plugins" / "other-plugin").mkdir(parents=True)
(uni / "plugins" / "other-plugin" / "plugin.json").write_text('{"name":"other-plugin"}', encoding="utf-8")

# 8a) 默认安全卸载且不伤同级目录
assert run_cmd(uninstall_sh, uni).returncode == 0
assert not (uni / "plugins" / "control-tower").exists()
assert (uni / "config.json").is_file()
assert (uni / "plugins" / "other-plugin" / "plugin.json").is_file()
# 幂等再次卸载返回 0
assert run_cmd(uninstall_sh, uni).returncode == 0

# 8b) --include-legacy 同时清理旧全局 Skill
assert run_cmd(install_sh, uni, "--mode", "legacy-skill").returncode == 0
assert run_cmd(uninstall_sh, uni, "--include-legacy").returncode == 0
assert not (uni / "skills" / "control-tower").exists()
assert (uni / "config.json").is_file()

# 8c) 非本插件目录安全阻断
funi = tmp / "uni_foreign"
(funi / "plugins" / "control-tower").mkdir(parents=True)
(funi / "plugins" / "control-tower" / "plugin.json").write_text('{"name":"unrelated"}', encoding="utf-8")
assert run_cmd(uninstall_sh, funi).returncode != 0
assert (funi / "plugins" / "control-tower" / "plugin.json").is_file()
PY
then
  pass "8. uninstall.sh 身份校验卸载、非本插件阻断与零误伤全部通过"
else
  fail "8. uninstall.sh 安全卸载或零误伤校验失败"
fi

# 9) Hooks 端到端隔离实测（总控定向、裸 ID 秒登速查、>=2 次压缩防刷屏换届提醒）
if "$PYTHON_BIN" - "$REPO_ROOT" "$TMP_CONFIG" <<'PY'
import json, os, pathlib, subprocess, sys

repo = pathlib.Path(sys.argv[1])
tmp = pathlib.Path(sys.argv[2])

ws = tmp / "hook_ws"
(ws / ".agents").mkdir(parents=True)
app_data = tmp / "app_data"
data_dir = tmp / "ct_data"

ctrl_id = f"{'c'*8}-{'1'*4}-{'4'*4}-{'8'*4}-{'a'*12}"
worker_id = f"{'b'*8}-{'2'*4}-{'4'*4}-{'8'*4}-{'d'*12}"
other_id = f"{'e'*8}-{'3'*4}-{'4'*4}-{'8'*4}-{'f'*12}"

reg_text = f"""# 台账
## 一、当前独占资源租约
| 字段 | 当前值 |
| --- | --- |
| **锁状态** | `IDLE（空闲待分配）` |
| **持锁会话** | - |

## 二、常驻主交流总控会话
- **当前现役总控会话**：`{ctrl_id}`（状态：`ONLINE`）
"""
(ws / ".agents" / "SESSION-REGISTRY.md").write_text(reg_text, encoding="utf-8")

# 构造被控专职会话日志
w_log = app_data / "brain" / worker_id / ".system_generated" / "logs" / "transcript.jsonl"
w_log.parent.mkdir(parents=True)
w_steps = [
    {"step_index": 0, "type": "USER_INPUT", "content": "<USER_REQUEST>\n实现核心协议解析\n</USER_REQUEST>"},
    {"step_index": 12, "type": "PLANNER_RESPONSE", "model": "gemini-4-neon-high", "created_at": "2026-11-21T20:00:00+08:00", "status": "DONE", "input_tokens": 12000, "cache_read_tokens": 0},
]
w_log.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in w_steps) + "\n", encoding="utf-8")

# 构造现役总控会话日志（含 2 次压缩：显式 checkpoint 与 token 骤降）
c_log = tmp / "ctrl_transcript.jsonl"
c_steps = [
    {"step_index": 1, "type": "PLANNER_RESPONSE", "model": "gemini-4-neon", "input_tokens": 120000, "cache_read_tokens": 0},
    {"step_index": 2, "type": "PLANNER_RESPONSE", "model": "gemini-4-neon", "input_tokens": 20000, "cache_read_tokens": 0},
    {"step_index": 3, "type": "PLANNER_RESPONSE", "model": "gemini-4-neon", "input_tokens": 110000, "cache_read_tokens": 0},
    {"step_index": 4, "type": "PLANNER_RESPONSE", "model": "gemini-4-neon", "input_tokens": 18000, "cache_read_tokens": 0},
]
c_log.write_text("\n".join(json.dumps(x, ensure_ascii=False) for x in c_steps) + "\n", encoding="utf-8")

env = {
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "HOME": str(tmp),
    "AGY_CONTROL_TOWER_DATA_DIR": str(data_dir),
    "ANTIGRAVITY_APP_DATA_DIR": str(app_data),
}

def call_hook(script_rel, payload):
    r = subprocess.run(
        [sys.executable, str(repo / script_rel)],
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True, text=True, env=env,
    )
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)

# 9a) 非总控静音直通且不建状态目录
assert call_hook("scripts/hook-session-start.py", {"conversationId": other_id, "workspacePaths": [str(ws)]}) == {}
assert call_hook("scripts/hook-pre-invocation.py", {"conversationId": other_id, "workspacePaths": [str(ws)], "lastUserInput": worker_id[:8], "transcriptPath": str(c_log)}) == {}
assert not data_dir.exists()

# 9b) 现役总控 SessionStart 返回简报
ss = call_hook("scripts/hook-session-start.py", {"conversationId": ctrl_id, "workspacePaths": [str(ws)]})
ss_msg = ss["injectSteps"][0]["systemMessage"]["systemMessage"]
assert "[control-tower 总控就位]" in ss_msg and "IDLE" in ss_msg

# 9c) 现役总控 PreInvocation：裸 ID（8 位前缀）+ 2 次压缩首次换届提醒
p1 = call_hook("scripts/hook-pre-invocation.py", {
    "conversationId": ctrl_id,
    "workspacePaths": [str(ws)],
    "lastUserInput": worker_id[:8],
    "transcriptPath": str(c_log),
})
msgs1 = [s["systemMessage"]["systemMessage"] for s in p1["injectSteps"]]
assert any("[control-tower 裸ID速查]" in m and "实现核心协议解析" in m and "gemini-4-neon-high" in m for m in msgs1), msgs1
assert any("[control-tower 换届提醒]" in m and "2 次" in m for m in msgs1), msgs1
assert "terminationBehavior" not in p1

# 9d) 同压缩次数二次调用不再重复刷屏换届提醒
p2 = call_hook("scripts/hook-pre-invocation.py", {
    "conversationId": ctrl_id,
    "workspacePaths": [str(ws)],
    "lastUserInput": "普通对话指令",
    "transcriptPath": str(c_log),
})
assert p2 == {}, f"Expected deduped empty hook output, got {p2}"
PY
then
  pass "9. Hooks 端到端实测（非总控静音、裸 ID 速查与压缩换届去重提醒）全通过"
else
  fail "9. Hooks 端到端实测失败"
fi

# 10) Sidecar Aux Pane 端到端 HTTP 实测
SC_WS="$TMP_CONFIG/sc_ws"
SC_DATA="$TMP_CONFIG/sc_data"
SC_APP="$TMP_CONFIG/sc_app"
mkdir -p "$SC_WS" "$SC_APP/brain"
SC_PORT=$("$PYTHON_BIN" -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()")
SC_TOKEN="selftest-ct-token"

AGY_CONTROL_TOWER_DATA_DIR="$SC_DATA" \
ANTIGRAVITY_APP_DATA_DIR="$SC_APP" \
ANTIGRAVITY_SIDECAR_WEB_PORT="$SC_PORT" \
ANTIGRAVITY_SIDECAR_UI_TOKEN="$SC_TOKEN" \
"$NODE_BIN" "$REPO_ROOT/sidecars/tower/main.mjs" >/dev/null 2>&1 &
SC_PID=$!

if "$PYTHON_BIN" - "$SC_PORT" "$SC_TOKEN" "$SC_WS" "$SC_APP" <<'PY'
import json, pathlib, sys, time, urllib.error, urllib.parse, urllib.request

port, token, ws_dir, app_dir = sys.argv[1:5]
base = f"http://127.0.0.1:{port}"
worker_id = f"{'a'*8}-{'9'*4}-{'4'*4}-{'8'*4}-{'f'*12}"

tp = pathlib.Path(app_dir) / "brain" / worker_id / ".system_generated" / "logs" / "transcript.jsonl"
tp.parent.mkdir(parents=True)
tp.write_text(json.dumps({"step_index": 5, "type": "USER_INPUT", "content": "<USER_REQUEST>\nSidecar探针目标\n</USER_REQUEST>", "model": "gemini-4-hydrogen-high"}) + "\n", encoding="utf-8")

def req(method, path, body=None, use_token=True):
    headers = {}
    if use_token:
        headers["x-sidecar-token"] = token
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    r = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=3) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")

ready = False
for _ in range(30):
    try:
        st, html = req("GET", "/", use_token=False)
        if st == 200 and "/preload.js" in html:
            ready = True
            break
    except Exception:
        time.sleep(0.1)
assert ready, "Sidecar failed to start"

st, _ = req("GET", "/styles.css", use_token=False)
assert st == 200
st, _ = req("GET", "/app.js", use_token=False)
assert st == 200

# 无 token POST 必须 401
st, _ = req("POST", "/api/registry/init", {"workspace": ws_dir}, use_token=False)
assert st == 401, f"Expected 401, got {st}"

# 初始化 + 重复冲突 409
st, raw = req("POST", "/api/registry/init", {"workspace": ws_dir, "relPath": ".agents/SESSION-REGISTRY.md"})
assert st == 200 and json.loads(raw)["ok"] is True
st, _ = req("POST", "/api/registry/init", {"workspace": ws_dir, "relPath": ".agents/SESSION-REGISTRY.md"})
assert st == 409

# 读取快照与模板
st, raw = req("GET", f"/api/snapshot?workspace={urllib.parse.quote(ws_dir)}")
snap = json.loads(raw)
assert st == 200 and snap["registryExists"] is True and snap["plugin"]["version"] == "1.0.0"
assert snap["templates"]["bootstrapPrompt"]
h1 = snap["hash"]

# 更新租约 + 过期 expectedHash 返回 409 + 一键释放 IDLE
st, raw = req("POST", "/api/lease/update", {
    "workspace": ws_dir, "expectedHash": h1, "lockStatus": "LOCKED", "holder": worker_id, "since": "2026-11-21"
})
assert st == 200
snap2 = json.loads(raw)["snapshot"]
assert snap2["parsed"]["lease"]["lockStatus"] == "LOCKED"
assert snap2["parsed"]["lease"]["holder"] == worker_id

st, _ = req("POST", "/api/lease/update", {"workspace": ws_dir, "expectedHash": h1, "action": "release"})
assert st == 409

st, raw = req("POST", "/api/lease/update", {"workspace": ws_dir, "expectedHash": snap2["hash"], "action": "release"})
assert st == 200
snap3 = json.loads(raw)["snapshot"]
assert "IDLE" in snap3["parsed"]["lease"]["lockStatus"]

# 任务队列增删
st, raw = req("POST", "/api/queue/upsert", {
    "workspace": ws_dir, "expectedHash": snap3["hash"], "id": "T9", "summary": "测试队列任务", "status": "RUNNING", "route": "L2 Orchestrator (Neon)"
})
assert st == 200
snap4 = json.loads(raw)["snapshot"]
assert any(q["id"] == "T9" and q["status"] == "RUNNING" for q in snap4["parsed"]["queue"])

st, raw = req("POST", "/api/queue/delete", {"workspace": ws_dir, "expectedHash": snap4["hash"], "id": "T9"})
assert st == 200
snap5 = json.loads(raw)["snapshot"]
assert not any(q["id"] == "T9" for q in snap5["parsed"]["queue"])

# 在线保存 + 路径穿越拦截
st, raw = req("POST", "/api/registry/save", {
    "workspace": ws_dir, "relPath": ".agents/SESSION-REGISTRY.md", "expectedHash": snap5["hash"],
    "content": snap5["content"] + "\n<!-- saved -->\n",
})
assert st == 200 and "<!-- saved -->" in json.loads(raw)["snapshot"]["content"]

st, _ = req("POST", "/api/registry/save", {"workspace": ws_dir, "relPath": "../etc/passwd", "content": "x"})
assert st == 403
st, _ = req("GET", f"/api/snapshot?workspace={urllib.parse.quote(ws_dir + '/no-such-dir')}")
assert st == 400

# 裸 ID 探针
st, raw = req("GET", f"/api/session/inspect?id={worker_id[:8]}")
ins = json.loads(raw)
assert st == 200 and ins["status"] == "ok" and ins["info"]["goal"] == "Sidecar探针目标"
PY
then
  pass "10. Sidecar Aux Pane 端到端 HTTP 鉴权、并发锁、队列编辑、防穿越与探针全通过"
else
  fail "10. Sidecar Aux Pane 端到端 HTTP 实测失败"
fi
kill "$SC_PID" 2>/dev/null || true
wait "$SC_PID" 2>/dev/null || true
SC_PID=""

# 11) scripts/check-legacy-refs.sh 只读审计准确性校验
if "$PYTHON_BIN" - "$REPO_ROOT" "$TMP_CONFIG" <<'PY'
import hashlib, pathlib, subprocess, sys

repo = pathlib.Path(sys.argv[1])
tmp = pathlib.Path(sys.argv[2])
checker = str(repo / "scripts" / "check-legacy-refs.sh")

fx = tmp / "legacy_fixture"
fx.mkdir()
old_f = fx / "old.md"
new_f = fx / "new.md"
old_f.write_text("read ~/.gemini/config/skills/control-tower/SKILL.md\n", encoding="utf-8")
new_f.write_text("read ~/.gemini/config/plugins/control-tower/skills/control-tower/SKILL.md\n", encoding="utf-8")

h_old = hashlib.sha256(old_f.read_bytes()).hexdigest()
h_new = hashlib.sha256(new_f.read_bytes()).hexdigest()

r1 = subprocess.run(["bash", checker, str(fx)], capture_output=True, text=True)
assert r1.returncode == 0 and "old.md" in r1.stdout and "new.md" not in r1.stdout, r1.stdout

r2 = subprocess.run(["bash", checker, "--fail-on-match", str(fx)], capture_output=True, text=True)
assert r2.returncode == 1

fx_clean = tmp / "clean_fixture"
fx_clean.mkdir()
(fx_clean / "ok.md").write_text("~/.gemini/config/plugins/control-tower/skills/control-tower/SKILL.md\n", encoding="utf-8")
r3 = subprocess.run(["bash", checker, "--fail-on-match", str(fx_clean)], capture_output=True, text=True)
assert r3.returncode == 0, r3.stdout

assert hashlib.sha256(old_f.read_bytes()).hexdigest() == h_old
assert hashlib.sha256(new_f.read_bytes()).hexdigest() == h_new
PY
then
  pass "11. scripts/check-legacy-refs.sh 只读审计准确性校验通过"
else
  fail "11. scripts/check-legacy-refs.sh 只读审计准确性校验失败"
fi

# 12) 公开仓库隐私脱敏、.agents/ 忽略、零间隔号与零危险删除命令校验
if "$PYTHON_BIN" - <<'PY'
import pathlib, re
gi = pathlib.Path(".gitignore").read_text(encoding="utf-8")
assert any(line.strip() == ".agents/" for line in gi.splitlines()), ".agents/ not ignored in .gitignore"

forb_home = "/" + "home" + "/"
forb_users = "/" + "Users" + "/"
forb_ip = "192." + "168."
forb_dot = chr(0x00B7)
forb_rm1 = "rm " + "-rf"
forb_rm2 = "rm " + "-fr"
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
    assert forb_rm1 not in txt and forb_rm2 not in txt, f"Forbidden delete command in {p}"
PY
then
  pass "12. 公开仓库隐私脱敏、.agents/ 忽略、零间隔号与脚本安全检查全通过"
else
  fail "12. 公开仓库隐私脱敏、.agents/ 忽略、零间隔号与脚本安全检查失败"
fi

echo "----"
if [ "$fails" -eq 0 ]; then
  echo "ALL PASS"
  exit 0
else
  echo "FAILED: $fails"
  exit 1
fi
