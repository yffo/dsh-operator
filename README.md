# dsh-operator

> 给每个 DSH 会话一双手。

[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2%20%3C0.3.0-8A2BE2)](https://github.com/deepseek-ai)
[![node](https://img.shields.io/badge/node-%3E%3D22.18-339933)](https://nodejs.org)

**全局 Computer Use 插件**：装进 desktop profile 后，任何会话（标准 / PTC / 极简 / 创造）都直接拥有 13 个桌面 GUI 工具和后台 `code_agent`——不用新建会话，也不用切换模式。

能力层裁剪自 [dsh-orb](https://github.com/mini-yifan/dsh-orb-cordis) v0.2.0 的 `dist/computer-use`（MIT）：去掉悬浮球、Electron helper、语音和设置页，只留计算机操作，并补了两处工程化改进：

- **观察截图自动降 token**：Retina 2x 截图交给模型前先缩到长边 ≤ 1280、重编码 JPEG q80（`sips`，失败回退原图）；
- **动作失败有校验提示**：动作后截图与上一张逐字节相同且动作有等待时，工具结果追加 `note`，配合提示词纪律减少「瞎重试」。

定位：与现有同类 DSH 插件 / 产品**齐平或领先**。三项硬指标（任务成功率 / 单任务 token / 单任务耗时）会以可复现的基线持续补测。

## 和其他方案的区别

| 方案 | 挂载方式 | 外部依赖 | 观察成本 | 备注 |
| --- | --- | --- | --- | --- |
| **dsh-operator**（本插件） | 全局（host 层） | 无：纯 JS + macOS 自带 `screencapture` / `osascript` | 截图先降 token 再入上下文 | vendored 代码可审计，可随上游 `sync-from-orb.sh` 更新 |
| 官方实验包 `dsh-computer-use` + `cua-driver-native` | 全局 | Cua Driver 原生 SDK / 二进制 | 原图 | 官方 seam，native 崩溃会带走宿主进程 |
| 社区 `dsh-computer-use@0.3.x` 等 | 全局 | 多数需要外部 `cua-driver` 或仅 macOS AX | 原图 | 工具数、平台覆盖不一 |
| preset 形态（本插件 0.2.0） | 会话级 | 无 | 原图 | 必须新建会话并选「Computer Use 模式」 |

## 能力

| 类别 | 工具 |
| --- | --- |
| 观察 | `screenshot` |
| 鼠标 | `click`（左/右、双击、修饰键）、`drag`、`scroll`、`long_press` |
| 键盘 | `input_text`（可替换原内容、回车提交）、`hotkey` |
| 等待 | `wait`、`long_wait` |
| 应用 / 文件 | `list_apps`、`open_app`、`open_in_browser`、`open_in_finder` |
| 后台会话 | `code_agent`、`code_agent_status`、`code_agent_stop` |

每次工具调用后自动附带新的前台窗口截图，坐标用 0–1000 归一化（Retina / 多倍屏都按比例，不是像素）。

`code_agent` 把一段独立的读文件/写文件/搜索工作丢给后台标准模式会话（会出现在侧栏），适合「前台要操作、后台要查资料」的任务。

## 为什么是全局

DSH 的 agent preset 是会话模板：会话创建时钉死工具集和提示词（保证请求前缀稳定，也避免普通会话被 GUI 工具污染）。而 **host 层 `ctx.tools.register()` 注册的工具是「全局工具」，由所有 agent 继承**——官方 Computer Use 也是以部署级 provider 的方式挂载一次。

本插件在 profile 层挂三行（主插件 + `code_agent` 注册表 + `code_agent`），所以任何会话直接可用；想收紧时用 `ctx.tools.restrict(...)` 在会话侧做白名单，而不是拆插件。

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

## 安全

- **安装即授权**：GUI 工具在工具内部不做逐次确认，所有会话都拥有桌面操作能力。敏感任务请在会话里明确约束（例如「只读、不要点确认/支付」）。
- **截图会上传**：观察截图作为附件进入模型上下文，会发到当前模型服务商（DeepSeek 账户）。敏感窗口请先关闭或遮挡。
- **权限继承 App**：插件以 DeepSeek Harness 的桌面权限运行（屏幕录制、辅助功能、控制其他 App）。代码在本仓库可审计，vendored 目录与补丁脚本都在。
- **无网络上报**：只用本机文件与系统命令，插件自身不发送遥测。

## 已知限制

- **平台**：以 macOS 为主；Windows 上 vendored 代码有 koffi 后端，但本仓库未验证；Linux 不提供 GUI 操作。
- **多屏 / 混合 DPI**：截图取「前台 App 窗口 union」，跨屏或缩放不一致时可能裁错（上游 dsh-orb issue #38），本插件未修。
- **纯视觉定位**：UI 变化、遮挡、动画过渡会导致定位失败；校验提示只能减少浪费，不能保证成功。适合可重复、可验收的操作。
- **首次授权**：屏幕录制 / 辅助功能需要用户手动在系统设置里允许；未授权时截图与输入都会失败。
- 上游代码按「照搬 + 幂等补丁」维护，上游大改时 `sync-from-orb.sh` 可能需要跟着调锚点。

## 工作原理：token 花在哪

- 13 个工具的 schema 是固定前缀，命中缓存后边际成本很低；**真正的大头是每次观察的截图**。
- 本插件的截图链路：`screencapture -x -C -R <union> -t jpg`（Retina 2x）→ `sips -Z 1280` 只缩长边 + q80 重编码 → 作为附件入上下文。实测 2558×1639 → 1280×820，图片 token 约降到 1/4。
- 坐标始终按原图归一化，缩放不改变点击精度。
- 动作校验：动作后截图 sha1 与上一张相同（且动作有等待）时标 `suspected_noop` 并追加 `note`，提示词里同步要求「先验证目标、无变化换路、同一失败动作最多重试两次」。
- 策略提示词：从上游约 8.4KB 精简到约 3.9KB（`lib/policy-slim.js`），每请求少约 1.3K token；坐标段仍是上游原文。
- 稳定性：截图存储失败降级为纯文本观察（`screens[].imageError`），跨屏窗口带 `screens[].clipped` / `visibleBounds` / `sourceBounds`，工具结果带 `actionEffect`。

## 目录结构

```
dsh-operator/
├── index.js                    # 插件入口：原生 helper 执行位自愈 + 转发上游导出
├── cordis.patch.yml            # 三行全局挂载 + config
├── lib/
│   ├── capture-downscale.js    # 截图缩放 / 重编码（本仓库代码）
│   ├── policy-slim.js          # 精简策略提示词（本仓库代码）
│   └── computer-use/           # vendored：上游 dsh-orb dist/computer-use
└── scripts/
    ├── apply-vendor-patches.mjs # 幂等补丁器（--check 只检查；补丁在 vendor-patches/*.json）
    ├── vendor-patches/p0.json   # 0.4.0 P0 补丁集
    ├── sync-from-orb.sh         # 从 npm 同步上游 dist/computer-use 并重打补丁
    ├── check-p0.mjs             # P0 冒烟检查（策略体积、字段、补丁幂等）
    └── test-shrink.mjs          # 截图缩放冒烟测试
```

## 开发

```bash
node --check index.js
node scripts/apply-vendor-patches.mjs --check   # 幂等性
node scripts/test-shrink.mjs                    # 13 项断言
node scripts/check-p0.mjs                       # P0 冒烟检查
bash -n scripts/sync-from-orb.sh
```

上游发布新版本时：

```bash
./scripts/sync-from-orb.sh 0.2.1   # 换掉 lib/computer-use 与 LICENSE，自动重打补丁
node scripts/test-shrink.mjs
```

## 版本

- **0.4.0** — 按源码审计落地 P0：策略提示词 8.4KB → 3.9KB、截图存储失败降级为纯文本观察、跨屏窗口 `clipped` 元数据、结构化 `actionEffect`、工具名冲突检测。
- **0.3.2** — 修复 `open_app` 激活已运行 App：JXA 没有 `activateWithOptions_` 桥接、中文显示名 `open -a` 也找不到，改走 `open -b <bundleId>`。
- **0.3.1** — 修复 `list_apps` 恒为空 / `open_app` 无法激活已运行 App（JXA 的 `activationPolicy` 是字符串，上游用 `!== 0` 比较）。
- **0.3.0** — 更名 `dsh-operator`（原 `dsh-orb-computer-use`），对外发布。
- **0.2.2** — 截图缩放/重编码 + 动作校验提示 + 提示词纪律。
- **0.2.1** — 改为 host 层全局挂载（不再依赖 agent preset）。
- **0.2.0** — 从 dsh-orb 抽出 computer-use 能力层，preset 形态首发。

## 路线图

- 用 5 类真实任务（Finder、系统设置、浏览器、办公 App、多步跨应用）记录成功率 / token / 耗时的基线。
- AX 树文本观察（省 token 又提精度）、zoom 局部放大、历史截图轮转、多屏 DPI 修正。

## 上游与许可

MIT。`lib/computer-use/` 与工具提示词来自 [dsh-orb](https://github.com/mini-yifan/dsh-orb-cordis) v0.2.0（Copyright (c) 2026 mini-yifan，MIT）；本仓库相对上游的裁剪与补丁见 [NOTICE](NOTICE) 和 `scripts/apply-vendor-patches.mjs`。
