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

// 0.68.0：进度口径统一到 planProgress（plan_run 与 operator_status 共用）
import { planProgress } from "../lib/planner.js";

test("planProgress：给出总数/完成数/下一步与工具名", () => {
	const plan = {
		id: "demo",
		status: "running",
		steps: [
			{ id: "one", tool: "list_windows", status: "done" },
			{ id: "two", tool: "screenshot", status: "pending" },
			{ id: "three", tool: "click", status: "pending" }
		]
	};
	const progress = planProgress(plan);
	assert.equal(progress.total, 3);
	assert.equal(progress.done, 1);
	assert.equal(progress.remaining, 2);
	assert.equal(progress.nextStep, "two");
	assert.equal(progress.nextTool, "screenshot");
});

test("planProgress：全部完成时 next 为空", () => {
	const plan = { id: "done", status: "done", steps: [{ id: "one", tool: "x", status: "done" }] };
	const progress = planProgress(plan);
	assert.equal(progress.nextStep, null);
	assert.equal(progress.nextTool, null);
	assert.equal(progress.remaining, 0);
});

// 0.82.0：createPlan 必须保留 expect，否则 plan_run 的断言永不执行
test("createPlan 保留 verify 与 expect", () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-plan-expect-"));
	configurePlanStore({ dir });
	try {
		const plan = createPlan({
			goal: "保留 expect 的计划",
			steps: [
				{ id: "s1", tool: "ax_menu", args: { path: "文件/新建访达窗口" }, expect: { contains: "Invoked" }, verify: { kind: "app_running", contains: "访达" } }
			]
		});
		const saved = readPlan(plan.id);
		assert.deepEqual(saved.steps[0].expect, { contains: "Invoked" });
		assert.deepEqual(saved.steps[0].verify, { kind: "app_running", contains: "访达" });
	} finally {
		configurePlanStore({ dir: null });
		rmSync(dir, { recursive: true, force: true });
	}
});

// 0.113.0：中断后要能看出「停在哪一步」
test("planProgress：running 步单独报出来", () => {
	const plan = {
		id: "half",
		status: "running",
		steps: [
			{ id: "s1", tool: "click", status: "done" },
			{ id: "s2", tool: "hotkey", status: "running" },
			{ id: "s3", tool: "ocr", status: "pending" }
		]
	};
	const progress = planProgress(plan);
	assert.equal(progress.running, 1);
	assert.equal(progress.runningStep, "s2");
	assert.equal(progress.runningTool, "hotkey");
	assert.equal(progress.nextStep, "s3");
});

// 0.114.0：断言覆盖——「执行完」和「验证过」要能分开看
test("planProgress：统计有 expect/verify 的步数", () => {
	const plan = {
		id: "p",
		status: "pending",
		steps: [
			{ id: "s1", tool: "click", status: "pending", expect: { contains: "ok" } },
			{ id: "s2", tool: "click", status: "pending" },
			{ id: "s3", tool: "click", status: "pending", verify: { kind: "app_running", contains: "访达" } }
		]
	};
	assert.equal(planProgress(plan).asserted, 2);
});
