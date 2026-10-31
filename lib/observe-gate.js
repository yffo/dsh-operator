/**
 * 首帧观察闸（0.9.0 懒观察）。
 *
 * 默认 `auto`：只有本会话在最近 `idleObserveMs`（默认 10 分钟）内做过 GUI 动作时，
 * 新的 user 消息才自动附一张首帧截图。纯聊天会话不再产生截图 token。
 * 会话第一次需要看屏幕时，模型调 `wait`（内部 recapture 会返回观察），
 * 这条约定写在策略文本里，所以懒观察不会引入「拿旧截图盲点」的风险。
 *
 * 无 I/O；会话用 WeakMap 关联，不泄漏。
 */

/** 默认 GUI 活动窗口：10 分钟。 */
export const DEFAULT_IDLE_OBSERVE_MS = 10 * 60 * 1e3;

/** session -> 最近一次 GUI 动作时间戳（ms）。 */
const ACTIVITY = new WeakMap();

/**
 * Record that one GUI action just ran for this session.
 * @param session - agent session object (any object works as a key).
 * @returns void
 */
export function noteGuiActivity(session) {
	if (session === void 0 || session === null) return;
	try {
		ACTIVITY.set(session, Date.now());
	} catch {
		// non-object session: ignore
	}
}

/**
 * Last GUI activity timestamp for this session.
 * @param session - agent session object.
 * @returns epoch ms, or undefined.
 */
export function lastGuiActivityAt(session) {
	if (session === void 0 || session === null) return void 0;
	try {
		return ACTIVITY.get(session);
	} catch {
		return void 0;
	}
}

/**
 * Whether the pre-step hook should attach a first-frame observation.
 * @param session - agent session object.
 * @param config - resolved plugin config (`firstFrame`, `idleObserveMs`).
 * @returns boolean
 */
export function shouldObserveFirstFrame(session, config = {}) {
	const mode = typeof config.firstFrame === "string" ? config.firstFrame : "auto";
	if (mode === "eager") return true;
	if (mode === "off") return false;
	const last = lastGuiActivityAt(session);
	if (last === void 0) return false;
	const idle = Number.isFinite(config.idleObserveMs) ? config.idleObserveMs : DEFAULT_IDLE_OBSERVE_MS;
	if (idle <= 0) return false;
	return Date.now() - last <= idle;
}

/**
 * Guard text so the model knows how to look without an attached frame.
 * @returns the policy sentence appended to the slim policy.
 */
export function lazyObservePolicyLine() {
	return "If this turn has no attached window screenshot yet (lazy observation), call wait once before acting — it returns a fresh observation. Then map clicks from that screenshot.";
}
