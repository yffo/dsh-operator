# lib/computer-use 是 fork，不是「原样 vendor + 补丁」

**状态（0.9.1 起）**：`lib/computer-use/` 是从上游拷贝后**直接修改**的 first-party 代码，
不再有「先同步、再打 62 个锚点补丁」的机制。原因：补丁注入面过宽（A1 结构债），
上游一改源码就大面积断锚，而我们已经和上游方向明显分叉（悬浮球/语音/宿主 vs 纯工具层）。

## 上游

- 项目：[dsh-orb](https://github.com/mini-yifan/dsh-orb-cordis) v0.2.0
- 来源：npm `dsh-orb@0.2.0` 包内 `dist/computer-use/`
- 许可：MIT（Copyright (c) 2026 mini-yifan），本仓库保留 [LICENSE](../LICENSE) 与 [NOTICE](../NOTICE)
- vendored 时间：2026-10-31

## 与上游的差异（2026-11-01 统计，对比 dist/computer-use）

| 文件 | hunks | 变更行 | 内容 |
| --- | --- | --- | --- |
| `index.js` | 20 | 240 | 配置扩展、截图降 token、图片准入降级、clipped 元数据、结构化 actionEffect、AX 文本观察、区域坐标归一化、扩展工具接线、审计、前台缓存、懒观察、noop 不附图、hotkey guard |
| `backend-xLwiz83E.js` | 12 | 43 | 截图参数、裁切元数据、JXA 字段修复（activationPolicy 字符串 / open -b / pid）、前台缓存、裁剪区域来源 |
| `index.d.ts` | 1 | 10 | 配置 / 返回值类型补字段 |
| 另外 9 个文件 | 0 | 0 | 与上游一致 |

源码里保留 `PATCH(computer-use)` 注释作为**修改点索引**（不是自动补丁），
配合 `docs/PLAN-2026-11.md` 的变更记录使用。

## 为什么要 fork

1. 62 个锚点补丁的维护成本高于上游收益：上游大改会同时断十几个锚点，sync 变成手工修。
2. 我们的功能已超出上游范围（查询/验证工具、审计、AX、懒观察、guard），继续「补丁叠加」会让契约越来越难解释。
3. fork 后 `lib/computer-use/` 可以直接被测试与覆盖率统计，不再有「vendored 不计」的盲区。

## 上游更新怎么办

1. 拉取新版本到临时目录（不覆盖仓库）：
   ```bash
   ./scripts/fetch-upstream.sh 0.2.1
   diff -ru /tmp/dsh-orb-upstream-0.2.1/dist/computer-use lib/computer-use
   ```
2. 逐 hunk 判断：上游修复是否与我们的改动冲突；能合并的手工合并，并在本文件与 NOTICE 记录。
3. 跑 `npm test`（旧四套 + bench check + 70 项 node:test），必要时真机回归。
4. 修改点注释（`PATCH(computer-use)`）保留，方便下次对照。

## 许可与归属

- 上游 MIT 许可与版权声明保留；本仓库修改同样以 MIT 发布（见 [LICENSE](../LICENSE)）。
- NOTICE 中记录了每个版本相对上游的功能变更。
