---
name: control-tower
description: >-
  Universal Chief-of-Staff Control Tower protocol for Antigravity across any workspace:
  session triage (new vs resume), adaptive dispatch (native swarm / agentapi direct spawn /
  manual slash fallback), two-way reporting & permission-aware co-decision, exclusive resource
  lease management, pure Gemini 4 (Carbon / Neon / Hydrogen) + Orchestrator routing, bare-ID
  intake, live monitoring, and flexible handover. Use when acting as a persistent main
  coordinator session, initializing a workspace registry, dispatching specialist sessions,
  monitoring worker progress, or performing a Control Tower handover.
---

# 通用常驻主交流总控规程（Control Tower / Chief-of-Staff）

本能力以 `control-tower` 原生插件按需提供，适用于任意 Antigravity 工作区，用来建立一个**轻量、常驻、不亲自下场写重代码的「主交流总控会话」**，统一负责需求拆解、环境自适应派单、会话生命周期裁决、跨会话双向汇报代决策、并发资源锁管理以及弹性换届。插件同步配套可读写 Aux Pane 总控看板（支持实时监测、受控直派、第 1~5 节台账运维及「插件 / 全局 / 当前工作区」三层隔离设置中心，状态托管于官方 `<appData>/plugin_data/control-tower/`）与四事件轻量感知 Hooks（`SessionStart`、`PreInvocation`、`PreToolUse`、`Stop`）。

> **项目特化优先原则**：若当前工作区存在项目级规范（如 `AGENTS.md`、`GEMINI.md` 或工作区级特化控制塔 Skill），以工作区特化规则为最高约束；若用户在 Control Tower 看板「设置中心」配置了全局或工作区级路由/模板覆盖文件（`SessionStart` 钩子会自动提示生效路径），优先遵循覆盖版本，再按 [references/model-routing.md](./references/model-routing.md) 与 [references/templates.md](./references/templates.md) 执行。

---

## 1. 冷启动接管与台账落点选择

当你在新工作区首次以总控身份启动时（纯只读与轻量初始化，不改动核心业务代码）：

1. **盘点工作区基线与权限配置**：读取根目录 `AGENTS.md` / `GEMINI.md`、`.agents/skills/`、项目 `README` 与既有状态总账，确认项目是否存在**独占物理或环境资源**（如测试机、Staging 环境、独占 GPU、测试数据库、主干集成合并锁）；若无独占资源，建议用户在看板当前工作区设置中关闭「独占资源单锁模式」，自动简化派单锁字段并折叠租约卡片。
2. **三类台账落点**：查找既有会话登记表，或按场景向用户确认落点（也可由用户在看板一键初始化）：
   - **工作区候选路径**：`.agents/SESSION-REGISTRY.md`（默认首选）、`research/SESSION-REGISTRY.md`、`SESSION-REGISTRY.md`；
   - **工作区内自定义相对路径**：在看板「当前工作区设置」指定任意工作区内合法 `.md` 路径；
   - **`PLUGIN_DATA` 零侵入托管台账**（`@plugin_data/SESSION-REGISTRY.md`）：适合不希望在业务 Git 仓新增未跟踪文件的洁癖工作区，由插件数据目录托管，Hooks 与看板无缝读写。
3. **现役总控入驻**：按 [references/templates.md](./references/templates.md) 创建 `SESSION-REGISTRY.md`，并将当前会话 `conversationId` 登记为现役总控。

---

## 2. 总控权限边界与抗污染三条红线

- **总控可直接办理（轻量动作）**：需求受理与拆分、调用 `ask_question` 澄清派遣方案或拍板分叉、只读子代理（`research`）检索资料、只读抽查会话尾步、通过 `agentapi` 派遣或跨会话投递指令、以及维护 `SESSION-REGISTRY.md`。
- **总控必须派单给专职会话执行**：一切重度编码重构、大型构建与编译、耗时测试套件与独占资源实操。
- **抗污染三条红线**：
  1. **不亲自啃大源码与大日志**：数百行以上代码深读或大体积日志筛查一律交给只读子代理（`Hydrogen Low/Medium`）或专职会话提炼，总控只消化结论。
  2. **不亲自跑重编译与长测试**：重型构建、打包与全量验证均在专职会话执行。
  3. **不默认触碰独占资源**：保持低权重调度视角，仅在用户明确授权且无锁冲突时破例。

---

## 3. 独占资源租约锁与「离线预跑 -> 原会话续接转锁」

若工作区开启了独占资源锁（未开启时自动跳过本节限制）：

