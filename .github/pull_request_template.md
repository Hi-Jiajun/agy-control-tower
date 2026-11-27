## 变更摘要 / Summary

<!-- 简述本次 PR 解决的问题、改动范围及设计取舍 -->

## 自检清单 / Checklist

- [ ] 仅修改源码仓文件，未向 `./plugin/` 混入仓根研发文档、测试或第三方依赖（保持 `components.rules === 0` 与零依赖 ESM）
- [ ] 如涉及版本号变更，已同步对齐 `package.json`、`plugin/plugin.json`、`plugin/sidecars/tower/package.json` 及 `CHANGELOG.md`
- [ ] 已在本地通过 `npm run ci`（若本机装有 Chrome 与 `agy` CLI，已完整运行 `npm run gate`）
- [ ] 不含任何个人本地绝对路径、真实完整会话 ID、内网 IP、凭据或间隔号字符
