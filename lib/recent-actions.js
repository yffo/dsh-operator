// 最近动作环形缓冲（0.64.0）：给跨窗口交接自动补充「最近做过什么」。
// 只记工具名/成败/短备注；不落参数正文，不阻塞工具调用。

export const RECENT_LIMIT = 20;

const entries = [];

/**
 * 记一条最近动作（同工具连续失败也只各记一条，交给 failure_list 做聚合）。
 * @param {string} tool 工具名。
 * @param {boolean} ok 是否成功。
 * @param {string} [note] 短备注（≤80 字符，禁止放参数正文）。
 */
export function recordRecentAction(tool, ok, note) {
	if (typeof tool !== "string" || tool === "") return;
	const entry = { tool: tool.slice(0, 60), ok: ok === true, ...(typeof note === "string" && note !== "" ? { note: note.slice(0, 80) } : {}) };
	entries.push(entry);
	if (entries.length > RECENT_LIMIT * 2) entries.splice(0, entries.length - RECENT_LIMIT);
}

/** 取最近 N 条（默认 20），不修改缓冲。 */
export function recentActions(limit = RECENT_LIMIT) {
	const size = Number.isInteger(limit) && limit > 0 ? Math.min(limit, RECENT_LIMIT) : RECENT_LIMIT;
	return entries.slice(-size);
}

/** 清空（测试用）。 */
export function clearRecentActions() {
	entries.length = 0;
}