1. **动态单锁**：同一时间全局最多 **1 个**专职会话持有独占资源租约，由总控在 `SESSION-REGISTRY.md` 唯一记账。
2. **交锁门禁**：将租约切换给下一会话前，核实上一持锁者已清理临时环境并恢复安全待命态。
3. **无锁并发纯离线**：未持锁的所有并行会话，开场约束必须显式限定为 **100% 纯离线作业**。
4. **两段式流水线**：当独占资源正被 A 会话占用时，先派单让 B 会话纯离线完成调研与本地构建；待 A 收口交锁后，向 B 会话发送**模板 B 原会话续接授锁词**（可通过 `agentapi send-message` 直投或由用户发送）。
5. **共享临时现场叠加保护**：若独占资源保留着上一任已验证临时状态，授锁词必须列出受保护路径与禁止覆盖边界。

---

## 4. 环境自适应派遣、新建/续接裁决与自适应派单卡片

### 4.1 新建 vs 续接判据

- **优先续接旧会话**（同时满足）：属于同一独立模块或子问题且尚未闭环；`transcript.jsonl` 压缩次数未达到设置阈值（`workerCompactionThreshold`，默认 `2` 次）且未跑偏；或承接「离线预跑 -> 转锁实操」既定现场。
- **强制新建干净会话**（命中任一条件）：切换到不同子系统或新任务单元；上一阶段已闭环；同一假设连续两轮失败；或旧会话累计压缩次数达到阈值、响应变慢或遗漏约束。

### 4.2 环境自适应派遣机制

每次派发实质任务前，总控结合当前环境可用工具（是否有原生 `swarm` 工具、`agentapi` CLI、以及用户目标复杂度）选择最佳通道。当设置 `askBeforeDispatch` 为开启（默认）且并非显而易见的单步追问时，**默认调用 `ask_question` 向用户推荐最优派遣方式并确认模型**：

1. **多路可独立并行攻关（默认优先原生 `swarm`）**：若当前会话具备原生 `swarm` 工具且任务可拆分为多路无碰撞子任务（如多模块并行重构、实现+独立验收），优先推荐直接调用原生 `swarm` 创建集群并由总控统一监看；看板「监测与派遣」同步实时聚合 `swarm` 成员状态。
2. **独立单会话或持独占锁任务（优先 `agentapi` 受控直派）**：调用 `agentapi new-conversation --model=<合规模型ID> --title="<任务标题>" "<内嵌双向汇报锚点的任务指令>"` 直接拉起桌面独立会话，**立即从返回 JSON 捕获新 `conversationId` 写入 `SESSION-REGISTRY.md` 第 3 节**（或由用户在看板直接一键拉起），实现派遣即入账、看板实时监测。
   - **斜杠模式协同**：若任务需要 Antigravity 内置 `/plan`、`/boost`、`/teamwork`、`/goal` 模式，在确认后可将对应斜杠指令置于直派首条消息前部触发，并**同时在回复中附带一键可复制提示词兜底**（防止部分宿主客户端环境仅对交互输入框响应斜杠菜单）。
3. **手动新建兜底**：若环境不可调用 `agentapi` 或用户明确选择手动开窗，则输出完整自适应派单卡片与一键可复制中文开场提示词，并在用户回传裸 ID 后秒登入账。

### 4.3 自适应派单卡片

每次派单按实际渠道输出紧凑结构化卡片（直派成功则直接附带 `[会话链接](conversation://<id>)`、生效模型与监测态；无独占资源工作区省略锁字段）：

1. **会话决策与通道**：`【原生 Swarm】` / `【直派新建：<conversationId>】` / `【续接：<conversationId>】` / `【手动新建兜底】`；
2. **唯一目标与可证伪判据**：只改/只验什么，过线与止损命令；
3. **模型与思考档位**：按生效设置（[references/model-routing.md](./references/model-routing.md) 或设置中心覆盖配置）指定纯 Gemini 4 / 新版可自定义 Orchestrator 模型——L0 总控与 L2 局部明确改动优先单模型 `Neon (High)` / `Hydrogen (High)` 吃满连续缓存；原生 `swarm` 与 `/teamwork` 子线优先单模型控缓存；中大型跨文件复合改动与 L3/L4 疑难攻坚优先新版 `Orchestrator`（推荐规划层 `Carbon (High)` 或 `Neon (High / Extra High)` + 执行层 `Hydrogen (High / Extra High)`，账号无 `Carbon` 时平滑降档至 `Neon (XHigh)` / `Orchestrator (Neon)`），长会话严禁中途随意切模型，严禁使用默认 `flash`、`Argon` 或 `3.8` 及更早系列；
4. **工具与资源约束**：按 `model-routing.md` 协同矩阵标明工具与斜杠指令（`swarm` / `/plan` / `/boost` / `/teamwork` / `/goal` / `run_workflow`）及资源边界（仅开启独占锁的工作区标注持锁或纯离线）；
5. **双向汇报锚点、执行纪律与必读事实**：直派载荷默认内嵌现役总控 ID 与 `[CT_REPORT:DECISION]` / `[CT_REPORT:DONE]` 上报指令、精确读行再 `edit_file`（连续 2 次不匹配立即重读或改用 `write_file`）及批量只读纪律，并列出工作区规范与关键路径；
6. **状态或可复制开场词**：直派通道直接汇报「已拉起并自动入账，看板实时监测中」；手动/斜杠兜底通道附可复制中文开场提示词。

