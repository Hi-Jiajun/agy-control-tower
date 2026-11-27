# Control Tower 三阶段架构演进总蓝图（L1 北极星）

本文档位于源码仓根目录 `docs/`（不打入 `./plugin/` 安装包），作为 `control-tower` 持续演进的战略北极星、架构不变量与三阶段实施路线图。

---

## 一、核心架构不变量与反目标（Invariants & Non-Goals）

### 必须长期守住的架构底线
1. **纯净包与开发/运行态严格隔离**：运行态资产仅存在于 `./plugin/` 且始终通过 `agy plugin validate --strict ./plugin` 零警告；研发脚本、复盘工具、回放库与测试套件一律留在仓根。
2. **纯零第三方依赖 Node.js ESM 单栈**：运行态 `./plugin/` 与仓根自演化研发门禁均不引入重型 npm 第三方运行时依赖，依托原生 Node.js ESM、Antigravity 官方 CLI/SDK 与本机标准工具运行。
3. **零全局污染与零外部弹窗**：坚持 `components.rules === 0`（绝不向无关工作区注入 always-on 全局规则）；通知 100% 复用 Antigravity 原生系统通知，严禁外部桌面弹窗命令。
4. **单真源不裂脑**：每个工作区始终保持单一逻辑决策真源（现役主总控），任何后台监测或按需域分总控均在显式授权边界内运作，无权越权改写全局总账或推翻总体架构方向。
5. **纯 Gemini 4 + Orchestrator 路由红线**：仅选用 `Carbon` / `Neon` / `Hydrogen` 与新版可自定义 `Orchestrator`，严禁 `Argon` 与 `Gemini 3.8` 及更早系列模型，严禁引用 `magpie-quota` 评估 Antigravity 配额。
6. **隐私与字符卫生门禁**：全仓严禁提交本地用户绝对路径、静态完整 UUID、内网 IP、凭据或间隔号字符。

### 本演进周期刻意不做的反目标（Non-Goals）
- 不伪造或绕过 Antigravity 权限检查、`project_id` 边界或外部反自动化门禁。
- 不强迫小型单日项目启用复杂三层路线图或重度 Swarm 拓扑（保持小项目零负担冷启动）。
- 不养长期常驻且上下文割裂的「双平级 AI 总控」。

---

## 二、五方向对齐决策总览与三阶段路线

### 第一阶段（`v1.3.0` — 已完成交付）：五环自演化研发闭环底座 + Orchestrator 最新路由同步

- **环 1：零侵入黑匣子飞行记录仪**
  - `plugin/lib/logger.mjs`：轮转脱敏 JSONL 飞行日志（`<PLUGIN_DATA>/logs/ct-flight.jsonl`，单文件 2MB 上限、保留 3 份），自动脱敏用户路径/内网 IP/Token 凭据。
  - 在 `ct-hook.mjs` 与 Sidecar `main.mjs` 全面消除静默 `catch {}`，记录异常、慢调用（`> 100ms`）、写保护拦截、唤醒跳过原因与 4xx/5xx 请求。
  - 看板设置中心「插件设置」新增轻量只读「黑匣子诊断日志」视图与清理按钮。
- **环 2：遥测复盘与改进提案引擎（`scripts/ct-miner.mjs` / `npm run mine`）**
  - 只读聚合本机近期 `transcript.jsonl` 与黑匣子日志，自动聚类缓存穿透、模型切层、`edit_file` 失配、高压缩老化、Hook 报错与写保护摩擦，输出脱敏实证改进提案。
- **环 3：隔离沙箱与事故轨迹回放库（`tests/replays/` + `scripts/ct-replay.mjs` / `npm run replay`）**
  - 把真实踩坑现场脱敏沉淀为可重复执行的红变绿回放样本（`*.replay.json`），支持一键从近期异常日志冻结生成新回放骨架。
