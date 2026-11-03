import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_IDLE_OBSERVE_MS,
	lazyObservePolicyLine,
	lastGuiActivityAt,
	noteGuiActivity,
	shouldObserveFirstFrame
} from "../lib/observe-gate.js";

const session = (name) => ({ id: name });

test("默认 auto：没有 GUI 活动时不观察", () => {
	assert.equal(shouldObserveFirstFrame(session("a"), {}), false);
	assert.equal(shouldObserveFirstFrame(undefined, {}), false);
	assert.equal(shouldObserveFirstFrame(session("a"), { firstFrame: "auto" }), false);
});

test("eager 总是观察，off 从不观察", () => {
	const s = session("b");
	assert.equal(shouldObserveFirstFrame(s, { firstFrame: "eager" }), true);
	assert.equal(shouldObserveFirstFrame(s, { firstFrame: "off" }), false);
	noteGuiActivity(s);
	assert.equal(shouldObserveFirstFrame(s, { firstFrame: "off" }), false);
});

test("auto：GUI 活动在 idle 窗口内才观察", () => {
	const s = session("c");
	noteGuiActivity(s);
	assert.equal(shouldObserveFirstFrame(s, {}), true);
	assert.equal(shouldObserveFirstFrame(s, { idleObserveMs: 60000 }), true);
	assert.equal(shouldObserveFirstFrame(s, { idleObserveMs: 1 }), true);
});

test("idle 过期后不再观察（用 0 模拟过期）", () => {
	const s = session("d");
	noteGuiActivity(s);
	assert.equal(shouldObserveFirstFrame(s, { idleObserveMs: 0 }), false);
	// 反向：负数视为非法窗口，保守不观察
	assert.equal(shouldObserveFirstFrame(s, { idleObserveMs: -1 }), false);
});

test("会话之间互不影响", () => {
	const a = session("e1");
	const b = session("e2");
	noteGuiActivity(a);
	assert.equal(shouldObserveFirstFrame(a, {}), true);
	assert.equal(shouldObserveFirstFrame(b, {}), false);
});

test("lastGuiActivityAt 只记录对象会话，不抛错", () => {
	const s = session("f");
	assert.equal(lastGuiActivityAt(s), undefined);
	noteGuiActivity(s);
	assert.equal(typeof lastGuiActivityAt(s), "number");
	assert.doesNotThrow(() => noteGuiActivity(undefined));
	assert.equal(lastGuiActivityAt(undefined), undefined);
	assert.ok(DEFAULT_IDLE_OBSERVE_MS >= 60000);
});

test("策略文本提醒模型先 wait 观察", () => {
	const line = lazyObservePolicyLine();
	assert.match(line, /wait/);
	assert.match(line, /observation/);
});
