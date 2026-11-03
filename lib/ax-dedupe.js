// 多步操作里相邻观察的 AX 树经常一字不差（点按不动文本、滚动不改语义）。
// 同样的 4–5KB 反复回传纯属烧 token：连续两次相同就折叠成一行说明。
// 但最多连折两次——模型可能确实需要再看一遍树，第三次就回全文。

import { createHash } from "node:crypto";

export const AX_UNCHANGED_NOTE = '<tree_unchanged>Same element tree as the previous observation; call the observation tool again if you need the full tree.</tree_unchanged>';

/** 连续折叠次数的上限：超过就强制回全文。 */
export const AX_DEDUPE_MAX_NOTES = 2;

const objectState = new WeakMap();
const stringState = new Map();
const STRING_KEY_LIMIT = 128;

function stateFor(session) {
	if (typeof session === "object" && session !== null) {
		const existing = objectState.get(session);
		if (existing !== undefined) return existing;
		const created = { digest: "", notes: 0 };
		objectState.set(session, created);
		return created;
	}
	if (typeof session === "string") {
		const existing = stringState.get(session);
		if (existing !== undefined) return existing;
		const created = { digest: "", notes: 0 };
		if (stringState.size >= STRING_KEY_LIMIT) {
			const oldest = stringState.keys().next().value;
			if (oldest !== undefined) stringState.delete(oldest);
		}
		stringState.set(session, created);
		return created;
	}
	return undefined;
}

/**
 * 通用快照去重：同一 key 连续两次相同文本折叠成 note。
 * @param {object|string|undefined} key 会话对象或稳定字符串键。
 * @param {string|undefined} text 本次文本。
 * @param {string} note 折叠时返回的一行说明。
 * @param {number} maxNotes 最多连折几次，超过强制回全文。
 */
export function dedupeByKey(key, text, note, maxNotes = AX_DEDUPE_MAX_NOTES) {
	if (typeof text !== "string" || text === "" || key === undefined || key === null) return text;
	const state = stateFor(key);
	if (state === undefined) return text;
	const digest = createHash("sha1").update(text).digest("hex");
	if (state.digest === digest) {
		if (state.notes < maxNotes) {
			state.notes += 1;
			return note;
		}
		state.notes = 0;
		return text;
	}
	state.digest = digest;
	state.notes = 0;
	return text;
}

/**
 * 同一 session（对象或字符串键）的 AX 文本去重。
 * @param {object|string|undefined} session 会话对象，或 `cua:<windowId>` 这类稳定键。
 * @param {string|undefined} text 本次 AX 文本。
 * @returns {string|undefined} 原文，或“未变化”的一行说明。
 */
export function dedupeAxText(session, text) {
	return dedupeByKey(session, text, AX_UNCHANGED_NOTE, AX_DEDUPE_MAX_NOTES);
}