- **环 4：四维立体自动化门禁**
  - **L1 单元与纯逻辑测试**：覆盖共享核心、Hooks、Sidecar API、以及从 `app.js` 抽离的纯前端状态逻辑模块 `plugin/sidecars/tower/ui-logic.mjs`。
  - **L2 事故回放回归集**：`tests/replays.test.mjs` 自动执行全部历史事故样本。
  - **L3 真浏览器全功能与窄宽栏 UI 冒烟**：`scripts/ct-ui-smoke.mjs`（`npm run test:ui`）通过 Node 原生 WebSocket + CDP 驱动无头 Chrome/Chromium，实测 Aux Pane 超窄栏（`360x844`）、窄栏（`390x844`）暗/亮双主题与宽栏（`960x844`）共 36 项交互与几何检查，校验 0 Console Error、0 未捕获异常、0 横向溢出、13 处模型选择器、滑动指示条与 DOM 记忆化零重绘。
  - **L4 Skill 与 Prompt 行为契约评测**：`scripts/ct-skill-eval.mjs`（`npm run test:eval`）按 17 项黄金场景校验路由红线、新版 Orchestrator 配置、缓存与编辑纪律、写保护、WebView 异步非阻塞与端到端换届交接卡契约。
- **环 5：发布前快照、实装体检与一键秒回滚**
  - `scripts/ct-doctor.mjs`（`npm run doctor`）：实装后健康探针（版本一致性、无旧散装 Skill 双重发现、无失效 Sidecar 进程、黑匣子 24h 健康度、快照库存）。
  - `scripts/ct-release.mjs`（`release:snapshot` / `release:list` / `release:rollback`）：实装前自动备份运行态插件包至 `<PLUGIN_DATA>/releases/`（保留最近 3 版），异常时一键经官方 `agy plugin install` 回滚并复检。
- **Orchestrator 双层自定义路由同步**：
  - 适配 Antigravity 新版 `Orchestrator`（支持分别自定义规划模型与执行模型及各自思考档位，且支持单会话菜单覆写规划模型），同步升级 `model-routing.md`、`SKILL.md`、`settings.mjs` 预设与别名映射。

### 第二阶段（`v1.4.0` — 已完成交付）：左侧会话栏瘦身（方向一）+ 前后台无冲突防打扰架构（方向二）

- **执行面默认隐藏化与顶层白名单**
  - 默认派单通道收束至三大零左侧栏污染执行面：原生 `swarm`（支持单/多 worker 精准指定任意模型 + `share`/`branch` 隔离 + 结项一键回收）、`invoke_subagent`（同模型轻量单任务/只读调研）、`run_workflow`（多文件扇出与确定性流水线）。
  - `agentapi new-conversation` 顶层会话严格收紧为 3 类白名单（需人工盯屏/逐条审批的高危或独占硬件实操、独立于总控生命周期且需斜杠模式的跨天史诗主线、用户明确要求单开窗口），并按固定角色槽位复用。
  - Control Tower 看板升级为「四执行面统一任务导航器」，集中展示并定位所有隐藏与顶层任务。
- **冷热解耦三层防打扰架构**
  - **零 Token Sidecar 常驻哨兵**：定时低频增量扫描活跃执行面，自动检测完工、卡死（Stuck）、连续报错、压缩超限与锁超时，0 Token 不抢回合。
  - **优先级事件信箱 `inbox.json` + 焦点防打扰门禁（Focus Gate）**：事件分级 `P0`（紧急阻塞）/ `P1`（阶段里程碑）/ `P2`（静默例行）。主总控处于前台高频对话聚焦态时，严禁 `P2`/非紧急 `P1` 插嘴打断，仅在下次 `PreInvocation` 附一行极简待办摘要与看板角标；空闲态才批量汇总唤醒。
  - **按需临时域分总控（On-Demand Domain Lead）**：超大型并发项目按需经原生 `swarm` 拉起持明确授权边界的临时域分总控，收口回传摘要后休眠/销毁。

