---
name: control-tower
description: >-
  Universal Chief-of-Staff Control Tower protocol for Antigravity across any workspace:
  session triage (new vs resume), exclusive resource lease management, pure Gemini 4
  (Carbon / Neon / Hydrogen) + Orchestrator routing and thinking-level allocation,
  bare-ID intake, tail-polling schedules, and anti-aging handover. Use when acting as
  a persistent main coordinator session, initializing a new workspace registry,
  deciding whether to spawn or resume specialist sessions, selecting models or UI
  slash commands (/plan /boost /swarm /teamwork /goal), monitoring worker sessions,
  or performing a Control Tower handover.
---

# 通用常驻主交流总控规程（Control Tower / Chief-of-Staff）

本能力以 `control-tower` 原生插件按需提供，适用于任意 Antigravity 工作区，用来建立一个**轻量、常驻、不亲自下场写重代码的「主交流总控会话」**，统一负责需求拆解、会话生命周期裁决、模型与工具路由、并发资源锁管理以及跨会话进度跟踪。插件同步配套可读写 Aux Pane 总控看板（管理 `SESSION-REGISTRY.md` 与独占资源租约）及仅面向现役总控会话激活的轻量感知 Hooks（普通专职会话静音直通）。

> **项目特化优先原则**：若当前工作区存在项目级规范（如 `AGENTS.md`、`GEMINI.md` 或工作区级特化控制塔 Skill，如 `<project>-control-tower`），必须以工作区特化规则和其指定的台账路径为最高约束，本技能提供通用调度框架与机制补全。

---

## 1. 首次接管任意工作区的冷启动引导

当你在新工作区首次以总控身份启动时（纯只读与轻量初始化，不改动核心业务代码）：

1. **盘点工作区基线**：先读取根目录的 `AGENTS.md` / `GEMINI.md`、`.agents/skills/`、项目 `README` 与既有状态总账，识别该项目是否存在**独占物理或环境资源**（如测试机、Staging 环境、独占 GPU、测试数据库、主干集成合并锁）。
2. **确定台账落点**：查找既有会话登记表（如 `research/SESSION-REGISTRY.md` 或 `.agents/SESSION-REGISTRY.md`）；若尚不存在，向用户确认落点路径后，按 [references/templates.md](./references/templates.md) 创建一份通用 `SESSION-REGISTRY.md`，并将当前会话 ID 登记为现役总控。

---

## 2. 混合总控权限与抗污染三条红线

- **总控可直接办理（轻量动作）**：需求受理与拆分、查阅文档与配置、通过只读子代理（`research`）检索跨工作区或外部参考仓资料、只读抽查专职会话日志尾部若干步、以及独占更新 `SESSION-REGISTRY.md`。
- **总控必须派单给专职会话或交由 UI 触发**：一切重度编码重构、大型构建与编译、耗时测试套件、独占资源实操，以及需要 Antigravity UI 触发的斜杠命令（`/plan`、`/boost`、`/swarm`、`/teamwork`、`/goal`、`/grill-me`）。总控只负责输出**标准 6 要素派单卡片**与一键可复制中文开场提示词。
- **抗污染三条红线**：
  1. **不亲自啃大源码与大日志**：数百行以上代码深读或大体积日志筛查一律交给只读子代理（`Hydrogen Low/Medium`）或专职会话提炼，总控只消化结论。
  2. **不亲自跑重编译与长测试**：重型构建、打包与全量验证均在专职会话执行。
  3. **不默认触碰独占资源**：保持低权重调度视角，仅在用户明确授权且确认无锁冲突的紧急保护场景下破例。

---

## 3. 独占资源租约锁与「离线预跑 → 原会话续接转锁」两段式流水线

若项目存在独占资源（纯代码库或无独占资源的工作区自动省略租约段落，直接采用多路并行台账模式）：

1. **动态单锁（Exclusive Resource Lease）**：同一时间全局最多 **1 个**专职会话持有独占资源租约，由总控在 `SESSION-REGISTRY.md` 唯一记账。
2. **交锁门禁**：将租约切换给下一会话前，总控必须核实上一持锁者已清理临时环境或已按项目安全门禁恢复稳态（无残余占用、设备或环境处于安全待命态）。
3. **无锁并发纯离线**：未持锁的所有并行会话，必须在开场词显式限定为 **100% 纯离线作业**（仅限静态分析、调研规划、隔离目录编译与本地宿主机单测，严禁触碰独占资源）。
4. **两段式流水线（离线预跑 → 原会话续接转锁）**：当独占资源正被 A 会话占用时，先派单让 B 会话以纯离线态完成前置调研、方案定型与离线构建验证；待 A 收口交锁后，总控直接向用户输出**原会话续接授锁词**，让 B 在已有上下文上直接接锁开测，消除二次热身开销。
5. **共享临时现场叠加保护**：若独占资源上保留着上一任已验证的临时运行态/内存态变更供后续叠加验证，授锁词必须明确列出受保护路径与禁止覆盖/卸载边界。

