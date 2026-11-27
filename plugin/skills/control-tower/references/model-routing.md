# 纯 Gemini 4 + 新版 Orchestrator 满思考舒适区路由规范

本路由规范依据 Google 官方文档（`ai.google.dev`、`deepmind.google`、`antigravity.google`）及本机 Antigravity `hub-2.35.0+` 实测遥测数据制定，供全局 `control-tower` 在任意工作区统一调用。

> **看板动态可编辑提示**：本文件为插件内置默认基准。用户可在 Control Tower Aux Pane 看板「设置中心」中针对**全局**或**当前工作区**分别自定义 `L0~L4` 默认模型、白名单策略与 `autoLearnMode` 自动学习开关，或在线覆写本路由规范正文；存在覆盖时 `SessionStart` 钩子会自动向现役总控提示生效路径。

---

## 1. 明确排除项与配额边界

- **禁用模型**：严禁推荐或调度 **`Gemini 4 Argon`**（含 `Orchestrator (Argon)` / `gemini-pro-orchestrator-argon`）以及 **`Gemini 3.8 Flash` 及以前所有旧代模型**，严禁使用默认低档快捷词 `flash` / `flash_lite`。
- **默认不用外部模型**：默认不调度 Anthropic（`Claude`）与 OpenAI（`GPT-OSS`）系列模型（若特定工作区通过项目级 `AGENTS.md` 显式授权，则以工作区规定为准）。
- **配额查验边界**：严禁引用 `magpie-quota` 判断 Antigravity 模型额度；Antigravity 配额与限流状态一律以 Antigravity 客户端面板或 `swarm{action:"models"}` 实时返回为准。

---

## 2. Gemini 4 三模型舒适区与满思考档位锚点（均支持 1M 上下文）

本阶段遵循**「全模型思考档位拉至各自最高 + 让每个模型待在自己最适宜的舒适区工作」**原则：

| 模型代号 | 最高思考档位 | 舒适区与官方定位 | API 参考定价（输入 / 输出 per 1M） |
| --- | --- | --- | --- |
| **`Gemini 4 Carbon`** | **`High`**（无 `XHigh`） | 顶级旗舰深推：跨层架构设计、疑难死坑根因攻坚、作为 `Orchestrator (Carbon)` 规划脑 | `$4.00 / $20.00` |
| **`Gemini 4 Neon`** | **`XHigh`**（客户端显示 `Extra High`） | 旗舰工程均衡：L0 常驻总控主力单模型、复杂多文件重构、长会话高压缩稳健性、作为 `Orchestrator (Neon Extra High)` 主力规划脑 | `$3.00 / $15.00` |
| **`Gemini 4 Hydrogen`** | **`XHigh`**（客户端显示 `Extra High`） | 极速高精度执行主力：新版 `Orchestrator` 执行引擎、L1 轻量只读扫描/归档、Swarm 只读与轻验 worker | `$1.50 / $7.50` |

---

## 3. 新版可自定义 `Orchestrator` 主力定位与单模型边界

### 3.1 新版 `Orchestrator` 双层自定义机制与满思考默认配置
Antigravity 客户端在「设置 -> 模型与用量 -> **Orchestrator 设置**」中支持分别自定义**规划模型**与**执行模型**（均拉至最高思考档 `Extra High` / `High`），并在规划完成后通过 `exit_plan_mode` 切换至高速执行层，显著改善纯单模型 `Neon` / `Carbon` 偏慢的体感：
- **推荐客户端全局配置**：
  - **规划模型**：日常主力 **`Gemini 4 Neon (Extra High)`**（重度跨层架构或疑难攻坚在单会话菜单选 **`Gemini 4 Carbon (High)`**）；
  - **执行模型**：统一拉满 **`Gemini 4 Hydrogen (Extra High)`**（高速执行且显著降低 `edit_file` 失配率）。
- **CLI / `agentapi` 与原生 `swarm` 官方 ID 映射**：
  - `Orchestrator (Neon Extra High)` / `Orchestrator (Neon)` -> **`gemini-pro-orchestrator-neon`**
  - `Orchestrator (Carbon)` -> **`gemini-pro-orchestrator`**
  - 单模型满思考 ID：`gemini-4-carbon-high`、`gemini-4-neon-xhigh`、`gemini-4-hydrogen-xhigh`（自动兼容宿主 `gemini-4-hydrogen-tiered-high/xhigh` 子代理标识）。

