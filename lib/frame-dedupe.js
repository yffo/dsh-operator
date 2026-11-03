import { createHash } from "node:crypto";

/** 同一窗口连续同一帧只在第一次附图；第二次给这行说明。 */
export const FRAME_UNCHANGED_NOTE =
	"<image_unchanged>Same pixels as the previous observation; the screenshot is omitted to save tokens. Call screenshot again if you need to re-check.</image_unchanged>";

/**
 * 对截图字节求 sha1——必须是像素字节本身，不能用 attachmentId（实测它不是逐帧唯一的）。
 * @param {Uint8Array | undefined} data - 截图字节。
 * @returns {string | undefined} 十六进制摘要；没有字节时返回 undefined。
 */
export function frameHash(data) {
	if (!(data instanceof Uint8Array) || data.length === 0) return;
	return createHash("sha1").update(data).digest("hex");
}

/**
 * 判断这一帧是否与上一次相同，并记住当前帧。
 * @param {string} key - 窗口/区域键。
 * @param {string | undefined} hash - 当前帧摘要。
 * @param {Map<string, string>} store - 会话内上次帧。
 * @returns {boolean} true 表示同一帧（可以省掉附图）。
 */
export function isSameFrame(key, hash, store) {
	if (typeof hash !== "string" || hash === "") return false;
	const previous = store.get(key);
	store.set(key, hash);
	return previous === hash;
}
