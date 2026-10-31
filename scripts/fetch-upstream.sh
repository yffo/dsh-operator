#!/usr/bin/env bash
# 拉取上游 dsh-orb 指定版本到临时目录，供人工 diff；**不会**修改 lib/computer-use。
# 用法：./scripts/fetch-upstream.sh [版本] [输出目录]
set -euo pipefail

version="${1:-0.2.0}"
out="${2:-/tmp/dsh-orb-upstream-$version}"

rm -rf "$out"
mkdir -p "$out"
curl -fsSL "https://registry.npmmirror.com/dsh-orb/-/dsh-orb-$version.tgz" -o "$out/orb.tgz"
tar -xzf "$out/orb.tgz" -C "$out"
echo "上游 $version 已解到：$out/package/dist/computer-use"
echo "对比："
echo "  diff -ru '$out/package/dist/computer-use' lib/computer-use"