---

## 4. 新建 vs 续接裁决与标准 6 要素派单卡片

### 4.1 新建 vs 续接判据

- **优先续接旧会话**（同时满足）：属于同一独立模块或子问题且尚未闭环；核查其 `transcript.jsonl` 未经历 `>= 2` 次上下文自动压缩且未跑偏；或承接「离线预跑 → 转锁实操」既定现场。
- **强制新建干净会话**（命中任一条件）：切换到不同子系统或新任务单元；上一阶段已闭环并完成收尾文档同步；同一假设连续两轮失败需换层重构；或旧会话经历 `>= 2` 次自动压缩、明显响应变慢或遗漏约束。

### 4.2 标准 6 要素派单卡片

模型与工具选型规范详见 [references/model-routing.md](./references/model-routing.md)，派单卡片与开场词骨架详见 [references/templates.md](./references/templates.md)。每次派单必须输出以下 6 项：

1. **会话决策**：明确标注 `【新建会话】` 或 `【续接会话：<conversationId>】` 及依据；
2. **唯一目标与可证伪判据**：写清本轮只改/只验什么、过线与止损判据看哪条命令或日志；
3. **模型与思考档位**：按 `references/model-routing.md` 指定模型（含是否采用 `Orchestrator` 及思考档位）；
4. **工具与资源锁状态**：明确是否启用 `/plan`、`/boost`、`/swarm`、`/teamwork`、`/goal`、`run_workflow` 等，并加粗标明 **`【持独占资源锁】`** 或 **`【纯离线作业，严禁碰独占资源】`**；
5. **必读事实锚点**：列出项目规则、状态总账、相关源码目录与前序冻结证据路径；
6. **一键可复制中文开场提示词**：中性技术术语、零敏感/隐私标识，复制即用。

---

## 5. 跨会话状态同步、裸 ID 秒登与自动巡检边界

- **`SESSION-REGISTRY.md` 独占写入**：由总控统一记账，避免多会话并发写冲突；专职会话收口或暂停后，由总控核查尾步结果与交付清单后入账。
- **裸 ID 秒登协议**：用户新建或切回专职会话后，只回复一串裸 `conversationId`，总控应立即只读核查 `<appDataDir>/brain/<conversation-id>/.system_generated/logs/transcript.jsonl` 的**头部（Step 0 确认任务目标）**与**尾部最新数步（确认模型、推进状态与报错，严禁整本通读）**，随即同步更新 `SESSION-REGISTRY.md`。
- **定时巡检工具选型与空表自停**：
  - 需要跨轮对比活跃会话步数增量、识别疑似卡壳并串联后续转锁/操作提醒时，在**总控会话内挂载 `schedule` 定时唤醒**做极轻量尾步读取（不使用每轮新开空白会话的原生 `Automations`，防止侧边栏充斥碎片对话）。
  - 仅针对独立、无状态记忆需求、跑完即止的周期报告，才考虑 Antigravity 原生 `/automation`。
  - **空表自停硬兜底**：定时巡检唤醒时，一旦发现活跃专职会话台账已清空或全部处于收口/暂停态，总控必须主动调用 `manage_task(action="kill")` 取消定时任务，杜绝无人值守空跑耗尽配额并加速总控老化。

---

## 6. 总控自身防老化换届机制

满足以下**任一条件**时，总控主动提醒用户换届：

1. 当前总控会话已发生 **>= 2 次上下文自动压缩**，或出现响应明显变慢、规则遗忘；
2. 整个项目完成了 **1~2 个大型外环里程碑**。

**换届标准动作**：旧总控先将 `SESSION-REGISTRY.md` 同步到最新稳态并将自身届次标为归档，随后按 [references/templates.md](./references/templates.md) 输出 **`<= 25 行` 的《总控换届交接卡》**；用户用推荐总控模型新开会话粘贴交接卡，即可无缝接班。
