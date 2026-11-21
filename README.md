# control-tower

面向 **Google Antigravity** 的通用常驻主交流总控（Chief-of-Staff）原生插件，用于在任意工作区建立轻量、常驻、不直接下场写重代码的调度主线，统一负责需求拆分、新建与续接会话裁决、独占资源单锁调度、纯 Gemini 4 与 Orchestrator 分层模型路由、裸 ID 秒登入账与总控换届。

## 插件核心能力与组件边界

- **总控规程技能（`skills/control-tower/`）**：按需渐进式披露，包含核心调度规程、纯 Gemini 4 + Orchestrator 路由手册与 5 套即用模板。
- **可读写 Aux Pane 总控看板（`sidecars/tower/`）**：零第三方依赖的 Node.js Sidecar，自动跟随当前打开的工作区（并支持切换近期工作区），提供 `SESSION-REGISTRY.md` 可视化读写、独占资源锁一键释放、现役总控与活跃会话尾步/压缩老化实时探查、任务队列增删改及标准模板一键复制；写操作支持 `x-sidecar-token` 鉴权、路径白名单防穿越、SHA256 乐观并发锁与原子落盘。
- **总控定向轻量感知 Hooks（`hooks.json` + `scripts/hook-*.py`）**：仅当当前会话是工作区 `SESSION-REGISTRY.md` 登记的现役总控时激活，普通专职会话静音直通；支持单行裸 ID / 8+ 位前缀自动速查头尾步摘要，以及现役总控发生 `>= 2` 次上下文压缩时的防刷屏换届提醒。
- **刻意零全局污染**：不包含 `rules/AGENTS.md`（不向普通专职会话注入 always-on 规则），不向 `~/.local/bin/` 安装终端命令，独立运行状态默认存于 `~/.local/share/agy-control-tower/`（支持 `AGY_CONTROL_TOWER_DATA_DIR` 覆盖）。

## 目录结构

```text
control-tower/
├── AGENTS.md                        # 本仓库独立工作区开发协作规则（不拷入运行态插件）
├── LICENSE                          # MIT 许可证
├── README.md                        # 说明与安装验收指南
├── plugin.json                      # Antigravity 原生插件清单
├── hooks.json                       # 生命周期钩子配置
├── install.sh                       # 原生插件/兼容模式互斥安装脚本
├── uninstall.sh                     # 身份校验安全卸载脚本
├── assets/
│   └── logo.svg                     # 128x128 矢量图标
├── scripts/
│   ├── ctlib.py                     # 台账与 transcript.jsonl 共享解析库
│   ├── hook-session-start.py        # SessionStart 现役总控简报钩子
│   ├── hook-pre-invocation.py       # PreInvocation 裸 ID 速查与换届提醒钩子
│   ├── check-legacy-refs.sh         # 只读审计工作区残留旧全局路径脚本
│   └── selftest.sh                  # 隔离临时目录 12 项全自动自检套件
├── sidecars/
│   └── tower/                       # Aux Pane 总控看板 Sidecar（零外部依赖）
│       ├── package.json
│       ├── sidecar.json
│       ├── main.mjs
│       ├── index.html
│       ├── styles.css
│       └── app.js
└── skills/
    └── control-tower/
        ├── SKILL.md                 # 全局总控核心规程
        └── references/
            ├── model-routing.md     # 纯 Gemini 4 + Orchestrator 路由与思考档位规范
            └── templates.md         # 通用 SESSION-REGISTRY 骨架、派单卡与换届模板
```

## 安装、版本校验、兼容迁移与卸载

默认安装原生插件至 `~/.gemini/config/plugins/control-tower/`（可通过环境变量 `AGY_CONFIG_DIR` 覆盖目标配置根目录）：

```bash
# 1. 仅预览安装计划与冲突清理动作（不创建或写入任何文件）
./install.sh --dry-run

# 2. 只读查看当前已安装插件与旧全局 Skill 状态
./install.sh --status

# 3. 隔离目录测试安装（安全验证用，不触碰真实配置）
AGY_CONFIG_DIR=/tmp/agy-test-config ./install.sh

# 4. 实装或平滑升级至默认配置目录（需先获得发布门禁许可）
#    若检测到托管中的旧 ~/.gemini/config/skills/control-tower，将在同步插件后自动原子移除，杜绝同名 Skill 双重发现
./install.sh

# 5. 极端场景回退至旧散装全局 Skill 形态（保持单份互斥，自动移除插件目录）
./install.sh --mode legacy-skill

# 6. 安全卸载（默认仅卸载插件目录，保留数据目录与各工作区台账；--include-legacy 可一并移除旧 Skill）
./uninstall.sh --dry-run
./uninstall.sh
```

### 旧路径引用迁移审计

插件化后新路径锚点为 `~/.gemini/config/plugins/control-tower/skills/control-tower/`。可使用只读审计工具盘点任意业务工作区中尚未更新的旧 `skills/control-tower` 引用（自动排除已更新的新路径）：

```bash
bash scripts/check-legacy-refs.sh /path/to/workspace-a /path/to/workspace-b
```

## 沙箱自检与官方插件校验

改动源码后请在发布前先运行全隔离自检套件（全程写入临时沙箱并在退出时自动清理，不触碰真实 `~/.gemini/config/` 与 `~/.local/share/`）：

```bash
bash scripts/selftest.sh
```

若本机已安装 Antigravity CLI（`agy`），自检套件会自动对沙箱安装态执行严格模式校验；也可手动对隔离安装目标执行：

```bash
agy plugin validate --strict --json /tmp/agy-test-config/plugins/control-tower
```

## 演进路线（Roadmap）

- **T1（已完成源码落地，待发布门禁实装）**：完成 Antigravity 原生插件化（`plugin.json`、`hooks.json`、总控定向 Hooks、可读写 Aux Pane 看板、身份归属与版本互斥安装/卸载、只读旧引用审计与 12 项沙箱自检）。
- **后续演进**：获准发布门禁后完成本机实装与业务工作区旧路径引用的批量收口，并视需要扩展只读多工作区聚合视图或公开远端发布。
