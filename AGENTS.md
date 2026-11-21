# control-tower 独立工作区协作规则

本仓库为 Google Antigravity 通用总控技能 `control-tower` 的独立开发源码仓，支持作为独立工作区直接打开维护。所有通用约定与公开仓库安全基线一致：全程中文技术交流、先核查再改写、严禁 `rm -rf`、严禁将本地私有信息写入仓库。

## 仓库范围与目录结构

| 路径 | 职责说明 |
| --- | --- |
| `skills/control-tower/SKILL.md` | 全局常驻主交流总控核心规程（入口与调度纪律） |
| `skills/control-tower/references/model-routing.md` | 纯 Gemini 4（`Carbon` / `Neon` / `Hydrogen`）与 `Orchestrator` 分层路由规范 |
| `skills/control-tower/references/templates.md` | 通用 `SESSION-REGISTRY.md` 骨架、引导提示词、标准派单卡与换届交接卡模板 |
| `install.sh` | 显式发布脚本（支持 `--dry-run` 与 `AGY_CONFIG_DIR` 覆盖，默认安装至 `~/.gemini/config/skills/control-tower/`） |
| `scripts/selftest.sh` | 隔离临时沙箱自检脚本（校验结构、Frontmatter、相对链接、干跑、实装哈希与隐私合规） |

## 开发态与运行态严格隔离（核心红线）

1. **只在源码仓修改，严禁直接编辑运行态**：日常开发只改动本仓库内文件；严禁直接编辑 `~/.gemini/config/skills/control-tower/` 下的已安装文件。
2. **先过沙箱自检**：任何修改后必须运行 `bash scripts/selftest.sh`，确认全部检查 `PASS` 且退出码为 `0`。
3. **发布门禁控制**：未经用户明确授权获取实装发布许可前，严禁执行不带隔离目录的 `./install.sh` 覆写真实 `~/.gemini/config/`。

## 兼容边界与防冲突约束

- **保持当前全局 Skill 路径兼容**：在专职原生插件化改造里程碑正式实施前，`install.sh` 必须保持将产物同步至 `$AGY_CONFIG_DIR/skills/control-tower/`，以确保多个已有工作区对 `~/.gemini/config/skills/control-tower/` 的引用零中断。
- **严禁双份并存引发双重发现**：不得在未清理 `~/.gemini/config/skills/control-tower/` 的情况下同时向 `~/.gemini/config/plugins/control-tower/skills/control-tower/` 安装同名 Skill。

## 隐私规范与 Git 纪律

1. **公私分离**：`.agents/` 已在 `.gitignore` 中排除；禁止在本仓库提交本地绝对路径、会话 ID（UUID）、内网 IP、账号凭据或任意个人运行台账。
2. **模型路由红线**：仅选用纯 Gemini 4（`Carbon` / `Neon` / `Hydrogen`）与 `Orchestrator`；禁用 `Argon` 与 `Gemini 3.8` 及更早系列模型；不以 `magpie-quota` 判断 Antigravity 配额。
3. **仅本地 Git 提交**：日常只做本地提交；未经用户明确要求，不得添加远端仓库或执行 `git push`。
