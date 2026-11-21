# 纯 Gemini 4 + Orchestrator 分层模型与思考档位路由规范

本路由规范依据 Google 官方文档（`ai.google.dev`、`deepmind.google`、`antigravity.google`）及 Antigravity 会话模式实测边界制定，供全局 `control-tower` 在任意工作区统一调用。

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

## 3. `Orchestrator` vs 单模型选用边界

- **优先用 `Orchestrator (Neon / Carbon)`**：适合「需要强判断规划/复核纠偏 + 大量动手编辑/跑命令」的复合开发与排障任务；系统自动在规划层与 `Hydrogen` 高速执行层间来回交接，兼具质量与配额效率。
- **必须改用单模型的 3 种明确边界**：
  1. **纯轻量扫描 / 提取 / 文档归档整理**：直接用单模型 **`Hydrogen (Low / Medium)`**，避免双层握手额外回合与开销。
  2. **需要全程手动锁死顶格思考深度**：官方说明 `Orchestrator` 自动托管思考深度，不支持手动固定 Effort；遇到必须全程顶格深推不可降档的场景时，改用单模型 **`Carbon (High)`** 或 **`Neon (XHigh)`**。
  3. **会话内需执行含写盘 `type_name="self"` 的完整 `run_workflow`**：2026-11-20 实测表明，双模型 `plan_execute` 执行轮会触发 `[plan review due]` 钩子导致 `self` 写盘 worker 受阻（仅 `type_name="research"` 只读扇出不受影响）。要在单会话内直跑完整读写工作流，选用单模型 `Neon (High)` 或 `Hydrogen (High)`。
  4. **L0 总控轻量短交互偏好**：长跑实测亦已印证，当 L0 总控主要处理短交互裁决、尾步抽查与轻量改登记表时，单模型 **`Gemini 4 Neon (High)`** 与 **`Orchestrator (Neon)`** 均表现极稳健且可零错误长驻运行，可按延迟手感二选一。

---

## 4. 思考档位官方最佳实践

- **`Low`**：信息提取、日志正则筛选、状态速查、文本格式化（最低延迟与思考 token 开销）。
- **`Medium`**：常规问答、台账同步、常规代码审查，以及 **`Carbon` 默认档位**。
- **`High`**：`Hydrogen` 与 `Neon` 默认档位、`Carbon` 顶档；适用于复杂编码、系统调试、工程排错与方案设计。
- **`XHigh`**（仅 `Neon` / `Hydrogen`）：**严禁作为全局默认**；仅在 `High` 验证未通过或遭遇跨多层极端疑难逻辑死坑时条件开启。

---

## 5. 通用 L0..L4 任务分层路由表

| 层级 | 典型任务场景 | 首选模型与思考档位 | 备选 / 切换条件 | 工具与斜杠命令策略 |
| --- | --- | --- | --- | --- |
| **L0 常驻总控** | 需求受理、新建/续接裁决、资源锁调度、裸 ID 登记、尾步巡检与换届 | **`Orchestrator (Neon)`**（利用 `Neon` 长会话压缩强项）<br>或单模型 **`Gemini 4 Neon (High)`**（短交互更利落，已在实战长跑印证零错误） | 若偏好更轻量单模型回答，可选 **`Neon (Medium)`** | 轻量读写与 `schedule` 巡检直出；重活一律发 6 要素派单卡 |
| **L1 轻量批量与归档** | 多源资料检索扇出、大日志筛查、静态/合规检查、收尾文档归档、`agy -p` 探针 | **`Hydrogen (Low)`**（纯提取/扫描）<br>**`Hydrogen (Medium)`**（文档整理/结构化摘要） | — | 只读子代理（`research`）或只读 `run_workflow` |
| **L2 常规单模块内环** | 常规功能开发、单一子系统/Bug 排查、独立单测与局部迭代 | **`Orchestrator (Neon)`**（`Neon` 定判据 + `Hydrogen` 高速实现与测验） | 会话内需跑完整读写 `run_workflow` → 单模型 **`Neon (High)`**；纯小改 → **`Hydrogen (High)`** | 单会话精益迭代；**默认不开 `/swarm`、`/boost`** |
| **L3 跨层疑难硬骨头** | 跨驱动/跨进程崩溃、深层并发竞态、复杂内存/图形错误、长期未决架构死坑 | **`Orchestrator (Carbon)`**（`Carbon` 顶配深推纠偏 + `Hydrogen` 快速验证） | 需全程极限深推不切分 → 单模型 **`Carbon (High)`**；`High` 连续受阻再条件触发 **`Neon (XHigh)`** | 优先 **`/plan`**；单个孤立疑难死坑叠加 **`/boost`** |
| **L4 多路合流与发布** | 多模块结果集成、全量总装打包、独立离线验收与里程碑发布 | **`Orchestrator (Neon)`**（跨模块冲突多时升 **`Orchestrator (Carbon)`**） | 含多路 `self` 写盘编排 → 单模型 **`Neon (High)`** | 固定验收走离线门禁；仅 ≥3 路独立重编才开短周期 **`/swarm`**（完事即 `kill`）；跨多天工程用 **`/teamwork`**；过夜无人值守才用 **`/goal`** |

---

## 6. 纯 Gemini 4 内部平滑降级阶梯

遇额度紧张或速率受限时，仅在 `Carbon / Neon / Hydrogen` 家族内部按以下阶梯降级，**绝不退回 `Argon` 或 `3.8`，也不默认切换非 Gemini 系**：

`Carbon (High)` / `Neon (XHigh)` → `Orchestrator (Carbon)` / `Neon (High)` → `Orchestrator (Neon)` / `Hydrogen (High)` → `Hydrogen (Medium)` → `Hydrogen (Low)`。
