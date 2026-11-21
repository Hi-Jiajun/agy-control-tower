# control-tower 独立工作区协作规则

本仓库为 Google Antigravity 通用常驻主交流总控原生插件 `control-tower` 的独立开发源码仓，支持作为独立工作区直接打开维护。所有通用约定与公开仓库安全基线一致：全程中文技术交流、先核查再改写、严禁强制递归删除命令、严禁将本地私有信息写入仓库、全仓禁用间隔号字符。

## 仓库范围与目录结构

| 路径 | 职责说明 |
| --- | --- |
| `plugin.json` | Antigravity 原生插件清单（仅使用官方白名单字段，定义版本与推荐提示词） |
| `hooks.json` | 生命周期钩子配置（插件根路径放置，仅对现役总控激活轻量感知） |
| `assets/logo.svg` | 128x128 透明背景矢量插件图标（兼顾明暗主题） |
| `skills/control-tower/SKILL.md` | 全局常驻主交流总控核心规程（入口与调度纪律） |
| `skills/control-tower/references/model-routing.md` | 纯 Gemini 4（`Carbon` / `Neon` / `Hydrogen`）与 `Orchestrator` 分层路由规范 |
| `skills/control-tower/references/templates.md` | 通用 `SESSION-REGISTRY.md` 骨架、引导提示词、标准派单卡与换届交接卡模板 |
| `scripts/ctlib.py` | 台账与日志解析共享库（仅 Python 标准库） |
| `scripts/hook-session-start.py` | `SessionStart` 钩子：现役总控轻量就位简报，非总控静音直通 |
| `scripts/hook-pre-invocation.py` | `PreInvocation` 钩子：现役总控裸 ID 自动速查与 `>= 2` 次压缩换届提醒 |
| `sidecars/tower/` | 零依赖可读写 Aux Pane 总控看板（`package.json`、`sidecar.json`、`main.mjs`、前端资产） |
| `install.sh` | 显式发布脚本（支持 `--dry-run`、`--status`、`--mode`、身份归属与 SemVer 校验及 `AGY_CONFIG_DIR` 覆盖） |
| `uninstall.sh` | 显式卸载脚本（校验身份归属后安全移除，支持 `--dry-run` 与 `--include-legacy`） |
| `scripts/check-legacy-refs.sh` | 源码仓专用只读工具：审计业务工作区残留旧全局路径引用 |
| `scripts/selftest.sh` | 隔离临时沙箱自检套件（12 项全量校验，包含 `agy plugin validate --strict`） |

## 开发态与运行态严格隔离（核心红线）

1. **只在源码仓修改，严禁直接编辑运行态**：日常开发只改动本仓库内文件；严禁直接编辑 `~/.gemini/config/plugins/control-tower/`、`~/.gemini/config/skills/control-tower/` 或 `~/.local/share/agy-control-tower/` 下的运行态文件。
2. **严禁污染运行态插件包**：`install.sh` 仅白名单同步运行态所需文件；源码仓根目录 `AGENTS.md`、`install.sh`、`uninstall.sh`、`scripts/selftest.sh` 与 `scripts/check-legacy-refs.sh` 严禁同步到 `$AGY_CONFIG_DIR/plugins/control-tower/`（插件根 `AGENTS.md` 会触发 `agy plugin validate --strict` 警告）。
3. **先过沙箱自检**：任何修改后必须运行 `bash scripts/selftest.sh`，确认 12 项全部 `PASS` 且退出码为 `0`。
4. **发布门禁控制**：未经用户明确授权获取实装发布许可前，严禁执行不带 `AGY_CONFIG_DIR` 隔离目录的 `./install.sh` 或 `./uninstall.sh` 改动真实 `~/.gemini/config/`。

## 兼容边界、版本校验与防冲突约束

- **双形态强互斥不变量**：任意时刻 `$AGY_CONFIG_DIR/plugins/control-tower` 与 `$AGY_CONFIG_DIR/skills/control-tower` 至多存在其一，严禁双份并存引发同名 Skill 双重发现；禁止使用目录软链桥接旧全局 Skill 路径。
- **身份归属与版本门禁**：安装与卸载前必须校验目标确实为 `control-tower` 托管产物；检测到更低源码版本覆盖更高已装版本时默认阻断（需显式 `--allow-downgrade`）；检测到未知额外文件时安全阻断（需人工确认后传入 `--force-migrate`）。
- **零全局规则与零外部 CLI 污染**：本插件刻意不包含 `rules/AGENTS.md`（避免 always-on 污染非总控专职会话），也不向 `~/.local/bin/` 写入全局终端命令。

## 隐私规范与 Git 纪律

1. **公私分离**：`.agents/` 已在 `.gitignore` 中排除；禁止在本仓库提交本地绝对路径、会话 ID（UUID）、内网 IP、账号凭据或任意个人运行台账。
2. **模型路由红线**：仅选用纯 Gemini 4（`Carbon` / `Neon` / `Hydrogen`）与 `Orchestrator`；禁用 `Argon` 与 `Gemini 3.8` 及更早系列模型；不以 `magpie-quota` 判断 Antigravity 配额。
3. **仅本地 Git 提交**：日常只做本地提交；未经用户明确要求，不得添加远端仓库或执行 `git push`。
