#!/usr/bin/env bash
# 编译 AX 快照辅助程序（P1-6）。需要 Xcode Command Line Tools：xcrun swiftc。
# 默认出通用二进制（arm64 + x86_64）；某一架构编译失败时降级为当前架构并打印警告。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p lib/bin
ARCH="$(uname -m)"
TARGETS=("arm64-apple-macos13.0" "x86_64-apple-macos13.0")
OUTS=()
for target in "${TARGETS[@]}"; do
  arch="${target%%-*}"
  out="lib/bin/ax-snapshot-${arch}"
  if xcrun swiftc -O -target "$target" scripts/ax-helper.swift -o "$out" 2>/tmp/ax-build-"$arch".log; then
    OUTS+=("$out")
  else
    echo "warn: cannot build $arch (see /tmp/ax-build-${arch}.log); falling back" >&2
    rm -f "$out"
  fi
done
if [[ ${#OUTS[@]} -eq 0 ]]; then
  echo "error: no arch could be built" >&2
  exit 1
fi
if [[ ${#OUTS[@]} -eq 1 ]]; then
  cp "${OUTS[0]}" lib/bin/ax-snapshot
else
  xcrun lipo -create "${OUTS[@]}" -output lib/bin/ax-snapshot
fi
rm -f lib/bin/ax-snapshot-arm64 lib/bin/ax-snapshot-x86_64
chmod +x lib/bin/ax-snapshot
echo "built: $(pwd)/lib/bin/ax-snapshot"
file lib/bin/ax-snapshot
