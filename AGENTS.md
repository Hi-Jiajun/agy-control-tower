# control-tower 独立工作区协作规则

本仓库为 Google Antigravity 通用常驻主交流总控原生插件 `control-tower` 的独立开发源码仓，采用官方 `./plugin/` 纯净包隔离架构与纯零依赖 Node.js ESM 单栈，支持作为独立工作区直接打开维护。所有通用约定与公开仓库安全基线一致：全程中文技术交流、先核查再改写、严禁强制递归删除命令、严禁将本地私有信息写入仓库、全仓禁用间隔号字符。

## 仓库范围与目录结构

| 路径 | 职责说明 |
| --- | --- |
| `package.json` | 仓根私有工程清单（定义 `test` / `test:ui` / `test:eval` / `replay` / `mine` / `doctor` / `gate` / `selftest` / `validate` / `setup-hooks`，零第三方依赖） |
| `docs/ARCHITECTURE-ROADMAP.md` | 本仓三阶段演进战略蓝图与架构不变量（不打入 `./plugin/`） |
| `plugin/` | Antigravity 官方标准原生插件纯净包（`agy plugin validate --strict ./plugin` 零警告通过） |
| `plugin/plugin.json` | Antigravity 原生插件清单与唯一 SemVer 版本真源（仅使用官方白名单字段） |
| `plugin/hooks.json` | 四事件生命周期钩子配置（`SessionStart`、`PreInvocation`、`PreToolUse`、`Stop` -> `node ./scripts/ct-hook.mjs`） |
| `plugin/lib/` | 零依赖共享核心（`paths.mjs`、`logger.mjs`、`inbox.mjs`、`roadmap.mjs`、`registry.mjs`、`settings.mjs`、`transcript.mjs`），供 Hooks 与 Sidecar 共用 |
| `plugin/scripts/ct-hook.mjs` | 四事件统一钩子入口（双角色感知与路线图北极星摘要、`PreToolUse` 双证换届放行与台账写保护、裸/多 ID 速查、节流兜底哨兵与 `[CT_REPORT:DONE]` 路线图联动、`Stop` 无条件释放焦点锁与防漏报兜底、弹性换届与静默版本戳） |
| `plugin/sidecars/tower/` | 零依赖模块化 Aux Pane 总控看板（后端 `main.mjs` + `lib/agentapi.mjs` 异步缓存桥 + `routes/{roadmap,inbox}.mjs`；前端 `app.js` + `views/{overview,sessions,roadmap,settings}.mjs` + `ui-logic.mjs`；四执行面统一导航与 Swarm 隔离回收、统一 `inbox.json` 横幅与零 Token 哨兵、三层路线图隐藏面派单与 Handoff 预览、原生内联归档与三层设置中心） |
| `plugin/skills/control-tower/` | 总控核心规程、`model-routing.md` 路由手册（含新版 Orchestrator 双层自定义）与去硬编码 `templates.md` |
| `scripts/ct-{miner,replay,ui-smoke,skill-eval,doctor,release}.mjs` | 五环自演化研发工具链（遥测复盘提案、事故回放、无头浏览器 CDP 冒烟、Skill 契约评测、实装体检与快照秒回滚） |
| `scripts/cleanup-legacy-skill.sh` | 安全核查与清理旧散装 `$AGY_CONFIG_DIR/skills/control-tower`（消除双重发现） |
| `scripts/check-legacy-refs.sh` | 源码仓专用只读工具：审计业务工作区残留旧全局路径引用 |
| `scripts/git-hooks/pre-commit` | 本地提交前合规门禁（脱敏、零间隔号、版本一致性、`agy plugin validate --strict ./plugin`） |
| `scripts/selftest.sh` & `tests/` | 基于内置 `node:test` 的模块化单测、脱敏事故回放库（`tests/replays/`）与孤立临时沙箱 E2E 验证套件 |

## 开发态与运行态严格隔离（核心红线）

1. **只在源码仓修改，严禁直接编辑运行态**：日常开发只改动本仓库内文件；严禁直接编辑 `~/.gemini/config/plugins/control-tower/`、`~/.gemini/config/skills/control-tower/` 或 `<appData>/plugin_data/control-tower/` 下的真实运行态文件。
2. **纯净包边界**：仓根 `AGENTS.md`、`CHANGELOG.md`、`package.json`、`tests/` 及 `scripts/` 下工具脚本一律留在仓根，严禁放入 `plugin/` 目录污染插件安装体。
3. **版本单一真源**：升级版本时必须保持 `plugin/plugin.json`、`package.json` 与 `plugin/sidecars/tower/package.json` 中的 `version` 完全一致，并同步更新 `CHANGELOG.md`。
4. **先过沙箱与严格校验**：任何修改后必须运行 `npm test`（或 `bash scripts/selftest.sh`）及 `agy plugin validate --strict ./plugin`，确认全绿且退出码为 `0`。
5. **发布门禁控制**：未经用户明确授权获取实装发布许可前，严禁执行影响真实配置的 `agy plugin install ./plugin`、`agy plugin uninstall control-tower` 或不带 `AGY_CONFIG_DIR` 覆盖的 `scripts/cleanup-legacy-skill.sh`。

## 兼容边界、防双重发现与零全局污染约束

- **消除双重发现**：若本机存在历史 `~/.gemini/config/skills/control-tower`，正式切换到原生插件前须先通过 `bash scripts/cleanup-legacy-skill.sh` 安全清理，绝不保留双份并存。
- **零全局规则与零外部 CLI 污染**：本插件刻意不包含 `rules/AGENTS.md`（避免 always-on 污染非总控专职会话），也不向 `~/.local/bin/` 写入全局终端命令；运行状态统一由官方 `<appData>/plugin_data/control-tower/` 托管。

## 隐私规范与 Git 纪律

1. **公私分离**：`.agents/` 已在 `.gitignore` 中排除；禁止在本仓库提交本地绝对路径、会话 ID（UUID）、内网 IP、账号凭据或任意个人运行台账。
2. **模型路由红线**：仅选用纯 Gemini 4（`Carbon` / `Neon` / `Hydrogen`）与 `Orchestrator`；禁用 `Argon` 与 `Gemini 3.8` 及更早系列模型；不以 `magpie-quota` 判断 Antigravity 配额。
3. **仅本地 Git 提交**：日常只做本地提交；未经用户明确要求，不得添加远端仓库或执行 `git push`。
