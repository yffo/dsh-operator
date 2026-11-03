// 执行单元状态表（0.102.0，路线图 P2）
//
// 借鉴 superagent 原型的 stage 表思路（不是照抄它的工单体系）：给「谁在跑、跑到哪、卡在谁身上」
// 一个可计算的事实，而不是靠翻日志猜。
//
// 五种状态：
//   queued          已排队，还没开始
//   working         正在执行
//   waiting-person  等人（确认/接管/授权）
//   idle            没有任务在跑
//   ended           结束（完成或失败，带原因）
//
// 只有一个「当前任务」：同一会话里开新任务会把旧任务标成 ended（原因 superseded），
// 这样不会出现两个任务同时「working」的假象。

/** 合法的状态值。 */
export const EXECUTION_STATES = Object.freeze(["queued", "working", "waiting-person", "idle", "ended"]);

/** 状态迁移表：from → 允许去往的 to（ended 是终态，可从任意态进入）。 */
const TRANSITIONS = Object.freeze({
	queued: ["working", "ended", "waiting-person"],
	working: ["waiting-person", "ended", "idle"],
	"waiting-person": ["working", "ended", "idle"],
	idle: ["queued", "working", "ended"],
	ended: []
});

/** 状态表：session -> task。 */
const tasks = new Map();

/** 清空（测试用）。 */
export function resetExecutionState() {
	tasks.clear();
}

/**
 * 判断迁移是否合法。
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
	if (EXECUTION_STATES.includes(from) === false || EXECUTION_STATES.includes(to) === false) return false;
	if (from === to) return true;
	return (TRANSITIONS[from] ?? []).includes(to);
}

/**
 * 开一个任务（同一会话已有任务时，旧任务标 ended/superseded）。
 * @param {string} session
 * @param {{label?: string, total?: number, now?: number}} [options]
 * @returns {object} 任务快照
 */
export function beginTask(session, options = {}) {
	const key = String(session ?? "default");
	const previous = tasks.get(key);
	if (previous !== undefined && previous.state !== "ended") {
		previous.state = "ended";
		previous.endReason = "superseded";
		previous.updatedAt = options.now ?? Date.now();
	}
	const task = {
		session: key,
		label: typeof options.label === "string" ? options.label.slice(0, 120) : "",
		state: "queued",
		step: 0,
		total: Number.isInteger(options.total) && options.total > 0 ? options.total : 0,
		startedAt: options.now ?? Date.now(),
		updatedAt: options.now ?? Date.now(),
		endReason: null
	};
	tasks.set(key, task);
	return { ...task };
}

/**
 * 迁移状态（不合法就抛错，不静默改）。
 * @param {string} session
 * @param {string} to
 * @param {{reason?: string, step?: number, now?: number}} [options]
 * @returns {object}
 */
export function setState(session, to, options = {}) {
	const key = String(session ?? "default");
	const task = tasks.get(key);
	if (task === undefined) throw new Error(`no task for session: ${key}（先 beginTask）`);
	if (canTransition(task.state, to) === false) {
		throw new Error(`invalid transition: ${task.state} → ${to}`);
	}
	task.state = to;
	task.updatedAt = options.now ?? Date.now();
	if (Number.isInteger(options.step)) task.step = Math.max(task.step, options.step);
	if (to === "ended") task.endReason = typeof options.reason === "string" ? options.reason : "completed";
	return { ...task };
}

/**
 * 读任务快照。
 * @param {string} session
 * @returns {object|null}
 */
export function readTask(session) {
	const task = tasks.get(String(session ?? "default"));
	return task === undefined ? null : { ...task };
}

/**
 * 一行人话（给 operator_status 用）。
 * @param {string} session
 * @returns {string}
 */
export function describeTask(session) {
	const task = readTask(session);
	if (task === null) return "execution: idle（没有任务记录）";
	if (task.state === "ended") return `execution: ended（${String(task.endReason ?? "completed")}）`;
	const progress = task.total > 0 ? ` ${String(task.step)}/${String(task.total)}` : task.step > 0 ? ` ${String(task.step)}` : "";
	const label = task.label === "" ? "" : ` · ${task.label}`;
	return `execution: ${task.state}${progress}${label}`;
}
