# toolview 进度交接：P0 落地活动卡片

> 用途：上一窗口（2026-11-01 12:01）杨总要求「记录一下当前进度，重新开窗口继续开发」，当轮模型侧无输出、指令未落地；本文件补上交接记录，并在同一份文件里跟踪 P0 的落地进度。
> 设计真源：[`docs/TOOLVIEW-CARDS.md`](TOOLVIEW-CARDS.md) · 可交互 demo：[`design/toolview-demo.html`](../design/toolview-demo.html)

## 1. 已完成（截至 c07f4b2）

| 提交 | 内容 |
| --- | --- |
| `70b79a4` | demo v3：长任务表达（longFlow 3.2s、实时「已耗时」）、HUD 富化（缩略图回退+目标+第 n/N 步+效果标签+进度轨）、去掉缩放、放慢扫光 |
| `c07f4b2` | 文档：把 v3 的动效收敛与 HUD 增强写回 `docs/TOOLVIEW-CARDS.md` §9 |

当前 `design/toolview-demo.html`（1011 行）已经能演示：活动卡片头部（点/标题/目标/耗时/模式徽标/折叠）、分段进度、每步一行（序号/状态标签/元信息/缩略图）、失败原因+建议+动作按钮、确认门、完成折叠摘要、桌面 HUD 四态。

## 2. 现状（0.23.0 已落地 P0）

`client/client.js` 从 334 行扩到 810 行，仍是手写零构建经典脚本、无 React hooks；`test/client-render.test.mjs` 用极小的 React 兼容层在 Node 里把真实卡片渲染成对象树做断言。

- 头部：状态点 + 中文标题（正在操作 · 第 n/N 步 / 已完成 · N 步 / 失败 · 第 k/N 步 / 已中断）+ 目标行（运行中）或结果行（结算后）+ 实时耗时 + 确认门 + 截图张数 + 执行模式徽标 + 折叠按钮。
- 正文：分段进度 + 逐步行（序号/中文动作/状态标签/备注/缩略图）+ 失败原因与建议 + 富摘要 extra + 截图 gallery（点击开灯箱）+ `<details>调用详情`（args + 原始输出）。
- 行为：运行中/失败默认展开，完成默认折叠；`prefers-reduced-motion` 关闭动画。
- 历史那版「一行日志」的摘要逻辑（stripToolPrefix / richSummary）全部保留，避免旧测试与旧卡片信息回退。

**结论：P0 清单七项已进真客户端，等待宿主内实机观感确认（见 §7）。**

## 3. 宿主契约（本轮从 App 内 `app.asar` 实测，0.2.1-rc.5）

视图 props：`{ phase, block, toolName, callId, cwd?, home?, openFile, loadImage, inspect?, useDisclosure }`。

`block` 三态（`lib/types/client/conversation-nodes/tool.js`）：

| phase | 字段 |
| --- | --- |
| `preparing` | `callId, name, turn, step, time, subCalls, args`（流式 PartialArguments） |
| `start` | `callId, name, argsRaw, args, turn, step, time, subCalls` |
| `result` | `kind:"tool-result", seq, time, callId, name, args, call:{name,argsRaw} \| null, callTime, content, isError, error?, meta?, subCalls` |

- 耗时：`time - callTime`（事件时间，毫秒级数值）；运行中 `Date.now() - block.time`。
- 参数：`block.call?.argsRaw`（已结算）/ `block.argsRaw`（运行中）；`block.args` 是惰性读器，客户端继续用 `argsRaw` 解析即可。
- 图片：结果 `content` 里 `{ type:"image", attachment:{ attachmentId, mediaType, bytes, width, height, name? } }`；宿主 `imageReferences()` 会校验，不合规退化为通用卡。
- 缩略图：`props.loadImage(attachment)` 返回 `Promise<url>`（同步有 `loadImage.peek`）。客户端在 ref 回调里 `loadImage(attachment).then(url => img.src = url)` 即可，不需要 hooks。

## 4. P0 落地清单（本轮做，只改 `client/client.js`）

1. **活动卡片头部**：状态点（run/ok/warn/err）+ 中文标题（如「正在操作 · 第 n/N 步」/「已完成 · 4 步」）+ 目标行（从 args 提取 app › window › control）+ 耗时胶囊（运行中实时走秒）+ 执行模式徽标（后台执行·不影响你 / 前台执行·短暂占用）+ 折叠/展开。
2. **分段进度**：按步骤数渲染进度段（done / active / err），运行中的段做一次性扫光。
3. **步骤行**：ax_batch / cua_act / browser_dom_fill 这类多步工具逐行展示（序号、动作、状态标签、耗时）；单步工具至少一行。
4. **缩略图**：结果里的 image 附件 → 74×48 缩略图；点击开灯箱（纯 DOM，无 hooks）。
5. **失败原因 + 建议**：从 `error`/输出里翻译成「原因 + 能怎么办」（重试/接管/查看上一步）。
6. **确认门展示**：guarded 工具且 `args.confirm !== true` 时标「需要你确认」。
7. **完成折叠**：完成后收起步骤，摘要成「4 步 · 6.8s · 2 张截图」，可再展开。

不动宿主 wire 协议、不加依赖、不使用 React hooks（`test/client-bundle.test.mjs` 硬约束）。

## 5. 验证

```bash
node --check client/client.js
npm run test:node
```

然后让宿主重载客户端 bundle（刷新页面），在真实会话里触发 `ax_batch` / `cu_observe` / `browser_dom_probe` 等工具，对照 demo 检查卡片。

## 6. 交付记录（0.23.0）

- 卡片实现：`client/client.js`（810 行）+ 样式注入 `<style id="dsh-operator-toolview-css">`。
- 渲染测试：`test/client-render.test.mjs` 8 项（运行中/确认门/前台/缩略图/失败建议/进度段/中断/card error 兜底）。
- 浏览器预览页：`design/toolview-preview.html`，直接加载真实 `client/client.js`（迷你 React 兼容层）出 7 个用例，明暗主题可切、灯箱可点。
- 验证：`node --check client/client.js` OK；`npm run test:node` 207/207（原 199 + 新增 8）。

## 7. 之后（不在 P0）

- P1：宿主给结果块补可选 `ui` 字段（步骤结构化），客户端优先读 `ui`、缺失回退文本解析（见 `docs/TOOLVIEW-CARDS.md` §4）。
- P2：暂停/接管按钮、桌面常驻 HUD（同源状态，见 §9.1）。
- P0 尾巴：宿主内实机观感（长任务扫光节奏、深色主题对比度）需要真实会话里多看几次再调。
