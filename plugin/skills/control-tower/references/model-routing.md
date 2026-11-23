# 纯 Gemini 4 + Orchestrator 分层模型、工具协同与缓存路由规范

本路由规范依据 Google 官方文档（`ai.google.dev`、`deepmind.google`、`antigravity.google`）及本机 Antigravity 实战遥测数据制定，供全局 `control-tower` 在任意工作区统一调用。

> **看板动态可编辑提示**：本文件为插件内置默认基准。用户可在 Control Tower Aux Pane 看板「设置中心」中针对**全局**或**当前工作区**分别自定义 `L0~L4` 默认模型、白名单策略，或在线覆写本路由规范正文；存在覆盖时 `SessionStart` 钩子会自动向现役总控提示生效路径。

---

## 1. 明确排除项与配额边界

- **禁用模型**：严禁推荐或调度 **`Gemini 4 Argon`**（含 `Orchestrator (Argon)`）以及 **`Gemini 3.8 Flash` 及以前所有旧代模型**。
- **默认不用外部模型**：默认不调度 Anthropic（`Claude`）与 OpenAI（`GPT-OSS`）系列模型（若特定工作区通过项目级 `AGENTS.md` 显式授权，则以工作区规定为准）。
- **配额查验边界**：严禁引用 `magpie-quota` 判断 Antigravity 模型额度；Antigravity 配额与限流状态一律以 Antigravity 客户端面板为准。

---

## 2. Gemini 4 三模型官方能力锚点（均支持 1M 上下文）

| 模型代号 | 官方定位与擅长场景 | API 参考定价（输入 / 输出 per 1M） | 支持思考档位 |
| --- | --- | --- | --- |
| **`Gemini 4 Carbon`** | 顶级旗舰长程深推：最复杂的多步推理、跨层架构设计、疑难根因攻坚、持续突破复杂逻辑死胡同 | `$4.00 / $20.00`（标准价） | `Low` / `Medium`（默认） / `High`（无 `XHigh`） |
| **`Gemini 4 Neon`** | 中高主力工程均衡（衍生自 Carbon）：复杂软件工程、多文件重构调试、**长会话上下文压缩与高工具调用密度场景** | `$3.00 / $15.00` | `Low` / `Medium` / `High`（默认） / `XHigh` |
| **`Gemini 4 Hydrogen`** | 高速轻量执行主力：日常编码、快速迭代验证、批量只读扫描与子代理执行；同时是 **Orchestrator 内置执行引擎** | `$1.50 / $7.50` | `Low` / `Medium` / `High`（默认） / `XHigh` |

---

## 3. 单模型 vs `Orchestrator` 选用边界

本机实测表明：**同模型连续执行缓存命中率可达 `94%+`**，而 `Orchestrator` 规划层与执行层来回切换时缓存命中会骤降至 `~41%`（单步冷输入放大约 10 倍）。因此选型遵循「单模型优先吃满缓存，重型规划/执行分离再用 `Orchestrator`」原则：

- **优先用单模型的 4 种明确场景**：
  1. **L0 常驻总控与高频短交互**：总控以需求拆解、尾步核查、改台账与派单为主，首选单模型 **`Gemini 4 Neon (High)`**（工具报错率极低且零切层冷输入损耗）；极轻量短问答可选 **`Gemini 4 Neon (Medium)`**。
  2. **L1 纯轻量扫描 / 提取 / 文档归档**：直接用单模型 **`Gemini 4 Hydrogen (Low / Medium)`**，避免双层握手开销。
  3. **L2 边界清晰的常规单模块编码与局部修复**：直接用单模型 **`Gemini 4 Neon (High)`** 或 **`Gemini 4 Hydrogen (High)`**，吃满 `91%~97%` 连续缓存并减少执行层编辑失误。
  4. **需全程锁死思考深度或跑含写盘 `self` 的 `run_workflow`**：`Orchestrator` 自动托管思考深度且双模型 `plan_execute` 会触发 `[plan review due]` 阻塞 `self` 写盘 worker；遇到此类场景必须选用单模型（`Carbon (High)` / `Neon (High / XHigh)` / `Hydrogen (High)`）。
