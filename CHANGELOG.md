# Changelog

All notable changes to `control-tower` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.0] - 2026-11-23

### Added
- **第三阶段（方向三）：子会话四象限物理隔离与协作契约协议**
  - 在 `plugin/lib/roadmap.mjs` 实现文件所有权边界（Ownership Map）重叠冲突检测 `detectOwnershipOverlaps()` 与四象限契约派单词生成器 `buildWorkstreamContractPrompt()`（内嵌 `workspace: share/branch/inherit` 隔离档位、Swarm 频道 / Workflow 流水线 / `.agents/handoffs/` 协作拓扑、所有权边界、验收命令与 L4 统一合流门禁）。
  - 在 `plugin/skills/control-tower/SKILL.md` 新增第 7 节「子会话四象限隔离与协作协议」并在 `references/templates.md` 新增「模板 D：跨波次接力契约卡片」。
- **第三阶段（方向四）：大型长期项目三层混合存储路线图（L1 + L2 + L3）与看板联动**
  - 新增 `plugin/lib/roadmap.mjs`：按需启用（小项目零负担），支持工作区 `.agents/` 与 `PLUGIN_DATA` 零侵入托管双落点；管理 L1 战略北极星 `ROADMAP.md` 与 L2 结构化分支依赖图 `roadmap.json`（含循环依赖拦截、自动就绪度计算、分支标记完成后的下游新解锁分支提示与里程碑进度汇总）。
  - 升级 `plugin/scripts/ct-hook.mjs`：`SessionStart` 为已启用路线图的工作区现役总控自动注入 1 行 L1/L2 进度、就绪并行分支与所有权冲突速览，防多轮换届战略漂移。
  - 升级 Aux Pane 看板 `plugin/sidecars/tower/`：新增 6 标签响应式导航（窄栏 3x2 零溢出）与「路线图」交互树页签（含里程碑进度条、L1 在线编辑、所有权冲突预警横幅、分支依赖树与一键复制四象限契约派单词 / 标记完成自动解锁下游），并新增 `/api/roadmap/*` 全套鉴权路由及 `/api/dispatch/create` 的 `workstreamId` 自动回链。
- 扩充四维自动化门禁：新增 `tests/roadmap.test.mjs`、`tests/inbox-and-surfaces.test.mjs`、2 份新回放样本（`INC-007` 焦点门禁暂缓唤醒与 `INC-008` 路线图循环依赖/所有权冲突），L3 无头 Chrome CDP 真浏览器冒烟覆盖全部 6 标签与路线图交互初始化，L4 Skill 行为契约评测扩充至 14 项黄金场景。

## [1.4.0] - 2026-11-23

### Added
- **第二阶段（方向一）：左侧会话栏瘦身与四执行面统一任务导航**
  - 在 `plugin/lib/transcript.mjs` 新增 `inspectHiddenSurfaces()`，增量扫描主总控尾步自动聚合零左侧栏污染的隐藏执行面（原生 `swarm` + `invoke_subagent` + `run_workflow`），与顶层 `agentapi` 会话共同组成看板「四执行面统一任务导航器」。
  - 在 `plugin/lib/settings.mjs` 新增全局 `dispatchSurfacePolicy`（默认 `hidden_first` 隐藏面优先，支持 `slot_reuse` 与 `allow_toplevel`）；看板受控直派卡片改为白名单折叠态并在顶层会话达 3 个以上时给出瘦身提示。
- **第二阶段（方向二）：冷热解耦零 Token 后台哨兵 + 焦点防打扰门禁（Focus Gate）**
  - 新增 `plugin/lib/inbox.mjs`：实现工作区隔离优先级事件队列 `inbox.json`（`P0` 紧急阻塞 / `P1` 阶段里程碑 / `P2` 静默例行）、前台聚焦状态跟踪与防打扰门禁 `evaluateFocusGate()`，以及零 Token 哨兵巡检引擎 `evaluateSentinelSweep()`（自动检测报错、卡死、高压缩与停稳待归档）。
  - 升级 `plugin/scripts/ct-hook.mjs`：`PreInvocation` 识别真实用户前台对话记录焦点态并被动注入 1 行信箱摘要；`Stop` 钩子在总控回复结束时释放 `inFlight`，在专职会话停下时若主总控处于前台聚焦窗口则自动暂缓抢占式唤醒并沉淀至 `inbox.json`。
  - 升级 Sidecar `plugin/sidecars/tower/`：新增零 Token 后台巡检定时器、`/api/inbox`、`/api/inbox/ack`、`/api/inbox/deliver`、`/api/sentinel/sweep` 路由与总览页「零 Token 哨兵与优先级收件箱」交互卡片。
  - 在 `plugin/skills/control-tower/{SKILL.md,references/templates.md}` 落地隐藏面优先白名单、冷热解耦防打扰规程与「模板 C：按需临时域分总控（Domain Lead）」授权契约。

## [1.3.0] - 2026-11-23

