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

## 发版后

- 等了 CI 变绿（`gh run list --limit 1`）。
- JS/依赖有变化 → 请用户重启 App；仅 `client/` 有变化 → 页面刷新即可。
- 记录备份路径与 doctor 输出；失败样本/审计目录不应有新增噪声。
- 更新 README「变更」与 `docs/PROJECT-2026-11.md` 的交付状态（若该版本属于里程碑）。

## 不要做

- 不要 `git tag -d` / 强推 tag；版本号一旦公开就只增不改。
- 不要在工作区有未提交改动时发版。
- 不要在 CI 红时发版；先修 CI。
