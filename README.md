# control-tower

面向 **Google Antigravity** 的通用常驻主交流总控（Chief-of-Staff）Skill，用于在任意工作区建立轻量、常驻、不直接下场写重代码的调度主线，统一负责需求拆分、新建与续接会话裁决、独占资源单锁调度、纯 Gemini 4 与 Orchestrator 分层模型路由、裸 ID 秒登入账与总控换届。

## 目录结构

```text
control-tower/
├── AGENTS.md                        # 本仓库独立工作区开发协作规则
├── README.md                        # 说明与安装验收指南
├── install.sh                       # 同步安装至 ~/.gemini/config/skills/control-tower/
├── scripts/
│   └── selftest.sh                  # 隔离临时目录全自动自检套件
└── skills/
    └── control-tower/
        ├── SKILL.md                 # 全局总控核心规程
        └── references/
            ├── model-routing.md     # 纯 Gemini 4 + Orchestrator 路由与思考档位规范
            └── templates.md         # 通用 SESSION-REGISTRY 骨架、派单卡与换届模板
```

## 安装与预览

默认安装至 `~/.gemini/config/skills/control-tower/`（可通过环境变量 `AGY_CONFIG_DIR` 覆盖目标配置根目录，例如用于隔离测试）：

```bash
# 仅预览安装路径与拷贝清单（不创建或写入任何文件）
./install.sh --dry-run

# 安装到默认配置目录（发布门禁许可后执行）
./install.sh

# 安装到指定隔离目录
AGY_CONFIG_DIR=/tmp/agy-test-config ./install.sh
```

## 沙箱自检

改动源码后请在发布前先运行全隔离自检脚本（全程写入临时沙箱并在退出时自动清理，不触碰真实 `~/.gemini/config/`）：

```bash
bash scripts/selftest.sh
```

## 演进路线（Roadmap）

- **当前阶段（基线稳态）**：保留 `~/.gemini/config/skills/control-tower/` 全局 Skill 目录形式，确保现有多个业务工作区（含对 `~/.gemini/config/skills/control-tower/SKILL.md` 及随附模板的既有引用）零破坏兼容。
- **后续里程碑**：独立推进 Antigravity 原生插件化封装（补充 `plugin.json`、可选生命周期钩子与面板能力），并同步完成现有各业务工作区引用路径迁移与同名 Skill 双重发现防冲突清理。
