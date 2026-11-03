// GUI 工具名判定（0.79.0 抽出，避免 recent-actions 与 skill-candidates 互相 import）。

/** 精确名单：不是前缀命名、但确实会操作 GUI 的工具。 */
const GUI_EXACT = new Set([
	"click", "input_text", "scroll", "hotkey", "wait", "long_wait", "screenshot", "long_press", "drag",
	"open_in_browser", "open_in_finder", "list_apps", "open_app", "ocr", "screenshot_window",
	"list_windows", "verify_state", "zoom_region", "window_move",
	"cua_act", "cua_observe", "cua_windows", "cua_launch"
]);

/** 前缀名单：ax_* / cua_* / cu_* / browser_* / clipboard_* 都会碰机器。 */
const GUI_PREFIX = /^(ax_|cua_|cu_|browser_|clipboard_|screenshot_|open_|list_|verify_|zoom_|window_)/;

/**
 * 判断一个工具名是否属于「会操作 GUI」的那类。
 * @param {string} name
 * @returns {boolean}
 */
export function isGuiToolName(name) {
	const tool = String(name ?? "");
	if (tool === "") return false;
	return GUI_EXACT.has(tool) || GUI_PREFIX.test(tool);
}
