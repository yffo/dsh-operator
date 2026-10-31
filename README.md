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
| **dsh-operator**（本插件） | 全局（host 层） | 无：纯 JS + macOS 自带 `screencapture` / `osascript` / 编译一次的本机 AX 助手 | 截图先降 token 再入上下文，原生 App 附 AX 文本 | vendored 代码可审计，可随上游 `sync-from-orb.sh` 更新 |
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
| 查询 / 验证 | `list_windows`（窗口 + 显示器 + 前台 App，含 window_id）、`screenshot_window`（只截指定窗口）、`verify_state`（轮询状态谓词，只报事实、不带图） |
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
| `auditLog` | `true` | 写无内容审计日志到 `~/.dsh/dsh-operator/audit.jsonl`（事件名 / 数量 / 布尔 / 耗时，不含截图、坐标、标题、输入文本） |

## 安全

- **安装即授权**：GUI 工具在工具内部不做逐次确认，所有会话都拥有桌面操作能力。敏感任务请在会话里明确约束（例如「只读、不要点确认/支付」）。
- **截图会上传**：观察截图作为附件进入模型上下文，会发到当前模型服务商（DeepSeek 账户）。敏感窗口请先关闭或遮挡。
- **权限继承 App**：插件以 DeepSeek Harness 的桌面权限运行（屏幕录制、辅助功能、控制其他 App）。代码在本仓库可审计，vendored 目录与补丁脚本都在。
- **剪贴板**：`input_text` 走「快照剪贴板 → 写入 → 粘贴 → 恢复」链路，结束后尽量恢复原剪贴板（恢复失败会清空，避免残留测试文本）；剪贴板内容不会进审计日志、不会额外上传，但粘贴目标 App 可能读取。
- **无网络上报**：只用本机文件与系统命令，插件自身不发送遥测。

## 已知限制

- **平台**：以 macOS 为主；Windows 上 vendored 代码有 koffi 后端，但本仓库未验证，且 `list_windows` / `screenshot_window` / `verify_state` / AX 快照只在 macOS 注册；Linux 不提供 GUI 操作。
- **多屏 / 混合 DPI**：观察截图取「前台 App 窗口 union」，跨屏仍可能裁错（上游 dsh-orb issue #38）；`list_windows` 会显式列出每个显示器的 bounds/scale 和每个窗口的归属，可用 `screenshot_window` 按窗口截图规避。
- **纯视觉定位**：UI 变化、遮挡、动画过渡会导致定位失败；校验提示只能减少浪费，不能保证成功。适合可重复、可验收的操作。
- **AX 只覆盖原生 App**：AX 树在 AppKit 原生应用里好用（系统设置、访达、备忘录、预览等），Electron / Web 应用（Chrome、Harness、微信）树很浅或不可见，少于 `axMinNodes`（默认 16）时自动不附、退回纯视觉。AX 助手是预编译的 macOS 二进制；换架构/平台需要 `pnpm run build:ax` 重新编译（需要 Xcode Command Line Tools）。
- **首次授权**：屏幕录制 / 辅助功能需要用户手动在系统设置里允许；未授权时截图与输入都会失败。
- 上游代码按「照搬 + 幂等补丁」维护，上游大改时 `sync-from-orb.sh` 可能需要跟着调锚点。

## 工作原理：token 花在哪

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
│   ├── operator-tools.js       # 扩展工具：list_windows / screenshot_window / verify_state
│   ├── bin/ax-snapshot         # 预编译 AX 助手（macOS arm64）
│   └── computer-use/           # vendored：上游 dsh-orb dist/computer-use
└── scripts/
    ├── apply-vendor-patches.mjs # 幂等补丁器（--check 只检查；补丁在 vendor-patches/*.json）
    ├── vendor-patches/p0.json   # 0.4.0 P0 补丁集
    ├── vendor-patches/p1.json   # 0.5.0 AX 观察补丁集
    ├── vendor-patches/p2.json   # 0.5.1 axText 透传
    ├── vendor-patches/p3.json   # 0.5.2 pid 透传
    ├── vendor-patches/p4.json   # 0.5.3 截图区域归一化
    ├── vendor-patches/p5.json   # 0.6.0 扩展工具 / 审计 / 浅 AX 阈值接线
    ├── sync-from-orb.sh         # 从 npm 同步上游 dist/computer-use 并重打补丁
    ├── ax-helper.swift          # AX 助手源码（build-ax-helper.sh 编译）
    ├── build-ax-helper.sh       # 编译 AX 助手到 lib/bin/ax-snapshot
    ├── check-p0.mjs             # P0 冒烟检查（策略体积、字段、补丁幂等）
    ├── test-shrink.mjs          # 截图缩放冒烟测试
    ├── test-ax.mjs              # AX 快照格式化 / 降级测试
    └── test-operator.mjs        # 扩展工具 / 审计日志测试
```

> 本地开发提示：`dsh plugin add file:...` 会把包装成硬链接。若用会替换 inode 的编辑器改文件
> （很多 GUI/工具会写临时文件再 rename），安装副本可能仍是旧内容。改完核对一下：
> `cmp -s lib/ax-observer.js ~/.dsh/profiles/desktop/node_modules/dsh-operator/lib/ax-observer.js`，
> 不一致就 `cp -f` 过去，或干脆 `remove` + `add` 重装一次。

## 开发

```bash
node --check index.js
node scripts/apply-vendor-patches.mjs --check   # 幂等性
node scripts/test-shrink.mjs                    # 13 项断言
node scripts/check-p0.mjs                       # P0 冒烟检查
node scripts/test-ax.mjs                        # AX 快照 / 降级测试
node scripts/test-operator.mjs                  # 扩展工具 / 审计日志测试
npm test                                        # 上面三套测试一起跑
./scripts/build-ax-helper.sh                    # 重新编译 AX 助手（macOS）
bash -n scripts/sync-from-orb.sh
```

上游发布新版本时：

```bash
./scripts/sync-from-orb.sh 0.2.1   # 换掉 lib/computer-use 与 LICENSE，自动重打补丁
node scripts/test-shrink.mjs
```

## 版本

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

## 路线图

- 用 5 类真实任务（Finder、系统设置、浏览器、办公 App、多步跨应用）记录成功率 / token / 耗时的基线。
- zoom 局部放大、历史截图轮转、多屏 DPI 修正（`list_windows` 已给出显示器 bounds/scale，剩下是截图侧）。
- Windows 侧验证与做厚（当前仅 vendored 基础工具；`list_windows` / `screenshot_window` / `verify_state` / `ax_press` 只在 macOS 注册）。
- 可选：官方 seam provider 适配层（把本插件的能力包成 provider，供只用官方 seam 的组合选择）。

## 上游与许可

MIT。`lib/computer-use/` 与工具提示词来自 [dsh-orb](https://github.com/mini-yifan/dsh-orb-cordis) v0.2.0（Copyright (c) 2026 mini-yifan，MIT）；本仓库相对上游的裁剪与补丁见 [NOTICE](NOTICE) 和 `scripts/apply-vendor-patches.mjs`。
