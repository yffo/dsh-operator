// 0.102.0（P2）：执行单元五态状态表
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	beginTask,
	canTransition,
	describeTask,
	EXECUTION_STATES,
	readTask,
	resetExecutionState,
	setState
} from "../lib/execution-state.js";

test("五态齐全，且 ended 是终态", () => {
	assert.deepEqual([...EXECUTION_STATES], ["queued", "working", "waiting-person", "idle", "ended"]);
	for (const state of EXECUTION_STATES) {
		if (state === "ended") assert.equal(canTransition(state, "working"), false);
	}
});

test("正常流程：queued → working → waiting-person → working → ended", () => {
	resetExecutionState();
	beginTask("s1", { label: "整理桌面", total: 3 });
	assert.equal(readTask("s1").state, "queued");
	assert.equal(setState("s1", "working", { step: 1 }).state, "working");
	assert.equal(setState("s1", "waiting-person").state, "waiting-person");
	assert.equal(setState("s1", "working", { step: 2 }).state, "working");
	const ended = setState("s1", "ended", { reason: "completed" });
	assert.equal(ended.state, "ended");
	assert.equal(ended.endReason, "completed");
	assert.equal(ended.step, 2);
});

test("非法迁移直接抛错，不静默改状态", () => {
	resetExecutionState();
	beginTask("s2");
	setState("s2", "ended", { reason: "failed" });
	assert.throws(() => setState("s2", "working"), /invalid transition/);
});

test("同一会话开新任务：旧任务标 ended/superseded，不会两个 working", () => {
	resetExecutionState();
	beginTask("s3");
	setState("s3", "working");
	const next = beginTask("s3", { label: "新任务" });
	assert.equal(next.state, "queued");
	assert.equal(readTask("s3").label, "新任务");
});

test("describeTask 给出人话", () => {
	resetExecutionState();
	assert.match(describeTask("nope"), /idle/);
	beginTask("s4", { label: "截图", total: 5 });
	setState("s4", "working", { step: 2 });
	assert.match(describeTask("s4"), /working 2\/5 · 截图/);
	setState("s4", "ended", { reason: "completed" });
	assert.match(describeTask("s4"), /ended（completed）/);
});
