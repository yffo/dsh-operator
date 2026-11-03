// noop 阶梯（0.99.0，路线图 P1-3）
//
// 动作报「画面没变化」时，模型的本能是原样重试——重试三次还是没变，纯烧时间还可能有副作用。
// 这里按会话记录「同一个动作签名连续失败几次」，给三级反应：
//   1 次：提示「先放大观察或重读 AX 快照」
//   2 次：升级「换条通道（ax_press / browser_* / 快捷键）」
//   3 次：拒绝再执行同一动作，要求先改变观察

const MAX_ENTRIES = 200;
/** 同一签名的记录多久后失效（毫秒）。 */
export const NOOP_TTL_MS = 10 * 60 * 1000;

/** session -> Map<signature, {count, at}> */
const store = new Map();

/** 清空（测试用）。 */
export function resetNoopLadder() {
	store.clear();
}

/**
 * 动作签名：工具名 + 关键参数（位置/索引/文本），用于判断「是不是同一个动作」。
 * @param {string} tool
 * @param {object} args
 * @returns {string}
 */
export function actionSignature(tool, args = {}) {
	const parts = [String(tool)];
	const keys = ["position", "index", "x", "y", "key", "keys", "text", "ref", "selector", "url", "path"];
	for (const key of keys) {
		const value = args?.[key];
		if (value === undefined || value === null) continue;
		parts.push(`${key}=${Array.isArray(value) ? value.join(",") : String(value).slice(0, 60)}`);
	}
	return parts.join("|");
}

/**
 * 记一次 noop，返回该给的下一步动作。
 * @param {string} session 会话标识
 * @param {string} signature 动作签名
 * @param {number} [now]
 * @returns {{ count: number, action: "hint"|"escalate"|"refuse", note: string }}
 */
export function recordNoop(session, signature, now = Date.now()) {
	const key = typeof session === "string" && session !== "" ? session : "default";
	let bucket = store.get(key);
	if (bucket === undefined) {
		bucket = new Map();
		store.set(key, bucket);
	}
	const previous = bucket.get(signature);
	const count = previous !== undefined && now - previous.at <= NOOP_TTL_MS ? previous.count + 1 : 1;
	bucket.set(signature, { count, at: now });
	// 控制内存：超量时丢最早的
	if (bucket.size > MAX_ENTRIES) {
		const oldest = [...bucket.entries()].sort((a, b) => a[1].at - b[1].at)[0];
		if (oldest !== undefined) bucket.delete(oldest[0]);
	}
	if (count >= 3) {
		return {
			count,
			action: "refuse",
			note: `同一个动作已连续 ${String(count)} 次没有产生画面变化，已拒绝继续重试。请先改变观察方式（zoom_region 放大、重读 AX 快照、或换应用窗口），再决定下一步。`
		};
	}
	if (count === 2) {
		return {
			count,
			action: "escalate",
			note: "同一个动作第 2 次没有产生画面变化：别再重复坐标点击，换一条通道试试（原生控件用 ax_press/ax_set_value，网页用 browser_click，或改用快捷键）。"
		};
	}
	return {
		count,
		action: "hint",
		note: "动作执行了但画面没有变化（可能被遮挡、焦点不在、或目标不可点）。先 zoom_region 放大观察目标区域，或重新读一次 AX 快照确认控件还在。"
	};
}

/**
 * 动作生效后清掉该会话的记录（下一次 noop 重新从 1 开始）。
 * @param {string} session
 */
/**
 * 查当前同签名的 noop 次数（执行前用；达到阈值就拒绝再试）。
 * @param {string} session
 * @param {string} signature
 * @param {number} [now]
 * @returns {number}
 */
export function peekNoop(session, signature, now = Date.now()) {
	const key = typeof session === "string" && session !== "" ? session : "default";
	const bucket = store.get(key);
	if (bucket === undefined) return 0;
	const entry = bucket.get(signature);
	if (entry === undefined) return 0;
	return now - entry.at <= NOOP_TTL_MS ? entry.count : 0;
}

export function clearNoop(session) {
	const key = typeof session === "string" && session !== "" ? session : "default";
	store.delete(key);
}