### 第三阶段（`v1.5.0` — 已完成交付）：子会话隔离协作协议（方向三）+ 三层长期项目路线图（方向四）

- **四象限隔离与协作协议**
  - 物理隔离三档：纯只读/轻验用 `inherit`；并行写代码默认 `workspace: "share"`（worktree 级隔离）；破坏性重构用 `branch`；物理设备继续沿用独占单锁。
  - 三类协作拓扑：紧耦合实时攻关走原生 `swarm` 频道直聊；松耦合确定性流水线走 `run_workflow` `pipeline` + JSON `schema` 契约；跨波次接力走 `.agents/handoffs/<task>.md` 轻量契约文件。
  - 派前划定文件所有权边界（Ownership Map），完工由专门集成步（L4 Merge & Verify）统一合流验证并回收工作树。
- **三层混合存储长期路线图 + 看板联动**
  - **L1 战略北极星（`ROADMAP.md`）**：1~2 页愿景、里程碑 DoD、架构不变量、反目标与 ADR 索引，防总控换届漂移。
  - **L2 结构化路线与分支依赖树（`roadmap.json`）**：史诗主线 -> 分支节点，含 `status` / `dependsOn` / `ownership` / `acceptance`，采用渐进式细化（Rolling Wave），兼容工作区目录与 `PLUGIN_DATA` 零侵入托管。
  - **L3 瘦身实时执行台账（`SESSION-REGISTRY.md`）**：聚焦活跃执行面、独占锁与 `workstreamId` 关联。
  - 看板新增「路线图」交互树：自动高亮就绪（`ready`）节点、支持带契约一键派单并回填 L3，分支验收完成后自动提示新解锁的可并行下游分支。

### 第四阶段（`v1.6.0 ~ v1.6.1` — 已完成交付）：实战遥测根因修复、看板模块化拆分与 Carbon 全栈并发安全加固

- **线上实战缺陷根治与交互闭环**
  - `PreToolUse` 双证换届接班放行（看板预授权 `pendingSuccessors` 或剥离系统信封后的交接卡验证 + 第 2 节总控槽位自指校验，严拒活跃顶层与隐藏面 worker）及静默版本戳。
  - 单真源 `inbox.json` 横幅收敛、总控 `Stop` 无条件释放 `focusModeInFlight`、焦点忙碌期延迟回执持久化补投，以及 Sidecar + Hook 双引擎零 Token 哨兵（含健康空信箱 `lastSweepAt` 落盘）。
  - 路线图三按钮派单（含 `blocked`/`done` 依赖门禁）、`.agents/handoffs/<id>.md` 4KB 有界防穿越预览、Swarm 隔离徽章与休眠成员安全回收、原生内联归档表单与异步缓存 `agentapi` 桥接。
- **模块化架构与并发安全加固**
  - Sidecar 前后端拆分为 `lib/agentapi.mjs`、`routes/{roadmap,inbox}.mjs` 与 `views/{overview,sessions,roadmap,settings}.mjs`；引入恒定时间 Token 校验、工作区串行互斥锁、持锁直派原子授锁、全局 409 冲突横幅、`rawBaseHash`/L1/L2 乐观锁、脏表单防轮询覆盖与请求序号防竞态。
  - 核心库引入零依赖跨进程文件锁 `withFileLockSync`、多级父目录软链逃逸拦截、纯 `Buffer` 字节换行增量扫描与超 64KB 尾行遥测回退；沉淀 12 条 L2 事故回放样本与 16 项 L4 契约评测，加固 `pre-commit` Git 暂存区校验与 `ct-release` 原子快照。

### 第五阶段（`v1.7.0 ~ v1.7.1` — 已完成交付）：零依赖 SSE 实时流、双轨无错回执、哨兵自愈与全局抽屉

