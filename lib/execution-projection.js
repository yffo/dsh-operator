// 执行状态的会话投影（0.104.0，路线图 P2 尾项）
//
// 为什么要有这一层：
// - 宿主的执行状态表（lib/execution-state.js）是**进程内 Map**，只有 operator_status 看得见；
//   HUD 拿不到，只能自己去翻会话事件（binding.eventSource，非公开契约）。
// - 会话投影是宿主公开的「日志派生状态」通道：宿主折叠、客户端读一份校验过的快照。
//   这样 HUD 和执行状态表就共用同一份口径，也不再依赖 eventSource。
//
// 只折事件、不写事件：官方读取器拒绝未知的非 ignorable 事件（见 dsh-session/known-event-types），
// 所以这里绝不往会话日志里塞自定义事件。需要的事实日志里本来就有：
//   tool/call + tool/result        —— 正在操作（工具名、耗时、成败）
//   approval/asked + decided       —— 在等杨总确认（黄灯的真实信号）
//   turn/end                       —— 这一轮结束
//
// 校验器为什么不用 zod：宿主的投影注册表只调用 `schema.parse(value)`（源码 254/258/296/304），
// 不依赖 ZodType 的具体类；而本仓库本地没有 node_modules，用零依赖的小校验器测试才能直接跑。
// 契约上仍按 Zod 的语义实现：strict（未知字段报错）+ parse 返回脱离原对象的副本。

import { DEFAULT_IDLE_MS } from "./execution-tick.js";
import { isGuiToolName } from "./gui-tool-names.js";

/** 投影 key：客户端按这个名字读（client/client.js 的 PROJECTION_KEY 必须一致）。 */
export const EXECUTION_PROJECTION_KEY = "operatorExecution";

/** 折叠语义变了就 +1（旧 checkpoint 会被宿主判定不兼容后全量重放）。 */
export const EXECUTION_PROJECTION_STATE_VERSION = 3;

/** 多久没有新动作就认为这一轮结束（与 execution-tick 的 DEFAULT_IDLE_MS 同源）。 */
export const PROJECTION_IDLE_MS = DEFAULT_IDLE_MS;

/**
 * 投影里的状态。与 execution-state.js 的五态同口径，但 `queued` 不会出现在日志里
 * （排队是进程内状态），所以客户端可见的只有这四种。
 */
export const EXECUTION_VIEW_STATES = Object.freeze(["idle", "working", "waiting-person", "ended"]);

/** 状态字段白名单（stateSchema 与 viewSchema 同一份形状，view 只是去掉内部字段）。 */
const STATE_FIELDS = Object.freeze([
	"state",
	"tool",
	"step",
	"startedAt",
	"updatedAt",
	"callStartedAt",
	"callFinishedAt",
	"failed",
	"reason",
	"callId",
	// v2：在等确认的是哪个工具（GUI 工具不请求审批，真正需要人拍板的常常是 bash/write）
	"approvalTool",
	// v3：当前回合号——步数按回合算，不再跨回合累加
	"turn"
]);

/** view 字段（给客户端的部分；callId 是内部配对用，不暴露）。 */
const VIEW_FIELDS = Object.freeze(STATE_FIELDS.filter((field) => field !== "callId"));

/** 数字字段（turn 允许 -1，单独校验）。 */
const NUMBER_FIELDS = Object.freeze(["step", "startedAt", "updatedAt", "callStartedAt", "callFinishedAt"]);

/** 字符串字段。 */
const STRING_FIELDS = Object.freeze(["tool", "reason", "callId"]);

/**
 * 初始状态：空闲、没有任何动作。
 * @returns {object} 新的状态对象（每次调用都给新引用）。
 */
export function initExecutionState() {
	return {
		state: "idle",
		tool: "",
		step: 0,
		startedAt: 0,
		updatedAt: 0,
		callStartedAt: 0,
		callFinishedAt: 0,
		failed: false,
		reason: "",
		callId: "",
		approvalTool: "",
		turn: -1
	};
}

/**
 * 事件时刻；拿不到就退回 0（不让一个坏事件把整条驱动打断）。
 * @param {object} event 会话事件。
 * @returns {number}
 */
