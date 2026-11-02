/**
 * 平台能力判定测试（0.21.5）：Windows/Linux 上扩展工具不注册，但基础 GUI 工具仍可用。
 * 这里只测纯函数与 status 汇总，不碰真实系统。
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	areExtendedToolsSupported,
	EXTENDED_TOOLS_PLATFORM,
	extendedToolsSkipReason,
	isVerifiedPlatform,
	platformCapabilities,
	platformSummary
} from "../lib/platform.js";
import { collectStatus } from "../lib/status.js";

test("areExtendedToolsSupported：只有 darwin 为 true", () => {
	assert.equal(EXTENDED_TOOLS_PLATFORM, "darwin");
	assert.equal(areExtendedToolsSupported("darwin"), true);
	assert.equal(areExtendedToolsSupported("win32"), false);
	assert.equal(areExtendedToolsSupported("linux"), false);
});

test("extendedToolsSkipReason：说明 macOS-only、带平台名，并明确未验证", () => {
	const win = extendedToolsSkipReason("win32");
	assert.match(win, /macOS-only/);
	assert.match(win, /win32/);
	assert.match(win, /unverified/);
	const linux = extendedToolsSkipReason("linux");
	assert.match(linux, /no verified desktop backend/);
});

test("平台矩阵：只有 darwin 标记为已验证", () => {
	assert.equal(isVerifiedPlatform("darwin"), true);
	assert.equal(isVerifiedPlatform("win32"), false);
	assert.equal(isVerifiedPlatform("linux"), false);
	assert.equal(isVerifiedPlatform("freebsd"), false);
	assert.deepEqual(platformCapabilities("win32"), { base: true, extended: false, verified: false });
	assert.deepEqual(platformCapabilities("linux"), { base: false, extended: false, verified: false });
	assert.equal(platformCapabilities("freebsd").base, false);
});

test("platformSummary：Windows/Linux 文案写明 UNVERIFIED", () => {
	assert.match(platformSummary("darwin"), /verified/);
	assert.match(platformSummary("win32"), /UNVERIFIED/);
	assert.match(platformSummary("win32"), /implemented/);
	assert.match(platformSummary("linux"), /UNVERIFIED/);
	assert.match(platformSummary("linux"), /not implemented/);
	assert.match(platformSummary("freebsd"), /UNVERIFIED/);
});

test("collectStatus：extendedToolsSupported 随 platform 变化，文本给出跳过原因", () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-operator-status-"));
	const mac = collectStatus({ home, platform: "darwin" });
	assert.equal(mac.extendedToolsSupported, true);
	assert.equal(mac.platformVerified, true);
	assert.match(mac.text, /extended surface registered on macOS/);
	const win = collectStatus({ home, platform: "win32" });
	assert.equal(win.extendedToolsSupported, false);
	assert.match(win.text, /macOS-only/);
	assert.match(win.text, /win32/);
	assert.equal(win.platformVerified, false);
	assert.match(win.text, /UNVERIFIED/);
	const linux = collectStatus({ home, platform: "linux" });
	assert.equal(linux.platformVerified, false);
	assert.match(linux.text, /not implemented/);
});
