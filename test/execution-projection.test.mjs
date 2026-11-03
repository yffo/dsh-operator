// 0.104.0：执行状态的会话投影（operatorExecution）——折叠语义与注册降级
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	applyExecutionEvent,
	createExecutionProjection,
	executionStateSchema,
	executionView,
	executionViewSchema,
	EXECUTION_PROJECTION_KEY,
	EXECUTION_PROJECTION_STATE_VERSION,
	initExecutionState,
	installExecutionProjection,
	PROJECTION_IDLE_MS,
	describeExecutionProjection
} from "../lib/execution-projection.js";

const T0 = 1_000_000;

function call(callId, name, time = T0, args = "{}") {
	return { type: "tool/call", time, seq: 1, data: { callId, name, arguments: args, turn: 1, step: 1 } };
}

function result(callId, time = T0 + 500, isError = false) {
	return { type: "tool/result", time, seq: 2, data: { message: { source: { callId }, isError } } };
}

function asked(toolName, time = T0 + 100, callId) {
	return { type: "approval/asked", time, seq: 3, data: { id: "a1", toolName, ...(callId === undefined ? {} : { callId }) } };
}

function decided(time = T0 + 200, outcome = "allowed-once") {
	return { type: "approval/decided", time, seq: 4, data: { id: "a1", outcome } };
}

function fold(events, state = initExecutionState()) {
	return events.reduce((current, event) => applyExecutionEvent(current, event), state);
}

test("初始状态：空闲、全字段齐、通过两个 schema", () => {
	const state = initExecutionState();
	assert.equal(state.state, "idle");
	assert.doesNotThrow(() => executionStateSchema.parse(state));
	assert.doesNotThrow(() => executionViewSchema.parse(executionView(state)));
	const next = initExecutionState();
	assert.notEqual(next, state, "每次 init 都给新引用（宿主会写入 checkpoint）");
});

test("无关事件返回同一个引用（宿主的零下游工作约定）", () => {
	const state = initExecutionState();
	assert.equal(applyExecutionEvent(state, { type: "turn/start", time: T0, data: {} }), state);
	assert.equal(applyExecutionEvent(state, { type: "tool/call", time: T0, data: { callId: "x", name: "bash", arguments: "{}" } }), state);
	assert.equal(applyExecutionEvent(state, { type: "tool/result", time: T0, data: { message: { source: { callId: "nope" } } } }), state);
	// v2：任何工具的审批都点亮黄灯（GUI 工具自己从不请求审批）
	const bashAsk = applyExecutionEvent(state, asked("bash"));
	assert.equal(bashAsk.state, "waiting-person");
	assert.equal(bashAsk.approvalTool, "bash");
});

test("GUI 调用：working、步数递增、同一轮共用 startedAt", () => {
	const first = fold([call("c1", "open_in_finder", T0)]);
	assert.equal(first.state, "working");
	assert.equal(first.tool, "open_in_finder");
	assert.equal(first.step, 1);
	assert.equal(first.startedAt, T0);
	assert.equal(first.callStartedAt, T0);
	assert.equal(first.callFinishedAt, 0, "刚开始还没有结果");
	const second = fold([call("c2", "ax_press", T0 + 8000)], first);
	assert.equal(second.step, 2);
	assert.equal(second.startedAt, T0, "同一轮不重置起点");
	assert.equal(second.tool, "ax_press");
});

test("结果配对：只认自己的 callId，失败要落到 failed", () => {
	const state = fold([call("c1", "click")]);
	const other = applyExecutionEvent(state, result("c9", T0 + 100, true));
	assert.equal(other, state, "别人的结果不碰状态");
	const done = applyExecutionEvent(state, result("c1", T0 + 300, true));
	assert.equal(done.callFinishedAt, T0 + 300);
	assert.equal(done.failed, true);
	assert.equal(done.state, "working", "一次调用结束不等于这一轮结束");
});

test("审批事件：等确认 → 黄灯（带审批工具），决定后回到 working", () => {
	const state = fold([call("c1", "click"), asked("click", T0 + 100, "c1")]);
	assert.equal(state.state, "waiting-person");
	assert.equal(state.tool, "click", "正在操作的 GUI 工具保留");
	assert.equal(state.approvalTool, "click");
	const resumed = applyExecutionEvent(state, decided(T0 + 9000));
	assert.equal(resumed.state, "working");
	assert.equal(resumed.approvalTool, "");
	assert.equal(resumed.updatedAt, T0 + 9000);
});

test("审批事件：空闲时被 bash 的确认点亮，工具名取审批工具", () => {
	const state = fold([asked("bash", T0)]);
	assert.equal(state.state, "waiting-person");
	assert.equal(state.tool, "bash");
	assert.equal(state.startedAt, T0);
	const stale = fold([decided(T0 + 50)], state);
	assert.equal(stale.state, "working");
	assert.equal(stale.approvalTool, "");
});