### Added
- **第一阶段：五环自演化研发闭环底座（Self-Evolving Plugin Foundry）**：
  - **环 1（零侵入黑匣子飞行记录仪）**：新增零依赖轮转脱敏 JSONL 日志模块 `plugin/lib/logger.mjs`（落盘 `<PLUGIN_DATA>/logs/ct-flight.jsonl`，2MB 轮转保留 3 份，自动脱敏路径、内网 IP 与敏感凭据）；全面消除 `ct-hook.mjs` 与 Sidecar `main.mjs` 的静默错误吞没，记录异常、慢调用（`>= 100ms`）、写保护拦截与 `Stop` 唤醒跳过原因；看板「插件设置」新增轻量只读「黑匣子飞行诊断日志」面板与 `/api/diagnostics` 接口。
  - **环 2（本机遥测复盘与改进提案引擎）**：新增仓根只读分析器 `scripts/ct-miner.mjs`（`npm run mine`），聚合本机近期 `transcript.jsonl` 与黑匣子日志，自动聚类缓存穿透、`edit_file` 失配、高压缩老化与运行态异常并输出脱敏实证改进提案。
  - **环 3（隔离沙箱与事故轨迹回放库）**：新增 `scripts/ct-replay.mjs`（`npm run replay`）及 `tests/replays/` 6 份脱敏真实历史事故样本（覆盖跨插件 `PLUGIN_DATA` 隔离、收件人校验、旧版台账提示、Git SHA 过滤、一次性版本同步与新版 Orchestrator 护栏），并支持 `--freeze-latest` 从黑匣子异常冻结生成新回放骨架。
  - **环 4（四维立体自动化门禁）**：抽离纯前端状态逻辑至 `plugin/sidecars/tower/ui-logic.mjs` 并补充 L1 单测（`tests/ui-logic.test.mjs`、`tests/logger-and-miner.test.mjs`）；接入 L2 回放回归测试（`tests/replays.test.mjs`）；新增零依赖无头 Chrome CDP 真浏览器 UI 冒烟测试 `scripts/ct-ui-smoke.mjs`（`npm run test:ui`，校验 Aux Pane `390x844` 暗/亮双主题与 `960x844` 宽栏 0 Console Error 与 0 横向溢出）；新增 10 项黄金场景 Skill 与 Prompt 行为契约评测套件 `scripts/ct-skill-eval.mjs`（`npm run test:eval`）。
  - **环 5（发布前快照、实装健康体检与一键秒回滚）**：新增 `scripts/ct-doctor.mjs`（`npm run doctor`）校验已装版本一致性、无旧散装 Skill 残留、无失效 Sidecar 进程与黑匣子 24h 健康度；新增 `scripts/ct-release.mjs` 支持实装前自动备份最近 3 版快照至 `<PLUGIN_DATA>/releases/`，支持一键经官方 `agy plugin install` 回滚与复检（附全沙箱测试 `tests/release-and-doctor.test.mjs`）。
- 新增仓根三阶段演进战略蓝图文档 `docs/ARCHITECTURE-ROADMAP.md`（不打入 `./plugin/` 运行包）。

### Changed
- 适配 Antigravity 客户端新版 **Orchestrator 双层自定义能力**（支持分别自定义规划模型与执行模型及含 `Extra High` 的思考档位，并支持单会话菜单覆盖规划模型）：同步更新 `plugin/skills/control-tower/references/model-routing.md`、`SKILL.md` 及 `plugin/lib/settings.mjs`（新增 `Orchestrator (Neon Extra High)`、`Orchestrator (Carbon High)`、`Gemini 4 Neon/Hydrogen Extra High` 等别名映射与预设）。

## [1.2.3] - 2026-11-23

### Added
- 在 `plugin/scripts/ct-hook.mjs` 的 `PreInvocation` 中新增一次性去重的「插件版本升级自动感知提醒」（比对 `plugin.json` 当前版本与 `state.json` 中各现役总控的 `lastSyncedVersion`）：当插件升级后，本机所有已有历史步数的在位老总控在下一轮被唤醒时均会自动收到一次重读最新版 `SKILL.md`、`model-routing.md` 与 `templates.md` 的提示（全新首轮总控静默记账不打扰）。

## [1.2.2] - 2026-11-23

### Changed
- 基于近 7 天实战遥测与缓存命中率分析重构 `plugin/skills/control-tower/references/model-routing.md`：
  - 将 `L0` 常驻总控与 `L2` 常规单模块明确开发首选切换为单模型 `Gemini 4 Neon (High)` / `Hydrogen (High)`（轻量短交互可选 `Neon (Medium)`），避免高频短交互下双层切换导致的缓存穿透；`L2` 跨多文件复合任务与 `L3`/`L4` 保留 `Orchestrator`（复杂规划优先 `Orchestrator (Carbon)`）。
  - 放宽 `XHigh` 思考档位为「不全局默认，按需直接启用」。
  - 新增第 6 节「单模型 / `Orchestrator` 与 `swarm`、`/plan`、`/boost`、`/teamwork`、`/goal`、`run_workflow` 协同搭配矩阵」与第 7 节「上下文缓存保护三条护栏」。
  - 在降级阶梯中补充「当前切换账号 `Carbon` 模型不可用时临时降档至 `Neon (XHigh)` / `Orchestrator (Neon)` / `Neon (High)`」策略。
- 同步升级 `plugin/skills/control-tower/SKILL.md` 与 `references/templates.md`：在派单开场骨架内嵌「精确 `read_file` 后再 `edit_file`、连续 2 次不匹配立即重读或改用 `write_file`」及「独立只读操作同轮批量合并」纪律。
- 同步更新 `plugin/lib/settings.mjs` 默认全局预设（`l0ControllerModel` 与 `l2StandardModel` 默认调整为 `Gemini 4 Neon (High)`）并在看板 `MODEL_PRESETS` 补充 `Gemini 4 Neon (XHigh)` 与 `Gemini 4 Hydrogen (XHigh)`。

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
