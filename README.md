# control-tower

面向 **Google Antigravity** 的通用常驻主交流总控（Chief-of-Staff）原生插件，用于在任意工作区建立轻量、常驻、不亲自下场写重代码的调度主线，统一负责需求拆分、新建与续接会话裁决、独占资源单锁调度、纯 Gemini 4 与 Orchestrator 分层模型路由、裸 ID 秒登入账与总控换届。

## 插件核心能力与架构边界

- **标准 `./plugin/` 纯净包布局**：运行态全部资产收拢在 [plugin/](plugin/) 子目录，仓储研发文档与测试放在仓根，直接通过 `agy plugin validate --strict ./plugin` 零警告校验，并支持原生 `agy plugin install ./plugin` 安装与卸载。
- **纯零依赖 Node.js ESM 单栈**：`plugin/lib/`（`paths.mjs`、`registry.mjs`、`settings.mjs`、`transcript.mjs`）同时驱动 Hooks 与 Sidecar，彻底消除双语言重复解析；`transcript.jsonl` 采用头 `32KB` + 尾 `64KB` 分片及字节偏移增量扫描缓存。
- **可读写 Aux Pane 总控看板（`plugin/sidecars/tower/`）**：支持实时无感监测（同时聚合独立专职会话与原生 `swarm` 集群）、按路由护栏校验的受控直派新会话（`/api/dispatch/create`）、`SESSION-REGISTRY.md` 第 1~5 节全结构化操作、以及严格物理隔离的「插件 / 全局 / 当前工作区」三层设置中心（含 `PLUGIN_DATA` 零侵入托管台账模式与文档在线覆盖）。
- **四事件定向感知 Hooks（`plugin/hooks.json` + `plugin/scripts/ct-hook.mjs`）**：覆盖 `SessionStart`（现役总控与已入账专职会话双角色注入）、`PreInvocation`（裸/多 ID 及汇报速查、弹性换届提醒）、`PreToolUse`（非总控改写台账防呆门禁）、与 `Stop`（专职会话漏报阶段收口自动回执兜底）；无关会话静音直通。
- **官方数据目录隔离**：刻意不包含 `rules/AGENTS.md`（不向无关会话注入 always-on 全局规则）；运行状态与三层设置统一存于官方 `<appData>/plugin_data/control-tower/`（支持 `AGY_CONTROL_TOWER_DATA_DIR` / `PLUGIN_DATA` 覆盖）。

## 目录结构

```text
control-tower/
├── AGENTS.md                        # 仓根独立工作区开发协作规则（不打入 ./plugin/ 运行包）
├── CHANGELOG.md                     # 版本变更记录（Keep a Changelog）
├── LICENSE                          # MIT 许可证
├── README.md                        # 本仓库说明与官方安装/研发规范指南
├── package.json                     # 仓根私有工程清单（npm test / selftest / validate / setup-hooks）
├── plugin/                          # Antigravity 官方标准原生插件纯净包
│   ├── plugin.json                  # 唯一版本真源（SemVer）
│   ├── hooks.json                   # 四事件钩子 -> node ./scripts/ct-hook.mjs
│   ├── README.md
│   ├── LICENSE
│   ├── assets/logo.svg
│   ├── lib/{paths,registry,settings,transcript}.mjs
│   ├── scripts/ct-hook.mjs
│   ├── sidecars/tower/
│   └── skills/control-tower/
├── scripts/
│   ├── check-legacy-refs.sh         # 只读审计工作区残留旧全局路径脚本
│   ├── cleanup-legacy-skill.sh      # 安全清理旧散装 ~/.gemini/config/skills/control-tower
│   ├── git-hooks/pre-commit         # 提交前自动脱敏、版本一致性与严格校验门禁
│   └── selftest.sh                  # 兼容自检入口
└── tests/                           # 零外部依赖 node:test 分层单测与沙箱 E2E 套件
```

## 官方安装、升级、旧版清理与卸载

本插件严格遵循 Antigravity 官方 `agy plugin` 工具链安装与管理。

```bash
# 1. 官方严格模式校验纯净插件包
agy plugin validate --strict ./plugin

# 2. 若本机曾安装旧版散装全局 Skill（~/.gemini/config/skills/control-tower），先只读核查并安全清理防双重发现
bash scripts/cleanup-legacy-skill.sh --status
bash scripts/cleanup-legacy-skill.sh --dry-run
bash scripts/cleanup-legacy-skill.sh

# 3. 使用官方 CLI 安装或更新插件（需在符合工作区发布门禁许可后执行）
agy plugin install ./plugin

# 4. 核验安装状态
agy plugin list --json

# 5. 卸载插件
agy plugin uninstall control-tower
```

### 旧路径引用迁移审计

若历史工作区文档仍显式引用旧全局 Skill 路径 `skills/control-tower`，可使用只读审计工具扫描：

```bash
bash scripts/check-legacy-refs.sh /path/to/workspace-a /path/to/workspace-b
```

## 规范化研发与质量门禁

```bash
# 启用本地提交前脱敏、零间隔号、版本一致性与 agy strict 校验门禁
npm run setup-hooks

# 运行模块化 node:test 全部测试（全沙箱隔离，零污染本机真实配置）
npm test

# 或运行兼容自检入口
bash scripts/selftest.sh
```
