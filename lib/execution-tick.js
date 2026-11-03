// 执行状态接线（0.103.0）
//
// execution-state.js 是纯状态表，这里是「把真实动作翻译成状态」的薄适配：
// - 本会话还没有任务 → 开一个（label=工具名）
// - 已有任务且没结束 → working，步数 +1
// - 超过 idleMs 没有新动作 → 标 ended/completed（否则状态永远停在 working）

import { beginTask, readTask, setState } from "./execution-state.js";

/** 多久没有 GUI 动作就认为这一轮结束。 */
export const DEFAULT_IDLE_MS = 90 * 1000;

/**
 * 记一次 GUI 动作。
 * @param {string} session
 * @param {string} tool
 * @param {{now?: number, total?: number}} [options]
 * @returns {object} 任务快照
 */
export function tickExecution(session, tool, options = {}) {
	const now = Number.isFinite(options.now) ? options.now : Date.now();
	const label = String(tool ?? "gui").slice(0, 120);
	let task = readTask(session);
	if (task === null || task.state === "ended") {
		beginTask(session, { label, ...(Number.isInteger(options.total) ? { total: options.total } : {}), now });
		task = readTask(session);
	}
	if (task !== null && task.state !== "working") {
		// waiting-person / queued / idle 都允许回到 working（表里允许）
		setState(session, "working", { step: (task.step ?? 0) + 1, now });
	} else if (task !== null) {
		setState(session, "working", { step: (task.step ?? 0) + 1, now });
	}
	return readTask(session);
}

/**
 * 空闲超时收尾：把还在 working 的任务标成 ended/completed。
 * @param {string} session
 * @param {{now?: number, idleMs?: number}} [options]
 * @returns {object|null} 收尾后的快照；没做任何事返回 null
 */
export function expireIdle(session, options = {}) {
	const now = Number.isFinite(options.now) ? options.now : Date.now();
	const idleMs = Number.isFinite(options.idleMs) && options.idleMs > 0 ? options.idleMs : DEFAULT_IDLE_MS;
	const task = readTask(session);
	if (task === null || task.state !== "working") return null;
	if (now - task.updatedAt < idleMs) return null;
	return setState(session, "ended", { reason: "idle-timeout", now });
}
