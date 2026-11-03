#!/usr/bin/env bash
# 把仓库代码同步到 profile 里「实际被加载的那份拷贝」。
#
# 背景：profile 用 "file:" 装 dsh-operator 时，pnpm 复制的是实体目录，
# 改仓库源码不会影响运行中的 App，必须同步后再重启。
#
# ⚠️ 2026-11-02 事故（本脚本初版造成）：
#   @deepseek-ai/dsh-shell-env 会给每个工具 shell 注入 DSH_PROFILE_DIR=<profile 根>，
#   初版拿它当覆盖目标，于是 rsync 把 lib/ 铺到 profile 根、cp 又把插件的 package.json
#   覆盖成 profile 清单 → dsh.profile.bundles 消失 → 所有 bundle 不加载 →
#   ctx.connection undefined → 启动即崩：Cannot read properties of undefined
#   (reading 'authenticatedUrl')。
#   教训：① 永远不要读 DSH_PROFILE_DIR 当目标；② 目标必须是 .../node_modules/dsh-operator；
#         ③ 写完必须复查 profile 清单没被改。
#
# 用法：
#   bash scripts/sync-profile.sh              # 同步
#   bash scripts/sync-profile.sh --dry-run    # 只打印将要做的事
#   DSH_OPERATOR_TARGET=<profile>/node_modules/dsh-operator bash scripts/sync-profile.sh
#
# 同步后需完全退出并重开 App 才生效。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${DSH_OPERATOR_TARGET:-$HOME/.dsh/profiles/desktop/node_modules/dsh-operator}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

die() { echo "✗ $*" >&2; exit 1; }

# ── 安全阀 1：目标必须落在 node_modules/dsh-operator ──────────────────────
case "$TARGET" in
  */node_modules/dsh-operator) : ;;
  *)
    die "目标目录不合法 → $TARGET
  必须形如 <profile>/node_modules/dsh-operator。
  看起像 profile 根？那样会把 lib/ 和 package.json 铺到 profile 根，覆盖 dsh.profile.bundles，
  App 会启动即崩（authenticatedUrl）。"
    ;;
esac
[ -d "$TARGET" ] || die "目标目录不存在：$TARGET
  先确认 dsh-operator 是以 file: 装进 profile 的，或用 DSH_OPERATOR_TARGET 指定 .../node_modules/dsh-operator"

# ── 安全阀 2：源与目标都必须是 dsh-operator ────────────────────────────────
SOURCE_NAME="$(node -p "require('$ROOT/package.json').name")"
[ "$SOURCE_NAME" = "dsh-operator" ] || die "仓库 package.json 的 name 不是 dsh-operator（实际：${SOURCE_NAME}）"
TARGET_NAME="$(node -p "require('$TARGET/package.json').name" 2>/dev/null || echo "")"
[ "$TARGET_NAME" = "dsh-operator" ] || die "目标 package.json 的 name 不是 dsh-operator（实际：${TARGET_NAME:-读不到}）"

# ── 安全阀 3：profile 清单必须是 dsh-profile-desktop ──────────────────────
PROFILE_DIR="$(dirname "$(dirname "$TARGET")")"
PROFILE_MANIFEST="$PROFILE_DIR/package.json"
[ -f "$PROFILE_MANIFEST" ] || die "找不到 profile 清单：$PROFILE_MANIFEST"
BEFORE_NAME="$(node -p "require('$PROFILE_MANIFEST').name" 2>/dev/null || echo "")"
[ "$BEFORE_NAME" = "dsh-profile-desktop" ] || die "profile 清单 name 不是 dsh-profile-desktop（实际：${BEFORE_NAME:-读不到}），先修清单"

echo "仓库：$ROOT"
echo "目标：$TARGET"
echo "清单：${PROFILE_MANIFEST}（${BEFORE_NAME}）"

# 0.104.0：client/ 也必须同步。此前只同步 lib/ + package.json，
# 结果 0.95.0 的底部状态条（客户端半侧）从来没进过运行中的 App——
# 「代码写了、测试绿了、用户看不见」正是这一层遗漏造成的。
SYNC_DIRS="lib client"
SYNC_FILES="package.json index.js cordis.patch.yml"

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] 将执行："
  for dir in $SYNC_DIRS; do echo "  rsync -a --delete $ROOT/$dir/ $TARGET/$dir/"; done
  for file in $SYNC_FILES; do echo "  cp $ROOT/$file $TARGET/$file"; done
  exit 0
fi

for dir in $SYNC_DIRS; do rsync -a --delete "$ROOT/$dir/" "$TARGET/$dir/"; done
for file in $SYNC_FILES; do cp "$ROOT/$file" "$TARGET/$file"; done

# ── 事后复查：清单没被动过 ────────────────────────────────────────────────
AFTER_NAME="$(node -p "require('$PROFILE_MANIFEST').name" 2>/dev/null || echo "")"
[ "$AFTER_NAME" = "dsh-profile-desktop" ] || die "同步后 profile 清单被改坏了（name=${AFTER_NAME}）！立刻 cp $PROFILE_DIR/package.json.known-good $PROFILE_MANIFEST"

VERSION="$(node -p "require('$TARGET/package.json').version")"
echo "✓ 已同步，插件版本 ${VERSION}，profile 清单完好"
echo "  完全退出并重开 DeepSeek Harness 后生效"