- **零依赖 `fs.watch` + SSE 实时推送引擎（`lib/sse-hub.mjs`）**：通过 `/api/events` 建立单连接实时事件通道，文件或 API 写变更 `120ms` 去抖即时推送前端，SSE 在线期间将后台轮询自动降频至 `24s+` 低功耗兜底态，零订阅时自动回收目录监听器。
- **WebView 安全内联二次确认微交互**：所有破坏性删除与配置重置按钮统一接入 `confirmInline()` 两段式内联确认状态机（3 秒超时自动解除，挂起期间锁定列表重绘），100% 杜绝 `window.confirm` 阻塞风险。
- **跨工作区全局概览抽屉（`routes/workspaces.mjs`）与双轨零错投递**：顶栏自动发现并汇总全部已建总控工作区状态与未读 `P0/P1` 告警；Hook 与 Sidecar 建立纯零 Token 双轨回执投递并升级 `version=2` 信箱自愈消解。

### 第六阶段（`v1.8.0` — 已完成交付）：全最高思考 `Orchestrator` 舒适区路由与智能双触发 `/learn` 闭环

- **全最高思考舒适区路由与 `Swarm` 显式配模**：默认全面采用各自最高思考档位，由新版可自定义 `Orchestrator` 承担 `Swarm` 编码/复合验证 worker 与常规开发主力，单模型专注 `L1` 纯只读扫描与含写盘 `run_workflow`；`ct-miner` 同步输出「新版 Orchestrator vs 纯单模型」实测对比表。
- **智能双触发 `/learn` 审批闭环**：新增三层 `autoLearnMode` 开关（`smart_proposal` / `milestone_only` / `off`），专职会话只提炼候选且禁改规则/技能，总控在阶段收口、换届与纠偏信号（15 分钟节流）时按原生 `/learn` 契约产出 `learning_proposal.md` 供审批后落盘，并在看板提供一键「发送 `/learn`」按钮。

### 第七阶段（`v1.8.1 ~ v1.10.0` — 当前版本）：宿主网关兼容、实证路由调优、本地纵深安全加固与三端开源就绪

- **经典单脚本打包兼容宿主鉴权网关（`v1.8.1`）**：服务端按需编译 `/app.bundle.js` 经典 IIFE 包并附加 `no-store` 防缓存头与 `boot-guard.js` 启动守卫，彻底规避宿主网关对 `<script type="module">` 子模块图的拦截。
- **全通道 MCP 台账写保护与实证 `L0 / Swarm` 动静分流（`v1.9.0 ~ v1.9.1`）**：`PreToolUse` 扩展拦截 `apply_edits` / `call_mcp_tool`；修复双层 `Orchestrator` 压缩双计；基于 45h 遥测将 `L0` 常驻总控回调为单模型 `Gemini 4 Neon (XHigh)` 消除短对话切层损耗，保留 `Swarm` 与 `L2/L4` 使用 `Orchestrator (Neon Extra High)`。
- **Antigravity 原生设计系统焕新、质感动效与渲染性能优化、Sidecar 纵深安全加固及三端开源 CI（`v1.10.0`）**：看板信息架构与视觉全面升级为双行磨砂吸顶顶栏（`<= 88px`）+ 单行 6 标签页（`总览 / 执行面 / 路线图 / 队列 / 台账 / 设置`）、双模式初始化引导卡、`IDLE` 静默降噪与 `<details>` 渐进式披露；重构全站 13 处模型字段为带职责分组的原生 `<select>` 并动态同步自定义白名单，引入 GPU `translate3d` 滑动指示条、`stateSig`/`sinceSig` 零载荷静默轮询短路、`dirtyTabs` 惰性渲染与 `setHtmlIfChanged` DOM 记忆化，并支持实装时自动回收旧驻留 Sidecar 进程；升级 `#validOrigin` URL 主机名精确匹配、新增 `#validHost` 防 DNS Rebinding、`Sec-Fetch-Site: cross-site` 拦截及安全响应头；补齐 Windows 个人目录脱敏、无 `agy` 离线严格校验器 `ct-validate-offline.mjs`、中英双语开源文档与三操作系统 GitHub Actions CI。
