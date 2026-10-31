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

/** 非 macOS 时给用户看的跳过原因（operator-tools 注册与 operator_status 共用）。 */
export function extendedToolsSkipReason(platform = process.platform) {
	return `extended tools (list_windows/screenshot_window/verify_state/AX) are macOS-only; skipped on ${platform} (Windows/Linux support is untested; base GUI tools still work)`;
}
