#!/usr/bin/env bash
# 用 dsh-orb 指定版本重新同步 lib/computer-use 与 LICENSE。
# 用法：./scripts/sync-from-orb.sh 0.2.0
set -euo pipefail

version="${1:?用法: sync-from-orb.sh <dsh-orb 版本>}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

url="https://registry.npmmirror.com/dsh-orb/-/dsh-orb-${version}.tgz"
echo "↓ $url"
curl -fsSL -o "$work/orb.tgz" "$url"
tar -xzf "$work/orb.tgz" -C "$work"
test -d "$work/package/dist/computer-use" || { echo "包里没有 dist/computer-use" >&2; exit 1; }

rm -rf "$root/lib/computer-use"
cp -R "$work/package/dist/computer-use" "$root/lib/computer-use"
cp "$work/package/LICENSE" "$root/LICENSE"
chmod 755 "$root/lib/computer-use/macos-sck-capture"

# 重新打本包的补丁（截图缩放 + 动作验证提示）；锚点不匹配会报错退出。
node "$root/scripts/apply-vendor-patches.mjs"

echo "✅ 已同步 dsh-orb@${version} → lib/computer-use，并重新应用本包补丁"
echo "   记得核对 cordis.patch.yml 的上游 diff，并更新 package.json / NOTICE 里的版本号。"