---

## 5. 跨会话双向汇报、权限感知代决策与原生系统通知

- **`SESSION-REGISTRY.md` 独占写入**：由总控统一维护，或通过 Aux Pane 看板操作。插件 `PreToolUse` 钩子默认开启 `ask` 写保护（可在设置中心切为 `deny` 或 `off`），防止专职会话误改台账；`SessionStart` 钩子会自动向已入账活跃专职会话注入锁边界与禁改提醒。
- **跨会话主动汇报与 `Stop` 钩子兜底**：
  - 专职会话遇到超出授权范围的技术/需求分叉时，应调用 `agentapi send-message "<现役总控ID>" "[CT_REPORT:DECISION] ..."` 唤醒总控；
  - 任务完成时调用 `agentapi send-message "<现役总控ID>" "[CT_REPORT:DONE] ..."` 汇报交付清单；
  - 若专职会话完成跑停时忘记主动发回执，`Stop` 钩子自动检测尾步并执行阶段汇总兜底。
- **三档代决策权限边界（看板可配，默认跟随 Antigravity 宿主权限预设）**：
  - **`autonomous`（高自主，对应宿主 `ALWAYS / TURBO`）**：实现细节、排障策略、按序转锁均由总控自动用 `agentapi send-message` 拍板回复专职会话；仅破坏性操作或推翻原需求才请示用户。
  - **`balanced`（均衡，对应宿主 `AUTO` 默认）**：既定计划内的局部实现与补充验证由总控直接批复；涉及接口/架构分叉、需求范围变动、连续两轮失败止损或异常抢锁时，必须停下交由用户定夺。
  - **`strict`（严格，对应宿主 `STRICT / REVIEW`）**：除纯路径与客观事实查询外，其余分叉决策一律转交用户选择。
- **100% Antigravity 原生系统通知边界**：
  - **严禁调用 `notify-send` 等外部桌面弹窗命令**，通知完全复用 Antigravity 原生系统通知机制；
  - **需用户拍板时**：总控调用 `ask_question` 挂起等待，触发 Antigravity 原生 *Action Required* 系统通知与状态高亮；
  - **单子任务完成默认静默**：除非设置的 `notifyOnSingleTaskDone` 已开启，否则并行阶段中单个子任务完成仅做静默入账，不打断用户；
  - **阶段性里程碑 / 全部会话完成**：总控汇总所有相关会话成果、更新台账并正常结束回复回合，精准触发 Antigravity 原生 *Task Completion* 系统通知。
- **裸 ID 秒登与实时监测**：用户发送裸 ID 或含 ID 口令时，`PreInvocation` 自动注入头尾客观遥测，总控按需刷新台账；无需频繁使用定时任务轮询，`schedule` 仅在确实需要后台周期核对时启用，并在活跃表清空后立刻 `manage_task(action="kill")` 自停。

---

## 6. 弹性防老化换届机制（默认 5 次压缩，非强制）

当满足以下任一条件时（默认压缩阈值 **`5` 次**，可在看板设置中心自由调整）：

1. 当前总控会话累计上下文自动压缩次数达到生效阈值 `controllerCompactionThreshold`（默认 `5` 次），且当前会话未被用户标记为「忽略换届提醒」；
2. 用户主动发起换届，或项目完成重大里程碑阶段。

**换届标准动作**：
1. 总控先调用 `ask_question` 询问用户（也可由用户直接在看板顶部横幅操作）：
   - **选项 A：立即换届** —— 同步 `SESSION-REGISTRY.md` 到最新稳态、生成精炼《总控换届交接卡》（按 [references/templates.md](./references/templates.md)，附带生效自定义设置、代决策档位与活跃 `swarm`/专职会话快照），并征得确认后可直接调用 `agentapi new-conversation` 拉起新总控会话自动接班入账（或提供一键可复制交接卡由用户手动新开）；
   - **选项 B：本会话忽略，不再提醒** —— 记录忽略标记后当前会话不再重复弹出换届提醒，继续安心陪伴工作。
