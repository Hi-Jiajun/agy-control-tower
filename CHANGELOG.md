# Changelog

All notable changes to `control-tower` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.1] - 2026-11-24

### Fixed
- **完工回执纯零 Token 双轨投递（消除 `stop_agentapi_failed`）**：
  - 针对 Antigravity `hooks.json` 子进程不注入 `ANTIGRAVITY_LS_ADDRESS` 的宿主契约，升级 `plugin/scripts/ct-hook.mjs`：无 `LS_ADDRESS` 时不再盲调 `agentapi`，改为零报错落盘 `inbox.json` 的 `deferredReceipt` 与阶段回执项（`stop_receipt_queued_inbox`）。
  - 看板在线时由 `plugin/sidecars/tower/main.mjs` 结合 `SseHub` `fs.watch` 实时感知与后台哨兵，在主总控空闲期自动代发唤醒总控；看板未开时由主总控下次 `PreInvocation` 在清零焦点状态前自动捕获并注入 `[control-tower 待收阶段回执]`，固化为 L2 回放样本 `INC-013`。
- **哨兵信箱 `P0` 严格终态判据、自愈消解与 `version=2` 迁移**：
  - 修复 `plugin/lib/transcript.mjs` 末尾 `64KB` 扫描循环在后续无错步骤未清零历史 `lastError` 的缺陷；`plugin/lib/inbox.mjs` 排除原生 Swarm 中的主总控 `coordinator` 自身，仅当子会话尾步真正停在未恢复异常终态时才触发 `P0`，并在会话继续推进、完工、归档或销毁后自动将旧告警消解为已读（固化为 L2 回放样本 `INC-014`）。
  - `inbox.json` 升级至 `version: 2` 并持久化 `workspace` 真实路径，首次读取自动无感清洗旧版遗留的假阳性 `P0` 并清空旧版 `state.pendingAttention` 残留。
- **跨工作区双端自动纳管与慢钩子 I/O 剪枝**：
  - `plugin/lib/paths.mjs` 新增 `loadKnownWorkspaces()` 与 `recordKnownWorkspace()`（支持有界父级目录哈希回填已有总控仓），Hook 与 Sidecar 双端自动登记，且 `routes/workspaces.mjs` 全局抽屉默认仅聚焦「有总控台账的工作区 + 当前打开仓」。
  - `inspectNativeSwarm()` 在磁盘读取前直接跳过已 `killed` 成员并短期缓存单回合 `brain` 目录项列表；在看板与路线图派单锚点补入跨回合 `edit_file` 先 `read_file` 对齐缩进及连续 2 次失配止损提醒。

## [1.7.0] - 2026-11-24

### Added
- **零依赖 `fs.watch` + `/api/events` SSE 实时推送引擎**：
  - 新增 `plugin/sidecars/tower/lib/sse-hub.mjs`：基于 Node 原生 `fs.watch` 与 HTTP `text/event-stream` 实现 `120ms` 去抖实时推送，监听 `dataDir`、工作区信箱/路线图目录及 `.agents/` 台账变更（自动忽略 `.tmp.*` / `.tmp-*` / `*.lock` 临时锁文件，零订阅客户端时自动释放文件句柄，`close()` 时瞬时销毁全部连接与心跳）。
  - Sidecar 写操作与后台哨兵发现新告警后即时广播 `workspace_changed`；前端接入 `EventSource`（顶栏展示 `SSE 实时` 绿点），在 SSE 在线时将安全兜底轮询自动降频至 `24s+`，断线时无缝回退自适应轮询。
- **WebView 原生内联二次确认微交互（零 `window.confirm`）**：
  - 在 `plugin/sidecars/tower/ui-logic.mjs` 与 `app.js` 新增纯状态机 `nextInlineConfirmState()` 与 `confirmInline()`：破坏性删除与重置操作（路线图删除分支、队列删除任务、三层设置恢复默认、文档覆盖恢复内置、清空诊断日志）首次点击变更为 `确认删除?` / `确认重置?` / `确认清空?` 高亮确认态（3 秒超时自动恢复，二次点击才提交），且确认窗口期内自动暂停后台刷新防止按钮重绘丢失。
