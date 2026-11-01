# cua-driver：人机并行后端（0.22.0）

官方 [cua-driver](https://cua.ai/cua-driver) 的卖点是**后台操作 + agent 自带光标**：AI 在点、在打字时，用户还能同时用同一台 Mac（鼠标键盘不被抢、窗口不被前置）。本插件 0.22.0 起把这份能力做成**可选的新工具面**，与原有工具并存、互不干扰：

- 原有 13 个 GUI 工具与 AX 系列**完全不变**（走系统级 CGEvent / AX，会抢前台光标）。
- 新增 `cua_windows` / `cua_observe` / `cua_act` 三个工具，走 cua-driver，**后台投递、不移动用户鼠标**。
- 没装 cua-driver 时自动跳过（打一条 warn），插件其余功能照常。

一句话：**要人机并行就用 `cua_*`；要低依赖、零外部进程就用原有工具。**

## 前置条件

1. 安装 cua-driver（>=0.22.0）：

   ```bash
   /bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
   cua-driver --version
   ```

2. 授权（一次即可）：

   ```bash
   cua-driver permissions grant
   ```

   按提示在「系统设置 → 隐私与安全性」里给 **CuaDriver** 打开 **辅助功能** 和 **屏幕录制**。截图被 TCC 挡住时 `cua_observe` 会自动退回纯 AX 树并给 `note` 提示，不影响后台点按。

3. 插件第一次调用 `cua_*` 时会自动 `spawn cua-driver serve` 拉起 daemon（约 1–2s），之后复用同一个 daemon；也可以用 `cua-driver serve` 手动常驻。

## 三个工具

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `cua_windows` | 列窗口 / 显示器 / 前台窗口（含 `window_id`、pid、layer、bounds） | `app_contains`、`title_contains`、`on_screen_only`、`limit` |
| `cua_observe` | 取某个窗口的快照：AX 树（`element_token`）+ 可选截图 | `window_id`（必填）、`include_screenshot`、`max_elements`、`max_depth`、`query`、`since` |
| `cua_act` | 对窗口执行一个后台动作 | `window_id`、`action` + 动作参数（见下） |

`cua_act` 的 `action`：

| action | 目标 | 参数 |
| --- | --- | --- |
| `click` | `element_token` 优先；或 `x/y`（窗口局部像素） | `button`（left/right/middle）、`count`、`modifiers` |
| `type_text` | `element_token` 或 `x/y` 聚焦后输入 | `text`（不会按回车） |
| `press_key` | 当前聚焦元素 | `key`（如 `escape`、`return`） |
| `hotkey` | 目标进程 | `keys`（如 `["cmd","c"]`） |
| `scroll` | `element_token` 或 `x/y` | `direction`（up/down/left/right）、`amount` |
| `drag` | 窗口局部像素 | `from_x/from_y/to_x/to_y`、`duration_ms` |
| `set_value` | `element_token`（popup/select/输入框） | `value`（字符串） |

通用参数：`delivery_mode`（默认 `background`）、`fallback_foreground`（默认 `false`，失败时允许前台重试并回执 `fallback="foreground"`）、`observe`（默认 `true`，动作后附带 AX 树摘要）。

## 典型工作流

```text
cua_windows                                  → 找到 window_id（比如 42）
cua_observe({window_id:42})                  → 拿 element_token（如 s00000004:12）与截图
cua_act({window_id:42, action:"click", element_token:"s00000004:12"})
```

`element_token` 只在**同一次快照**里有效；窗口变化后重新 `cua_observe`。给 `x/y` 时是窗口局部像素（不是全局屏幕坐标），窗口必须可见。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `DSH_OPERATOR_CUA=0` | 彻底关闭 cua 工具（不注册、不拉 daemon） |
| `DSH_OPERATOR_CUA_BIN` | 指定 cua-driver 可执行文件路径 |
| `DSH_OPERATOR_CUA_SOCKET` | 指定 daemon socket 路径（`cua-driver serve --socket <path>`） |

## 错误提示（工具输出里的 `hint` / `note`）

- `direct_capture_consent_required`：截图未授权 → 纯 AX 重试 + 提示 `cua-driver permissions grant`。
- `select_menu_would_raise_window`：后台点 `<select>` 会提窗 → 改用 `set_value`。
- `background_unavailable`（如 `drag_and_drop_session`）：该交互无法后台 → 传 `fallback_foreground: true` 重试。
- `target_focus_unconfirmed`：目标聚焦没确认 → 先 `click` 聚焦，或改用 `element_token`。
- `element token ... stale`：快照过期 → 重新 `cua_observe`。

## 已知限制

- **后台 type_text 在 Electron/Chromium 可能被拒**：这类 App 会把无焦点输入视为无效，cua-driver 会回退 CGEvent（变成前台输入）。要全后台，优先 `set_value` 或先确认焦点。
- **macOS 原生拖放不支持后台**：跨 App 的 drag&drop 会 `background_unavailable`，只能前台执行。
- **窗口必须可见**：`x/y` 路径要求窗口在屏幕上（不用置顶，但不能最小化/在别的 Space）。`element_token` 不受此限。
- **cua_* 与旧工具是两套通道**：旧工具会移动真实光标；混用没问题，但别期待旧工具也「不抢焦点」。

## 验证

```bash
# 单测（假驱动，不需要系统授权）
node --test test/cua-tools.test.mjs

# 真机冒烟
cua-driver status
cua-driver call list_windows '{}'
```

真机验收清单：`cua_windows` 能列出目标窗口 → `cua_observe` 拿到元素与截图（首次需授权）→ `cua_act` 后台点击/输入期间，用户鼠标可同时移动、目标窗口不前置。

## 相关

- 官方文档：<https://cua.ai/docs/cua-driver>
- 官方安装脚本：<https://cua.ai/driver/install.sh>
- 实现在 `lib/cua-driver.js`（CLI/daemon 客户端）与 `lib/cua-tools.js`（三个工具的注册与映射）。
