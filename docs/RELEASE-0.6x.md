# 0.6x 发布说明（少 token · 失败自愈 · 观察裁剪）

## 亮点

- **等元素/等文案/等 URL**：`browser_wait` 支持 `selector`+`visible`、`text`、`expect_url`，不再靠 sleep 猜。
- **按文案点击**：`browser_click {text:"登录"}` 先取语义快照匹配可见文案；多个候选会拒绝并列出前 8 个，避免点错。
- **一次往返拿结果**：`browser_click`/`browser_type`/`browser_key` 支持 `refresh`，成功后直接附新快照（固定取 20 个 ref，大页不炸）。
- **语义快照默认**：`browser_state` 默认 `semantic_v2`（带 `name`/`role`），比 `dom_refs_v1` 更短且少猜；驱动不支持自动回退。
- **观察裁剪**：`browser_state` 的正文 1200 字符、结构树 30 行封顶（`max_refs` 默认 40，上限 200）；连续观察同一元素树折叠成 `<tree_unchanged>`，连续快照的 refs 段折叠成 `<refs_unchanged>`。
- **截图去重（0.59.0）**：按截图字节的 sha1 判同一帧，同一窗口同一区域连续同一帧第二次不再附图，只给 `<image_unchanged>`。
- **可交互过滤**：`browser_state {interactive_only:true}` 只列 link/button/input；`browser_read {interactive_only:true}` 只回可点文案。
- **失败自愈**：`browser_*` 遇 `ref_stale`/`not found` 自动补一次快照并把新 refs 附在错误里；`failure_list` 同类失败 ≥3 次给 `repeat:` 行与换策略建议；AX 动作失败会给最新快照摘要（`recovery`）。
- **诚实报错**：驱动返回 `status:"refused"`（审批/授权）以前被当成功，现在归一化成失败并说明原因。

## 升级注意

- 0.59.0 需要重启 App 才生效（客户端/主进程都会加载插件代码）。
- `browser_download` 需要宿主确认（destructive-tool confirmation）；CLI/独立进程没有确认通道时会被直接拒绝。
- 截图去重的实现前提是「截图字节可哈希」；如果换后端（Windows PNG）仍适用。

## 真机记录（macOS）

- 绑定 Chrome 真实 profile：`browser_prepare {app:"Chrome"}` → `attached_existing_profile`。
- `browser_click {text:"Learn more", refresh:true}` → 点击成功并附 35→20 个新 refs。
- `browser_wait {expect_url:"help/example-domains"}` → `地址已变化…（150ms）`。
- `browser_state` 结构树裁剪在 30 行生效。
- 测试：296 项，`npm run check:p0` 全绿。