- **跨工作区全局概览抽屉与顶栏 `P0/P1` 汇总角标**：
  - 新增 `plugin/sidecars/tower/routes/workspaces.mjs`（`GET /api/workspaces/overview` 与 `snapshot.multiWorkspace`）：零写入聚合当前与最近全部工作区的现役主总控、独占锁状态、活跃专职会话数、路线图完成度及未读 `P0/P1` 告警数。
  - 看板顶栏工作区选择栏新增 `#global-ws-btn` 全局角标按钮与可折叠 `#global-ws-drawer` 跨仓卡片列表，支持异常工作区置顶排序与一键跨工作区秒切。

## [1.6.1] - 2026-11-24

### Fixed
- **核心库与四事件钩子并发安全加固（Carbon 深度审查）**：
  - **多级父目录软链防逃逸与有界读取**：升级 `plugin/lib/paths.mjs` 的 `assertSafeTargetWithinRoot` 向上回溯校验最近存在祖先目录的 `realpathSync`，接入 `roadmap.mjs` 工作区路径与 `inspectNodeHandoff`（限定 `.md` 后缀与 `4KB` 有界读取），阻断父目录软链跨工作区读/写逃逸。
  - **零依赖跨进程文件锁与两段式 `Stop` 状态同步**：新增 `withFileLockSync` 与 `updatePluginState` 保护 `state.json`、`inbox.json`、`roadmap.json` 并发读写，根治多专职会话同时停机覆写 `pendingSilentDone` 导致阶段回执漏报的竞态，并支持 8 位短前缀匹配与焦点忙碌期延迟回执持久化补投。
  - **双证换届与多工作区写保护收紧**：`PreToolUse` 遍历全部挂载工作区匹配台账路径，递归提取编辑参数并校验第 2 节 `当前现役总控会话` 确实更新为自身 ID，剥离 `<SYSTEM_MESSAGE>` 头部并排除隐藏面 Swarm/子代理成员后核验交接卡，同时为 `pendingSuccessors` 提供 60 秒多步编辑幂等宽限期。
  - **纯 `Buffer` 字节换行增量扫描与超 64KB 尾行遥测回退**：重写 `transcript.mjs` 分片扫描器避免跨块截断 UTF-8 多字节字符导致偏移漂移或无换行尾行双倍计次；在尾行超 64KB 时自动回退增量累加器最新模型/状态，修复并行多 `invoke_subagent` 认领丢失与 `hasOutboundAgentApiReport` 正文假阳性。
  - **健康空信箱节流落盘**：修复 `evaluateSentinelSweep` 在已存在空 `inbox.json` 时未持久化 `lastSweepAt` 导致每轮重复扫描的问题。
- **Sidecar 看板前后端安全与状态一致性加固**：
  - **后端安全与并发**：顶层 HTTP 回调包裹畸形 URL 防崩溃容错；Token 鉴权升级为恒定时间 `timingSafeEqual` 并增加 `POST` Origin 同源保护；剥离 `GET /api/snapshot` 隐式挂载定时器副作用与 `GET` 慢日志建目录副作用；新增工作区异步互斥锁与持独占锁直派第 1 节原子授锁；路线图 `dispatch-hidden` 增加 `blocked`/`done` 依赖门禁与模型合规校验；`agentapi` 缓存按 `projectId` 隔离并支持并发合并、写后失效与 `SIGKILL` 超时升级。
  - **前端防覆盖与无障碍**：将 `#conflict-banner` 提升至全局顶栏，独立维护 `rawBaseHash` 与 L1/L2 乐观锁哈希；修复路线图编辑丢失隐藏字段、重命名迁移下游依赖及「编辑 -> 新增」残留 `originalId` 误删节点；为设置页、文档编辑器、租约与总控表单增加脏状态防轮询覆盖、请求序号防旧响应回退、耗时按钮防连点锁、窄栏单列自适应与 `.switch` 键盘焦点样式。
- **技能规程对齐与五环工具链加固**：
  - 在 `SKILL.md` 与 `templates.md` 补齐 `[CT_ROADMAP_DISPATCH]`、`[CT_SWARM_CLEANUP]`、`[CT_INBOX_DELIVER]` 处置规范、`slot_reuse` 操作契约、双证换届保留前任 ID 要求及 `[CT_REPORT:DONE] [<节点ID>]` 汇报格式。
  - `pre-commit` 升级为优先校验 Git 暂存区索引（覆盖 RFC1918 全网段与双间隔号）；`ct-release.mjs` 快照改为 `.tmp-*` 原子暂存转正并过滤残损目录；`ct-doctor.mjs` 支持识别升级前旧版 Sidecar 进程并同步 `--config-dir` 子进程环境；`ct-miner.mjs` 改为真有界 `8MB` 尾切片读取；新增 `EVAL-16` 端到端换届交接卡契约评测。

