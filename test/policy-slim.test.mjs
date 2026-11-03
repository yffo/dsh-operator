import { test } from "node:test";
import assert from "node:assert/strict";
import { SLIM_POLICY_HEAD_BYTES, SLIM_POLICY_TAIL_BYTES, slimPolicy } from "../lib/policy-slim.js";

const MILLI = "Coordinate space is 0-1000 fractions of the attached window screenshot.";
const PIXEL = "Coordinate space is pixels of the attached full-resolution screenshot.";

test("slimPolicy：millifraction 模式用上游坐标段原文，不混入 pixel 段", () => {
	const policy = slimPolicy("millifraction", MILLI, PIXEL);
	assert.ok(policy.includes(MILLI));
	assert.equal(policy.includes(PIXEL), false);
	assert.ok(policy.startsWith("Reply first."));
	assert.ok(policy.includes("call wait once before acting"));
});

test("slimPolicy：pixel 模式切换坐标段", () => {
	const policy = slimPolicy("pixel", MILLI, PIXEL);
	assert.ok(policy.includes(PIXEL));
	assert.equal(policy.includes(MILLI), false);
});

test("slimPolicy：体积在 5KB 以内（审计指标）", () => {
	const policy = slimPolicy("millifraction", MILLI, PIXEL);
	const bytes = Buffer.byteLength(policy, "utf8");
	assert.ok(bytes < 5120, `policy 实际 ${String(bytes)}B`);
	assert.ok(bytes > 3000, "策略不应被砍到失去行为约束");
});

test("slimPolicy：HEAD/TAIL 字节常量与拼接一致", () => {
	const policy = slimPolicy("millifraction", MILLI, PIXEL);
	const milliBytes = Buffer.byteLength(MILLI, "utf8");
	assert.equal(SLIM_POLICY_HEAD_BYTES + milliBytes + SLIM_POLICY_TAIL_BYTES, Buffer.byteLength(policy, "utf8"));
	assert.ok(SLIM_POLICY_HEAD_BYTES > 0);
	assert.ok(SLIM_POLICY_TAIL_BYTES > 0);
});

test("slimPolicy：不含未替换的占位符", () => {
	const policy = slimPolicy("millifraction", MILLI, PIXEL);
	assert.equal(policy.includes("${"), false);
	assert.equal(policy.includes("undefined"), false);
});
test("slimPolicy：包含自适应 operator 协议（task_profile/plan/skill/browser_dom 指引）", () => {
	const policy = slimPolicy("millifraction", MILLI, PIXEL);
	for (const needle of ["task_profile", "plan_create", "plan_run", "skill_list", "skill_run", "skill_save", "browser_dom_probe", "browser_dom_snapshot", "operator_status"]) {
		assert.ok(policy.includes(needle), `策略缺少 ${needle}`);
	}
});