### 3.2 舒适区边界（何时用 `Orchestrator`，何时留单模型）
- **主力使用新版 `Orchestrator` 的核心舒适区（默认覆盖 `L2 / L3 / L4` 及编码/验证 Swarm worker）**：
  1. **`L2` 常规功能开发、`L3` 跨层疑难攻坚、`L4` 多路合流与发布**：规划层一次写透目标文件路径、符号与验收命令，由 `Hydrogen (Extra High)` 一气呵成完成多步编辑与测试验证；单轮含 15+ 步自主编码/验证的独立长链开发会话同样适用。
  2. **原生 `swarm` 编码与复合验证 worker**：经实测原生 `swarm` 在 `gemini-pro-orchestrator-neon` 下稳定零切层直跑（缓存命中 94%+、单工具冷输入最低且编辑失配率 < 1%），总控派单时显式指定对应模型即可兼顾深度与并发速度；疑难攻坚/架构审查 worker 选用 `gemini-pro-orchestrator`。
- **坚持单模型更舒适的 4 类明确边界**：
  1. **`L0` 常驻主交流总控**：短对话多轮互动（问答、拍板、轻量查态、改台账、派单）使用双层 `Orchestrator` 易在规划与执行切层间额外消耗 40%~63% 冷输入并引入 `[plan review]` 往返；默认回用纯单模型 **`Gemini 4 Neon (XHigh)`**（`gemini-4-neon-xhigh`），稳健、零切层损耗且缓存命中最高。
  2. **`L1` 纯只读扫描 / 日志检索 / 批量归档**：直接用单模型 **`Gemini 4 Hydrogen (XHigh)`**，一步直出免双层握手开销。
  3. **含写盘 `self` 的 `run_workflow` 动态流水线**：双模型 `plan_execute` 可能触发 `[plan review due]` 阻塞无交互写盘 worker，必须选用单模型 **`Gemini 4 Neon (XHigh)`** 或 **`Gemini 4 Hydrogen (XHigh)`**。
  4. **极少数不宜中途切段的连续超深推死坑**：可按需切单模型 **`Gemini 4 Carbon (High)`**（或 `Neon (XHigh)`）一镜到底。

---

## 4. 思考档位纪律（默认全最高）

- **默认拉满各自最高思考档**：`Carbon -> High`、`Neon -> XHigh (Extra High)`、`Hydrogen -> XHigh (Extra High)`，`Orchestrator` 的规划层与执行层同样保持对应最高思考档。
- **`High / Medium / Low` 仅作为降级或极轻机械任务备选**：日常派单不再默认降档牺牲思考精度；仅在遭遇限流、额度紧张或大批量纯正则机械提取时才按第 8 节阶梯下调。

---

## 5. 通用 L0..L4 任务分层路由表

| 层级 | 典型任务场景 | 首选模型（默认最高思考） | 显式 CLI / Swarm ID | 备选 / 例外条件 | 工具与斜杠策略 |
| --- | --- | --- | --- | --- | --- |
| **L0 常驻总控** | 需求受理、新建/续接裁决、资源锁调度、台账维护、裸 ID 速查与换届 | 单模型 **`Gemini 4 Neon (XHigh)`** | `gemini-4-neon-xhigh` | 顶层单窗口长链大开发（单轮 15+ 步）可选 **`Orchestrator (Neon Extra High)`** | 隐藏面优先派遣（原生 `swarm` / `invoke_subagent` / `run_workflow`） |
| **L1 轻量扫描与归档** | 多源资料检索扇出、大日志筛查、静态/合规审计、收尾归档 | 单模型 **`Gemini 4 Hydrogen (XHigh)`** | `gemini-4-hydrogen-xhigh` | 纯机械筛选限流时可降 `Hydrogen (High)` | 只读子代理（`research`）或只读 `run_workflow` |
| **L2 常规功能开发** | 常规多文件功能实现、子系统 Bug 排查、单测补齐与局部重构 | **`Orchestrator (Neon Extra High)`** | `gemini-pro-orchestrator-neon` | 含写盘 `run_workflow` 必须用单模型 **`Neon (XHigh)`** / **`Hydrogen (XHigh)`** | 优先原生 `swarm`；默认不开 `/boost` |
| **L3 跨层疑难硬骨头** | 跨驱动/跨进程崩溃、深层并发竞态、复杂内存/图形错误、长期架构死坑 | **`Orchestrator (Carbon)`** | `gemini-pro-orchestrator` | 极难一镜到底深推用单模型 **`Carbon (High)`**；账号无 `Carbon` 临时替补 **`Orchestrator (Neon Extra High)`** / **`Neon (XHigh)`** | 优先 **`/plan`**；孤立疑难死坑叠加 **`/boost`** |
| **L4 多路合流与发布** | 多模块集成、全量打包构建、独立离线验收与里程碑发布 | **`Orchestrator (Neon Extra High)`** | `gemini-pro-orchestrator-neon` | 复杂跨仓冲突升 **`Orchestrator (Carbon)`**；含写盘 `run_workflow` 用单模型 **`Neon (XHigh)`** | 多路并行用原生 **`swarm`**；跨多天工程用 **`/teamwork`**；过夜无人值守用 **`/goal`** |

---

## 6. 原生 `swarm` 显式配模与协同工具搭配矩阵

