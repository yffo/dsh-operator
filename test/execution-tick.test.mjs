// 0.103.0：动作 → 执行状态
import assert from "node:assert/strict";
import { test } from "node:test";

import { readTask, resetExecutionState } from "../lib/execution-state.js";
import { DEFAULT_IDLE_MS, expireIdle, tickExecution } from "../lib/execution-tick.js";

test("第一次动作建任务并进入 working", () => {
	resetExecutionState();
	const task = tickExecution("s1", "click", { now: 1000 });
	assert.equal(task.state, "working");
	assert.equal(task.step, 1);
	assert.equal(task.label, "click");
});

test("连续动作累加步数", () => {
	resetExecutionState();
	tickExecution("s2", "click", { now: 1000 });
	const second = tickExecution("s2", "ax_press", { now: 2000 });
	assert.equal(second.step, 2);
	assert.equal(second.label, "click", "标签保持在任务开始时");
});

test("空闲超时把 working 收尾成 ended/completed", () => {
	resetExecutionState();
	tickExecution("s3", "click", { now: 1000 });
	assert.equal(expireIdle("s3", { now: 1000 + DEFAULT_IDLE_MS + 1 })?.endReason, "idle-timeout");
	assert.equal(readTask("s3").state, "ended");
});

test("没到空闲时间不动；已结束的任务不再被超时改写", () => {
	resetExecutionState();
	tickExecution("s4", "click", { now: 1000 });
	assert.equal(expireIdle("s4", { now: 1500 }), null);
	expireIdle("s4", { now: 1000 + DEFAULT_IDLE_MS + 1 });
	assert.equal(expireIdle("s4", { now: 999999 }), null);
});
