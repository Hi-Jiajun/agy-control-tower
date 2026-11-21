# Changelog

All notable changes to `control-tower` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-11-21

### Added
- 采用官方标准 `./plugin/` 子目录纯净包布局，直接支持 `agy plugin validate --strict ./plugin` 零警告及 `agy plugin install ./plugin` 原生安装与升级。
- 在 `plugin/lib/` 收敛为纯零依赖 Node.js ESM 共享库（`paths.mjs`、`registry.mjs`、`transcript.mjs`），彻底消除 Python Hooks 与 Node Sidecar 的双语言解析重复。
- 支持多宿主 `appData/brain`（`antigravity`、`antigravity-ide`、`antigravity-cli`）及官方 `<appData>/plugin_data/control-tower` 状态存储。
- `inspectTranscript()` 新增头 `32KB` + 尾 `64KB` 分片读取及字节偏移增量扫描缓存（含 `state.json` 200 条 LRU 裁剪），解决大体积 `transcript.jsonl` 全量读盘性能瓶颈。
- `PreInvocation` 钩子扩展短口令多十六进制会话 ID 识别（忽略代码块与非命中 SHA 哈希）。
- Sidecar 总控看板补齐第 1~5 节全章节结构化写表操作（含现役总控登记、裸 ID 探针一键入账活跃表、活跃会话一键归档至里程碑）与 `/_sidecar/send-message` 投递现役总控联动，并显式阻断默认 `flash` 的 `/_sidecar/new-conversation`。
- 仓根引入零依赖 `node:test` 分层单测与沙箱 E2E 套件（`tests/*.test.mjs`）、`scripts/cleanup-legacy-skill.sh` 与本地 `scripts/git-hooks/pre-commit` 合规门禁。

### Changed
- 将 `PreInvocation` / `SessionStart` 钩子入口收敛至 `plugin/scripts/ct-hook.mjs`（`hooks.json` 使用 `node ./scripts/ct-hook.mjs`）。
- 加固 Sidecar 全量 `/api/*` 与 `/_sidecar/*`（含 `GET` 路由）的 `x-sidecar-token` 鉴权，并剥离 `GET /api/snapshot` 隐式写盘副作用（改为显式 `POST /api/workspace/select`）。
- 更新 `plugin/skills/control-tower/references/templates.md` 去除硬编码 `~/.gemini/config` 路径，改为兼容原生插件安装位置与同目录相对引用。

### Removed
- 移除根目录手写文件拷贝版 `install.sh` / `uninstall.sh` 与旧 Python 钩子脚本（`scripts/ctlib.py`、`scripts/hook-*.py`），改由 Antigravity 官方 `agy plugin` 生命周期接管。

## [1.0.0] - 2026-11-21

### Added
- 完成 `control-tower` 初始原生插件化改造（`plugin.json`、`hooks.json`、总控定向感知 Hooks、可读写 Aux Pane Sidecar 看板与 12 项隔离沙箱自检）。
