import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { configurePlanStore, createPlan, deletePlan, listPlans, planDir, readPlan, updatePlan, validatePlan } from "../lib/planner.js";

const dir = mkdtempSync(join(tmpdir(), "dsh-operator-plans-"));
configurePlanStore({ dir });
after(() => rmSync(dir, { recursive: true, force: true }));

const steps = [
	{ id: "open-settings", tool: "open_app", args: { name: "系统设置" } },
	{ id: "switch-displays", tool: "ax_press", args: { index: 50, expect_role: "AXButton", expect_title: "显示器" } }
];

test("planner：validatePlan 接受合法计划、拒绝非法字段", () => {
	const ok = validatePlan({ goal: "打开系统设置", steps });
	assert.equal(ok.ok, true, ok.errors.join("; "));
	assert.equal(validatePlan({ goal: "短", steps }).ok, false);
	assert.equal(validatePlan({ goal: "打开系统设置", steps: [] }).ok, false);
	assert.equal(validatePlan({ goal: "打开系统设置", steps: [{ id: "Bad ID", tool: "open_app" }] }).ok, false);
	assert.equal(validatePlan({ goal: "打开系统设置", steps: [{ id: "a", tool: "open_app", args: { password: "x" } }] }).ok, false);
	assert.equal(validatePlan({ goal: "打开系统设置", steps: [{ id: "a", tool: "open_app" }, { id: "a", tool: "click" }] }).ok, false);
});

test("planner：create → list → read 全流程（文件落在临时目录）", () => {
	const created = createPlan({ goal: "打开系统设置并切到显示器", steps, tier: "standard" });
	assert.match(created.id, /^plan-\d{8}-\d{6}-[a-z0-9]{4}$/);
	assert.ok(existsSync(join(planDir(), `${created.id}.json`)));
	const plan = readPlan(created.id);
	assert.equal(plan.goal, created.plan.goal);
	assert.equal(plan.steps.length, 2);
	assert.equal(plan.status, "pending");
	assert.ok(listPlans().some((item) => item.id === created.id));
});

test("planner：updatePlan 推进步骤并推导整体状态", () => {
	const { id } = createPlan({ goal: "打开系统设置并切到显示器", steps });
	let result = updatePlan(id, { stepId: "open-settings", status: "running" });
	assert.equal(result.plan.status, "running");
	result = updatePlan(id, { stepId: "open-settings", status: "done" });
	assert.equal(result.summary.counts.done, 1);
	assert.equal(result.summary.nextStep, "switch-displays");
	result = updatePlan(id, { stepId: "switch-displays", status: "done" });
	assert.equal(result.plan.status, "done");
	const failed = createPlan({ goal: "打开系统设置并切到显示器", steps });
	updatePlan(failed.id, { stepId: "switch-displays", status: "failed", note: "no such button" });
	assert.equal(readPlan(failed.id).status, "failed");
	assert.throws(() => updatePlan(failed.id, { stepId: "nope", status: "done" }), /step not found/);
	assert.throws(() => updatePlan(failed.id, { stepId: "open-settings", status: "exploded" }), /invalid step status/);
});

test("planner：非法 id / 删除不存在的计划", () => {
	assert.throws(() => readPlan("../../etc/passwd"), /invalid plan id/);
	assert.equal(deletePlan("plan-20000101-000000-zzzz"), false);
	const { id } = createPlan({ goal: "打开系统设置并切到显示器", steps });
	assert.equal(deletePlan(id), true);
	assert.equal(existsSync(join(planDir(), `${id}.json`)), false);
});
