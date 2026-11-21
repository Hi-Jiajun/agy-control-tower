# Changelog

All notable changes to `control-tower` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2026-11-22

### Fixed
- 加固 `plugin/lib/paths.mjs` 的 `resolvePluginDataDir()`：仅在 `PLUGIN_DATA` 环境变量尾段目录名为 `control-tower` 时采信，防止跨插件共享终端环境中 `PLUGIN_DATA` 指向其他插件目录导致的串目录风险（显式 `AGY_CONTROL_TOWER_DATA_DIR` 保持最高优先）。
- 在 `plugin/scripts/ct-hook.mjs` 的现役总控 `SessionStart` 注入中新增标准台账结构合规自检提示（如第 1 节未匹配标准独占资源租约表头或第 3 节存在无有效会话 ID 占位行时发出温和对齐提醒，不破坏标准解析契约）。

## [1.2.0] - 2026-11-22

### Added
- 新增三层物理隔离配置中心 `plugin/lib/settings.mjs`（`plugin-settings.json`、`global-settings.json` + 全局文档覆盖、`workspaces/<wsHash>/settings.json` + 工作区覆盖，全部托管于 `<appData>/plugin_data/control-tower/`，读操作零副作用）。
- 支持只读读取宿主 `~/.gemini/config/config.json`（及 `$AGY_CONFIG_DIR`）权限配置并映射为总控默认代决策档位（`autonomous` / `balanced` / `strict`），同时支持工作区级独占资源单锁模式开关与 `PLUGIN_DATA` 零侵入托管台账模式（`@plugin_data/SESSION-REGISTRY.md`）及工作区自定义相对路径。
- 扩展 `plugin/hooks.json` 与 `plugin/scripts/ct-hook.mjs` 为四事件协同架构：新增双角色感知（`SessionStart` 向已入账专职会话注入锁边界与双向汇报锚点）、`PreToolUse` 台账防误改写保护（默认 `ask`，支持 `deny`/`off`）、以及 `Stop` 钩子自动防漏报阶段回执兜底。
- 在 `plugin/lib/transcript.mjs` 新增原生 `swarm` 状态与消息板动态解析（`inspectNativeSwarm`）、长汇报上下文精确会话 ID 过滤（自动跳过无关 Git SHA）、以及 `Stop` 主动汇报检测（`hasOutboundAgentApiReport`）。
- 升级 Aux Pane 看板 UI 与后端（`plugin/sidecars/tower/`）：新增「受控直派」通道（`/api/dispatch/create` 与模型合规校验的 `/_sidecar/new-conversation`）、原生 Swarm 实时集群面板、智能无感自动轮询、顶部待办/换届提醒横幅、精美微动效与无障碍降级支持，以及三段式隔离「设置中心」标签页（无台账工作区亦可随时打开）。

### Changed
- 将默认总控换届上下文压缩提醒阈值从 `2` 次提高至 `5` 次（非强制、看板可调），并支持一键拉起新总控接班或标记「本会话忽略不再提醒」。
- 升级 `plugin/skills/control-tower/SKILL.md` 与 `references/templates.md`，引入环境自适应派遣（优先推荐原生 `swarm`、次选 `agentapi` 直派并支持斜杠前缀、保留手动兜底）、三档代决策与 100% Antigravity 原生系统通知边界。
- 放宽 `PreInvocation` 默认速查输入阈值至 `2000` 字符 / `6` 个 ID，并对 `[CT_AUTO_RECEIPT]` 回执自动跳过重复速查。

## [1.1.0] - 2026-11-21

### Added
- 采用官方标准 `./plugin/` 子目录纯净包布局，直接支持 `agy plugin validate --strict ./plugin` 零警告及 `agy plugin install ./plugin` 原生安装与升级。
- 在 `plugin/lib/` 收敛为纯零依赖 Node.js ESM 共享库（`paths.mjs`、`registry.mjs`、`transcript.mjs`），彻底消除 Python Hooks 与 Node Sidecar 的双语言解析重复。
- 支持多宿主 `appData/brain`（`antigravity`、`antigravity-ide`、`antigravity-cli`）及官方 `<appData>/plugin_data/control-tower` 状态存储。
- `inspectTranscript()` 新增头 `32KB` + 尾 `64KB` 分片读取及字节偏移增量扫描缓存（含 `state.json` 200 条 LRU 裁剪），解决大体积 `transcript.jsonl` 全量读盘性能瓶颈。
- `PreInvocation` 钩子扩展短口令多十六进制会话 ID 识别（忽略代码块与非命中 SHA 哈希）。
- Sidecar 总控看板补齐第 1~5 节全章节结构化写表操作（含现役总控登记、裸 ID 探针一键入账活跃表、活跃会话一键归档至里程碑）与 `/_sidecar/send-message` 投递现役总控联动，并显式阻断默认 `flash` 的 `/_sidecar/new-conversation`。
- 仓根引入零依赖 `node:test` 分层单测与沙箱 E2E 套件（`tests/*.test.mjs`）、`scripts/cleanup-legacy-skill.sh` 与本地 `scripts/git-hooks/pre-commit` 合规门禁。

### Changed
- 将 `PreInvocation` / `SessionStart` 钩子入口收敛至 `plugin/scripts/ct-hook.mjs`（`hooks.json` 使用 `node ./scripts/ct-hook.mjs`）。
- 加固 Sidecar 全量 `/api/*` 与 `/_sidecar/*`（含 `GET` 路由）的 `x-sidecar-token` 鉴权，并剥离 `GET /api/snapshot` 隐式写盘副作用（改为显式 `POST /api/workspace/select`）。
- 更新 `plugin/skills/control-tower/references/templates.md` 去除硬编码 `~/.gemini/config` 路径，改为兼容原生插件安装位置与同目录相对引用。

### Removed
- 移除根目录手写文件拷贝版 `install.sh` / `uninstall.sh` 与旧 Python 钩子脚本（`scripts/ctlib.py`、`scripts/hook-*.py`），改由 Antigravity 官方 `agy plugin` 生命周期接管。

## [1.0.0] - 2026-11-21

### Added
- 完成 `control-tower` 初始原生插件化改造（`plugin.json`、`hooks.json`、总控定向感知 Hooks、可读写 Aux Pane Sidecar 看板与 12 项隔离沙箱自检）。