- **优先用 `Orchestrator (Carbon / Neon)` 的场景**：
  - 适合「需要强判断架构规划/复核纠偏 + 大量跨多文件动手实现与验证」的中大型复合开发与 L3 跨层排障；规划阶段应一次把目标文件、符号与验证命令写透，尽量减少执行中途反复切回规划层。

---

## 4. 思考档位最佳实践

- **`Low`**：信息提取、日志正则筛选、状态速查、文本格式化（最低延迟与思考 token 开销）。
- **`Medium`**：轻量 L0 总控短交互（`Neon (Medium)`）、常规问答、文档整理与 **`Carbon` 默认档位**。
- **`High`**：`Neon` 与 `Hydrogen` 常规编码主力档位、`Carbon` 顶档；适用于复杂编码、系统调试、工程排错与方案设计。
- **`XHigh`**（仅 `Neon` / `Hydrogen`）：不作为全局默认，**按需直接启用**；遇到高复杂逻辑、深度排障、单模型一镜到底攻坚或账号 `Carbon` 不可用需替补深推时可直接选用。

---

## 5. 通用 L0..L4 任务分层路由表

| 层级 | 典型任务场景 | 首选模型与思考档位 | 备选 / 切换条件 | 工具与斜杠命令策略 |
| --- | --- | --- | --- | --- |
| **L0 常驻总控** | 需求受理、新建/续接裁决、资源锁调度、裸 ID 登记、尾步核查与换届 | 单模型 **`Gemini 4 Neon (High)`** | 极轻量短交互选 **`Neon (Medium)`**；仅超重度多路编排再考虑 **`Orchestrator (Neon)`** | 轻量读写直出；重活按环境自适应派遣（优先原生 `swarm` 或 `agentapi` 直派） |
| **L1 轻量批量与归档** | 多源资料检索扇出、大日志筛查、静态/合规检查、收尾文档归档 | 单模型 **`Hydrogen (Low)`**（纯扫描提取）<br>单模型 **`Hydrogen (Medium)`**（结构化整理） | — | 只读子代理（`research`）或只读 `run_workflow` |
| **L2 常规单模块内环** | 常规功能开发、单一子系统/Bug 排查、独立单测与局部迭代 | 局部明确改动首选单模型 **`Neon (High)`** 或 **`Hydrogen (High)`** | 跨多文件复合架构调整 → **`Orchestrator (Neon)`**；含写盘 `run_workflow` → 单模型 **`Neon (High)`** | 单会话精益迭代；**默认不开 `/boost`** |
| **L3 跨层疑难硬骨头** | 跨驱动/跨进程崩溃、深层并发竞态、复杂内存/图形错误、长期未决架构死坑 | **`Orchestrator (Carbon)`**（规划一次到位、切层少、综合缓存优） | 需单模型一镜到底连贯深推 → **`Carbon (High)`** 或按需 **`Neon (XHigh)`**；账号无 `Carbon` 时临时降档至 **`Neon (XHigh)`** / **`Orchestrator (Neon)`** | 优先 **`/plan`**；单个孤立疑难死坑叠加 **`/boost`** |
| **L4 多路合流与发布** | 多模块结果集成、全量总装打包、独立离线验收与里程碑发布 | 冲突复杂选 **`Orchestrator (Carbon)`**；常规集成选 **`Orchestrator (Neon)`** | 含多路 `self` 写盘编排 → 单模型 **`Neon (High)`**；账号无 `Carbon` 时临时降档至 **`Orchestrator (Neon)`** / **`Neon (High)`** | 多路独立并行优先原生 **`swarm`**；跨多天工程用 **`/teamwork`**；过夜无人值守才用 **`/goal`** |

---

## 6. 单模型 / `Orchestrator` 与协同工具（`swarm` / `/plan` / `/boost` / `/teamwork` / `/goal` / `run_workflow`）搭配矩阵

