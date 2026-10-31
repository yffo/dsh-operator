# 兼容性矩阵

> 更新于 v0.16.0（2026-11-01）。这里只记录「验证过」的结论；没机器/没测的组合一律标未验证，不做猜测。

## DSH / 宿主

| DSH 版本 | 状态 | 说明 |
| --- | --- | --- |
| 0.2.1-rc.2 ~ 0.2.1-rc.5 | ✅ 已验证 | 开发与真机验收主环境；0.2.1-rc.5 下全工具（含客户端卡片）运行正常 |
| < 0.2.1-rc.2 | ⚠️ 未验证 | 依赖 `@deepseek-ai/*` 的 slots/toolview 契约可能不同，不保证 |
| 更新版本 | ⚠️ 未验证 | 升级后先跑 `npm run doctor`；客户端卡片依赖 `tool.call.toolview` slot，若契约变化会整体退化为原生卡片（不影响工具本身） |

## 平台

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| macOS arm64 | ✅ 已验证 | 主力开发与验收环境（AX 助手为 lipo 通用二进制） |
| macOS x86_64 | ✅ 已验证（二进制层面） | helper 含 x86_64 slice，`doctor` 校验双架构；Intel 真机未跑过 GUI 验收 |
| Windows / Linux | ⚠️ 未验证 | 扩展工具在非 darwin 直接跳过并打印警告；截图缩放不调用 `sips`；没有真机验收 |

## 运行时

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20 | CI 在 20 / 22 双版本跑全量测试；CDP 浏览器通道需要 ≥ 22（全局 WebSocket），低版本自动跳过 |
| 屏幕录制权限 | 必需 | 首次截图会弹系统授权（归属 DeepSeek Harness） |
| 辅助功能权限 | `ax_*` / AX 观察需要 | 未授权时 AX 文本退化为无、截图与点击仍可用 |
| Chrome「允许 Apple 事件中的 JavaScript」 | 可选 | 开启后浏览器 DOM 通道走 AppleScript；不开则用 CDP（`browserCdpPort`）或退回截图 |

## 已知限制

- AX 助手是 Swift 编译产物：若系统升级后签名/权限异常，`npm run doctor` 会给出提示。
- 浏览器 DOM 通道只做只读+点击+填表；不读 Cookie/密码、不伪造指纹、遇风控停手。
- 多屏混合 DPI 的截图侧修正未实现（`list_windows` 已带显示器 bounds/scale）。
