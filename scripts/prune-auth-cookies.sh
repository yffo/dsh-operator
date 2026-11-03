#!/usr/bin/env bash
# 清理桌面端累积的 dsh-auth-* 认证 cookie。
#
# 背景（上游 bug #11583）：桌面端每次启动都用随机端口，而认证 cookie 名由
# `dsh-auth-<sha256(host:port)>` 派生 → 每启动一次新增一条，永不复用。Chromium
# 的 cookie 库按 host 隔离、不按端口，于是 127.0.0.1 域下的 cookie 只增不减。
# 累积到约 70 条时 Cookie 请求头突破 Node 的 16KB maxHeaderSize → 服务端 431 →
# 桌面端误报 `desktop welcome: Web authentication failed`，且无法自愈。
#
# profile 里把 cookieMaxAgeDays 改成 7 只是缓解：重度重启日（一天重启 10 次）
# 稳态仍有 70 条，照样踩线。这个脚本用来在需要时一次性清干净。
#
# 用法：
#   bash scripts/prune-auth-cookies.sh            # 清理（先备份）
#   bash scripts/prune-auth-cookies.sh --dry-run  # 只看数量和寿命分布
#
# 注意：必须在 App 完全退出后运行——运行中 Chromium 持有数据库，可能锁表，
#       且内存里的 cookie 会在退出时回写。
set -euo pipefail

COOKIE_DB="$HOME/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

die() { echo "✗ $*" >&2; exit 1; }

[ -f "${COOKIE_DB}" ] || die "找不到 cookie 库：${COOKIE_DB}
  非 macOS 或尚未启动过桌面端？"

# App 还开着就直接拒绝（避免锁表 + 内存回写）
# 注意：macOS 的 pgrep -f 对超长 pattern 会静默不匹配，这里用短 pattern + lsof 双保险。
APP_RUNNING=0
pgrep -f "Contents/MacOS/DeepSeek Harness" >/dev/null 2>&1 && APP_RUNNING=1
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -q "DeepSeek" && APP_RUNNING=1
if [ "${APP_RUNNING}" = "1" ]; then
  die "DeepSeek Harness 还在运行。请先完全退出（⌘Q）再执行。"
fi

command -v sqlite3 >/dev/null 2>&1 || die "找不到 sqlite3（macOS 自带，检查 PATH）"

COUNT="$(sqlite3 "${COOKIE_DB}" "select count(*) from cookies where name like 'dsh-auth-%';")"
echo "当前 dsh-auth-* cookie：${COUNT} 条"

if [ "${COUNT}" = "0" ]; then
  echo "无需清理。"
  exit 0
fi

# 寿命分布（天）：看有多少条是历史启动残留
echo "寿命分布（天 / 条数）："
sqlite3 "${COOKIE_DB}" "select round((expires_utc-creation_utc)/1000000.0/86400,0) as days, count(*) from cookies where name like 'dsh-auth-%' group by days order by days;"

# 风险评估：约 228 字节/条，16KB 上限
EST_BYTES=$(( COUNT * 228 ))
echo "估算 Cookie 头占用：约 ${EST_BYTES} 字节（上限 16384）"
if [ "${EST_BYTES}" -gt 12000 ]; then
  echo "⚠️ 已接近 431 阈值，建议尽快清理。"
fi

if [ "${DRY_RUN}" = "1" ]; then
  echo "[dry-run] 未做任何修改。"
  exit 0
fi

BACKUP_DIR="$HOME/.dsh/backups"
mkdir -p "${BACKUP_DIR}"
BACKUP="${BACKUP_DIR}/Cookies.bak-$(date +%Y%m%d-%H%M%S)"
cp "${COOKIE_DB}" "${BACKUP}"
echo "已备份：${BACKUP}"

sqlite3 "${COOKIE_DB}" "delete from cookies where name like 'dsh-auth-%';"

AFTER="$(sqlite3 "${COOKIE_DB}" "select count(*) from cookies where name like 'dsh-auth-%';")"
echo "✓ 清理完成：${COUNT} → ${AFTER} 条（下次启动会自动重铸一条）"
