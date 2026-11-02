# 发布流程（dsh-operator）

> 一条命令发版，减少“手打序列 + 忘记某步”的风险。脚本：`scripts/release.mjs`（npm script：`release`）。

## 前置

- 工作区干净（`git status --porcelain` 为空）；功能/文档提交先落下，发布只提交 `package.json` 的版本号。
- CI 基线绿：发版前最近一次 `gh run list` 应为 success。
- 需要同步安装副本时，确保 `~/.dsh/profile/desktop` 可写（`dsh plugin` 需要 danger-full-access）。

## 标准流程

```bash
# 1) 看一眼计划（默认 dry-run，不改任何文件）
npm run release -- 0.16.0

# 2) 真发：改版本 → 跑全量测试 → commit → tag → push
npm run release -- 0.16.0 --yes

# 3) 同时同步本机安装副本并自检（推荐）
npm run release -- 0.16.0 --yes --install
```

脚本会做：

1. 校验版本号（semver-ish，允许 `0.16.0-rc.1`）；
2. 拒绝已存在的 tag（不覆盖、不 force）；
3. `package.json` 版本号 bump；
4. `npm test`（可用 `--skip-tests` 跳过，不建议）；
5. `git add package.json` + commit `release: vX`；
6. `git tag -a vX` + `git push origin main --tags`；
7. `--install`：`dsh plugin --profile desktop remove/add file:<repo>`，再跑 `scripts/doctor.mjs`。
   ⚠️ pnpm 的 `file:` 依赖会复用旧内容（新文件缺失/旧文件残留）：装完必须再同步一次再校验——
   `rsync -a --delete --exclude .git --exclude node_modules --exclude test --exclude docs --exclude bench --exclude archive --exclude .github <repo>/ ~/.dsh/profiles/desktop/node_modules/dsh-operator/`
   然后逐文件 `cmp`（至少 index.js / package.json / lib/operator-tools.js / lib/computer-use/index.js / client/client.js）。

## 0.4x 真机清单（macOS，重启 App 后跑一遍）

浏览器/OCR/剪贴板都是「注册后要重启才生效」，发版或同步后按顺序验：

1. `operator_status`：版本号对、`platform: darwin … (verified)`、`browserCdpPort` 是预期值；
2. `cua_windows app_contains="Chrome"` 能看到窗口（没有就先打开 Chrome）；
3. `browser_prepare app="Chrome"`（多窗口时加 `window_title`）→ `browser_state` 有 refs；
4. 随便点一个非破坏性链接 → `browser_click ref=…`；再 `browser_read max_chars=800` 看文本；
5. 调试端口在开时：`browser_wait`（readyState+空闲）、`browser_network reload:true`；
6. `ax_batch` 里混一条 `browser_open` + 一条桌面 `hotkey`，确认顺序执行；
7. `ocr` 对当前窗口截一次，返回带坐标文本行；
8. `clipboard_write` 一段短文本 → `clipboard_read` 回读一致；
9. `click` 落在危险按钮（测试页「删除账户」）→ 应被 guard 拒绝，`confirm:true` 才放行；
10. `failure_list` 看最近样本：不应有授权/未开启导致的噪声。

任何一步失败：先看 `~/.dsh/dsh-operator/audit.jsonl` 最后几条与 `failures/` 当日文件，再对照 `doctor` 输出。

## 发版后

- 等了 CI 变绿（`gh run list --limit 1`）。
- JS/依赖有变化 → 请用户重启 App；仅 `client/` 有变化 → 页面刷新即可。
- 记录备份路径与 doctor 输出；失败样本/审计目录不应有新增噪声。
- 更新 README「变更」与 `docs/PROJECT-2026-11.md` 的交付状态（若该版本属于里程碑）。

## 不要做

- 不要 `git tag -d` / 强推 tag；版本号一旦公开就只增不改。
- 不要在工作区有未提交改动时发版。
- 不要在 CI 红时发版；先修 CI。

## 0.5x 一键链路（macOS 真机，约 10 秒）

前置：Chrome 已打开任意页面；插件版本 ≥ 0.56.0；重启过 App。

| # | 调用 | 期望 |
|---|---|---|
| 1 | `browser_prepare {app:"Chrome"}` | `已绑定 pid=… window=…` |
| 2 | `browser_state {pid, window_id, max_refs:15}` | 列出 tabs，`target_id=…` |
| 3 | `browser_state {target_id, tab_id}` | `refs (n): p28:7 link Learn more …`（默认语义快照，带文案） |
| 4 | `browser_click {text:"Learn more", refresh:true}` | `已点击 p29:7` + 新快照 |
| 5 | `browser_wait {expect_url:"help/example-domains"}` | `地址已变化：…（<500ms）` |

**瘦身对照（同一 iana 页，41 refs）**：0.55 及以前 `browser_state` 回包 5443 字符；0.56 截断正文/结构树后 2197 字符，省 60%。

常见偏差：
- 第 1 步报 `browser_consent_required` → 升级 cua-driver 或确认已 `--grant existing-profile`（插件自 0.24.5 起自动带）；
- 第 5 步超时 → 页面没真正跳转，先用 `browser_read` 看当前地址；`expect_url` 不需要调试端口。

