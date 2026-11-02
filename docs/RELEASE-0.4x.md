# 0.4x 发布说明（草稿）

面向使用者的一句话：**浏览器自动化从「能点」走到「能等、能读、能自愈、能自证」**，同时把每次观察的 token 成本压下来。

## 亮点

- **真实浏览器闭环**：`browser_prepare` 绑定你正在用的 Chrome（真实登录态），`browser_state` 给语义 ref，`browser_click` 可传 ref 或可见文案（歧义会列候选而不是乱点）。
- **等得到**：`browser_wait` 除了「页面就绪 + 网络空闲」，还能等元素出现/可见（`selector` + `visible`），不再靠 sleep 猜。
- **看得到**：`browser_read` 读页面可见文本（固定骨架表达式，不执行任意 JS）；`browser_console` / `browser_network` 看控制台错误与失败请求（需 `browserCdpPort`）。
- **自愈**：ref 过期时 `browser_click/type/pointer/select` 自动补一次快照，把最新 refs 贴在错误里；`browser_open` 默认导航后直接给快照。
- **更省 token**：连续相同的 AX 快照折叠成一行说明；`browser_state` 的 refs 段重复时同样折叠（大快照实测 1223→198 字符）。
- **桌面侧补齐**：`ocr`（Vision 文本兜底，带 0–1000 坐标）、`clipboard_read/write`、坐标点击 guard（危险控件必须 `confirm:true`）。
- **诊断**：`failure_list` 多一行 `hot:`（工具·类型组合热点）；`operator_status` 显示浏览器通道状态，并在「磁盘版本 ≠ 运行版本」时提示重启。

## 版本索引

| 版本 | 内容 |
| --- | --- |
| 0.35.0 | ref 过期自动补快照 |
| 0.36.0 | `browser_open` 导航后自动快照 |
| 0.37.0 | `browser_read`（CDP） |
| 0.38.0 | `browser_click` 按文案点，歧义拒绝 |
| 0.39.0 | `ax_batch` 混跑浏览器动作 |
| 0.40.0 | 浏览器失败样本进入 `failure_list` |
| 0.41.0 | `browser_read` 支持 `selector` |
| 0.42.0 | `browser_prepare` 按 app 找窗口；`browser_download` 核对新增文件 |
| 0.43.0 | `failure_list` hot 摘要；`operator_status` 版本不一致提示 |
| 0.44.0 | `operator_status` 显示浏览器通道注册状态 |

## 升级注意

- 装完/同步后**重启 App**（JS 与工具注册都会重新加载）；只改 `client/` 的版本刷新页面即可。
- 浏览器工具依赖 `cua-driver`；连真实 Chrome 首次需要一次「调试授权」，之后 daemon 以 `--grant existing-profile` 常驻。
- CDP 三件套需要显式开端口：Chrome `--remote-debugging-port=<port>` + 插件配置 `browserCdpPort`。没开时会明确报「连不上」并给开启方法。
- 真机验收按 `docs/RELEASE.md` 的「0.4x 真机清单」十步走。

## 已知限制

- 浏览器工具只在 macOS 验证过；Windows 基础 GUI 后端代码在但未真机验证，Linux 未实现桌面后端。
- `browser_read` 只读可见文本，不返回 HTML/属性；需要结构化数据时用 `browser_dom_*`（AppleScript 通道）或 `browser_state` 的 refs。
- 文件上传/下载会写磁盘，`browser_download` 必须显式 `confirm:true`。
