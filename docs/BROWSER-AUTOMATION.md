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

1. `cua_windows app_contains="Chrome"` → 拿 `pid` / `window_id`，或直接 `browser_prepare app="Chrome"` 让工具找窗口（多个时用 `window_title` 收窄，否则列候选）；
2. `browser_state pid=… window_id=…` 尝试绑定；若被拒（`browser_consent_required` / `browser_requires_setup`）→
   `browser_prepare pid=… window_id=… delivery_mode:"foreground"`（macOS Chrome 会弹一次它自己的调试授权，点允许即可）；
3. `browser_state target_id=… tab_id=…` 拿 semantic 快照：`tabs` + `refs`（`p1:12` 这种）；只要文字不要结构时用 `browser_read`（CDP，固定表达式读 `innerText`，比截图省 token；长页面加 `selector` 只读某块）；
4. 操作：
   - `browser_open url=…`（导航，导航后 ref 全失效；默认自动取新快照并附 refs，`wait:false` 跳过）
   - `browser_click ref=…`
   - `browser_type ref=… text=… replace=true|mode:keystrokes`
   - `browser_pointer action=scroll|hover|double_click|drag …`
   - `browser_select ref=… label|value`
5. 每一步之后如果要继续点别的元素，先重新 `browser_state`——ref 会因页面变化而失效。同一页面连续快照时 refs 会折叠成一行 `<refs_unchanged>`（最多连折 2 次），页面一变立刻回全文；需要完整列表时传 `query` 或换个页面。

`target_id` / `tab_id` 会记住最近一次绑定值，所以第 4 步通常只用传 `ref`；显式传 `target_id`/`tab_id` 可以覆盖。

## 按文案点击的格式说明（0.46.0）

`browser_click text` 内部先取 `snapshot_format:"semantic_v2"`（`name`/`role` 才是人话）；`dom_refs_v1` 的 `label` 只给 `href=…`，匹配不到可见文案。驱动不支持 v2 时自动回退默认格式。

## 只看可交互元素

```
browser_state {interactive_only: true, max_refs: 20}
→ refs (17): …（只剩 link/button/input/checkbox 这类）
```

标题、段落、静态文本会被过滤掉，适合「这页有哪些能点的」。需要全文时用 `browser_read`。

## 常用配方（可直接抄）

```jsonc
// 只在 refs 里找「登录」相关元素，省 token
browser_state { "query": "登录" }

// 文案已经看准了：不用先抄 ref（歧义会列候选，不会乱点）
browser_click { "text": "提交订单" }

// 等元素出现再点，别用 sleep
browser_wait { "selector": "#pay", "visible": true, "timeout_ms": 8000 }
browser_click { "text": "确认支付" }

// 只读价格区，不读整页
browser_read { "selector": ".price-summary", "max_chars": 800 }

// 开调试端口时：看控制台与失败请求（reload:true 抓加载期错误）
browser_console { "reload": true, "duration_ms": 1200 }
browser_network { "reload": true, "duration_ms": 1500 }

// 一批里混桌面与浏览器动作（失败即停）
ax_batch { "steps": [
  { "action": "browser_open", "url": "https://example.com" },
  { "action": "wait", "seconds": 1 },
  { "action": "hotkey", "keys": "cmd,l" }
] }
```

## 授权与姿态

- 绑定用户正在用的浏览器是**显式动作**：cua-driver 会要求授权，macOS Chrome 还会弹它自己的确认框。
- 后台姿态不可用（例如窗口在别的 Space）时返回 `background_unavailable`；`delivery_mode:"foreground"` 接受短暂前置，结束后会把原来的前台 App 还回去。
- 隔离模式（`allow_launch:true` + `profile.mode:"isolated_new"`）会给一个一次性的干净 Chrome，不碰用户 profile。

## 风控清单（P3）

- **节奏**：两次动作之间留 300–800ms（`browser_wait` 之后再点），不要毫秒级连点同一元素；
- **顺序**：先 `browser_state` 拿 ref，再 click/type；ref 过期就重新取，不要猜坐标；
- **批处理（0.39.0）**：`ax_batch` 的 steps 里可以直接用 `browser_open` / `browser_click` / `browser_type`，和 `click`/`input`/`hotkey` 混在一个调用里；首错即停，摘要取工具返回文本。
- **按文案点（0.38.0）**：`browser_click text="登录"` 内部先取快照再匹配；匹配到多个会拒绝并列出候选（用 `role`/`index` 收窄），不会盲点；
- **自愈（0.35.0）**：ref 过期/快照被取代/元素找不到时，click/type/pointer/select 会自动补一份最新 refs 在错误里（`已自动重新取快照` 段落），直接拿新 ref 继续即可；授权、后台不可用这类错误不会乱重取；
- **环境**：用真实 profile、真实 UA/语言/时区；不 headless、不加 `--enable-automation`、不注入伪装脚本；
- **输入**：能逐字就 `mode:"keystrokes"`，批量 `insert_text` 只在确实需要时用；
- **并发**：同一站点不要多标签并行刷；
- **遇挑战**：验证码/风控页直接停手交人，不尝试绕过；
- **CDP**：只连自己起的调试实例，不把远程调试端口暴露到公网。

## profile 姿态

| 姿态 | 怎么来 | 适合 | 代价 |
| --- | --- | --- | --- |
| 现有 Chrome | `browser_prepare` 绑 `pid+window_id` | 需要真实登录态、真实扩展 | 会短暂抢占前台；窗口在别的 Space 时后台不可用 |
| 隔离 Chrome | `browser_prepare {allow_launch:true, profile:{mode:"isolated_new"}}` | 冒烟、不需要登录的流程 | 没有登录态，每次都是干净浏览器 |
| 专用调试 Chrome | `--remote-debugging-port=9222 --user-data-dir=…` + `browserCdpPort` | 需要 console/network/等网络空闲 | 要自己维护这个实例；不要用日常主 profile |