## [1.6.0] - 2026-11-24

### Fixed
- **总控换届双证放行与静默版本戳**：修复现役总控合法换届交接时新总控首次更新 `SESSION-REGISTRY.md` 被 `PreToolUse` 误拦截及 2 秒后收到虚假 `[control-tower 版本同步]` 提醒的问题。`ct-hook.mjs` 引入双证校验（看板一键换届预登记 `pendingSuccessors` 或首轮提示含换届交接卡与卸任总控 ID，且写入内容须含自身 ID，绝不放行已入账专职会话），换届接班或冷启动登记成功时自动静默写入 `lastSyncedVersion` 并清理卸任总控遗留项。
- **提醒单真源收敛、双擎零 Token 哨兵与焦点锁无条件释放**：
  - 看板顶部横幅统一收敛至 `inbox.json` 单真源，自动裁剪已卸任总控的换届/决策僵尸条目及超期已读或低优项，彻底消除跨天僵尸横幅。
  - 修复总控 `Stop` 因非 `NO_TOOL_CALL` 或 `fullyIdle: false` 跳过而导致 `focusModeInFlight` 长期卡死 `true` 的缺陷（改为总控任意 `Stop` 无条件释放 `inFlight` 且 `inbox.mjs` 将过期兜底窗收紧至 5 分钟）；同时补齐 Sidecar `GET /api/snapshot` 自动激活哨兵定时与 `PreInvocation` 节流兜底哨兵双引擎。
- **消除 WebView 原生弹窗阻塞与 Sidecar 同步阻塞**：
  - 将看板归档操作的 `window.prompt()` 替换为原生内联表单 `#archive-form`，消除 Antigravity WebView 静默屏蔽风险。
  - 将 Sidecar `agentapi` 调用由同步阻塞 `execFileSync` 升级为异步 `execFile`，为 `/_sidecar/get-conversation-metadata` 增加 5 秒 TTL 内存缓存，并区分本地接口慢阈值（`100ms`）与外部 RPC 慢阈值（`SLOW_RPC_THRESHOLD_MS = 500ms`），消除误报 `slow_api`。

### Added
- **路线图派单三按钮与 Handoff 契约预览**：路线图分支卡片新增主按钮「交总控隐藏面派单」（`POST /api/roadmap/node/dispatch-hidden`）、次按钮「填入白名单直派」（自动预填 `#dispatch-form` 与 `workstreamId`）及「复制契约词」；`plugin/lib/roadmap.mjs` 新增防路径穿越的只读 `inspectNodeHandoff()`，自动发现并折叠展示 `.agents/handoffs/<id>.md` 交付摘要。
- **Swarm 隔离徽章与休眠回收请求**：看板原生 Swarm 成员卡展示 `workspace` 隔离档位徽章（`share` / `branch` / `inherit`），并提供「回收休眠成员」按钮（`POST /api/swarm/cleanup-request`）通知现役总控安全收尾。
- **`[CT_REPORT:DONE]` 路线图闭环联动**：`PreInvocation` 识别 `[CT_REPORT:DONE]` 回执时自动写入工作区信箱并在命中活跃路线图节点时向总控注入 1 行 `[control-tower 路线图联动]` 进度更新提示。
- **深化 L2 / L3 / L4 质量门禁**：沉淀 4 条线上实战事故为脱敏 L2 回放样本（`INC-009` ~ `INC-012`，共 12 条）；L3 无头 Chrome CDP 真浏览器冒烟升级为端到端交互测试（路线图初始化、新建分支、Handoff 预览、循环依赖错误提示、填入白名单直派、原生内联归档表单与设置保存）；新增 `EVAL-15` 禁止 Sidecar 使用阻塞式弹窗或同步 `execFileSync`（共 15 项评测）。

### Changed
- **Sidecar 前后端模块化拆分**：后端 `plugin/sidecars/tower/main.mjs` 拆出 `lib/agentapi.mjs`、`routes/roadmap.mjs`、`routes/inbox.mjs`；前端 `plugin/sidecars/tower/app.js` 拆出 `views/{overview,sessions,roadmap,settings}.mjs`，保持零第三方依赖与纯 ESM 架构。

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
