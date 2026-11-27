# 安全策略与威胁模型 / Security Policy

## 1. 安全设计边界（Security Model）

`control-tower` 作为运行在本地开发机上的 Antigravity 原生插件与 Aux Pane Sidecar，默认采取纵深防御策略：

1. **纯本地环回监听与防 DNS 重绑定（Loopback & Host Guard）**：
   - Sidecar HTTP 服务固定仅绑定 `127.0.0.1` 本地环回地址，绝不监听 `0.0.0.0` 或公网网卡。
   - 请求入口强制校验 `Host` 头主机名必须为本地环回（`127.0.0.1`、`localhost`、`[::1]`），阻断恶意域名通过 DNS Rebinding 读取本地接口。
2. **恒定时间鉴权与严格跨站请求拦截（Token + Origin + Fetch Metadata）**：
   - 当宿主注入 `ANTIGRAVITY_SIDECAR_UI_TOKEN` 时，所有 `/api/*` 与 `/_sidecar/*` 路由均采用 `crypto.timingSafeEqual`（SHA-256 定长摘要）执行恒定时间口令比对。
   - 保护路由强制拦截 `Sec-Fetch-Site: cross-site` 跨站请求，并对 `Origin` 执行 `URL` 主机名精确解析（严拒 `127.0.0.1.evil.example`、`localhost.evil.example` 等前缀伪造及未授权跨站沙箱 `Origin: null`）；全站静态与 JSON 响应统一附带 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` 与 `Cross-Origin-Resource-Policy: same-origin`。
3. **路径穿越与多级符号链接逃逸阻断（Sandbox & Symlink Containment）**：
   - 工作区台账、路线图及 `.agents/handoffs/` 预览文件读写均经过 `assertSafeTargetWithinRoot` 逐级父目录 `lstatSync` + `realpathSync` 校验，阻断 `..` 路径穿越与指向工作区外部的多级软链接逃逸。
4. **`PreToolUse` 跨工具台账写保护与双证换届校验**：
   - `ct-hook.mjs` 同时拦截内置 `write_file` / `edit_file` 与 MCP 批量写文件工具（`apply_edits` / `call_mcp_tool`），防止并行 worker 误改或伪造交接卡篡改 `SESSION-REGISTRY.md`。
5. **飞行黑匣子自动脱敏（PII & Secret Redaction）**：
   - `<PLUGIN_DATA>/logs/ct-flight.jsonl` 在落盘前自动抹除 Linux / macOS / Windows 个人主目录路径、RFC1918 内网 IP、`Bearer` 令牌、URL 敏感查询参数及敏感键值字段，并限制单文件体积与轮转份数。

## 2. 漏洞负责任披露（Reporting a Vulnerability）

如果您发现潜在安全漏洞（例如本地权限绕过、跨站调用、路径穿越或敏感信息泄漏）：

1. **请勿直接在公开 Issue 中披露未修复的利用细节**。
2. 请通过 GitHub 仓库的 **Private Vulnerability Reporting（Security Advisories）** 功能提交私密报告，并附上：
   - 影响版本与运行环境（OS / Antigravity 版本 / Node 版本）
   - 最小化复现步骤或概念验证（PoC，请预先脱敏个人路径与凭据）
   - 预期影响范围与修复建议（可选）
3. 维护者将在核实后尽快完成补丁修复、补充回归单测并发布安全更新说明。
