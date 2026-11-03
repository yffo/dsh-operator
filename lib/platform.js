/**
 * 平台能力判定（0.21.5）：把「扩展工具只支持 macOS」这条规则集中到一处，
 * 让 operator-tools（注册）、status（自诊断）、doctor（自检）共用同一套文案与判断，避免各写一份。
 */

/** 扩展工具（list_windows/screenshot_window/verify_state/AX 系列）支持平台。 */
export const EXTENDED_TOOLS_PLATFORM = "darwin";

/** @param {string} [platform] Node `process.platform` 值；测试可显式传入。 */
export function areExtendedToolsSupported(platform = process.platform) {
	return platform === EXTENDED_TOOLS_PLATFORM;
}

/**
 * 平台能力矩阵：代码路径 vs 是否真机验证。
 * - darwin：基础 + 扩展工具齐全，已验证。
 * - win32：基础 GUI 后端已实现（GDI 截图 + SendInput），但**没有真机验收**；扩展工具不注册。
 * - linux：插件能加载，桌面后端未实现，调用时报 unsupported_platform；未验证。
 */
export const PLATFORM_CAPABILITIES = {
	darwin: { base: true, extended: true, verified: true },
	win32: { base: true, extended: false, verified: false },
	linux: { base: false, extended: false, verified: false }
};

/** @returns {{base:boolean, extended:boolean, verified:boolean}} */
export function platformCapabilities(platform = process.platform) {
	return PLATFORM_CAPABILITIES[platform] ?? { base: false, extended: false, verified: false };
}

/** 该平台是否经过真机验证（Windows/Linux 一律 false，不冒充支持）。 */
export function isVerifiedPlatform(platform = process.platform) {
	return platformCapabilities(platform).verified;
}

/** 一行平台结论，status / doctor 共用，明确写「未验证」。 */
export function platformSummary(platform = process.platform) {
	if (platform === "darwin") return "darwin: base + extended tools (verified)";
	if (platform === "win32") return "win32: base GUI backend implemented but UNVERIFIED (no real-hardware acceptance); extended tools skipped";
	if (platform === "linux") return "linux: plugin loads, desktop backend is not implemented (UNVERIFIED); calls fail with unsupported_platform";
	return `${platform}: unsupported platform (UNVERIFIED)`;
}

/** 非 macOS 时给用户看的跳过原因（operator-tools 注册与 operator_status 共用）。 */
export function extendedToolsSkipReason(platform = process.platform) {
	return `extended tools (list_windows/screenshot_window/verify_state/AX/browser/clipboard) are macOS-only; skipped on ${platform} (${platform === "win32" ? "Windows base GUI is implemented but unverified" : "no verified desktop backend on this platform"})`;
}
