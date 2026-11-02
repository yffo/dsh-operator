# 跨窗口状态交接（方案草稿）

## 问题

长会话换新窗口后，模型不知道上一窗口做到哪、下一步是什么；用户侧体感是「新窗口没有记忆」。

## 边界

- 插件**看不到对话正文**，只能看到自己注册的工具调用与结果。
- 因此插件能可靠保存的是：**本窗口执行过什么、结果如何、还欠什么**，不是对话语义。
- 语义记忆应交给 tabellio（已有的长期记忆系统）；本文档只解决「工程状态交接」。

## 方案（P1，插件侧）

### 1. 状态文件

`~/.dsh/dsh-operator/state/handoff.json`：

```json
{
  "updatedAt": "2026-11-02T11:50:00+08:00",
  "cwd": "/Users/yangfu/yffto/dsh-operator",
  "goal": "一句话目标（模型写入）",
  "todos": [{ "text": "…", "status": "in_progress" }],
  "recent": [{ "tool": "browser_click", "ok": true, "note": "p12:7" }],
  "open": ["还没做的事"],
  "version": "0.6x"
}
```

- 由插件在每次工具调用结束时追加 `recent`（截断到最近 20 条，脱敏：只存工具名/成败/短备注，不存参数正文）。
- 只保留**一个**文件（覆盖写），不写日期序列。

### 2. 两个工具

- `operator_brief`：写/更新 `goal`、`todos`、`open`；返回当前 handoff 摘要。
- `operator_resume`：读 handoff + 最近失败摘要 + profile/运行版本差异，拼成一段「继续开发」的上下文（限 1200 字符）。

### 3. 自动提示

- 插件启动（`plugin_start`）时**不注入**任何内容（宿主没有注入通道）；
- 但在 `operator_status` 输出里加一行：`handoff: 上次 2026-11-02T11:50（goal: …；未完成 2 项）`，让新窗口第一次调 status 就能看到线索。

## 不做

- 不假装能恢复对话；不写长日志；不记录参数正文（隐私 + token）。
- 不自动把 handoff 塞进每次回复（会污染上下文），只在 `operator_resume` / `operator_status` 出现。

## 验收

1. 新窗口调用 `operator_status` 能看到上次 handoff 一行摘要；
2. `operator_resume` 返回 ≤1200 字符，含 goal/未完成/最近失败建议；
3. 跑 100 次工具调用后 handoff.json < 16KB；
4. 单测：写入→读取 round-trip、脱敏（不含 args 正文）、超过 20 条截断。
