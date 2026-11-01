# dsh-operator

> 给每个 DSH 会话一双手。

[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2%20%3C0.3.0-8A2BE2)](https://github.com/deepseek-ai)
[![node](https://img.shields.io/badge/node-%3E%3D22.18-339933)](https://nodejs.org)

**全局 Computer Use 插件**：装进 desktop profile 后，任何会话（标准 / PTC / 极简 / 创造）都直接拥有 13 个桌面 GUI 工具和后台 `code_agent`——不用新建会话，也不用切换模式。

能力层裁剪自 [dsh-orb](https://github.com/mini-yifan/dsh-orb-cordis) v0.2.0 的 `dist/computer-use`（MIT）：去掉悬浮球、Electron helper、语音和设置页，只留计算机操作，并补了三处工程化改进：

- **观察截图自动降 token**：Retina 2x 截图交给模型前先缩到长边 ≤ 1280、重编码 JPEG q80（`sips`，失败回退原图）；
- **动作失败有校验提示**：动作后截图与上一张逐字节相同且动作有等待时，工具结果追加 `note`，配合提示词纪律减少「瞎重试」；
- **原生 App 附 AX 文本快照**：侧栏、菜单、按钮这类 AX 树里有名字和位置的东西直接给文本，视觉截图仍是兜底（Web/Electron 自动退回纯视觉）。

定位：与现有同类 DSH 插件 / 产品**齐平或领先**。三项硬指标（任务成功率 / 单任务 token / 单任务耗时）会以可复现的基线持续补测。

## 和其他方案的区别

| 方案 | 挂载方式 | 外部依赖 | 观察成本 | 备注 |
| --- | --- | --- | --- | --- |
| **dsh-operator**（本插件） | 全局（host 层） | 无：纯 JS + macOS 自带 `screencapture` / `osascript` / 编译一次的本机 AX 助手 | 截图先降 token 再入上下文，原生 App 附 AX 文本 | 代码全可审计；上游能力层已 fork（见 `docs/FORK.md`），无外部引擎 |
| 官方实验包 `dsh-computer-use` + `cua-driver-native` | 全局 | Cua Driver 原生 SDK / 二进制 | 原图 | 官方 seam，native 崩溃会带走宿主进程 |
| 社区 `dsh-computer-use@0.3.x` 等 | 全局 | 多数需要外部 `cua-driver` 或仅 macOS AX | 原图 | 工具数、平台覆盖不一 |
| preset 形态（本插件 0.2.0） | 会话级 | 无 | 原图 | 必须新建会话并选「Computer Use 模式」 |

## 能力

| 类别 | 工具 |
| --- | --- |
| 观察 | `screenshot`；原生 App 每次观察还会附一份 `<ax_snapshot>` 文本（角色 / 标题 / 值 / 0–1000 位置） |
| 鼠标 | `click`（左/右、双击、修饰键）、`drag`、`scroll`、`long_press` |
| 键盘 | `input_text`（可替换原内容、回车提交）、`hotkey` |
| 等待 | `wait`、`long_wait` |
| 应用 / 文件 | `list_apps`、`open_app`、`open_in_browser`、`open_in_finder` |
| 查询 / 验证 | `list_windows`（窗口 + 显示器 + 前台 App，含 window_id）、`screenshot_window`（只截指定窗口）、`verify_state`（轮询状态谓词，只报事实、不带图）、`ax_press` / `ax_set_value`（按 AX 快照 index 后台点按/写入）、`ax_scroll`（AX 滚动区域，可给 index 或按 role/title 自动选容器；原生动作优先、不支持时提窗滚轮回退）、`ax_menu`（菜单路径触发）、`window_move`（按 pid/标题后台移动/缩放窗口，AXPosition/AXSize）、`zoom_region`（局部原生放大） |
| 后台会话 | `code_agent`、`code_agent_status`、`code_agent_stop` |

每次工具调用后自动附带新的前台窗口截图，坐标用 0–1000 归一化（Retina / 多倍屏都按比例，不是像素）。

`code_agent` 把一段独立的读文件/写文件/搜索工作丢给后台标准模式会话（会出现在侧栏），适合「前台要操作、后台要查资料」的任务。

## 为什么是全局

DSH 的 agent preset 是会话模板：会话创建时钉死工具集和提示词（保证请求前缀稳定，也避免普通会话被 GUI 工具污染）。而 **host 层 `ctx.tools.register()` 注册的工具是「全局工具」，由所有 agent 继承**——官方 Computer Use 也是以部署级 provider 的方式挂载一次。

本插件在 profile 层挂三行（主插件 + `code_agent` 注册表 + `code_agent`），所以任何会话直接可用；想收紧时用 `ctx.tools.restrict(...)` 在会话侧做白名单，而不是拆插件。

## 与官方 `computer-use` seam 的关系

官方 `@deepseek-ai/dsh-computer-use` 是一个「单槽位 provider 注册表」：提供方（Cua Driver 等）在组合层挂载一次，工具由提供方自带。`dsh-operator` **不走 seam**，而是把工具直接注册在 host 层（全局工具），所以：

- 单独用本插件时，不需要安装 seam 或任何 provider；
- 如果同一份组合里已经挂了官方 seam + provider，两边都会有 GUI 工具，会出现工具重名/抢桌面，**二选一**（用本插件就禁用 seam/provider，反之亦然）；
- 本插件的 `schema_version`、`<ax_snapshot>` 文本协议、`actionEffect` 字段都是自己的契约，不依赖官方 seam。

## 安装

前置：DSH desktop `>=0.2.1-rc.2 <0.3.0`；Node `>=22.18`；macOS 需要给 DeepSeek Harness 授权**屏幕录制**和**辅助功能**。

```bash
# 1. 取代码（放哪都行，示例 ~/Projects）
git clone https://github.com/yffo/dsh-operator.git ~/Projects/dsh-operator

# 2. 备份 profile 三件套
mkdir -p ~/.dsh/backups/dsh-operator-$(date +%Y%m%d-%H%M%S)
cp ~/.dsh/profiles/desktop/{package.json,pnpm-lock.yaml,cordis.patch.yml} \
   ~/.dsh/backups/dsh-operator-$(date +%Y%m%d-%H%M%S)/

# 3. 安装（在 profile 目录里跑 pnpm，必须完全退出 App 前先备份）
cd ~/.dsh && dsh plugin --profile desktop add --save-exact file:$HOME/Projects/dsh-operator
```

安装后**完全退出并重新打开 App**（profile 组合在启动时完成）。首次调用 GUI 工具时系统会弹出屏幕录制 / 辅助功能授权，允许后重试即可。

卸载：

```bash
cd ~/.dsh && dsh plugin --profile desktop remove dsh-operator
```

> pnpm 用硬链接把插件装进 profile。改完源码后如果行为没变，最稳的做法是 `remove` 再 `add` 一次；只改 `lib/` 里的 JS 通常下次加载就生效。

## 浏览器 DOM 工具（0.11.3）

三个扩展工具，走 AppleScript JS 通道（无需重启浏览器、保留登录态；需一次性开 Chrome 菜单「查看 → 开发者 → 允许 Apple 事件中的 JavaScript」）：

- `browser_dom_snapshot`：返回当前标签页 `title/url/text/links/interactive`（只读；不读 input 值/Cookie/密码）。
- `browser_dom_click`：按 CSS selector 或可见文本点按钮/链接；命中删除/pay/send 等破坏性词需 `confirm:true`。
- `browser_dom_fill`：原生 setter + input/change 填表（React/Vue 可用）；`type=password` 字段直接拒绝，值不进日志。
- `browser_dom_probe`：一次看两个通道的状态（AppleScript 是否开启、CDP 端口是否可达），据此决定用 DOM 还是截图。
- CDP 回退：配置 `browserCdpPort`（默认 0 = 关）并在启动 Chrome 时加 `--remote-debugging-port=<相同端口>`；AppleScript 通道报 disabled/error 时，snapshot/click/fill 会自动走 CDP，并在结果里带 `backend:"cdp"`。CDP 只连用户自己启动的 Chrome，不接管生命周期、不碰日常 profile。

通道关闭时 snapshot 会返回 `available:false` + 具体菜单路径提示，此时回退截图工具（视觉通道）。CDP 后端（`lib/browser-dom.js` + `npm run browser:spike`）用于独立 profile 的自动化验证，0.11.4 再接进工具。

## 技能库（0.11.2 起步）

`skill_save` / `skill_list` / `skill_show` / `skill_delete` 把可复用的操作序列存成 JSON：`~/.dsh/dsh-operator/skills/<name>.json`。

- 只存「工具名 + 参数」，不存截图/剪贴板/密码；参数里出现 password/secret/token/apiKey/cookie 等键会被拒绝。
- 名字限小写 kebab-case（防路径穿越），单技能 ≤50 步、args ≤8KB、最多 100 个；写入走临时文件 + rename。
- 本版只做管理；回放执行器（按步骤调用工具 + 失败重试/降级）在 0.11.3/0.12 接。

## 浏览器 DOM 通道（0.11.1，实验）

`lib/browser-dom.js` 是 0.11.2 技能库/0.12 规划器要用的浏览器底座，两条后端：

1. **AppleScript**（零重启、保留登录态）：需要 Chrome 菜单「查看 → 开发者 → 允许 Apple 事件中的 JavaScript」打开一次；该开关关闭时 `probeAppleScriptDom` 会返回 `disabled` 并给出 `APPLESCRIPT_DISABLED_HINT`。
2. **CDP**（自动化友好）：`spawn Chrome --headless=new --remote-debugging-port=0 --user-data-dir=<临时/独立 profile>`，读 `DevToolsActivePort` → `cdpConnect`（Node ≥22 自带 WebSocket）→ `Target.createTarget/attachToTarget(flatten)` → `Runtime.evaluate`。`npm run browser:spike` 可一键验证这条链路（临时 profile、跑完清理，不碰日常 Chrome）。

安全边界：只读取页面可见文本/链接/控件，不读 Cookie/密码、不伪造指纹、遇到风控挑战停手并转人工（见 `docs/PROJECT-2026-11.md` §8.1）。

## 配置

`cordis.patch.yml` 里给主插件传 config：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `postActionWaitMs` | `500` | 动作后等多久再截图（毫秒）。调低更快，但可能截到过渡帧；调高更稳、更慢 |
| `captureMaxEdge` | `1280` | 截图入上下文前的长边上限（px）。`0` 关闭缩放；Retina 2x 下 1280 约等于逻辑 640 宽 |
| `jpegQuality` | `80` | 缩放后 JPEG 质量。`100` 表示不重编码（仍会缩放） |
| `axObservation` | `true` | 原生 App 观察时是否附 AX 文本快照；设 `false` 退回纯视觉 |
| `axMaxNodes` | `120` | AX 快照节点上限（20–400）。越大信息越全，token 越多 |
| `axMinNodes` | `16` | 浅 AX 树阈值：节点数少于它就不附 AX 文本（Electron / Web 通常只有十几个节点） |
| `firstFrame` | `auto` | 首帧观察策略：`auto`（默认，仅 GUI 会话自动观察）/ `eager` / `off` |
| `idleObserveMs` | `600000` | `auto` 模式下判定「最近做过 GUI 动作」的窗口（毫秒） |
| `guard` | `true` | 敏感动作 guard（危险快捷键 / ax_press 危险标题需 `confirm: true`） |
| `auditLog` | `true` | 写无内容审计日志到 `~/.dsh/dsh-operator/audit.jsonl`（事件名 / 数量 / 布尔 / 耗时，不含截图、坐标、标题、输入文本） |
| `legacyToolNames` | `true` | 被 v2 强工具覆盖的 14 个旧工具名是否仍直接暴露；`false` 时只保留 `cu_observe`/`cu_act`（registry 内仍保留供分派/回放） |
| `failureSamples` | `true` | 工具失败时把诊断写进 `~/.dsh/dsh-operator/failures/<日期>.jsonl`（工具/分类/错误/脱敏参数，5MB 轮转、最多 20 个文件，绝不外传） |

## 排障与失败样本

```bash
npm run doctor              # 一条命令自检：版本/挂载/helper/权限/目录（--json 可贴 issue）
npm run preflight           # 隔离 DSH_HOME 的 headless 引导预检（插件加载错误在重启前暴露）
npm run failures            # 失败样本汇总（--json / --files / --dir / --top N）
```

- 失败样本落在 `~/.dsh/dsh-operator/failures/<YYYY-MM-DD>.jsonl`，每条含：工具名、失败分类（`guard_rejected` / `timeout` / `unavailable` / `not_found` / `cancelled` / `error`）、错误消息、**脱敏后的参数**（文本只留长度，枚举/方向/页码保留）、耗时。默认开启，`failureSamples: false` 可关。
- 隐私边界：只落本机、不联网、不写截图/剪贴板/输入原文；5MB 轮转、最多保留 20 个文件。发现系统性问题后再决定是否把**脱敏片段**贴进 issue。
- 两类排障入口：`doctor` 看「装没装对/有没有权限」，`failures` 看「哪类动作在什么工具上失败」。

## 安全

- **安装即授权**：GUI 工具在工具内部不做逐次确认，所有会话都拥有桌面操作能力。敏感任务请在会话里明确约束（例如「只读、不要点确认/支付」）。
- **截图会上传**：观察截图作为附件进入模型上下文，会发到当前模型服务商（DeepSeek 账户）。敏感窗口请先关闭或遮挡。
- **权限继承 App**：插件以 DeepSeek Harness 的桌面权限运行（屏幕录制、辅助功能、控制其他 App）。代码在本仓库可审计（含 fork 的 `lib/computer-use/`）。
- **剪贴板**：`input_text` 走「快照剪贴板 → 写入 → 粘贴 → 恢复」链路，结束后尽量恢复原剪贴板（恢复失败会清空，避免残留测试文本）；剪贴板内容不会进审计日志、不会额外上传，但粘贴目标 App 可能读取。
- **无网络上报**：只用本机文件与系统命令，插件自身不发送遥测。

## 已知限制

- **guard 是 v1**：覆盖危险快捷键、`ax_press` / `ax_set_value` / `ax_menu` 的危险标题与路径；视觉点击的语义目标还没接 AX hit-test（v2 计划），别把它当完整的安全沙箱。
- **`ax_menu` 需要目标 App 在前台**：后台 App 的菜单栏 AXPress 不会真正展开（实测后台调用返回成功但无效果）；需要菜单操作时先 `open_app` 再调用。
- **`ax_scroll` 的回退会把目标 App 提到前台**：原生支持 AX scroll action 的 App 走后台动作；不支持的 App（如 Finder 图标视图）会先提窗 + 激活再发全局滚轮，副作用是前台切换。
- **`ax_scroll` 自动选容器时返回的 index 是 helper 原始索引**：可能与快照里格式化后的索引不同（匿名节点被过滤），只用于本次调用的回执，别拿去 `ax_press` 复用。
- **`ax_scroll` 可以不给 index**：滚动容器常被匿名节点过滤或排在 120 节点之外；此时传 `expect_role`（可选 `expect_title`），工具会在新鲜树里自动选面积最大的匹配滚动容器（输出带 `resolved` 标记）。给 index 时仍以快照为准，必要时把 `axMaxNodes` 调大（如 400）。
- **`window_move` 的 Finder 尺寸限制**：实测部分 Finder 窗口接受 AXPosition 但拒绝 AXSize（位置成功、尺寸保持原值，例如「下载」窗口 920x436 不变）；需要精确并排时优先选择接受 resize 的窗口，或让用户手动调整。AX frame 位置读回以 AX frame 为准，CGWindow bounds 与其有系统性偏移。
- **多窗口拖拽前先把目标窗口置顶**：其他 App 窗口（如 Harness）可能盖住目标 Finder 窗口，拖拽落点会交给最上层窗口（实测掉进 Harness 聊天框变成附件）。用 `ax_menu` 的「窗口/<标题>」或 `open_app` 后点击目标窗口，再执行跨窗拖拽。

- **平台**：以 macOS 为主；Windows 上 vendored 代码有 koffi 后端，但本仓库未验证。Windows/Linux 上扩展工具（`list_windows` / `screenshot_window` / `verify_state` / AX 系列）不注册，启动时会打印一条 `extended tools are macOS-only` 警告；截图降 token 管线（sips）也会跳过、原样返回。Linux 不提供 GUI 操作。AX 助手是通用二进制（arm64 + x86_64），Intel Mac 也可用。
- **多屏 / 混合 DPI**：坐标与点击换算按全局逻辑点、与显示器 scale 无关；观察截图按捕获矩形的逻辑点区域取像素，混合 DPI 下不同屏的截图像素密度不同、跨屏 union 仍可能裁错（上游 dsh-orb issue #38，单屏机无法真机验证）。`list_windows` 会显式列出每个显示器的 bounds/scale 和每个窗口的归属，可用 `screenshot_window` 按窗口截图规避。
- **纯视觉定位**：UI 变化、遮挡、动画过渡会导致定位失败；校验提示只能减少浪费，不能保证成功。适合可重复、可验收的操作。
- **AX 只覆盖原生 App**：AX 树在 AppKit 原生应用里好用（系统设置、访达、备忘录、预览等），Electron / Web 应用（Chrome、Harness、微信）树很浅或不可见，少于 `axMinNodes`（默认 16）时自动不附、退回纯视觉。AX 助手是预编译的 macOS 二进制；换架构/平台需要 `pnpm run build:ax` 重新编译（需要 Xcode Command Line Tools）。
- **首次授权**：屏幕录制 / 辅助功能需要用户手动在系统设置里允许；未授权时截图与输入都会失败。
- `lib/computer-use/` 是上游 dsh-orb 的 fork（0.9.1 起），上游更新用 `scripts/fetch-upstream.sh` 人工对照合并；不再有自动补丁。

## 工作原理：token 花在哪

- 每次观察只带**当前这一张**截图；历史截图不会重复附带（会话上下文自己管理），所以不存在「截图越积越多」的问题。

- 13 个工具的 schema 是固定前缀，命中缓存后边际成本很低；**真正的大头是每次观察的截图**。
- 本插件的截图链路：`screencapture -x -C -R <union> -t jpg`（Retina 2x）→ `sips -Z 1280` 只缩长边 + q80 重编码 → 作为附件入上下文。实测 2558×1639 → 1280×820，图片 token 约降到 1/4。
- 坐标始终按原图归一化，缩放不改变点击精度。
- 动作校验：动作后截图 sha1 与上一张相同（且动作有等待）时标 `suspected_noop` 并追加 `note`，提示词里同步要求「先验证目标、无变化换路、同一失败动作最多重试两次」。
- 策略提示词：从上游约 8.4KB 精简到约 3.9KB（`lib/policy-slim.js`），每请求少约 1.3K token；坐标段仍是上游原文。
- 稳定性：截图存储失败降级为纯文本观察（`screens[].imageError`），跨屏窗口带 `screens[].clipped` / `visibleBounds` / `sourceBounds`，工具结果带 `actionEffect`。
- AX 快照：原生 App 的侧栏/按钮/菜单直接以文本给出（约 1KB/窗口、几十个节点），比同样的截图便宜，也避免「按钮名字靠视觉猜」；只在 AX 助手可用且树足够深时附加，否则静默跳过。

## 目录结构

```
dsh-operator/
├── index.js                    # 插件入口：原生 helper 执行位自愈 + 转发上游导出
├── cordis.patch.yml            # 三行全局挂载 + config
├── lib/
│   ├── capture-downscale.js    # 截图缩放 / 重编码（本仓库代码）
│   ├── policy-slim.js          # 精简策略提示词（本仓库代码）
│   ├── ax-observer.js          # AX 文本快照格式化 / 降级（本仓库代码）
│   ├── macos-query.js          # 窗口 / 显示器查询（调 AX 助手 --list-windows）
│   ├── audit-log.js            # 无内容审计日志（脱敏 + 5MB 轮转）
│   ├── failure-store.js        # 失败样本库（分类/脱敏/轮转/汇总）
│   ├── operator-tools.js       # 扩展工具：list_windows / screenshot_window / verify_state / ax_press / ax_set_value / ax_scroll / ax_menu / zoom_region
│   ├── bin/ax-snapshot         # 预编译 AX 助手（macOS 通用二进制：arm64 + x86_64）
│   └── computer-use/           # vendored：上游 dsh-orb dist/computer-use
├── scripts/
    ├── fetch-upstream.sh        # 拉取上游 tarball 供人工 diff（不覆盖 lib/computer-use）
    ├── ax-helper.swift          # AX 助手源码（build-ax-helper.sh 编译）
    ├── build-ax-helper.sh       # 编译 AX 助手到 lib/bin/ax-snapshot
    ├── check-p0.mjs             # P0 冒烟检查（策略体积、字段、fork 状态）
    ├── test-shrink.mjs          # 截图缩放冒烟测试
    ├── test-ax.mjs              # AX 快照格式化 / 降级测试
    └── test-operator.mjs        # 扩展工具 / 审计日志测试
├── client/client.js            # Web 客户端卡片（tool.call.toolview 行视图，手写无构建链）
├── .github/workflows/ci.yml    # CI：macOS runner 上 build helper + npm test
├── test/                       # node:test 测试（含失败样本库 / 场景矩阵 / doctor / 客户端声明）
└── bench/                      # 基准：tasks.json + scenarios.json（15 场景骨架）+ results/*.json
```

> 本地开发提示：`dsh plugin add file:...` 会把包装成硬链接。若用会替换 inode 的编辑器改文件
> （很多 GUI/工具会写临时文件再 rename），安装副本可能仍是旧内容。改完核对一下：
> `cmp -s lib/ax-observer.js ~/.dsh/profiles/desktop/node_modules/dsh-operator/lib/ax-observer.js`，
> 不一致就 `cp -f` 过去，或干脆 `remove` + `add` 重装一次。

测试与基准：

- `test/*.test.mjs` 用 node:test（25 个文件、146 项）：AX 格式化/降级、审计脱敏与轮转、策略体积、窗口过滤、扩展工具执行路径（含错误注入与取消）、截图缩放、bench 解析。
- `test:coverage` 用 Node 内建覆盖率（`--experimental-test-coverage`，不需要 c8）；自研 `lib/` 行覆盖 91.65%、分支 74.60%、函数 86.49%（vendored 与脚本不计入目标）。
- `bench/` 是脚本化基准：`bench/tasks.json` 定义 5 个真机任务与验收口径，`bench/results/*.json` 存历史结果，`npm run bench -- report` 出对比表、`npm run bench -- check` 校验数据自洽。

## 开发

```bash
node --check index.js
node scripts/test-shrink.mjs                    # 13 项断言
node scripts/check-p0.mjs                       # P0 冒烟检查
node scripts/test-ax.mjs                        # AX 快照 / 降级测试
node scripts/test-operator.mjs                  # 扩展工具 / 审计日志测试
node --test test/*.test.mjs                   # node:test 测试（146 项）
node scripts/bench.mjs check                    # 基准数据自洽校验
npm test                                        # 旧四套 + bench check + node:test 一起跑
npm run doctor                                  # 环境自检（9 项）
npm run failures                                # 失败样本汇总
npm run test:coverage                           # 覆盖率（Node 内建，不需要 c8）
npm run bench -- report                         # 基准对比表（A / A2 / B）
./scripts/build-ax-helper.sh                    # 重新编译 AX 助手（macOS）
bash -n scripts/fetch-upstream.sh
```

上游发布新版本时（fork 手动对照，见 docs/FORK.md）：

```bash
./scripts/fetch-upstream.sh 0.2.1   # 拉到 /tmp 后人工 diff，不会改动仓库
node scripts/test-shrink.mjs
```

## 版本

- **0.11.0** — 0.11 第一批（可用性与可运维）：失败样本库（`lib/failure-store.js`，分类 + 脱敏 + 5MB 轮转，默认开）、`npm run failures` 汇总 CLI、`npm run doctor` 9 项环境自检、`bench/scenarios.json` 15 条场景矩阵骨架 + 校验测试、GitHub Actions CI（macOS runner：build helper + 全量测试）。失败样本是 JS 改动，需重启 App 后生效。
- **0.10.6** — 修 0.10.5 的 `const captureRegion` 被循环重新赋值导致 observe 抛 `Assignment to constant variable` 的真 bug；新增静态守卫测试（并行断言 + 禁止循环内重新赋值）。
- **0.10.5** — 观察链路并行化：AX 快照与屏幕截图并行启动（AX spawn 实测 60–80ms，原本串在截图之后），一次观察省一次串行等待；daemon 常驻据此继续暂缓（收益 <100ms/次，不值子进程生命周期风险）。
- **0.10.4** — Windows/Linux 守卫：扩展工具跳过时打印明确警告；`sips` 降采样只在 darwin 执行，非 macOS 原样返回截图（未在 Windows 真机验证）。
- **0.10.3** — 修 `ax_press`/`ax_set_value` 带 `expect_role` 时被「自动选滚动容器」分支抢走的问题；滚动没找到容器时改为明确报错（不再静默退回整棵快照）；自动选容器输出带 `resolved` 标记。
- **0.10.2** — `ax_scroll` 支持省略 index：按 `expect_role`/`expect_title` 在新鲜树里自动选面积最大的滚动容器（输出 `resolved` 标记），解决滚动容器被匿名过滤/排在 120 节点外时找不到索引的问题。
- **0.10.1** — `ax_press` / `ax_set_value` 支持「索引漂移按 role/title 自动重定位」（带 `resolved` 标记，漂移超过 16 个节点仍拒绝）；新增 `ax_scroll`（AX 滚动动作，不支持时提窗 + 全局滚轮回退）；AX 快照匿名容器节点上限 40（超限裁剪并标 `truncated`）。daemon 常驻推迟到 0.10.2。
- **0.10.0** — 新增 `ax_set_value`（后台 AX 写原生文本框，secure 字段拒绝）、`ax_menu`（按菜单路径后台触发，危险路径需 `confirm: true`）；AX 助手改为通用二进制（arm64 + x86_64）；AX 快照加 24000 字符正文预算（异常大树截断并标 `truncated`）。
- **0.8.0** — 新增 `zoom_region`：局部区域原生分辨率放大截图，读小字/细节不用整屏重截。
- **0.7.0** — 新增 `ax_press`（后台 AXPress，按快照 index 命中并校验 role/title）；合并一次观察里的两次 JXA（前台缓存，每步省 100–200ms）。
- **0.6.2** — 修正浅 AX 树阈值：改为按格式化后实际保留的节点数判断（原来按原始节点数，Electron/Web 浅树仍会被附带）。
- **0.6.1** — 修复 0.6.0 的加载失败（`screenshot_window` 输出 schema 的嵌套 `image` object 缺 `additionalProperties`，DSH schema 编译器直接拒绝，插件整体不加载）；`test-operator.mjs` 加同类 schema 形状断言。
- **0.6.0** — 补齐审计剩余项：`list_windows`（窗口/显示器/前台 App，多屏显式标注）、`screenshot_window`（按窗口截图，绕开多窗口并集）、`verify_state`（谓词轮询：window_title / frontmost_app / app_running / ax_text / ax_element，只返回事实）、无内容审计日志 `~/.dsh/dsh-operator/audit.jsonl`、AX 文本带 `schema_version=1`、浅 AX 树阈值 `axMinNodes`（默认 16）。
- **0.5.3** — 修复 AX 坐标空间：多窗口截图时按截图区域（screen.bounds）归一化，避免多窗口时坐标偏移。
- **0.5.2** — 修复 AX 观察拿不到 pid（`foregroundFromFrontmost` 把 pid 丢了，AX 助手从不运行）。
- **0.5.1** — 修复 0.5.0 的 AX 文本未进入工具输出：工具结果是 `resultBlocks` 从 screens 重建的，AX 改为挂在观察结果的 `axText` 字段并全链路透传。
- **0.5.0** — 原生 App 观察附 AX 文本快照（`lib/ax-observer.js` + `lib/bin/ax-snapshot`）：侧栏/按钮/菜单直接给角色、标题、值与 0–1000 位置，Web/Electron 自动退回纯视觉；`Config` 新增 `axObservation` / `axMaxNodes`。
- **0.4.1** — 修复 0.4.0 的 schema 回归（`screens[].image.required: false` 在 DSH schema 里非法，导致插件加载即失败、GUI 工具全部消失）；`check-p0.mjs` 增加回归断言。
- **0.4.0** — 按源码审计落地 P0：策略提示词 8.4KB → 3.9KB、截图存储失败降级为纯文本观察、跨屏窗口 `clipped` 元数据、结构化 `actionEffect`、工具名冲突检测。
- **0.3.2** — 修复 `open_app` 激活已运行 App：JXA 没有 `activateWithOptions_` 桥接、中文显示名 `open -a` 也找不到，改走 `open -b <bundleId>`。
- **0.3.1** — 修复 `list_apps` 恒为空 / `open_app` 无法激活已运行 App（JXA 的 `activationPolicy` 是字符串，上游用 `!== 0` 比较）。
- **0.3.0** — 更名 `dsh-operator`（原 `dsh-orb-computer-use`），对外发布。
- **0.2.2** — 截图缩放/重编码 + 动作校验提示 + 提示词纪律。
- **0.2.1** — 改为 host 层全局挂载（不再依赖 agent preset）。
- **0.2.0** — 从 dsh-orb 抽出 computer-use 能力层，preset 形态首发。

- **0.12.0** — 复杂度分层与计划器：新增 `task_profile`（simple/standard/complex 三档，给出步数预算/是否先规划/校验节奏）、`plan_create`/`plan_update`（计划落盘 `~/.dsh/dsh-operator/plans/<id>.json`，步骤状态可跨轮次推进）；`bench/scenarios.json` 扩到 32 条（L0/L1/L2/异常各 8）；扩展工具 19 个；测试 126 项。JS 改动，需重启 App 后生效。

- **0.12.1** — 步骤执行器：`skill_run`（回放技能库里的工具序列）与 `plan_run`（按计划推进 pending 步骤并写回状态）；`lib/executor.js` 只允许本插件扩展工具、失败即停可配、dryRun 预览、结果只留短摘要；扩展工具 19→21；测试 132 项。JS 改动，需重启 App 后生效。

- **0.12.2** — 修 `skill_run`/`plan_run` 的 dryRun 输出含未声明字段 `argsPreview` 被 DSH 校验拒绝；`plan_run` 在没有 pending 步骤时返回明确成功（不再抛 `non-empty steps array is required`），dryRun 只预览 pending/running 步骤。

- **0.12.3** — 场景跑分工具：`npm run scenarios -- list|sheet|record|report`（32 条场景按层筛选、生成 markdown 跑分表、记录 JSONL 并汇总成功率/动作数/耗时/成本/失败分类）；`lib/scenarios.js` 纯函数 + 4 项测试。

- **0.13.0** — 状态与计划可见性：`operator_status`（版本/配置/技能数/计划数/失败样本/审计计数，用于自诊断）、`plan_list`（列出计划与完成进度）；扩展工具 21→23；`lib/status.js` + 2 项测试，`npm test` 138 项。

- **0.13.1** — 修 `operator_status` 输出缺 `dataDir` 声明导致 DSH 报 `returned invalid output`；补「返回字段必须全部在 output schema 声明」回归测试。

- **0.13.2** — 过程反馈（host 侧）：`plan_run` 返回 `totalSteps/doneSteps/nextStep` 并在文本里显示 `n/N done`；`operator_status` 追加「active plans」提示（下一次该跑哪个计划）。

- **0.13.3** — `operator_status` 显示真实版本（从 package.json 注入）；新增 `plan_delete` 工具（24 项扩展工具）。

- **0.14.0** — 策略段加入「Operator protocol」：多应用/登录/长任务先 `task_profile`（complex → `plan_create`+`plan_run` 逐阶段验证，simple 直接做）；优先复用 `skill_*`；浏览器优先 `browser_dom_*`（先 `browser_dom_probe` 探通道）；`operator_status` 作自诊断入口。

- **0.14.1** — `task_profile` 分层改进：多应用（≥2 个 App 线索）+3 动作 + 多个连接词会显著加分，跨应用任务不再误判 simple；新增 2 项回归测试。

- **0.15.0** — Web 客户端卡片：`client/client.js`（手写、无构建链）给本插件的 11 个自定义工具注册紧凑行视图（工具名 / 状态点 / 一行摘要，点击展开参数与结果全文）；`package.json` 增加 `dsh.client = { platform: "web" }` 与 `exports["./client"]`；只依赖外壳的 `react` 基座，不引入 UI primitives，渲染失败降级为工具名+状态。

- **0.15.1** — 客户端卡片改为**无 hooks**实现（原生 `<details>` 展开）：测试断言禁止 `useState/useEffect/...`。原因：宿主可能以普通函数方式调用 view，hooks 会触发 `Invalid hook call` 导致卡片空白；同时保留 try/catch 兜底（异常时显示 `card error: …` 而不是整卡消失）。`npm test` 147 项。

- **0.15.2** — 修卡片标题总是 `operator`：工具名应取 `props.toolName`（`block` 上没有 `toolName`），现在会显示 `Task profile` / `Operator status` / `Run plan` 等标签；`npm test` 148 项。

- **0.15.3** — 卡片覆盖扩到浏览器 DOM 工具（`DOM snapshot` / `DOM click` / `DOM fill`，连同 probe 共 14 个工具）；摘要去掉重复的 `tool: ` 前缀（如 `Task profile` 不再显示 `task_profile:` 开头）。`npm test` 149 项。
- **0.16.0** — 发布工程：`npm run release -- <version>` 一条命令完成「校验 → 改版本 → 全量测试 → commit → tag → push（可选同步安装副本 + doctor）」；新增 `docs/RELEASE.md` 发布清单与 `docs/COMPATIBILITY.md` 兼容矩阵。`npm test` 154 项。

- **0.17.0** — v2 工具面收敛第一步：统一注册表（扩展 24 工具 + fork 14 工具合成 registry）；新增强工具 `cu_observe`（action = screenshot / windows / window_screenshot / zoom / verify，旧工具名保留过渡）。`npm test` 159 项。

- **0.17.1** — 修 `cu_observe` 合并入参时的 defineTool 编译态 schema（`parameters` 已是 JSON Schema，需归一化回参数映射；且 DSL 只接受 `required: true`）。`npm test` 160 项。

- **0.18.0** — 工具面收敛第二步：新增 `cu_act`（9 个动作：click / drag / scroll / input / hotkey / ax_press / ax_set_value / ax_menu / ax_scroll），显式参数并集 + 按 action 运行时必填校验；客户端卡片覆盖 `cu_observe`/`cu_act`。

- **0.18.1** — 修 `cu_act` 参数里的 `minimum/maximum`（参数 DSL 不支持）；发布流程固定为「先 headless 引导预验，再让用户重启」。

- **0.18.2** — 修 `cu_observe` 入参必填串味：合并成员工具的 `required` 被带进并集，导致 `windows/screenshot` 也强制要 `window_id/kind`；改为合并后全部可选，必填按 action 在 `requiredByAction` 校验。

- **0.20.0** — 加载预检固化：新增 `scripts/preflight.mjs`（`npm run preflight`）——在**隔离的临时 DSH_HOME** 里用 headless profile 真实引导插件，`JsonSchemaError`/`plugin apply failed` 等加载错误直接判失败；`release` 流程在测试后自动跑预检（`--skip-preflight` 可跳过，dsh 缺失时自动 skip）。起因：0.10.5 / 0.17.0 / 0.18.0 三次加载问题都是重启后才暴露。`npm test` 164 项。

- **0.21.0** — 新增 `window_move`：AXPosition/AXSize 后台移动/缩放原生窗口（按 `pid` 或 `window_title` 定位，不抢前台、不动光标；先 size 后 position，适配 Finder 的位置夹取）。用途：把两个窗口摆成并排后再做跨窗拖拽/对照操作（L2-05 的前置能力）。`npm test` 164 项。

- **0.21.1** — 修 `window_move` 的 render 契约：返回值必须是内容块数组（`[{type:"text",...}]`），而不是 `{card,...}` 对象；补「render 返回文本块数组」回归断言。`npm test` 164 项。

- **0.21.2** — `verify_state` 失败现场可读化：`window_title` 未命中时回显当前可见窗口标题、`app_running` 回显可见 App 列表、`ax_text`/`ax_element` 未命中时回显 AX 快照里的样例标题（各取前 3 个），把「假超时」从盲猜变成可判断。`npm test` 165 项。

- **0.21.3** — `window_move` 支持布局预设：`layout` 取 `left-half`/`right-half`/`top-half`/`bottom-half`/`maximize`/`center`，按主屏可用区域（顶部让出 28pt 菜单栏）计算 frame；`center` 可用 `width`/`height` 指定窗口尺寸。并排两窗从 3+ 步压到 1 步；`window_move` 的 `x/y/width/height` 改为在无 `layout` 时才必需。样例标题去重（`[...new Set(titles)]`）。`npm test` 169 项。

- **0.21.4** — `window_move` frame 回读复核：写入后用 helper 返回的实际 frame 与请求比对，偏差超过 2pt 时自动重试一次，并在结果中标注 `retried`；render 追加「frame re-applied after first attempt differed」提示。用于兜住偶发首次 AXSize 不生效（App 自身夹取尺寸时重试无害，仍会如实回显最终 frame）。`npm test` 170 项。

- **0.21.5** — Windows/Linux 守卫做厚：新增 `lib/platform.js`（`areExtendedToolsSupported` / `extendedToolsSkipReason`），`operator-tools` 注册与 `operator_status` 共用同一判断与文案（状态里新增 `extendedToolsSupported` 字段与「macOS-only」说明）；非 darwin 上 `doctor` 不再把「AX helper 不存在」判成致命（改为「仅 macOS，跳过」），避免 Windows 用户误判；补平台单测。基础 GUI 工具仍走 vendored koffi 后端（Windows：GDI 截图 + SendInput；Linux 无）。`npm test` 173 项。

- **0.21.6** — 客户端富卡片：`ROWS` 扩到 16 个工具，`richSummary` 为浏览器通道/DOM 快照/技能列表/状态聚合提供结构化摘要（通道 ready 状态、links/controls 计数、技能名+步数、版本+计数行），并用 `data-tone`/`extra` 明细行区分警示与正常；失败卡片留到 0.21.7 随工具一起上。`npm test` 174 项。

- **0.21.7** — 失败样本查询闭环（PLAN 0.11-5 最小版）：新增 `failure_list` 工具——只读列出 `~/.dsh/dsh-operator/failures/` 的脱敏失败样本，返回总数、按 kind/tool 汇总、最近记录（tool/kind/message/时间）与每条 kind 的下一步提示；args 只保留长度、不落原文。`operator_status` 的 `failureFiles/failureRecords` 计数不变；客户端为 `failure_list` 加卡片（`N failure(s) · by kind …`，零样本显示 `no failures`）。`scripts/test-operator.mjs` 补脱敏/归类/提示断言。`npm test` 174 项。

- **0.21.8** — 多动作批处理（PLAN 0.11-1 最小版）：新增 `ax_batch` 工具，一次调用执行 2–12 个标量 AX 动作（`ax_press`/`ax_set_value`/`ax_menu`/`ax_scroll`），首错即停（异常、`pressed:false`、`ok:false` 都算失败），丢弃中间截图只回每步摘要（`N/M ok`、失败步号、逐步 note），适合「一次观察后回放已知点击序列」；客户端加「AX batch」卡片（`N/M step(s) ok`，失败附 `failed at step K`）。风控说明：`steps` 是 array-of-object，靠 `npm test` 与 preflight 双重验证 DSH 参数 DSL 是否接受；若未来 DSL 收紧则回退为逐动作调用。`npm test` 175 项。

- **0.21.9** — 多动作批处理正式版（PLAN 0.11-1）：`ax_batch` 动作面扩到 8 种（AX `ax_press`/`ax_set_value`/`ax_menu`/`ax_scroll` + fork `click`/`scroll`/`input`/`hotkey`，用 `x`/`y`/`text`/`keys`/`scroll_level` 等字段表达），失败判定沿用异常、`pressed:false`、`ok:false`。解析改为 **handlers 优先、`computerUseToolDefs` 兜底**（修 0.21.8 中自研 AX 工具不在 fork 工具表、运行时可能误报 `not registered` 的隐患）。「一次观察复用」语义明确：先 `cu_observe`/AX 快照观察一次，再用批处理回放已知序列，中间截图丢弃、只回逐步摘要。`npm test` 176 项。

- **0.21.10** — 失败样本归纳报告（PLAN 0.11-5 完整版）：`lib/failure-store.js` 新增 `KIND_SUGGESTIONS` / `suggestForKind()` / `renderFailureReport()`——把失败计数升级为 markdown 报告（总条数、按 kind、**策略与下一步**、按工具/消息/天、最近样本），每类失败带可执行建议（guard 拦截怎么办、超时先 recapture、定位失败如何刷新 AX/改 expect_role、能力不可用查权限等）；`scripts/failures.mjs` 增 `--report`（打印 markdown）与 `--write [path]`（默认 `~/.dsh/dsh-operator/failure-report.md`），可接 cron 定期留档。`npm test` 177 项。

- **0.19.0** — 旧工具名过渡开关：配置 `legacyToolNames`（默认 `true`）；设为 `false` 时被 v2 覆盖的 14 个旧工具不再直接出现在工具列表，但仍留在 registry 里供 `cu_observe`/`cu_act` 分派与 skill/plan 回放。被覆盖的旧名：`screenshot` `list_windows` `screenshot_window` `zoom_region` `verify_state` `click` `drag` `scroll` `input_text` `hotkey` `ax_press` `ax_set_value` `ax_menu` `ax_scroll`。`npm test` 161 项。

## 路线图

- 方向与 v2 方案：[docs/PROJECT-2026-11.md](docs/PROJECT-2026-11.md)（立项/调研/架构/排期，2026-11）
- 兼容性矩阵：[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)（DSH 版本 / 平台 / 运行时）
- 发布流程：[docs/RELEASE.md](docs/RELEASE.md)（一条命令发版）
- 场景矩阵真跑记录：[docs/SCENARIOS-2026-11.md](docs/SCENARIOS-2026-11.md)（32/32 全过，含 window_move/ax_menu 双窗口拖拽）
- v1 路线图与已完成项：[docs/PLAN-2026-11.md](docs/PLAN-2026-11.md)

完整计划（0.9 / 0.10 / 0.11、架构评审、借鉴 vs 自研、测试矩阵）见 [docs/PLAN-2026-11.md](docs/PLAN-2026-11.md)。

- 用 5 类真实任务（Finder、系统设置、浏览器、办公 App、多步跨应用）记录成功率 / token / 耗时的基线。
- zoom 局部放大、历史截图轮转、多屏 DPI 修正（`list_windows` 已给出显示器 bounds/scale，剩下是截图侧）。
- Windows 侧验证与做厚（当前仅 vendored 基础工具；`list_windows` / `screenshot_window` / `verify_state` / `ax_press` 只在 macOS 注册）。
- 可选：官方 seam provider 适配层（把本插件的能力包成 provider，供只用官方 seam 的组合选择）。

## 上游与许可

MIT。`lib/computer-use/` 与工具提示词 fork 自 [dsh-orb](https://github.com/mini-yifan/dsh-orb-cordis) v0.2.0（Copyright (c) 2026 mini-yifan，MIT）；相对上游的改动见 [NOTICE](NOTICE) 与 [docs/FORK.md](docs/FORK.md)。
