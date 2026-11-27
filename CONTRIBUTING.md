# 贡献指南 / Contributing to Control Tower

欢迎参与 `control-tower` 的改进与演化！为确保插件在 Google Antigravity 各宿主版本及 Linux / macOS / Windows 三端保持高可靠与纯净隔离，请在提交代码前阅读以下规范。

## 1. 核心架构不变量（Architecture Invariants）

1. **纯净 `./plugin/` 运行包边界**：
   - 只有运行态必需资产（`plugin.json`、`hooks.json`、`lib/`、`scripts/ct-hook.mjs`、`sidecars/tower/`、`skills/control-tower/`、`assets/`、`README.md`、`LICENSE`）允许放入 `./plugin/`。
   - 仓根研发文档、自检脚本（`scripts/`）、回放样本与单测（`tests/`）一律留在仓库根目录，严禁打入 `./plugin/`。
2. **零第三方 npm 运行时依赖**：
   - 运行态与测试工具链全部基于 Node.js（`>=20`）内置标准库（`node:fs`、`node:http`、`node:crypto`、`node:test` 等）实现，不引入外部 `node_modules` 依赖。
3. **零全局 Always-On 规则污染**：
   - 插件刻意不包含 `plugin/rules/AGENTS.md`（保持 `components.rules === 0`），绝不向未启用控制塔的普通会话注入全局规则；运行数据统一存放在 `<appData>/plugin_data/control-tower/`。
4. **WebView 异步非阻塞交互**：
   - Sidecar 后端路由严禁调用同步子进程阻塞事件循环；前端严禁调用 `window.confirm` / `window.alert` / `window.prompt`（破坏性操作统一使用内联两段式确认 `confirmInline()`）。

## 2. 本地开发环境初始化

```bash
# 1. 克隆仓库（无需 npm install）
git clone https://github.com/Hi-Jiajun/agy-control-tower.git
cd agy-control-tower

# 2. 启用跨平台本地 pre-commit 合规门禁钩子
npm run setup-hooks

# 3. 运行跨平台核心、事故回放、Skill 契约评测与离线包校验（无需安装 agy CLI）
npm run ci
```

如果本机同时安装了 Chrome / Chromium / Edge 与 Antigravity 官方 `agy` CLI，请运行完整四维门禁：

```bash
npm run gate
```

## 3. 四维自动化验证体系

| 层级 | 命令 | 验证范围 |
| --- | --- | --- |
| **L1 单元与纯逻辑** | `npm test` | 核心共享库、四事件 Hooks、Sidecar 鉴权/并发锁/API、前端纯状态机 `ui-logic.mjs` |
| **L2 事故轨迹回放** | `npm run replay` | 在隔离临时沙箱回放 `tests/replays/*.replay.json` 全部真实历史缺陷样本 |
| **L3 真浏览器 UI 冒烟** | `npm run test:ui` | 基于内置 WebSocket + CDP 驱动无头浏览器检验窄栏/宽栏、亮暗双主题与零控制台报错 |
| **L4 行为契约评测** | `npm run test:eval` | 校验 `SKILL.md`、路由护栏、双证换届闭环、缓存纪律与通知边界等 17 项黄金契约 |
| **离线/官方包校验** | `npm run validate:offline` / `npm run validate` | 校验清单字段白名单、钩子与看板入口完整性，以及 `agy plugin validate --strict ./plugin` |

修复线上新发现的边界缺陷时，推荐同步在 `tests/replays/` 下补充一份脱敏 `*.replay.json` 回归夹具。

## 4. 版本同步与隐私卫生门禁

- **版本单一真源**：升级版本号时，必须同步保持 `package.json`、`plugin/plugin.json`、`plugin/sidecars/tower/package.json`（及看板回退显示）完全一致，并更新 `CHANGELOG.md`。
- **隐私脱敏与字符门禁（由 `scripts/ct-precommit-check.mjs` 自动强制检查）**：
  - 严禁在任何代码、测试、文档或提交记录中写入本地用户主目录绝对路径（请统一使用 `$HOME`、`~` 或测试沙箱 `makeSandbox()`）、静态完整会话 UUID（测试请用 `makeConvId()`）、内网 IP、账号凭据或间隔号字符。
  - 严禁在仓库内编写强制递归删除命令字面量。
