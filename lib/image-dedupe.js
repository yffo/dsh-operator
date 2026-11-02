/**
 * 观察截图去重：同一个窗口连续两次截图若像素完全相同，第二次不再附图。
 * attachmentId 是内容寻址的，同一帧两张截图会拿到同一个 id，可以直接比较。
 */
export const IMAGE_UNCHANGED_NOTE =
	"<image_unchanged>Same pixels as the previous observation; the screenshot is omitted to save tokens. Call screenshot again if you need to re-check.</image_unchanged>";

/**
 * 去重键：屏幕序号 + 可见区域。不同窗口/区域互不影响。
 * @param {{screenIndex?: number, visibleBounds?: unknown}} screen - 截图条目。
 * @returns {string} 去重键。
 */
export function imageDedupeKey(screen) {
	const bounds = screen?.visibleBounds;
	const area = bounds === undefined || bounds === null ? "" : JSON.stringify(bounds);
	return `${String(screen?.screenIndex ?? 0)}:${area}`;
}

/**
 * 记下当前帧；与上一次同键且 attachmentId 相同的返回 false（不必再附图）。
 * @param {{screenIndex?: number, visibleBounds?: unknown, image?: {attachmentId?: string}}} screen - 截图条目。
 * @param {Map<string, string>} store - 会话内的上次帧记录。
 * @returns {boolean} 是否应该附图。
 */
export function rememberImage(screen, store) {
	const id = screen?.image?.attachmentId;
	if (typeof id !== "string" || id === "") return true;
	const key = imageDedupeKey(screen);
	if (store.get(key) === id) return false;
	store.set(key, id);
	return true;
}
