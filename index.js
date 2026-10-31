/**
 * dsh-operator —— dsh-orb 的 computer-use 能力层，去球后的宿主入口。
 *
 * 这个文件只做两件事：补齐 vendored 原生 helper 的执行位，再把真正的 cordis
 * 插件（`name` / `inject` / `apply` / `Config`）原样转发出去。
 * 实际的工具实现全部在 `lib/computer-use/`，来自 dsh-orb@0.2.0（MIT，见 NOTICE）。
 */
import { chmodSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// 上游发布的 tarball 里 ScreenCaptureKit helper 是 0644（dsh-orb issue #40）。
// 无球版没有 overlay guard，正常截图走 /usr/sbin/screencapture，不依赖这个二进制；
// 但装完后它要是被解出可执行位丢失，overlay-exclude 路径会 EACCES，这里顺手自愈。
const nativeHelpers = [
  ['lib', 'computer-use', 'macos-sck-capture'],
  ['lib', 'bin', 'ax-snapshot'],
]
for (const segments of nativeHelpers) {
  const path = join(here, ...segments)
  if (!existsSync(path)) continue
  try {
    chmodSync(path, 0o755)
  } catch (error) {
    console.warn(`[dsh-operator] 无法给 ${path} 加执行位：${String(error)}`)
  }
}

export { Config, PLUGIN_NAME, apply, inject, name } from './lib/computer-use/index.js'