## 反爬立场

- 不注入伪装脚本、不改 `navigator`、不用 headless、不加 `--enable-automation`；
- 输入走受信任事件，点击带真实坐标，滚动/输入节奏由调用方控制（需要更像人时用 `mode:"keystrokes"` 和分步滚动）；
- 不读 Cookie/密码，不尝试绕过验证码；遇到挑战返回明确提示，交给人接管；
- 审计只记录工具名、ref、结果类别，不记录页面内容与输入文本。

## 键盘输入（0.26.0）

`browser_key` 把按键补上：`return` 提交搜索、`tab` 换焦点、`escape` 关弹层、`cmd+l` 聚焦地址栏。

- 需要浏览器 pid：`browser_state(pid, window_id)` 绑定后会记住，也可以显式传；
- 按键走 `press_key`/`hotkey`，默认 `background`（不动前台），必要时 `delivery_mode:"foreground"`；
- 焦点要在页面里：先 `browser_click` 点一下输入框，再 `browser_key(return)`；
- 按键不可回读，`effect` 只是投递结果，必要时 `browser_state` 复核。

## 失败码与下一步

| 返回 | 含义 | 下一步 |
| --- | --- | --- |
| `browser_consent_required` / `browser_requires_setup` | 还没绑定 | `browser_prepare(pid, window_id, delivery_mode:"foreground")` |
| `background_unavailable` | 后台姿态被拒 | 同上，或把窗口切到当前 Space |
| `browser_ref_stale` / `stale` | ref 过期 | 重新 `browser_state` |
| `protected_resource_scope_invalid` | 缺少精确 target | 传 `target_id`/`tab_id`（绑定后会自动带） |
| `refused` | 参数或能力不满足 | 看 `refusal.message`，不要盲目重试 |

### 对话框 / 下载 / 文件上传（0.29.0）

- `browser_dialog`：`action:"inspect"` 拿 `dialog_id`，再 `accept`/`dismiss`；prompt 可带 `prompt_text`。不要靠截图猜弹窗内容。
- `browser_download`：给下载链接的 ref + 绝对目录 `destination_root`，并且必须 `confirm:true`——这是写磁盘动作。
- `browser_set_input_files`：给 `<input type=file>` 的 ref 和 1–32 个绝对路径，绕过原生文件选择器。

## CDP 后端（可选，0.25.0）

cua-driver 的 `browser_*` 只给「语义快照 + 输入动作」，拿不到 Runtime/Network 事件。要「导航后等网络空闲」「看控制台错误」「看失败请求」，走 CDP，但**只连你显式开启的调试端口**——cua-driver 的环回代理不暴露 `/json/*`，复用它只会 404。

开启方式（不影响日常浏览器）：用独立数据目录起一个 Chrome，再把端口配进插件。

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.dsh/chrome-cdp" \
  --no-first-run --no-default-browser-check
```

插件配置：`browserCdpPort: 9222`（默认 0 = 关闭）。开启后多三个工具：

| 工具 | 做什么 | 备注 |
| --- | --- | --- |
| `browser_wait` | 等 `document.readyState === "complete"` 且网络空闲（默认 500ms）；传 `selector` 时改为等该元素出现（`visible: true` 要求已渲染） | 可用 `url_contains` / `title_contains` / `index` 选 tab；元素等待超时给可读错误 |
| `browser_console` | 收集 error/warning/未捕获异常 | `reload:true` 会重载页面，才能抓到加载期错误 |
| `browser_network` | 收集失败请求与 4xx/5xx | 同上；默认只收调用之后的流量 |

边界：只读（启用 Runtime/Log/Network 收集事件，不执行页面 JS、不改 DOM、不导 Cookie）；`browserCdpPort=0` 或端口连不上时三个工具都返回同一句开启指引，不会抛错。

## 配置

- `DSH_OPERATOR_BROWSER=0`：关闭整组 `browser_*`；
- `browserSession`（插件配置）：多会话并行情景下给一个稳定的 session 标签，默认 `dsh-operator`；
- cua-driver < 0.38 没有浏览器工具，本组自动不注册。

## 与内置浏览器的关系

宿主自带 `dsh-builtin-browser`（34 个工具、自托管窗口、零设置）。两者定位不同：

- 通用网页自动化 / 抓取 / 跑流程 → 用内置浏览器，能力全、不碰用户浏览器；
- 「在我已登录的浏览器里点一下」/ 高风控站点 / 需要真实输入 → 用 `browser_*`。

不要为了统一而重造内置浏览器的那 30 多个工具；operator 的浏览器能力按需长。

## 0.46 真机验证（macOS，Chrome 156 现有 profile）

已跑通：`browser_prepare`（attach existing profile）→ `browser_state` → `browser_open`（自动附 refs）→ 按文案 `browser_click`（semantic_v2）→ `browser_read` / `browser_wait` / `browser_console` / `browser_network`（需 `browserCdpPort` + 调试端口）→ `browser_set_input_files`（本地 `<input type=file>`）。

下载例外：`browser_download` 在 cua-driver 里属于需要**宿主确认**的破坏性动作。没有确认通道时（CLI/独立进程/当前 App 没有弹确认）驱动返回 `status:"refused"`，工具现在会如实报失败并提示「需要宿主确认」，不会假装「已触发下载」。