test("步数按回合重置：同一回合累加，换回合从头算", () => {
	const first = fold([call("c1", "click", T0)]);
	assert.equal(first.step, 1);
	const sameTurn = fold([call("c2", "click", T0 + 500)], first);
	assert.equal(sameTurn.step, 2, "同一回合继续累加");
	const nextTurn = fold([{ type: "tool/call", time: T0 + 900, seq: 3, data: { callId: "c3", name: "click", arguments: "{}", turn: 2, step: 1 } }], sameTurn);
	assert.equal(nextTurn.step, 1, "换回合从头算");
	assert.equal(nextTurn.turn, 2);
});

test("turn/end 收尾；下一轮重新计数", () => {
	const ended = fold([call("c1", "click"), result("c1"), { type: "turn/end", time: T0 + 3000, data: { turn: 1, reason: { kind: "completed" } } }]);
	assert.equal(ended.state, "ended");
	assert.equal(ended.reason, "turn-end");
	const next = fold([call("c2", "hotkey", T0 + 10_000)], ended);
	assert.equal(next.step, 1, "新一轮从 1 开始");
	assert.equal(next.startedAt, T0 + 10_000);
});

test("空闲超过窗口算新的一轮", () => {
	const first = fold([call("c1", "click", T0), result("c1", T0 + 100)]);
	const later = fold([call("c2", "click", T0 + PROJECTION_IDLE_MS + 500)], first);
	assert.equal(later.step, 1, "间隔超过 90s 视为新一轮");
	assert.equal(later.startedAt, T0 + PROJECTION_IDLE_MS + 500);
});

test("describeExecutionProjection：与 execution 行措辞一致", () => {
	assert.equal(describeExecutionProjection(undefined), null);
	assert.equal(describeExecutionProjection(null), null);
	assert.equal(describeExecutionProjection(initExecutionState()), "execution: idle（没有任务记录）");
	assert.equal(describeExecutionProjection(fold([call("c1", "open_in_finder", T0)])), "execution: working 1 · open_in_finder");
	assert.equal(describeExecutionProjection(fold([asked("bash", T0)])), "execution: waiting-person · bash");
	assert.equal(
		describeExecutionProjection(fold([call("c1", "click"), result("c1"), { type: "turn/end", time: T0 + 100, data: { turn: 1 } }])),
		"execution: ended（turn-end）"
	);
});

test("视图：只给客户端需要的字段，且每个状态都能过 view schema", () => {
	const state = fold([call("c1", "click"), asked("click")]);
	const view = executionView(state);
	assert.equal(Object.hasOwn(view, "callId"), false, "callId 是内部配对用，不外发");
	assert.doesNotThrow(() => executionViewSchema.parse(view));
	for (const candidate of [initExecutionState(), state, fold([{ type: "turn/end", time: T0, data: { turn: 1 } }], state)]) {
		assert.doesNotThrow(() => executionViewSchema.parse(executionView(candidate)));
	}
});

test("schema 严格：未知字段、非法 state、负数都拒绝", () => {
	assert.throws(() => executionStateSchema.parse({ ...initExecutionState(), extra: 1 }), /未知字段/);
	assert.throws(() => executionStateSchema.parse({ ...initExecutionState(), state: "running" }), /非法 state/);
	assert.throws(() => executionStateSchema.parse({ ...initExecutionState(), step: -1 }), /step/);
	assert.throws(() => executionViewSchema.parse({ ...executionView(initExecutionState()), callId: "x" }), /未知字段/);
});

test("createExecutionProjection：key / stateVersion / wire 齐全", () => {
	const definition = createExecutionProjection();
	assert.equal(definition.key, EXECUTION_PROJECTION_KEY);
	assert.equal(definition.stateVersion, EXECUTION_PROJECTION_STATE_VERSION);
	assert.equal(definition.init().state, "idle");
	assert.equal(typeof definition.apply, "function");
	assert.equal(typeof definition.wire.view, "function");
	assert.doesNotThrow(() => definition.wire.viewSchema.parse(definition.wire.view(definition.init())));
});

test("installExecutionProjection：有服务就注册一次，缺服务静默跳过", () => {
	const registered = [];
	const ctx = {
		get: (name) => (name === "sessionProjections" ? { register: (definition) => registered.push(definition) } : undefined)
	};
	assert.equal(installExecutionProjection(ctx), true);
	assert.equal(registered.length, 1);
	assert.equal(registered[0].key, EXECUTION_PROJECTION_KEY);

	const deferred = [];
	const lazy = {
		get: () => undefined,
		inject: (names, callback) => {
			deferred.push(names.join(","));
			callback({ sessionProjections: { register: (definition) => registered.push(definition) } });
		}
	};
	assert.equal(installExecutionProjection(lazy), true);
	assert.deepEqual(deferred, ["sessionProjections"]);
	assert.equal(registered.length, 2);

	assert.equal(installExecutionProjection({ get: () => undefined }), false, "没有注入能力就不假装注册了");
	assert.equal(installExecutionProjection(null), false);
});
