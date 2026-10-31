#!/usr/bin/env bash
# 编译 AX 快照辅助程序（P1-6）。需要 Xcode Command Line Tools：xcrun swiftc。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p lib/bin
xcrun swiftc -O scripts/ax-helper.swift -o lib/bin/ax-snapshot
chmod +x lib/bin/ax-snapshot
echo "built: $(pwd)/lib/bin/ax-snapshot"