| 协同模式 | 推荐模型配置（必须显式指定 `model`） | 核心原因与约束 |
| --- | --- | --- |
| **原生 `swarm`** | **总控调用 `swarm{action:"add"}` 时必须显式传入 `model` 参数**：<br>- 常规编码 / 复合验证 worker -> **`gemini-pro-orchestrator-neon`**（`Orchestrator (Neon)`）<br>- 跨层架构攻坚 / 疑难根因 worker -> **`gemini-pro-orchestrator`**（`Orchestrator (Carbon)`）<br>- 纯只读调研 / 批量检索 / 轻量核验 worker -> **`gemini-4-hydrogen-xhigh`**（单模型高速直出） | 原生 `swarm` 已实测支持 `gemini-pro-orchestrator-neon` 与 `gemini-pro-orchestrator`；显式配模让每个 worker 留在对应舒适区，避免全部混用同一重型单模型拖慢速度。遇单个 worker 配额耗尽用 `swarm{action:"model"}` 平滑切换且切后不来回横跳 |
| **`/plan`** | 与 **`Orchestrator (Neon Extra High)`** / **`Orchestrator (Carbon)`** 天然契合 | 规划轮一次做足只读核查并写透精确文件、符号与验收命令，让执行层一气呵成减少切回规划层 |
| **`/boost`** | 仅限孤立 L3 硬骨头或高风险架构攻坚，配 **`Orchestrator (Carbon)`** 或单模型 **`Carbon (High)`** | 常规 L1/L2 严禁滥用 `/boost`；账号无 `Carbon` 时临时替补 `Orchestrator (Neon Extra High)` / `Neon (XHigh)` |
| **`/teamwork`** | 架构统筹用 **`Orchestrator (Carbon)`**，各并行实现与测试子线用 **`Orchestrator (Neon Extra High)`**，纯只读检索子线用 **`Hydrogen (XHigh)`** | 兼顾规划深度、执行速度与配额效率 |
| **`/goal`** | 常规长程无人值守首选 **`Orchestrator (Neon Extra High)`**；极高难度系统攻坚升 **`Orchestrator (Carbon)`** | 阶段性规划复核 + 高速执行闭环 |
| **`run_workflow`** | 含 `self` 写盘编排**必须用单模型**（`gemini-4-neon-xhigh` / `gemini-4-hydrogen-xhigh`）；纯只读 `research` 扇出用 **`gemini-4-hydrogen-xhigh`** | 规避 `Orchestrator` 双模型 `[plan review due]` 钩子阻塞无交互写盘 worker |

---

## 7. 上下文缓存保护三条护栏与 `ct-miner` 实测复盘

1. **长会话严禁中途随意切换模型**：实测单模型中途手动切模型会导致缓存命中率瞬间跌至 `0%`。除非发生配额耗尽、限流、账号切换导致当前模型不可用，或原模型连续两轮无法破局，否则进行中的长会话严禁中途反复更换模型。
2. **`Orchestrator` 规划一次写透，把切层次数压到最低**：每次规划层与执行层切换均会触发一次全上下文冷输入；因此进入 `Orchestrator` 规划阶段时应先并行做足只读核查，一次性输出完整精准的执行清单与验收命令，让 `Hydrogen (Extra High)` 在一次执行段内跑完闭环，切忌碎片化多轮来回横跳。
3. **已知独立只读操作同轮批量合并 + 定期 `npm run mine` 横向对比**：同轮并行批量读取减少无谓回合数；定期执行 `npm run mine` 查看「新版 `Orchestrator` vs 纯单模型」实测对比表，按真实缓存、冷输入与编辑失配数据持续迭代路由。

---

## 8. 纯 Gemini 4 内部平滑降级阶梯（含账号无 `Carbon` 临时替补）

遇额度紧张、速率受限，或**用户当前切换的账号 `Carbon` 模型不可用**时，仅在 `Carbon / Neon / Hydrogen` 家族内部按以下阶梯临时平滑降档，**绝不退回 `Argon` 或 `3.8`，也不默认切换非 Gemini 系**：

- **账号 `Carbon` 不可用时的临时替补**：原需 `Orchestrator (Carbon)` / `Carbon (High)` 的 L3/L4、`/boost`、`/teamwork` 统筹任务，临时替补为 **`Orchestrator (Neon Extra High)`** 或单模型 **`Gemini 4 Neon (XHigh)`**，待账号切回或 `Carbon` 恢复后再复原。
- **常规配额平滑降级阶梯**：
  `Orchestrator (Carbon)` / `Carbon (High)` -> `Orchestrator (Neon Extra High)` / `Neon (XHigh)` -> `Hydrogen (XHigh)` -> `Neon (High)` / `Hydrogen (High)` -> `Neon (Medium)` / `Hydrogen (Medium)` -> `Hydrogen (Low)`。
