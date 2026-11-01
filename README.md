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
- **代码可自持**：MIT。能力层 fork 自 [dsh-orb](https://github.com/mini-yifan/dsh-orb) v0.2.0 后直接收编进本仓库（无上游补丁链），199 项测试 + CI 全绿，欢迎自己改。

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
| 观察 | `screenshot`（截图+前台信息）、`wait` / `long_wait`、`cu_observe`（按窗口读 AX/截图）、`screenshot_window`、`list_windows`、`zoom_region`（局部原生分辨率放大） |
| 鼠标 / 键盘 | `click`、`drag`、`scroll`、`input_text`、`hotkey`、`long_press`、`cu_act`（后台动作） |
| AX 动作 | `ax_press`、`ax_set_value`、`ax_scroll`、`ax_menu`、`ax_batch`（2–12 个动作一批） |
| 窗口 / 应用 | `list_apps`、`open_app`（前台激活）、`cua_launch`（后台启动，不置顶）、`open_in_browser`、`open_in_finder`、`window_move`（含 left/right-half 等预设） |
| 浏览器 DOM | `browser_dom_snapshot`、`browser_dom_click`、`browser_dom_fill`、`browser_dom_probe`（Chrome/Safari，AppleScript 优先，CDP 回退） |
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

- macOS 为主：Windows 的 koffi 基础工具未真机验证；扩展工具（AX 系列）只在 macOS 注册。Linux 支持不保证。
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
npm test            # 199 项测试
```

会话里也可以直接问 `operator_status`（版本/工具面/审计行数），或列出失败样本（`failure_list`）。

## 文档

- [项目说明与决策记录](docs/PROJECT-2026-11.md)
- [兼容性与平台边界](docs/COMPATIBILITY.md)
- [cua-driver 人机并行](docs/CUA-DRIVER.md)
- [fork 说明](docs/FORK.md)
- [发布与版本](docs/RELEASE.md)
- [场景/验收矩阵](docs/SCENARIOS-2026-11.md)
- [seam provider 适配说明](docs/SEAM-PROVIDER.md)
- [开发计划](docs/PLAN-2026-11.md)

## 更新记录

按版本倒序，只列近期版本；完整历史见 [Releases](https://github.com/yffo/dsh-operator/releases) 与 tag。

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

MIT。`lib/computer-use/` 与工具提示词能力层 fork 自 [dsh-orb](https://github.com/mini-yifan/dsh-orb) v0.2.0（MIT），本仓库做了裁剪与工程化改造，版权与出处见 [NOTICE](NOTICE) 与 [docs/FORK.md](docs/FORK.md)。
