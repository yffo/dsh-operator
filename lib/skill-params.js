// 技能参数化（0.66.0）
//
// 0.11.2 的技能库只能原样回放：同一条技能换个目标（应用名、搜索词、文件名）就得重存一份，
// 于是「同类任务第二次执行步数 -50%」的目标根本达不到——省下的只是敲参数的时间。
//
// 这里给技能加上 `{{变量}}` 占位符：
//   steps: [{ tool: "open_app", args: { name: "{{app}}" } }]
//   skill_run { name: "...", args: { app: "系统设置" } }
// 回放时只替换字符串里的占位符，其余参数原样保留；缺参数直接报清楚，不执行。

/** 占位符语法：{{ name }}，名字限 a-zA-Z0-9_-，最长 32。 */
export const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_-]{1,32})\s*\}\}/g;

const MAX_VARIABLES = 24;

/**
 * 找出技能里用到的变量名（去重、排序）。
 * @param {Array<{args?: object}>} steps
 * @returns {string[]}
 */
export function collectVariables(steps) {
	const found = new Set();
	walkArgs(steps, (text) => {
		for (const match of text.matchAll(PLACEHOLDER_RE)) found.add(match[1]);
	});
	return [...found].sort().slice(0, MAX_VARIABLES);
}

/**
 * 用实际参数填充技能步骤。
 * 缺少的变量不会替换（保留占位符原样），由调用方决定是否中止。
 * @param {Array<{tool: string, args?: object}>} steps
 * @param {object} [args]
 * @returns {{ steps: Array<object>, missing: string[], used: string[] }}
 */
export function applySkillArgs(steps, args = {}) {
	const missing = new Set();
	const used = new Set();
	const safeArgs = args !== null && typeof args === "object" ? args : {};
	const fill = (value) => {
		if (typeof value === "string") {
			return value.replace(PLACEHOLDER_RE, (whole, name) => {
				const provided = safeArgs[name];
				if (provided === undefined || provided === null) {
					missing.add(name);
					return whole;
				}
				used.add(name);
				return String(provided);
			});
		}
		if (Array.isArray(value)) return value.map((item) => fill(item));
		if (value !== null && typeof value === "object") {
			const out = {};
			for (const [key, item] of Object.entries(value)) out[key] = fill(item);
			return out;
		}
		return value;
	};
	const cloned = (Array.isArray(steps) ? steps : []).map((step) => ({
		...step,
		...(step?.args === undefined ? {} : { args: fill(step.args) })
	}));
	return { steps: cloned, missing: [...missing].sort(), used: [...used].sort() };
}

/** 遍历 args 里所有字符串，交给回调（用于收集占位符）。 */
function walkArgs(steps, visit) {
	const walk = (value) => {
		if (typeof value === "string") return visit(value);
		if (Array.isArray(value)) return value.forEach(walk);
		if (value !== null && typeof value === "object") return Object.values(value).forEach(walk);
	};
	for (const step of Array.isArray(steps) ? steps : []) walk(step?.args);
}
