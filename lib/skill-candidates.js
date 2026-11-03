// 技能自动候选（0.79.0）
//
// G3 的「沉淀」现在全靠人手动写 skill_save：知道要存、知道每一步参数。
// 真实情况是做完一串操作就过去了。这里在内存里滚动记下**刚做成功的 GUI 动作**
// （工具名 + 参数），`skill_suggest` 直接把它拼成一条可保存的技能草案。
//
// 隐私边界：
// - 只在内存里留存（进程重启即失），不落盘、不进审计、不进失败样本；
// - 参数命中敏感键（password/token/…）的动作**整条丢弃**，不猜测、不脱敏后保存；
// - 只记成功的动作；失败的动作不进候选（技能要能重放）。

import { isGuiToolName } from "./gui-tool-names.js";
import { containsSecretText, containsSensitiveKey } from "./sensitive.js";
import { validateSkill } from "./skill-store.js";

/** 最多留多少步（技能上限 50，候选取小一些避免把整段杂事都收进来）。 */
export const CANDIDATE_MAX_STEPS = 24;
/** 单条参数序列化后的上限（超过就整条丢弃）。 */
const MAX_ARG_BYTES = 4096;

/** 候选条目：{ tool, args, key }；key 是会话标识，空串表示未标记。 */
let buffer = [];
let enabled = true;

/** 开/关候选记录（插件按配置调用）。 */
export function setCandidateRecording(value) {
	enabled = value !== false;
	if (enabled === false) buffer = [];
}

/**
 * 从工具执行上下文推导会话标识（0.83.0）。
 * 拿不到就返回空串——调用方会把空串当「不区分会话」。
 * @param {object|undefined} exec
 * @returns {string}
 */
export function sessionKeyOf(exec) {
	const agent = exec?.agent;
	const raw = agent?.id ?? agent?.sessionId ?? exec?.sessionId ?? exec?.session?.id ?? "";
	return typeof raw === "string" ? raw : "";
}

/**
 * 当前候选步数；给 key 时只算该会话（0.83.0）。
 * @param {string} [key]
 * @returns {number}
 */
export function candidateCount(key) {
	return listCandidates(key).length;
}

/**
 * 取候选列表（按会话过滤，含未标记条目以兼容旧行为）。
 * @param {string} [key]
 * @returns {Array<{tool:string,args:object,key:string}>}
 */
export function listCandidates(key) {
	if (typeof key !== "string" || key === "") return [...buffer];
	return buffer.filter((item) => item.key === "" || item.key === key);
}

/** 清空候选（测试与「用过一次」后调用）。 */
export function resetCandidates() {
	buffer = [];
}

/**
 * 记一步成功动作。非 GUI 工具、参数敏感、参数过大都会被丢弃。
 * @param {string} tool
 * @param {unknown} args
 * @returns {boolean} 是否被收下
 */
export function recordCandidate(tool, args, key = "") {
	if (enabled === false) return false;
	if (typeof tool !== "string" || isGuiToolName(tool) === false) return false;
	const payload = args !== null && typeof args === "object" && Array.isArray(args) === false ? args : {};
	// 0.82.0：只查顶层键名会漏掉 options.password 这类嵌套；自由文本里的密钥形态也要拦
	if (containsSensitiveKey(payload)) return false;
	if (containsSecretText(payload)) return false;
	let serialized;
	try {
		serialized = JSON.stringify(payload);
	} catch {
		return false;
	}
	if (Buffer.byteLength(serialized) > MAX_ARG_BYTES) return false;
	buffer.push({ tool, args: payload, key: typeof key === "string" ? key : "" });
	if (buffer.length > CANDIDATE_MAX_STEPS) buffer = buffer.slice(-CANDIDATE_MAX_STEPS);
	return true;
}

/**
 * 生成一条技能草案（不落盘）。
 * @param {{ name?: string, description?: string, now?: Date }} [options]
 * @returns {{ ok: boolean, skill?: object, errors?: string[], reason?: string }}
 */
export function buildCandidateSkill(options = {}) {
	const picked = listCandidates(options.key);
	if (picked.length === 0) return { ok: false, reason: "候选为空：先做几步成功的 GUI 操作，再来提技能" };
	const now = options.now instanceof Date ? options.now : new Date();
	const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
	// 0.82.0：同一天、同步数的两次建议会撞名，带时分秒
	const clock = `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
	const skill = {
		name: typeof options.name === "string" && options.name.trim() !== "" ? options.name.trim() : `captured-${stamp}-${clock}-${String(picked.length)}steps`,
		description: typeof options.description === "string" && options.description.trim() !== ""
			? options.description.trim()
			: `自动候选：最近 ${String(picked.length)} 步成功操作（${picked[0].tool} → ${picked[picked.length - 1].tool}）`,
		steps: picked.map((item) => ({ tool: item.tool, ...(Object.keys(item.args).length === 0 ? {} : { args: item.args }) }))
	};
	const validation = validateSkill(skill);
	if (validation.ok === false) return { ok: false, errors: validation.errors };
	return { ok: true, skill };
}
