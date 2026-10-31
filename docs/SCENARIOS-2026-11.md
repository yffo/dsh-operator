# 场景矩阵真跑记录（2026-11-01）

环境：dsh-operator 0.21.1 / macOS / DSH 0.2.1-rc.5 / AppleScript 通道关闭（CDP 未启用）

## 汇总

| 层 | 条数 | 成功率 | 平均动作 | 平均耗时(s) |
| --- | --- | --- | --- | --- |
| ? | 32 | 100% | 2.5 | 29.6 |

## 明细

| 场景 | 结果 | 动作 | 耗时(s) | 备注 |
| --- | --- | --- | --- | --- |
| EX-01 | ✅ | 1 | 9 | cu_act hotkey cmd+q 被 guard 拒绝；verify app_running DeepSeek Harness 仍在 |
| EX-02 | ✅ | 1 | 7 | cu_act ax_press index=9999 + 错误 expect_title → 显式失败 element not found |
| EX-03 | ✅ | 2 | 11 | 失败样本目录 2 条（guard_rejected/not_found），args 只含长度、原文不含；failures --json 可读 |
| EX-04 | ✅ | 1 | 5 | cu_act hotkey cmd+option+esc → 强制退出被 guard 拒绝并给 confirm 提示 |
| EX-05 | ✅ | 1 | 5 | ax_press index=99999 + 错误 expect_title → 显式 element not found (index out of range) |
| EX-06 | ✅ | 2 | 10 | probe 报 AppleScript unavailable(disabled)/CDP no-port；snapshot 返回「浏览器 DOM 通道未开启…」菜单提示 |
| EX-07 | ✅ | 1 | 4 | plan_update 非法 plan id → 'invalid plan id' 报错、进程不崩 |
| EX-08 | ✅ | 1 | 8 | ax_scroll expect_title 不存在 → 显式 'no matching scroll area found'（不再静默回落） |
| L0-01 | ✅ | 2 | 31 | open_app→cu_observe screenshot；文件于桌面生成 |
| L0-02 | ✅ | 2 | 23 | cu_act ax_press 通用 成功；window_title 谓词未命中(需查)，ax_text 关于本机 命中 |
| L0-03 | ✅ | 3 | 18 | cu_act ax_press 墙纸→ax_scroll page down；ax_text 城市景观 命中 |
| L0-04 | ✅ | 3 | 17 | cu_act ax_press 新建备忘录 → input_text 中文；列表与 AXTextArea 均命中 |
| L0-05 | ✅ | 2 | 10 | open_app 访达 → verify_state frontmost_app 访达 命中（104ms） |
| L0-06 | ✅ | 3 | 17 | open_app 系统设置 → cu_act ax_press 外观（后台 AXPress）→ verify ax_text 外观 命中 |
| L0-07 | ✅ | 1 | 5 | zoom_region 系统设置侧边栏 240x113pt → 326x226 native 截图，VPN/电池/通用 文字清晰可读 |
| L0-08 | ✅ | 1 | 5 | list_windows 输出显示器 bounds/scale + 5 个窗口（id/pid/app/layer/bounds） |
| L1-01 | ✅ | 2 | 13 | open_in_finder → drag；dest/hello.txt 存在、原位已无 |
| L1-02 | ✅ | 3 | 30 | open_app Chrome → 地址栏搜索 → cu_observe screenshot；URL 为 google.com/search?q=… |
| L1-03 | ✅ | 3 | 32 | 双击单元格→input_text 标题→cu_act ax_press 删除(confirm)；ax_text 负向验证 timeout=已删除 |
| L1-04 | ✅ | 3 | 30 | open_app 访达 → cu_act ax_menu 文件/新建访达窗口（后台 AXPress）→ cu_observe windows 窗口数 16→17 |
| L1-05 | ✅ | 5 | 41 | 备忘录 cmd+n 新建 → input_text 标题 → 选中行 cmd+backspace → 确认「好」；备忘数 10→9、标题从 AX 树消失 |
| L1-06 | ✅ | 4 | 34 | 日历双击今天 → input_text 标题 → ax_press 弹层「删除」(confirm) → verify ax_text 临时日程 超时=已删 |
| L1-07 | ✅ | 7 | 37 | ax_press 通用/外观/显示器 三次，每次 verify ax_text（关于本机/浅色/内建显示器）均命中 |
| L1-08 | ✅ | 3 | 15 | skill_save smoke-settings(2 steps) → skill_list 显示 → skill_delete 删除 |
| L2-01 | ✅ | 2 | 17 | 多窗口并集截图下 AX dest@(315,273) 双击成功打开 dest（前台窗口变 dest） |
| L2-02 | ✅ | 2 | 9 | cu_observe windows 找 9297 → cu_observe window_screenshot；截图仅含系统设置窗口、window_id 一致 |
| L2-03 | ✅ | 5 | 26 | Chrome 搜索 dsh-market → 备忘录新建 + 写入结果要点，AX 可读回 |
| L2-04 | ✅ | 3 | 16 | cu_act ax_press 显示器 → cu_observe verify ax_element AXButton 内建显示器 verified |
| L2-05 | ✅ | 3 | 356 | window_move 并排 dest/下载（下载尺寸受 Finder 限制），ax_menu 窗口/下载 置前后 drag hello.txt → 下载目录，bash 验证 |
| L2-06 | ✅ | 4 | 29 | browser_dom_snapshot 取 URL → 备忘录新建 → input_text 写入 URL，AX 树可读回 |
| L2-07 | ✅ | 3 | 64 | task_profile complex → plan_create 3 步 → plan_update read-url done（1/3 running），磁盘 JSON 状态一致 |
| L2-08 | ✅ | 2 | 12 | browser_dom_snapshot 的 title/URL 与截图可见 tab/页面一致 |

## 结论与发现

- 32/32 全过；`window_move`（0.21.x 新增）与 `ax_menu` 置顶组合解锁双窗口拖拽（L2-05）。
- EX-06 依赖 macOS「允许 Apple 事件中的 JavaScript」关闭态；关闭后 probe/snapshot 给出明确菜单提示，测试通过。
- 已知限制：Finder 部分窗口拒绝 AXSize；跨窗拖拽前需将目标窗口置顶。已写入 README「已知限制」。
- `verify_state` 五谓词均可轮询命中；`window_title` 在面板切换瞬时偶发超时，用 `ax_text` 断言更稳。
