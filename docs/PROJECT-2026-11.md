# dsh-operator 立项书 + 技术方案 v2（2026-11）

> 状态：**正式**（2026-11-01 杨总确认：v2 演进式重构可行、工具面收敛由维护者定、反爬立场认可、决策确定即开工）
> 关联：`docs/PLAN-2026-11.md`（v1 路线图与已完成项）、`docs/FORK.md`、`docs/ai/2026-10-31-cu-benchmark.md`（A/B/A2/A3 基准）、`README.md`

## 0. 一句话定位

**v1**：给 DSH 全局挂载的「视觉优先 GUI 手」——13 个工具 + 截图降 token + 动作效果校验。
**v2**：从「能点屏幕」升级为「**可复用的桌面/浏览器操作员**」——按任务复杂度自适应、可沉淀技能、可回放、可审计、可在 DSH 内有可见的操作过程。

## 1. 立项

### 1.1 背景

v0.3 → v0.10.6 已证明内核可行：A 组 5 真实任务 15 步 / 约 86s / +¥0.19（0.10.3），比官方 provider（36 步 / 280s / +¥0.70）省 3× 成本与 2× 步数。但用户感知到的价值仍是「点得动」，而不是「**替我把事做完**」。竞品的差距也不在单点工具，而在：技能沉淀、浏览器能力、任务编排、过程可见性。

### 1.2 目标（Outcome）

| 编号 | 目标 | 可测指标 |
|---|---|---|
| G1 | 简单任务一次到位 | 5 类简单任务（打开/切页/输入/截图/查询）成功率 ≥95%，中位步数 ≤4，单任务 ≤40s |
| G2 | 复杂任务可编排 | 跨 3+ 步骤、2+ 应用的任务成功率 ≥80%，提供「计划→执行→校验」可见轨迹 |
| G3 | 技能可沉淀回放 | 同类任务第二次执行步数下降 ≥50%；技能可导出/导入/校验失效 |
| G4 | 浏览器可用 | DOM 级操作（读页/填表/点链接）+ 人工接管入口；反爬场景不静默失败 |
| G5 | 过程可见 | DSH 内实时显示「正在操作：…」卡片（当前步骤/目标窗口/耗时/失败原因） |
| G6 | 成本/时延不退化 | 简单任务截图相关 token 比 v1 再降 ≥30%；观察链路 P95 ≤300ms |

### 1.3 非目标（Non-goals）

- 不做通用 AGI、不做模型训练；智能来自「任务分层 + 技能库 + 校验回路」。
- 不做反爬规避（见 §4.5）；不做遥测/数据上报。
- 不做官方 Cua Driver 的替代品；seam 兼容只做可选取适配层。
- Windows/多屏在无硬件前不进主发布流程（保持「未验证」标注）。

### 1.4 用户与场景

- 主用户：杨总（DSH 桌面重度用户），日常：系统设置、Finder、备忘录、日历、浏览器查资料/填表、微信只读。
- 次用户：任何装了 dsh-operator 的 DSH 会话（开发/调研/运营）。
- 典型任务：①「打开系统设置看显示器排列并截图」②「在浏览器搜 X 并摘三条结果」③「把下载目录里今天的截屏归档到项目目录」④「每周一把某表单填一遍」⑤「出错时把窗口状态和日志摘给我」。

### 1.5 成功判据与验收口径

统一口径：**成功率 × 步数 × 耗时 × 会话费用**，同一任务在「0.10.6（基线）→ 新版本」两轮都跑，结果落 `docs/ai/*-benchmark.md`；误差来源（机器负载）用两次取中位数。发布前必须满足：无回归（基线任务成功率不降、步数不升 >10%）。

### 1.6 风险与对策

| 风险 | 对策 |
|---|---|
| 功能推全导致工具面/提示膨胀，反而更慢 | 分层工具面（§4.3）：默认只暴露一层，高级能力用 `capabilities` 开关；复杂任务由策略引导而非默认加载 |
| 反爬/风控导致浏览器场景失败 | challenge 检测 + 人工接管 + 合法会话（§4.5） |
| 单人维护不可持续 | v2 模块化 + 契约测试 + CI + 可回放资产（技能/失败样本/基准） |
| 平台碎片（多屏/Windows） | 适配器分层，未验证项统一 `⚠️ 未验证` 标记 |

