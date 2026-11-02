# dsh-operator

> 给每个 DSH 会话一双手。

[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2%20%3C0.3.0-8A2BE2)](https://github.com/deepseek-ai)
[![node](https://img.shields.io/badge/node-%3E%3D22.18-339933)](https://nodejs.org)
[![tests](https://img.shields.io/badge/tests-199%20passing-brightgreen)](test/)

**dsh-operator** 是一个装一次、所有会话可用的 Computer Use 插件：安装进 DSH 的 desktop profile 后，无论你开「标准 / PTC / 极简 / 创造」哪种模式，会话里都会直接出现一套桌面 GUI 工具，支持看屏幕、点鼠标、敲键盘、开应用，也带一个后台 `code_agent`。不用建特殊会话，也不用切模式。

它不依赖任何外部账号、远程服务或运行时二进制：核心能力是纯 JavaScript + macOS 自带命令 + 一个编译好的小型 AX 助手。接入 cua-driver 只是可选增强，用来做「AI 在后台操作、你同时用电脑」的人机并行。

## 为什么值得装

- **装一次，全局可用**：挂在 host 层工具栈里，所有当前和将来的会话自动继承，不需要每个会话单独配。
- **观察自带省 token 机制**：Retina 截图先按长边 1280 + JPEG q80 编码再交给模型（约原图 1/4 的图片 token）；原生 App 额外附 AX 文本快照（通常约 1KB），比只给截图少猜很多。
- **动作有校验**：每次动作后自动重采并比较，给出 `actionEffect`（confirmed / unverifiable / suspected_noop）；失败会附上可读提示，而不是让模型瞎猜。
- **后台人机并行（可选）**：接入 [cua-driver](docs/CUA-DRIVER.md) 后，`cua_launch` 后台启动 App、`cua_observe` 读窗口、`cua_act` 在后台点击/输入，**不移动你的真实光标、不抢占焦点**；你也可以选择不装，全部基础工具照常可用。
- **安全边界清楚**：危险快捷键/「删除」类按压默认拦截（`guard`）；审计日志只记元数据、不存屏幕内容；失败样本自动脱敏；剪贴板用完还原。
- **代码可自持**：MIT，全部能力代码在本仓库维护、无外部补丁链，265 项测试 + CI 全绿；欢迎自己改、自己发布。

## 3 分钟上手

```bash
# 1. 取代码
git clone https://github.com/yffo/dsh-operator
cd dsh-operator

# 2. 备份 desktop profile 三件套（保险，可随时回滚）
cp ~/.dsh/profiles/desktop/package.json        ~/.dsh/backups/profile-package.json.bak
cp ~/.dsh/profiles/desktop/pnpm-lock.yaml      ~/.dsh/backups/profile-pnpm-lock.yaml.bak
cp ~/.dsh/profiles/desktop/cordis.patch.yml    $HOME/.dsh/backups/profile-cordis.patch.yml.bak

# 3. 安装进 profile
cd ~/.dsh
dsh plugin --profile desktop add --save-exact "file:$HOME/projects/dsh-operator"

# 4. 完全退出 DSH（⌘Q）再重新打开
```

首次使用 GUI 工具时 macOS 会弹「屏幕录制 / 辅助功能」授权，允许给 DeepSeek Harness（或你的 DSH 宿主 App）即可。装载后打开任意一个会话，问它「截一张图看看我的屏幕」，能返回截图就说明通了。

**升级**：把 `file:` 路径里的代码 `git pull` 或重新 clone 后，重复第 3 步（`dsh plugin … add` 会重装这个包），再重启一次 App。
**卸载**：`dsh plugin --profile desktop remove dsh-operator`，重启 App。

> 仓库路径按你的实际 clone 位置改；本文用 `$HOME/projects/dsh-operator` 举例。

## 工具一览

会话里实际能用的工具（旧版名字默认保留，可用配置 `legacyToolNames` 关闭）：

| 类别 | 工具 |
| --- | --- |
| 观察 | `screenshot`（截图+前台信息）、`wait` / `long_wait`、`cu_observe`（按窗口读 AX/截图）、`screenshot_window`、`list_windows`、`zoom_region`（局部原生分辨率放大）、`ocr`（Vision 文本兜底：AX 拿不到时读截图，返回带坐标的文本行） |
| 鼠标 / 键盘 | `click`、`drag`、`scroll`、`input_text`、`hotkey`、`long_press`、`cu_act`（后台动作） |
| AX 动作 | `ax_press`、`ax_set_value`、`ax_scroll`、`ax_menu`、`ax_batch`（2–12 个动作一批，可混跑桌面与浏览器动作） |
| 窗口 / 应用 | `list_apps`、`open_app`（前台激活）、`cua_launch`（后台启动，不置顶）、`open_in_browser`、`open_in_finder`、`window_move`（含 left/right-half 等预设） |
| 浏览器 DOM | `browser_dom_snapshot`、`browser_dom_click`、`browser_dom_fill`、`browser_dom_probe`（Chrome/Safari，AppleScript 优先，CDP 回退） |
| 浏览器自动化 | `browser_state`、`browser_prepare`、`browser_open`、`browser_click`、`browser_type`、`browser_pointer`、`browser_select`、`browser_key`（经 cua-driver：真实 profile、语义 ref、受信任输入） |
| 浏览器 CDP | `browser_wait`、`browser_read`、`browser_console`、`browser_network`（需 `browserCdpPort` + Chrome `--remote-debugging-port`：等网络空闲/等元素、读页面可见文本、看控制台错误、看失败请求） |
| 任务 / 技能 | `task_profile`、`plan_create/list/update/run/delete`、`skill_save/list/show/run/delete` |
| 后台会话 | `code_agent`（另起标准会话执行代码/长任务） |
| 查询 / 诊断 | `verify_state`（窗口标题/AX/前台等谓词轮询）、`operator_status`、`failure_list`（失败样本摘要） |

## 可选：cua-driver 人机并行

基础工具用的是「真实键盘鼠标」语义；如果你希望 **AI 操作的同时自己继续用电脑**，接入 cua-driver：

```bash
# 1. 安装 cua-driver（见官方文档），确认：
cua-driver --version

# 2. 首次授权（Accessibility + Screen Recording 一次）
cua-driver permissions grant

# 3. 试试后台流程
#    cua_windows -> cua_observe -> cua_act / cua_launch
```

- `cua_windows`：列出窗口和 `window_id`（不需要前台）。
- `cua_observe window_id=…`：读该窗口的 AX 树（`[N]` 行 + `element_token`），可选截图附件。
- `cua_act window_id=… action=click role=… name=…`：后台点击/输入，默认 `delivery_mode=background`。
- `cua_launch bundle_id=com.apple.Safari`：后台启动 App 或打开文件/URL，不抢焦点。

环境变量：`DSH_OPERATOR_CUA=0` 关闭 cua 工具；`DSH_OPERATOR_CUA_BIN` 指定 `cua-driver` 路径；`DSH_OPERATOR_CUA_SOCKET` 指定 daemon socket。完整参数与已知限制见 [docs/CUA-DRIVER.md](docs/CUA-DRIVER.md)。

## 浏览器自动化（真实 profile）

`browser_*` 走 cua-driver 的浏览器通道，直接操作**你正在用的 Chrome/Edge/Brave**（真实登录态、真实扩展、无自动化启动参数）：

```bash
# 1. 找到浏览器窗口
cua_windows app_contains="Chrome"
# 2. 绑定并拿语义快照（首次会要求授权；macOS Chrome 会弹一次它自己的调试确认）
browser_prepare pid=… window_id=… delivery_mode="foreground"
browser_state pid=… window_id=…        # 返回 target_id / tab_id / tabs / refs
# 3. 操作（ref 形如 p1:12，导航后失效）
browser_open url="https://example.com/"
browser_state target_id=… tab_id=…
browser_click ref="p1:2"
browser_type  ref="p1:5" text="hello" replace=true
browser_pointer action="scroll" delta_y=-600
```

- 输入默认走 `Input.dispatchMouseEvent`（受信任事件，不是 `element.click()`）；需要合成点击时才传 `input_route:"dom_event"`。
- 绑定用户浏览器需要显式授权；`background_unavailable` 时用 `delivery_mode:"foreground"`。
- 不读 Cookie/密码、不伪造指纹、不绕验证码；遇到挑战会停下并在提示里让你接管。
- `DSH_OPERATOR_BROWSER=0` 关闭这组工具；cua-driver < 0.38 时自动跳过。细节见 [docs/BROWSER-AUTOMATION.md](docs/BROWSER-AUTOMATION.md)。

## 为什么省 token

Computer Use 的成本主要不在截图数量，而在每张图多大：

- 2x Retina 全屏截图直接进模型，单张图片就是几千 token；本插件先缩到长边 1280 再按 q80 编码，量级约为原图的 1/4。
- 观察只带「当前这一张」截图，不为每一步上传历史图。
- 原生 App 额外给 AX 文本（`<ax_snapshot>`，通常 1KB 左右），模型能按「名字/角色」定位而不是从像素里猜坐标；Web/Electron 的 AX 树很浅时会自动退回纯视觉，不为没用信息付 token。
- 工具策略提示词做过瘦身（8.4KB → 3.9KB），全局会话每轮都在省。
- `suspected_noop`、`clipped`、`imageError` 等降级提示都能减少「模型反复重试同一动作」造成的浪费。

## 安全与边界

- **安装即授权**：插件能控制桌面和读取屏幕；装之前请确认这是你愿意用的工具。
- **guard**：危险快捷键（如强制退出）和「删除/移除/支付/发送」类静默按压会被拦截；确认要做时可显式 `confirm: true`。
- **审计**：`~/.dsh/dsh-operator/audit.jsonl` 记录动作事件（窗口 id、动作类型、结果计数等元数据），不记录屏幕内容、不记录输入文本。
- **失败样本**：仅保留工具名/错误类别/消息摘要与参数长度，不含文字内容；`npm run failures` 可导出摘要，`failure_list` 工具可直接看。
- **剪贴板**：输入长文本时临时使用「快照 → 写入 → 粘贴 → 还原」，不会把你的剪贴板内容发给模型。
- **网络**：插件本身不上传任何数据；截图会随会话请求发给模型服务商，这是 Computer Use 本身的代价。

## 已知限制

- **平台面（0.33.0）**：macOS 已验证；Windows/Linux「代码兼容、未验证」——Windows 基础 GUI 后端（GDI `BitBlt` + `SendInput`）能加载但没有真机验收，Linux 能加载但桌面后端未实现（调用报 `unsupported_platform`）；扩展工具（AX/浏览器/剪贴板）只在 macOS 注册。`operator_status` / `doctor` 会明确打印 `UNVERIFIED`，不冒充支持。
- 多屏混合 DPI 跨屏截图可能有裁切误差（`clipped`/`visibleBounds` 会提示）。
- 纯视觉定位仍然是兜底；无 AX 的 canvas/WebGL 界面只能点像素。
- `ax_menu` 需要前台进程有菜单栏；`open_app` 是前台激活（想要后台启动就用 `cua_launch`）。
- `window_move` 对 Finder 部分窗口会被系统拒绝尺寸（高度纵向被夹紧时以返回 frame 为准）；多窗口拖拽先把「目标窗口」置顶，否则落点会交给最上层窗口。
- cua 相关：需要另装 cua-driver 并授权；`element_token` 只在相邻 `cua_observe → cua_act` 之间有效（跨调用会过期，插件自动重试一次）；Electron/Chromium 后台输入可能回退前台一次。
- `guard` 仍是 v1：按标题/关键词判断，没有 hit-test；误拦时用 `confirm: true` 放行。

## 配置

`~/.dsh/profiles/desktop/cordis.patch.yml` 里给 `computer-use` 插件加配置（都有合理默认，通常不用改）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `captureMaxEdge` | `1280` | 观察截图长边上限（0 = 不缩放） |
| `jpegQuality` | `80` | 重编码质量（100 = 不重编码） |
| `axObservation` | `true` | 原生 App 观察是否附 AX 文本 |
| `firstFrame` | `"auto"` | 首帧观察策略：auto / eager / off |
| `guard` | `true` | 危险动作拦截 |
| `auditLog` | `true` | 无内容审计日志 |
| `legacyToolNames` | `true` | 保留旧工具名别名 |
| `failureSamples` | `true` | 写脱敏失败样本 |

cua-driver 相关：`DSH_OPERATOR_CUA`、`DSH_OPERATOR_CUA_BIN`、`DSH_OPERATOR_CUA_SOCKET`。

## 排障

```bash
npm run doctor      # 安装/数据目录/权限/日志等 9 项体检
npm run preflight   # 隔离环境里做一次 DSH 引导，抓插件加载错误
npm run failures    # 失败样本摘要（按错误类别分组）
npm test            # 265 项测试
```

会话里也可以直接问 `operator_status`（版本/工具面/审计行数），或列出失败样本（`failure_list`）。

## 文档

- [项目说明与决策记录](docs/PROJECT-2026-11.md)
- [兼容性与平台边界](docs/COMPATIBILITY.md)
- [cua-driver 人机并行](docs/CUA-DRIVER.md)
- [第三方许可（NOTICE）](NOTICE)
- [工具卡片设计（toolview）](docs/TOOLVIEW-CARDS.md) · [可交互 demo](design/toolview-demo.html) · [P0 进度与交接](docs/TOOLVIEW-P0-HANDOFF.md)
- [发布与版本](docs/RELEASE.md)
- [场景/验收矩阵](docs/SCENARIOS-2026-11.md)
- [seam provider 适配说明](docs/SEAM-PROVIDER.md)
- [开发计划](docs/PLAN-2026-11.md)

## 更新记录

按版本倒序，只列近期版本；完整历史见 [Releases](https://github.com/yffo/dsh-operator/releases) 与 tag。

- **0.40.0** 浏览器工具失败也进失败样本：`browser_*` 失败写 `failures/*.jsonl`（工具名 `browser_click` 等、错误分类、参数脱敏），`failure_list` / `scripts/failures.mjs` 能一起复盘；`stale`/`superseded` 归到 `not_found` 类。
- **0.39.0** `ax_batch` 可混跑浏览器动作：`browser_open` / `browser_click`（ref 或 text）/ `browser_type`，一次调用里「开页→点→输入→桌面按键」，中间不消耗回合；步骤摘要直接取浏览器工具返回的文本。
- **0.38.0** `browser_click` 支持按可见文案点：`text="登录"` 会先快照再匹配（不区分大小写，可用 `role`/`index` 收窄）；歧义时**拒绝点击并列出候选**，不会点错。
- **0.37.0** 新增 `browser_read`：CDP 读页面可见文本（固定表达式 `document.body.innerText`，不执行任意 JS；默认 4000 字符、硬顶 20000），只要文字时比截图省一个数量级的 token。
- **0.36.0** `browser_open` 导航后默认自动取一份新快照（最多重试 3 次、间隔 300ms），结果里直接带最新 refs，省掉一次 `browser_state`；`wait:false` 可跳过。
- **0.35.0** 失败自动补快照：`browser_click/type/pointer/select` 遇到 ref 过期/快照被取代/元素找不到时，自动再取一次最新 refs 附在错误里（模型直接用新 ref 继续，少一个来回）；`shouldRecoverWithSnapshot()` 只认这几类错误，授权/后台不可用不重取。
- **0.34.1** refs 去重加最小长度阈值：refs 段没比说明行明显长就不折叠，避免小快照「越折越长」；30 个 refs 的页面实测 1223→198 字符（-83%）。
- **0.34.0** `browser_state` 的 refs 连续快照去重：同一页面下一次快照只回一行 `<refs_unchanged>`（最多连折 2 次），页面一变立刻回全文；`lib/ax-dedupe.js` 抽出通用 `dedupeByKey`，AX 树与 refs 共用同一套折叠逻辑。
- **0.33.0** 平台面收敛：`lib/platform.js` 增加能力矩阵与 `platformSummary`，`operator_status`/`doctor` 明确打印 `UNVERIFIED`——Windows 基础 GUI 后端（GDI + SendInput）代码在但无真机验收，Linux 可加载但桌面后端未实现（`unsupported_platform`）；扩展工具仍只在 macOS 注册。
- **0.32.0** `browser_wait` 支持 `selector`（可加 `visible`）：等到某个元素出现/可见再动手，不用靠 sleep 猜；选择器走 JSON 转义后嵌进固定表达式，不执行任意页面 JS。
- **0.31.1** 技能/计划回放支持宿主 GUI 动作：`skill_run` / `plan_run` 现在能回放 `click` / `input_text` / `hotkey` / `scroll` / `drag` / `wait` 等基础动作（之前只跑插件自有工具，录制下来的序列回放不了）。
- **0.31.0** OCR 兜底：新增 `ocr` 工具（macOS Vision，返回 0–1000 坐标的文本行，低置信度行过滤、可按 query 过滤）。AX 树缺失/canvas/自绘界面时用它拿文本再点。
- **0.30.0** token 压缩 + 批量动作扩展：AX/窗口树在连续观察未变化时折叠成一行 `<tree_unchanged>`（最多连折两次，第三次回全文）；`ax_batch` 新增 `double_click` / `drag` / `long_press` / `wait`。
- **0.29.0** 剪贴板 + 浏览器对话框/下载/文件上传：新增 `clipboard_read` / `clipboard_write`（文本/图片/文件，读文本有上限）；`browser_dialog`（alert/confirm/prompt 检查与确认）、`browser_download`（按 ref 下载到指定目录，需 `confirm:true`）、`browser_set_input_files`（绕过原生选择器上传文件）。
- **0.28.0** AX 助手常驻通道：helper 新增 `--rpc`（stdin JSON 行），客户端 `lib/ax-rpc.js` 复用同一进程，实测后续 AX 快照/hit-test 从 ~90ms 降到 ~1ms；进程随 stdin EOF 退出，二进制被替换时自动重建，异常/超时一律回退一次性 spawn。`DSH_OPERATOR_AX_RPC=0` 可关闭。
- **0.27.0** 坐标点击 guard：`click`/`input_text` 先在落点做 AX hit-test，命中危险词（删除/支付/发送…）或安全输入框时拒绝执行并提示 `confirm: true`；AX 不可用时保持原行为。`lib/bin/ax-snapshot` 新增 `--hit-test x y`（仍是 arm64+x86_64 通用二进制）；新增 `test/guard-point.test.mjs`（5 项），227 测试。
- **0.26.1** 驱动会话自动重建：cua-driver 空闲/重启后会回收会话，工具遇 `session has ended` 先 `start_session` 再重试一次（`browser_key` 也改走统一 `call()`）。
- **0.26.0** 键盘输入：新增 `browser_key`（return/tab/escape/方向键/修饰键组合，绑定后复用 pid，默认后台投递）；文档补「风控清单」与「profile 姿态」两节；测试 220→222。
- **0.25.0** CDP 后端：新增 `browser_wait` / `browser_console` / `browser_network`（只连显式开启的调试端口，受 `browserCdpPort` 门控；`reload:true` 时重载页面抓加载期错误）；新增 `lib/browser-cdp.js` 与 `test/browser-cdp.test.mjs`，测试 213→220。
- **0.24.5** 插件拉起 cua-driver 时带 `--grant existing-profile`（`DSH_OPERATOR_CUA_GRANT=0` 可关）：否则手动/自动重启 daemon 后，`browser_prepare` 会以 `browser_consent_required` 拒绝接真实 Chrome。
- **0.24.4** `browser_state` 输出元素 `refs`（`p2:2 a href=…`），支持 `snapshot_format` 与 `query`：之前只列 tabs，`browser_click` 拿不到 ref；本轮真机验证已能点到真实链接。
- **0.24.3** `browser_prepare` 同样显式传 `strategy: {kind:"existing_profile"}`：不带时驱动只做端点探测（`already_prepared`），`get_browser_state` 仍以 `browser_consent_required` 拒绝。
- **0.24.2** `browser_state` 首次绑定补 `strategy: {kind:"existing_profile"}`：cua-driver 对 `pid+window_id` 形式的快照要求显式策略，缺了会以 `browser_consent_required` 拒绝。
- **0.24.1** 修复客户端插件启动失败：`client/client.js` 的模块导出补 `inject: ["slots"]`——宿主 client ctx 默认不注入 slots，直接读 `ctx.slots` 会抛 `cannot get property "slots" without inject`，App 启动即报 `web boot: 1 entry did not activate / dsh-operator: failed`；新增对应 bundle 断言。
- **0.23.0** toolview P0 落地真客户端：中文活动卡片（第 n/N 步、实时耗时、执行模式/确认门徽标）、分段进度、逐步行、结果缩略图+灯箱、失败原因与建议、完成折叠；新增渲染测试 `test/client-render.test.mjs`。
- **0.24.0** 浏览器自动化（真实 profile）：新增 `browser_state/prepare/open/click/type/pointer/select`，经 cua-driver 绑定用户正在用的 Chrome，ref 快照 + 受信任输入；`browser_dom_*`（AppleScript）保留为第二通道。
- **0.23.3** toolview 回退为一行状态「DSH 正在操作电脑」：去掉步骤行/缩略图/进度轨/日志块/确认门徽标，只保留状态点、工具名、状态词与可展开的调用详情；客户端从 862 行降到 ~210 行，测试同步收敛。
- **0.23.2** toolview 版式贴近设计稿：卡片间距/字号/圆角对齐 demo v3，步骤行改成「序号 → 缩略图位 → 中文动作」并带「状态 · 动作」标签；多步卡片默认展开；结算后用真实输出前 6 行做日志块；运行中超 10s 只给静态提示（不估算 ETA）。
- **0.23.1** toolview 长任务表达：运行中步骤序号加一圈 1.8s 脉冲（`dopPulse`），超过 10s 在卡片里显示「已耗时 Xs，仍在执行；你可以继续做别的事」；结算后自动收起。
- **0.22.6** 新增 `cua_launch`（后台启动 App 不置顶）；`open_app` 文档明确为前台激活。
- **0.22.5** `cua_act` 失败信息聚合（message/stdout/stderr/steps），stale token 自动重试更可靠。
- **0.22.4** `open_app` 中文名回退 bundle id；`cua_act` 过期 token 自动重新观察并重试。
- **0.22.3** cua 窗口截图按真实格式（PNG）保存；daemon 首次授权补齐。
- **0.22.2** `cua_observe` 默认 markdown 树 + `elements` 兜底；截图权限失败给出明确提示。
- **0.22.1** 修 `cua_observe` 可选字段输出（lossless JSON）。
- **0.22.0** 接入 cua-driver 可选后端（`cua_windows` / `cua_observe` / `cua_act`），后台人机并行。
- **0.21.12** `seam provider` 适配（探测式，不装 seam 时行为不变）。
- **0.21.11** 工具输出 schema 统一注入 `schemaVersion`，与 DSH 新版校验兼容。
- **0.21.8** `ax_batch`：一批 2–12 个 AX 动作，首错即停。

## 路线图

- 多屏混合 DPI 的跨屏截图校准。
- Windows 真机验证。
- 更完整的官方 seam provider 运行态（受 desktop 组合层顺序限制，暂缓）。
- 用 5 类真实任务做公开可复现的基线数据（成功率 / 步数 / token / 耗时）。

## 许可

MIT。第三方组件的版权与许可声明集中在 [NOTICE](NOTICE)；其余为本项目自有代码。