function timeOf(event) {
	const time = event === null || event === undefined ? undefined : event.time;
	return typeof time === "number" && Number.isFinite(time) ? time : 0;
}

/**
 * 校验并复制一份状态（strict）。
 * @param {unknown} value 候选状态。
 * @param {readonly string[]} fields 允许的字段。
 * @param {string} label 报错前缀。
 * @returns {object} 字段白名单内的浅拷贝。
 */
function parseFields(value, fields, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: 需要对象`);
	for (const key of Object.keys(value)) if (fields.includes(key) === false) throw new Error(`${label}: 未知字段 ${key}`);
	const state = value.state;
	if (EXECUTION_VIEW_STATES.includes(state) === false) throw new Error(`${label}: 非法 state ${String(state)}`);
	for (const key of NUMBER_FIELDS) {
		const number = value[key];
		if (typeof number !== "number" || Number.isFinite(number) === false || number < 0) throw new Error(`${label}: ${key} 需要非负有限数`);
	}
	for (const key of STRING_FIELDS) {
		if (fields.includes(key) === false) continue;
		const text = value[key];
		if (typeof text !== "string") throw new Error(`${label}: ${key} 需要字符串`);
	}
	if (typeof value.failed !== "boolean") throw new Error(`${label}: failed 需要布尔`);
	if (typeof value.turn !== "number" || Number.isInteger(value.turn) === false || value.turn < -1) throw new Error(`${label}: turn 需要 >= -1 的整数`);
	const parsed = {};
	for (const key of fields) parsed[key] = value[key];
	return parsed;
}

/** 状态 schema（等价于 z.object(…).strict()）。 */
export const executionStateSchema = Object.freeze({
	parse(value) {
		return parseFields(value, STATE_FIELDS, "operatorExecution state");
	}
});

/** 客户端视图 schema。 */
export const executionViewSchema = Object.freeze({
	parse(value) {
		return parseFields(value, VIEW_FIELDS, "operatorExecution view");
	}
});

/**
 * 从状态里取客户端可见的视图。
 * @param {object} state 折叠后的状态。
 * @returns {object} 客户端视图。
 */
export function executionView(state) {
	const view = {};
	for (const field of VIEW_FIELDS) view[field] = state[field];
	return view;
}

/**
 * 折叠一个事件。
 *
 * 约定（宿主文档）：与本单位无关的事件必须返回**同一个引用**，否则下游白算。
 * @param {object} state 当前状态。
 * @param {object} event 会话事件。
 * @returns {object} 新状态，或原引用。
 */
export function applyExecutionEvent(state, event) {
	if (state === null || typeof state !== "object") return state;
	const type = event === null || event === undefined ? undefined : event.type;
	if (type === "tool/call") {
		const data = event.data ?? {};
		const name = typeof data.name === "string" ? data.name : "";
		// 只认 GUI 工具：状态条说的是「正在操作电脑」，不是「正在跑工具」。
		if (isGuiToolName(name) === false) return state;
		const at = timeOf(event);
		const previous = typeof state.updatedAt === "number" ? state.updatedAt : 0;
		const turn = Number.isFinite(data.turn) ? Number(data.turn) : -1;
		// 回合变了就是新一轮：步数按「这一轮的第几步」算，不跨回合累加
		const newRun = state.state === "idle" || state.state === "ended" || turn !== state.turn || at - previous > PROJECTION_IDLE_MS;
		return {
			...state,
			state: "working",
			tool: name.slice(0, 120),
			step: newRun ? 1 : (Number(state.step) || 0) + 1,
			startedAt: newRun ? at : Number(state.startedAt) || at,
			updatedAt: at,
			callStartedAt: at,
			callFinishedAt: 0,
			failed: false,
			reason: "",
			callId: String(data.callId ?? "").slice(0, 200),
			approvalTool: "",
			turn
		};
	}
	if (type === "tool/result") {
		const data = event.data ?? {};
		const callId = String(data.message?.source?.callId ?? "");
		// 只认自己那次调用的结果；别的工具（含非 GUI）不碰状态。
		if (callId === "" || callId !== state.callId) return state;
		return {
			...state,
			callFinishedAt: timeOf(event),
			updatedAt: timeOf(event),
			failed: data.message?.isError === true
		};
	}
	if (type === "approval/asked") {
		const data = event.data ?? {};
		const approvalTool = (typeof data.toolName === "string" ? data.toolName : "").slice(0, 120);
		// 任何工具的审批都点亮黄灯：GUI 工具从不请求审批（我们自己的 confirm 是模型侧约束），
		// 真正需要人拍板的是 bash/write 这类工具——那正是「该看 HUD 一眼」的时刻。
		const at = timeOf(event);
		const fresh = state.state === "idle" || state.state === "ended";
		return {
			...state,
			state: "waiting-person",
			tool: fresh && approvalTool !== "" ? approvalTool : state.tool,
			startedAt: fresh ? at : state.startedAt,
			approvalTool,
			updatedAt: at
		};
	}
	if (type === "approval/decided") {
		if (state.state !== "waiting-person") return state;
		return { ...state, state: "working", approvalTool: "", updatedAt: timeOf(event) };
	}
	if (type === "turn/end") {
		if (state.state === "idle" || state.state === "ended") return state;
		return { ...state, state: "ended", reason: "turn-end", updatedAt: timeOf(event) };
	}
	return state;
}

/**
 * 把投影状态写成 `operator_status` 那一行（与 execution-state.js 的措辞保持一致）。
 * @param {object|undefined|null} state 宿主投影状态。
 * @returns {string|null} 没有人话可写时返回 null（调用方回退到进程内状态表）。
 */
export function describeExecutionProjection(state) {
	if (state === null || state === undefined || typeof state !== "object") return null;
	const step = Number.isInteger(state.step) && state.step > 0 ? ` ${String(state.step)}` : "";
	if (state.state === "idle") return "execution: idle（没有任务记录）";
	if (state.state === "waiting-person") {
		const tool = typeof state.approvalTool === "string" && state.approvalTool !== "" ? ` · ${state.approvalTool}` : "";
		return `execution: waiting-person${step}${tool}`;
	}
	if (state.state === "ended") return `execution: ended（${String(state.reason === "" ? "completed" : state.reason)}）`;
	const tool = typeof state.tool === "string" && state.tool !== "" ? ` · ${state.tool}` : "";
	return `execution: ${String(state.state)}${step}${tool}`;
}

/**
 * 造一个投影单元定义（宿主 sessionProjections.register 的入参）。
 * @returns {object} 投影定义。
 */
export function createExecutionProjection() {
	return {
		key: EXECUTION_PROJECTION_KEY,
		stateVersion: EXECUTION_PROJECTION_STATE_VERSION,
		stateSchema: executionStateSchema,
		init: () => initExecutionState(),
		apply: (state, event) => applyExecutionEvent(state, event),
		wire: {
			viewSchema: executionViewSchema,
			view: (state) => executionView(state)
		}
	};
}

/**
 * 注册执行状态投影。宿主没有 sessionProjections（旧版/精简版）时静默跳过：
 * 注册失败绝不能影响 GUI 工具本身。
 * @param {object} ctx 插件上下文。
 * @returns {boolean} 是否注册成功。
 */
export function installExecutionProjection(ctx) {
	if (ctx === null || ctx === undefined) return false;
	const register = (projections) => {
		if (projections === null || projections === undefined || typeof projections.register !== "function") return false;
		projections.register(createExecutionProjection());
		return true;
	};
	try {
		const projections = typeof ctx.get === "function" ? ctx.get("sessionProjections") : undefined;
		if (projections !== undefined) return register(projections);
		if (typeof ctx.inject !== "function") return false;
		// 可选依赖：服务晚到时也能补注册（与 installCoordinateMode 同一写法）。
		ctx.inject(["sessionProjections"], (scoped) => {
			try {
				register(scoped.sessionProjections);
			} catch (error) {
				console.warn(`[dsh-operator] execution projection 注册失败：${String(error?.message ?? error)}`);
			}
		});
		return true;
	} catch (error) {
		console.warn(`[dsh-operator] execution projection 不可用：${String(error?.message ?? error)}`);
		return false;
	}
}