| 协同模式 | 推荐模型配置 | 核心原因与约束 |
| --- | --- | --- |
| **原生 `swarm`** | 协调者优先单模型 **`Neon (High)`**（重架构用 `Carbon (High)`）；常规编码/验证 worker 优先单模型 **`Hydrogen (High)` / `Neon (High)`**；个别深坑 worker 单独指定 `Carbon (High)` 或按需 `Neon (XHigh)` | 避免 N 个 worker 同时跑 `Orchestrator` 反复切层放大冷输入；遇单个 worker 配额耗尽用 `swarm{action:"model"}` 平滑切换且切后尽量不再来回切回 |
| **`/plan`** | 与 **`Orchestrator (Carbon / Neon)`** 天然契合；中大型单模块改前锁范围亦可用单模型 `Neon (High)` | 要求规划轮一次写透目标文件、精确边界与验收命令，让执行层一气呵成减少切回规划层 |
| **`/boost`** | 仅限孤立 L3 硬骨头或高风险架构攻坚，配 **`Orchestrator (Carbon)`** 或单模型 **`Carbon (High)` / `Neon (XHigh)`** | 常规 L1/L2 严禁滥用 `/boost`；账号无 `Carbon` 时临时降档至 `Neon (XHigh)` |
| **`/teamwork`** | 角色分层配模：架构统筹用 **`Orchestrator (Carbon)`** / **`Carbon (High)`**，独立实现与测试子线默认单模型 **`Neon (High)` / `Hydrogen (High)`** | 防止全员重配顶配双层模型快速消耗配额并保持各子线高缓存 |
| **`/goal`** | 常规长程无人值守优先 **`Orchestrator (Neon)`** 或单模型 **`Neon (High)`**；极高难度跨层系统攻坚才升 **`Orchestrator (Carbon)`** | 兼顾长会话压缩稳健性与连续执行缓存效率 |
| **`run_workflow`** | 含 `self` 写盘编排**必须用单模型**（`Neon (High)` / `Hydrogen (High)`）；纯只读 `research` 扇出用 `Hydrogen (Low / Medium)` | 规避 `Orchestrator` 双模型 `[plan review due]` 钩子阻塞写盘 worker |

---

## 7. 上下文缓存保护三条护栏

1. **长会话严禁中途随意切换模型**：实测单模型中途手动切模型会导致缓存命中率瞬间跌至 `0%`。除非发生配额耗尽、限流、账号切换导致当前模型不可用，或原模型连续两轮无法破局，否则进行中的长会话严禁中途反复更换模型。
2. **`Orchestrator` 规划一次写透，减少来回横跳**：每次从执行层切回规划层均会触发高额冷输入；规划阶段应先做足只读核查，一次性输出清晰的文件路径、函数/符号名与验收命令，避免碎片化多轮往返。
3. **已知独立只读操作同轮批量合并**：将彼此独立的 `read_file`、目录检索与状态查询尽量在同一工具轮次并行发起，减少无谓回合数，最大化连续 `94%+` 缓存命中。

---

## 8. 纯 Gemini 4 内部平滑降级阶梯（含账号无 `Carbon` 临时降档）

遇额度紧张、速率受限，或**用户当前切换的账号 `Carbon` 模型不可用**时，仅在 `Carbon / Neon / Hydrogen` 家族内部按以下阶梯临时平滑降档，**绝不退回 `Argon` 或 `3.8`，也不默认切换非 Gemini 系**：

- **账号 `Carbon` 不可用时的临时替补**：原需 `Orchestrator (Carbon)` / `Carbon (High)` 的 L3/L4、`/boost`、`/teamwork` 统筹任务，临时降档为 **`Gemini 4 Neon (XHigh)`** 或 **`Orchestrator (Neon)`** / **`Gemini 4 Neon (High)`**，待账号切回或 `Carbon` 恢复后再复原。
- **常规配额平滑降级阶梯**：
  `Carbon (High)` / `Neon (XHigh)` → `Orchestrator (Carbon)` / `Neon (High)` → `Orchestrator (Neon)` / `Hydrogen (High)` → `Neon (Medium)` / `Hydrogen (Medium)` → `Hydrogen (Low)`。