## 2. 调研（2026-11-01 检索）

### 2.1 学术与基准

| 来源 | 关键结论 | 对本项目 |
|---|---|---|
| OSWorld（250 任务、真实桌面 VM，[2404.07972](https://arxiv.org/abs/2404.07972)） | CUA 在真实桌面任务上成功率仍低，长任务误差累积是主因 | 我们要做「步骤级校验」，不是一次点到底 |
| OSWorld-Pro（[2609.24890](https://arxiv.org/abs/2609.24890)，2026） | 过程级评测（67k+ 步级标注），单看终态会高估能力 | 我们的审计/基准应记录中间效应（actionEffect） |
| WebArena（[2307.13854](https://arxiv.org/abs/2307.13854)） | 自托管真实网站、确定性成功判据 | 浏览器场景要建确定性的验收断言 |
| Mind2Web（[2306.05949](https://arxiv.org/abs/2306.05949)）/ WebVoyager（[2401.13919](https://arxiv.org/abs/2401.13919)） | 真实网站泛化难，观测表示决定上限 | 视觉 + DOM 双通道比纯视觉稳 |
| SeeAct（[2401.01614](https://arxiv.org/abs/2401.01614)） | HTML 结构 + 视觉的 grounding 优于纯视觉；Set-of-Mark 对 Web 效果有限 | 浏览器用 DOM 索引/元素 ID，桌面用 AX 文本；不要只依赖截图 |
| Set-of-Mark（[2310.11441](https://arxiv.org/abs/2310.11441)） | 视觉标注能提升点击定位 | 桌面截图标注可借鉴（编号框） |
| An Illusion of Progress?（[2504.01382](https://arxiv.org/abs/2504.01382)） | 网页 agent 成绩被高估，轨迹质量/鲁棒性差 | 我们对外只报有证据的数字，标注口径 |

### 2.2 竞品/现状

| 项目 | 做法 | 我们学什么 / 不学什么 |
|---|---|---|
| browser-use（[github](https://github.com/browser-use/browser-use)） | 真实 Chrome + 技能/脚本沉淀 + 可嵌入 coding agent | 学：任务→脚本沉淀、可复用工作流；不学：把一切押在浏览器 |
| 官方 Cua Driver | native 引擎 + 完整 ActionResult 契约 | 学契约语义；不学其重引擎/单点故障（已审计） |
| 社区 dsh-computer-use / anionex | AX 文本树、guarded tools | AX 作为观察补充（已落地） |
| Computer Use 基线（Anthropic 文档） | 截图-动作-验证循环 | 与此一致；我们额外做降 token/效果判定 |

### 2.3 结论

1. 单点工具差异会被快速抹平；**资产（技能库、失败样本、基准、可审计性）**才是长期护城河。
2. 桌面与浏览器需要两条通道：桌面 = 视觉 + AX；浏览器 = DOM/可访问性 + 视觉兜底。
3. 反爬不是算法问题而是**协作问题**：检测、请求人工、复用合法会话；规避是死路。
4. 测试要从「点一下」升级到**场景矩阵**（简单/中等/复杂/错误/跨应用），否则无法证明准确率。

## 3. 现状与自研核心

### 3.1 v1 能力盘点（0.10.6）

工具 8 个：`click` / `input_text` / `hotkey` / `scroll` / `drag` / `screenshot` / `open_app` / `list_apps` + 扩展 `list_windows` / `screenshot_window` / `verify_state` / `ax_press` / `ax_set_value` / `ax_menu` / `ax_scroll` / `zoom_region` + `code_agent`；配置 10 项（懒观察/阈值/AX/guard/审计…）。

### 3.2 真自研 vs 补缺（诚实清单）

| 真自研（组合起来难复制） | 只是补缺（别当护城河） |
|---|---|
| 截图降 token 管线（1280/q80 + SOF 解析 + 失败回退） | 13 个基础工具（上游 MIT 骨架，已 fork） |
| `actionEffect` 前后截图 sha1 判定 + noop 不附图 | AX 文本观察（社区已有同类思路） |
| 多窗口坐标归一化（AX↔截图区域） | `list_windows`/`verify_state` 等查询工具（官方有同类概念） |
| 可回放资产：审计日志、基准 A/B/A2/A3、fork+契约测试 | guard 危险词（社区已有） |
| 零外部依赖 + 自编译 Swift helper（可重建） | AXPress/滚动（官方/社区有变体） |

**真护城河 = 上述自研技术 × 数据资产（技能库 + 失败样本 + 基准）× 工程纪律（可回放/CI/文档）**，而不是单个功能点。

### 3.3 是否彻底重构？

**结论：不做推倒重写，做「演进式 v2 重构」。**

理由：
- 现有内核（感知/动作/校验）经 3 轮基准验证，已有 79 项测试与真机数据；重写会丢掉调好的坐标/降采样/效果判定。
- 真正缺的是**上层**：规划器、能力分层、技能库、浏览器通道、UI 反馈。这些可以在现有内核上叠加。
- 重构方式：模块边界清理（`lib/perceive|plan|act|verify|skill|policy`）+ 工具面收敛 + 新增能力，每个阶段保持发布可用、可回滚。

## 4. v2 技术方案

### 4.1 复杂度自适应（用户核心诉求）

任务分四层，由**策略 + 工具描述**引导模型，而不是默认加载全部能力：

| 层 | 例子 | 默认流程 | 加载 |
|---|---|---|---|
| L0 单步 | 打开 App / 截屏 / 点一个已知按钮 | `observe → act`（或纯 AX 动作，不截图） | 基础 8 工具 |
| L1 小序列 | 切页 + 输入 + 校验 | `observe → 规划 2–4 步 → 逐步 act → verify_state` | + 校验工具 |
| L2 跨应用/长链 | 下载归档、填表、跨 App 搬运 | `plan → 执行 → 每步 effect 校验 → 失败回滚`；优先复用技能 | + 技能/批处理 |
| L3 未知/高风险 | 陌生网站、删除类 | 先 `observe` + 请求确认（guard）；必要时人工接管 | + 人工接管/面试 |

落地方式：
- `POLICY` 写「复杂度自评清单」（任务含几个明确步骤、是否跨应用、是否写数据、是否遇登录/验证码），模型据此选择层级；
- 工具 `cu_plan`（规划，可省略）与 `cu_verify`（统一校验）作为可选项，不强制；
- 简单任务默认**不附加**截图/AX（懒观察 + 浅树阈值已具备），复杂任务才升级观察密度。

### 4.2 模块划分（目标）

```
lib/
  perceive/   screenshot（降采样）、ax（快照）、windows、browser-dom
  act/        mouse、keyboard、axpress、menu、scroll
  verify/     effect（sha1）、state（谓词）、artifact（截图/文件）
  plan/       复杂度评估、步骤规划、失败回滚
  skill/      录制/存储/回放/失效检测
  policy/     guard、prompt、能力注册表
  audit/      事件日志（无内容）
  platform/   macos（现有）、windows（适配器占位）
```

### 4.3 工具面 v2（收敛 + 分层）

对外保持**少量强工具**（schema token 可控），内部 action 枚举扩展：

| 工具 | 覆盖 | 说明 |
|---|---|---|
| `observe` | 截图 / AX / 窗口列表 / 区域放大 | 合并 `screenshot`/`list_windows`/`zoom_region`/观察 |
| `act` | click / input / hotkey / scroll / drag / axpress / menu / scrollax / setvalue | 一个工具 + action 枚举，减少 schema |
| `app` | list / open / activate / quit(guard) | |
| `verify` | 谓词校验 / effect 判定 | |
| `skill` | list / save / run / delete | 新 |
| `browser` | open / read / click / type / extract / challenge | 新（DOM 通道） |
| `code_agent` | 保留 | |

兼容策略：v2 工具先以**新名字**并行注册（`cu_observe`/`cu_act`…），旧名保留一个版本过渡，README 标注 deprecation；`capabilities` 配置可选 `{ browser: true, skills: true, planner: true }`。

### 4.4 技能沉淀（browser-use 思路）

技能结构（`~/.dsh/dsh-operator/skills/<name>.json`）：

```json
{
  "schemaVersion": 1,
  "name": "archive-todays-screenshots",
  "target": { "platform": "macos", "apps": ["Finder"], "browser": false },
  "preconditions": [{ "kind": "dir_exists", "path": "~/Downloads" }],
  "steps": [
    { "tool": "app", "args": { "action": "open", "name": "访达" }, "expect": { "frontmost": "访达" } },
    { "tool": "act", "args": { "action": "click", "target": "...", "by": "ax", "title": "..." } }
  ],
  "verify": [{ "kind": "files_exist", "pattern": "..." }],
  "createdAt": "...", "source": "recorded|handwritten", "hitCount": 0
}
```

能力：`skill_save`（从审计轨迹提炼）、`skill_run`（逐步执行 + 每步校验，失败即停并返回第几步 + 现场截图）、`skill_list`（含 lastVerifiedAt / 失效原因）。失效检测：元素锚点（AX title/role、窗口标题）不存在时标记 stale，而不是盲点。

### 4.5 浏览器与反爬（合规立场）

- 浏览器通道优先用 **DOM/可访问性**（标签、角色、可点击元素），视觉兜底；这比纯截图更稳更省。
- **反爬不做规避**：Cloudflare/Turnstile、hCaptcha、短信/滑块等，检测到就**暂停并请用户接管**（DSH 内卡片提示「需要你完成人机校验」），完成后继续；会话复用用户自己的登录态，不伪造指纹、不绕验证码。
- 理由：规避不可靠、违反网站条款、有法律风险，且与「可审计」定位冲突。我们要的是「遇到风控会体面停下」，这本身就是可用性。
- 「像真人」：只做**节奏与可读性**（等待页面稳定、滚动可见、失败重试），不做指纹伪装。

### 4.6 DSH 内 UI 反馈（用户点名项）

现状：DSH Web 客户端给每次工具调用渲染卡片，自带 running/success/failure 状态（`dsh-client-ui-tool` 的 `tool.call.toolview` slot，按 wire 工具名注册）。

v2 做两件事：
1. **过程文案**：动作发起前，插件在工具结果/流式事件里带「正在操作：<窗口/控件>」，卡片即可显示（低成本）。
2. **自定义卡片插件**（`dsh-operator-ui`）：注册 `cu_act`/`cu_observe` 的 toolview，展示：当前步骤 n/N、目标 App/窗口、已用时、缩略截图、失败原因与建议；长任务显示进度条。这是 Client 插件（`ctx.slots.inject('tool.call.toolview', ...)`），可与主插件同仓分发，独立于 host。
3. 可选：把 `skill_run` 的步骤进度做成 checklist 卡片（类似 todo 视图），一眼看到第几步。

### 4.7 安全与合规

- guard 继续作为统一入口（危险动作/危险词/密码框/路径）；v2 增加「写操作前预览」（如将删除的文件/将发送的内容）。
- 审计仍无内容（只计数/布尔/耗时）；失败样本存**结构**不存屏幕文本。
- 浏览器：不注入脚本到第三方站点、不伪造 UA/指纹、不绕过风控。

### 4.8 平台与兼容

- macOS 为第一平台；Windows 以适配器占位，标注未验证。
- 保留 DSH 契约测试（schema/additionalProperties/defineTool 注册/apply 注入），DSH 升级先跑。
- 官方 seam：保持「全局挂载」为默认；`seam provider` 作为可选独立包（需契约稳定后）。

## 5. 测试与验收（要能立得住）

### 5.1 指标

每场景记录：成功与否、步数、耗时、会话费用增量、失败原因分类。

### 5.2 场景矩阵（目标 30+，按层）

| 层 | 场景数 | 例子 |
|---|---|---|
| L0 | 8 | 打开 App、截屏、点已知控件、切页、滚动、输入、读取窗口列表、验证前台 |
| L1 | 8 | 设置里改项并校验、Finder 拖拽、备忘录写一条、日历建删、浏览器搜并截图 |
| L2 | 8 | 下载归档、跨 App 复制粘贴、表单填写、批量重命名、截图整理、多窗口切换 |
| L3/异常 | 6 | 权限弹窗、应用未启动、元素不存在、验证码人工接管、网络失败、危险动作被 guard |

自动化：能用 AX/断言判定的走脚本（`bench/scenarios.json` + `scripts/bench.mjs`）；真机 GUI 用人工矩阵 + 录屏/截图存档。

### 5.3 发布门槛

- 单测 ≥100（含 guard fuzz、审计脱敏 fuzz、长会话、并行观察）
- 简单任务成功率 ≥95%、无基线回归
- 5 条 live-smoke 必过
- CI 全绿 + release checklist 勾完

## 6. 排期与优先级（挨着做）

| 批次 | 内容 | 产出 | 预估 |
|---|---|---|---|
| **0.11.0** | 失败样本库、doctor+安装脚本、CI、场景矩阵骨架（10→15） | 可诊断、可回归、可发布 | 2–3 天 |
| **0.11.1** | 测试补缺口（fuzz/长会话/性能阈值）、浏览器 DOM 通道 spike（只读+点击）、过程文案 | 浏览器最小可用 + 过程可见（低配） | 3–4 天 |
| **0.11.2** | 技能库 MVP（录制/保存/回放/失效）、工具面重构（observe/act 合并，旧名过渡） | 第二次执行步数 -50% | 4–5 天 |
| **0.12.0** | 复杂度分层策略 + 规划器 + 自定义 toolview 卡片（客户端插件）+ 场景矩阵 30+ | L2 复杂任务 ≥80% | 1 周+ |
| **1.0** | 稳定性/文档/发布工程：兼容矩阵、doctor 自检、seam 可选适配、Windows 适配（若有机器） | 可对外正式交付 | 视情况 |

优先级原则：**准确性 > 可用性 > 成本/时延 > 覆盖面 > 平台**；每批都以「真实任务 + 基准数据」验收，不做无数据的功能堆叠。

## 7. 项目治理（更正规）

| 环节 | 做法 | 频率 |
|---|---|---|
| 立项/复盘 | 本文件 + PLAN；每批结束写「做了什么/数据/教训」 | 每批 |
| 调研 | 每季度更新 §2（论文/竞品/现状），结论落文档 | 季度 |
| 方案评审 | 架构变更先写 RFC（本文件 §4 模式）再动代码 | 按需 |
| UI/交互 | 工具卡片/进度展示先出静态方案（本文 §4.6），再实现 | 0.12 |
| 沟通 | 每批产出「数据 + 结论 + 下一步」三行；重大风险立即说 | 每批 |
| 发布 | tag + CHANGELOG + release checklist + 5 条 live-smoke；见 §8.1 验收分级 | 每版 |
| 风险管理 | 已知未验证项统一标注；不做能力外承诺 | 持续 |

## 8. 决议记录（2026-11-01）

| 事项 | 决议 | 备注 |
| --- | --- | --- |
| 架构路线 | 演进式 v2，不推倒重写 | 明确约束：不得用叠 if-else / 特判来打补丁；新增能力必须进分层（perceive/plan/act/verify/skill/policy），框架性问题优先于功能 |
| 工具面收敛 | `observe/act/app/verify/skill/browser` 六工具 + 旧名过渡一版 | 收敛时机与粒度由维护者定，按版本推进 |
| 浏览器反爬 | DOM 优先；检测到风控就显式回报并交人工接管；**不做规避** | 补充要求：尽量不触发反爬（限速、模拟真实节奏、只读优先），减少人工干预，让 DSH 端到端处理 |
| 开工 | 决策确定即开工 | 本批 0.11.0 已动工 |

## 8.1 工程规范（0.11.0 起强制执行）

**改动验收分级**（按风险从低到高，至少做一级）：

| 级别 | 适用 | 做法 |
| --- | --- | --- |
| L1 单元/静态 | 纯函数、schema、解析、静态结构 | `npm test` 里覆盖；结构性约束写成静态守卫测试（例：`test/observe-parallel.test.mjs` 禁止 `captureRegion` 被重新赋值） |
| L2 集成（无 GUI） | helper 协议、失败样本、doctor、bench 数据 | 可注入依赖的集成测试；`npm run doctor`、`node scripts/bench.mjs check` |
| L3 真机冒烟 | 任何 JS 改动（工具注册/观察链路/配置） | **必须重启 App 后跑一次真实 GUI 动作**（例：`open_app` + 一次 `click`），确认 audit `action.effect` 正常；0.10.5 的 const bug 就是漏了这一步 |

**规则**：
1. 插件 JS 改动 → 重启验收（L3）才算完成；仅 helper/Swift 改动可热替换。
2. 新增工具/字段 → 同步 schema 断言 + README 配置/工具表 + 场景矩阵条目。
3. 破坏性动作（删除/发送/支付/退出）→ guard + `confirm` + README 记录；不新增「隐式破坏」路径。
4. 失败样本与审计只落本机、只记脱敏元数据（文本仅长度），不联网。
5. 每个版本必须：`npm test` 全绿 → 安装副本 `cmp` 一致 → commit + tag + push → 需要时请用户重启验收。

**反爬低触发原则**（写进后续 browser 通道设计）：
- 只读优先、先读后写；同一域名默认限速（连续动作 ≥1s），不并发轰炸。
- 不伪造指纹/不破解挑战；检测到 Cloudflare/Turnstile 等挑战时立即停手、截图 + URL 回报并请求人工接管。
- 表单/发送类动作必须二次确认（guard 层），失败一次即换策略而不是重试刷屏。

## 8.2 0.11.0 交付状态

- ✅ 失败样本库 `lib/failure-store.js` + 接线（默认 `failureSamples: true`，8 个扩展工具全覆盖）
- ✅ `npm run failures` 汇总 CLI（`--json/--files/--dir/--top`）
- ✅ `npm run doctor` 环境自检（9 项，`--json`，有 ❌ 退出码 1）
- ✅ `bench/scenarios.json` 15 条场景矩阵骨架（L0 4 / L1 4 / L2 4 / 异常 3）+ 校验测试
- ✅ GitHub Actions CI（macos-14 × Node 20/22：build helper + npm test）
- ⏳ 运行态生效：`failureSamples` 是 JS 改动，需重启 App；重启后 `doctor`/`failures` 走一遍即算验收

## 8.3 0.11.1 交付状态

- 浏览器 DOM 通道：`lib/browser-dom.js`（AppleScript 后端 + CDP 后端、probe/snapshot/click/fill、错误提示 `APPLESCRIPT_DISABLED_HINT`），`scripts/browser-spike.mjs` 真机通过（headless 临时 profile：读页 → 点按钮 → 校验 before/after，跑完清理）。
- 测试补缺：`test/guard-fuzz.test.mjs`（500 轮热键 + 300 轮危险标题 fuzz）、`test/audit-rotation.test.mjs`（脱敏/轮转/开关，轮转阈值可注入）、`test/browser-dom.test.mjs`（转义/probe 三态/脚本构造/DevToolsActivePort/CDP 类型自检）；`npm test` 105 项全绿，失败样本目录不再被测试污染。
- 已知限制：AppleScript JS 默认被 Chrome 关闭（需用户一次性开菜单开关「查看 → 开发者 → 允许 Apple 事件中的 JavaScript」）；CDP 路径要求独立 profile，暂无法复用日常 Chrome 登录态（0.11.2 做 profile 复用与登录接力）。
- 下一步（0.11.2）：把 DOM 能力包成 `browser` 工具族 + 技能库录制/回放，并在 guard 里加浏览器动作分类。

## 8.4 0.11.2 交付状态

- 技能库起步版：`lib/skill-store.js`（kebab-case 校验、敏感键拒绝、≤50 步/8KB/100 技能、临时文件+rename 原子写）+ 四个工具 `skill_save`/`skill_list`/`skill_show`/`skill_delete`；扩展工具注册面 8 → 12。
- 测试：`test/skill-store.test.mjs` 4 项（校验/增删查改/非法名/工具级 save→list→show→delete），`npm test` 109 项全绿。
- 限制：本版不含回放执行器；技能只是「可复用清单」，回放与失败恢复在 0.11.3 接。技能工具属 JS 改动，需重启 App 一次才在运行态出现。
- 下一步（0.11.3）：技能回放执行器（按步骤调用工具、带 expect/verify 与中断恢复）+ DOM 能力包装成 `browser_*` 工具族 + 工具门面收敛预研。

## 8.5 0.11.3 交付状态

- 浏览器 DOM 工具族：`browser_dom_snapshot` / `browser_dom_click` / `browser_dom_fill`（AppleScript JS 通道；只读优先、不读 input 值/Cookie、password 字段拒绝、破坏性点击需 confirm）；扩展工具 12 → 15。
- 测试：`test/browser-tools.test.mjs` 4 项（快照解析/通道关闭提示/点击 guard/填表与密码拒绝），`npm test` 113 项全绿。
- 限制：AppleScript 通道需一次性菜单开关；CDP 后端尚未接进工具（spike 已验证）；浏览器动作尚不进 `actionEffect` 体系。
- 下一步（0.11.4）：CDP 接入工具（独立 profile + DevToolsActivePort + 连接缓存）、技能回放执行器、`browser_*` 统一门面命名。

## 8.6 0.11.4 交付状态

- CDP 通道接进工具：`lib/browser-dom.js` 增 `cdpEvalScript/readCdpSnapshot/clickCdpDom/fillCdpDom/probeCdp`；Config 增 `browserCdpPort`（默认 0）；`browser_dom_snapshot/click/fill` 在 AppleScript 失败时按端口回退 CDP，输出带 `backend`；新增 `browser_dom_probe` 同时报告两通道状态（扩展工具 15 → 16）。
- 真机验证：临时 headless Chrome（file:// 页面 + 随机调试端口）→ `probeCdp` 报 Chrome/156、`readCdpSnapshot` 解析 title/text/interactive、`fillCdpDom` 返回 valueLength、`clickCdpDom` 点「Go」后页面文本 from before → clicked，全链路通过；测试用注入 fake 覆盖工具层回退与 probe（`npm test` 115 项全绿）。
- 限制：CDP 需用户自己以调试端口启动 Chrome（插件不接管进程/不碰日常 profile）；AppleScript 通道仍默认关闭需菜单开关；技能回放执行器推迟到 0.12。
- 下一步（0.12）：复杂度分层与规划器、技能回放、自定义 toolview 卡片、30+ 场景矩阵；之后多屏 DPI、Windows、seam 适配层。

## 8.7 0.12.0 交付状态（2026-11-01）

- 复杂度分层：`lib/task-profile.js`（`classifyTask`：信号词 + 文本长度 + 步数估计打分，输出 simple/standard/complex 与 maxSteps/requirePlan/verifyAfterEach/allowBatch），工具 `task_profile`。
- 计划器：`lib/planner.js`（`createPlan/validatePlan/listPlans/readPlan/updatePlan/deletePlan/configurePlanStore`，计划落盘 `~/.dsh/dsh-operator/plans/<id>.json`，敏感键拒收、原子写、30 天清理留给 0.12.1），工具 `plan_create`/`plan_update`（步骤状态 pending|running|done|failed|skipped，failed 使整计划 failed）。
- 场景矩阵：`bench/scenarios.json` 15→32 条（L0/L1/L2/exception 各 8），校验测试改为要求≥30 且每层≥8。
- 测试：`test/task-profile.test.mjs` 6 项、`test/planner.test.mjs` 4 项；`npm test` **126 项全绿**；扩展工具 16→19。
- 未做（后续）：计划执行器（按步调用工具 + 中断恢复）、技能回放执行器、自定义 toolview 卡片、30+ 场景跑分脚本——归 0.12.1/0.12.2。

## 8.8 0.12.1 交付状态（2026-11-01）

- 步骤执行器 `lib/executor.js`：`executeSteps` 顺序执行 {tool,args} 列表；只允许本插件扩展工具（拒绝 click/input_text 等基础工具与递归 skill_run/plan_run）；`stopOnError` 默认 true、失败后续步标 skipped；`dryRun` 只预览；结果只留状态 + ≤200 字符摘要（不回显图片/base64）。
- 工具：`skill_run`（回放技能库序列，支持 dryRun/stopOnError）、`plan_run`（执行计划 pending 步骤，逐 step 写回 pending→running→done/failed，失败即停）；扩展工具 19→21。
- 测试：`test/executor.test.mjs` 6 项（顺序执行/失败即停/继续执行/未授权工具与递归拒绝/dryRun/摘要裁剪）；`npm test` **132 项全绿**。
- 已知限制：基础 GUI 工具（click/input_text/drag 等）不在本执行器白名单，含这些步骤的计划/技能会显式失败，需要模型手动执行；自定义 toolview 卡片仍未开始。

## 8.10 0.12.3 交付状态（2026-11-01）

- 场景跑分工具：`lib/scenarios.js`（load/filter/group/buildRunSheet/validateRecord/recordLine/parseRecords/summarizeRecords/renderSummaryTable，本地日期）；CLI `scripts/scenarios.mjs` 四个子命令：`list`（按层/id/关键词筛选，可 --json）、`sheet`（生成 markdown 跑分表，含成功标准与结果栏）、`record`（追加 `bench/results/<本地日期>-scenarios.jsonl`）、`report`（读最近记录并输出分层次成功率/平均动作数/平均耗时/成本/失败分类）。
- 测试：`test/scenarios-tools.test.mjs` 4 项（32 条/分层 8-8-8-8、筛选、跑分表格式、记录校验与汇总计算）；`npm test` 136 项全绿。
- 产物加入 `.gitignore`（`bench/*-scenarios-sheet.md`、`bench/results/*-scenarios.jsonl`），避免跑分数据污染仓库。
- 下一步：0.13 自定义 toolview 卡片（「正在操作中…」步骤卡）+ 更主动的执行策略；多屏 DPI/Windows/seam 排队。

## 8.11 0.13.0 交付与 toolview 卡片调研（2026-11-01）

- 交付：`lib/status.js` + `operator_status`（版本/平台/axMaxNodes/failureSamples/browserCdpPort/技能数/计划数/失败文件与条数/审计行数与字节）、`plan_list`（计划 id/目标/状态/完成步数/更新时间）；扩展工具 21→23；`test/status.test.mjs` 2 项；`npm test` 138 项全绿。
- toolview 卡片调研结论（本机 `dsh-client-ui-tool` README）：业务包要在对话里渲染自定义工具卡，需要 **client（浏览器侧）入口** 在 `ctx.slots.inject('tool.call.toolview')` 里按 wire 工具名注册卡片；runtime 负责 call/result 配对与 PTC 子调用，业务包只提供原子视图。这意味着 dsh-operator 需要新增一个 Web 客户端 bundle（打包 + 在 profile 中注册），涉及 DSH 客户端构建链，风险与工作量高于纯 host 插件。
- 决策：0.13.1 先做「过程文案 + 状态提示」的 host 侧替代（工具描述/审计里带步骤计数），toolview 自定义卡片作为独立里程碑单独评估，不阻塞其他项。

## 8.13 0.13.2 过程反馈（host 侧，2026-11-01）

- 在 client 卡片（需 Web bundle）之前，先做 host 侧可见的进度：`plan_run` 输出 `totalSteps/doneSteps/nextStep`，文本变成 `n/N done, status …, next <step>`；`operator_status` 追加 `active plans: N (next <plan> → <step>)`，让模型/用户不用翻计划文件也知道下一步。
- 测试：既有 schema 回归覆盖 `operator_status`；`plan_run` 新字段走同一 additionalProperties:false 校验。`npm test` 139 项。

## 9. 参考

- OSWorld — https://arxiv.org/abs/2404.07972
- OSWorld-Pro（2026 现状）— https://arxiv.org/abs/2609.24890
- WebArena — https://arxiv.org/abs/2307.13854
- Mind2Web — https://arxiv.org/abs/2306.05949
- WebVoyager — https://arxiv.org/abs/2401.13919
- SeeAct（GPT-4V grounded web agent）— https://arxiv.org/abs/2401.01614
- Set-of-Mark — https://arxiv.org/abs/2310.11441
- An Illusion of Progress? — https://arxiv.org/abs/2504.01382
- browser-use — https://github.com/browser-use/browser-use
- Cloudflare Turnstile（人工校验与站点侧风控）— https://developers.cloudflare.com/turnstile/
- DSH 工具展示（tool.call.toolview 卡片机制）— 本机 `@deepseek-ai/dsh-client-ui-tool` README
