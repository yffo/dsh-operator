/**
 * 平台能力判定测试（0.21.5）：Windows/Linux 上扩展工具不注册，但基础 GUI 工具仍可用。
 * 这里只测纯函数与 status 汇总，不碰真实系统。
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { areExtendedToolsSupported, EXTENDED_TOOLS_PLATFORM, extendedToolsSkipReason } from "../lib/platform.js";
import { collectStatus } from "../lib/status.js";

test("areExtendedToolsSupported：只有 darwin 为 true", () => {
	assert.equal(EXTENDED_TOOLS_PLATFORM, "darwin");
	assert.equal(areExtendedToolsSupported("darwin"), true);
	assert.equal(areExtendedToolsSupported("win32"), false);
	assert.equal(areExtendedToolsSupported("linux"), false);
});

test("extendedToolsSkipReason：说明 macOS-only 并带上平台名", () => {
	const reason = extendedToolsSkipReason("win32");
	assert.match(reason, /macOS-only/);
	assert.match(reason, /win32/);
	assert.match(reason, /base GUI tools still work/);
});

test("collectStatus：extendedToolsSupported 随 platform 变化，文本给出跳过原因", () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-operator-status-"));
	const mac = collectStatus({ home, platform: "darwin" });
	assert.equal(mac.extendedToolsSupported, true);
	assert.match(mac.text, /extended surface registered on macOS/);
	const win = collectStatus({ home, platform: "win32" });
	assert.equal(win.extendedToolsSupported, false);
	assert.match(win.text, /macOS-only/);
	assert.match(win.text, /win32/);
});
