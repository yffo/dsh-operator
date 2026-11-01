# 浏览器自动化（browser_*）

0.24.0 起，operator 除了「桌面 + AX」，还有一组能操作**用户正在用的真实浏览器**的工具。
它们不接管浏览器生命周期、不启动带自动化参数的实例，走的是 cua-driver 的浏览器通道。

## 两条通道

| | `browser_*`（本文件） | `browser_dom_*`（0.11 起） |
| --- | --- | --- |
| 后端 | cua-driver 绑定原生窗口 + CDP 端点 | AppleScript JavaScript |
| 浏览器 | Chrome / Edge / Brave（macOS 上还有 Chrome 的授权弹窗） | Chrome / Safari |
| 登录态 | 真实 profile，天然带着 | 真实 profile，但要求「允许 Apple 事件中的 JavaScript」 |
| 输入 | 默认受信任输入（`Input.dispatchMouseEvent`） | `element.click()` 合成事件（`isTrusted=false`） |
| 感知 | semantic 快照 + ref（`p1:12`），可按 ref 操作 | DOM 快照（text/links/controls），按选择器或文字操作 |
| 导航 / 滚动 / 选择 | 有（open / pointer / select） | 没有（只有 click / fill） |
| 适配场景 | 高风控站点、需要「像人」的操作 | 零重启、Safari、只想读页面结构 |

两条通道可以共存；`browser_dom_probe` 报 AppleScript/CDP 状态，`browser_state` 报浏览器绑定状态。

## 标准流程

1. `cua_windows app_contains="Chrome"` → 拿 `pid` / `window_id`；
2. `browser_state pid=… window_id=…` 尝试绑定；若被拒（`browser_consent_required` / `browser_requires_setup`）→
   `browser_prepare pid=… window_id=… delivery_mode:"foreground"`（macOS Chrome 会弹一次它自己的调试授权，点允许即可）；
3. `browser_state target_id=… tab_id=…` 拿 semantic 快照：`tabs` + `refs`（`p1:12` 这种）；
4. 操作：
   - `browser_open url=…`（导航，导航后 ref 全失效）
   - `browser_click ref=…`
   - `browser_type ref=… text=… replace=true|mode:keystrokes`
   - `browser_pointer action=scroll|hover|double_click|drag …`
   - `browser_select ref=… label|value`
5. 每一步之后如果要继续点别的元素，先重新 `browser_state`——ref 会因页面变化而失效。

`target_id` / `tab_id` 会记住最近一次绑定值，所以第 4 步通常只用传 `ref`；显式传 `target_id`/`tab_id` 可以覆盖。

## 授权与姿态

- 绑定用户正在用的浏览器是**显式动作**：cua-driver 会要求授权，macOS Chrome 还会弹它自己的确认框。
- 后台姿态不可用（例如窗口在别的 Space）时返回 `background_unavailable`；`delivery_mode:"foreground"` 接受短暂前置，结束后会把原来的前台 App 还回去。
- 隔离模式（`allow_launch:true` + `profile.mode:"isolated_new"`）会给一个一次性的干净 Chrome，不碰用户 profile。

## 反爬立场

- 不注入伪装脚本、不改 `navigator`、不用 headless、不加 `--enable-automation`；
- 输入走受信任事件，点击带真实坐标，滚动/输入节奏由调用方控制（需要更像人时用 `mode:"keystrokes"` 和分步滚动）；
- 不读 Cookie/密码，不尝试绕过验证码；遇到挑战返回明确提示，交给人接管；
- 审计只记录工具名、ref、结果类别，不记录页面内容与输入文本。

## 失败码与下一步

| 返回 | 含义 | 下一步 |
| --- | --- | --- |
| `browser_consent_required` / `browser_requires_setup` | 还没绑定 | `browser_prepare(pid, window_id, delivery_mode:"foreground")` |
| `background_unavailable` | 后台姿态被拒 | 同上，或把窗口切到当前 Space |
| `browser_ref_stale` / `stale` | ref 过期 | 重新 `browser_state` |
| `protected_resource_scope_invalid` | 缺少精确 target | 传 `target_id`/`tab_id`（绑定后会自动带） |
| `refused` | 参数或能力不满足 | 看 `refusal.message`，不要盲目重试 |

## 配置

- `DSH_OPERATOR_BROWSER=0`：关闭整组 `browser_*`；
- `browserSession`（插件配置）：多会话并行情景下给一个稳定的 session 标签，默认 `dsh-operator`；
- cua-driver < 0.38 没有浏览器工具，本组自动不注册。

## 与内置浏览器的关系

宿主自带 `dsh-builtin-browser`（34 个工具、自托管窗口、零设置）。两者定位不同：

- 通用网页自动化 / 抓取 / 跑流程 → 用内置浏览器，能力全、不碰用户浏览器；
- 「在我已登录的浏览器里点一下」/ 高风控站点 / 需要真实输入 → 用 `browser_*`。

不要为了统一而重造内置浏览器的那 30 多个工具；operator 的浏览器能力按需长。
