// 0.70.0 计划模板：给计划自动加「先观察、后校验」的护栏。

import assert from "node:assert/strict";
import { test } from "node:test";

import { applyTemplate, suggestTemplate, TEMPLATE_NAMES } from "../lib/plan-templates.js";

const steps = [
	{ id: "act", tool: "input_text", args: { text: "hi" } },
	{ id: "shot", tool: "screenshot", args: {} }
];

test("verify-around：首尾各加一步", () => {
	const { steps: out, applied } = applyTemplate("verify-around", steps);
	assert.deepEqual(applied, ["verify-around"]);
	assert.equal(out.length, 4);
	assert.equal(out[0].tool, "list_windows");
	assert.equal(out[1].id, "act");
	assert.equal(out[3].tool, "list_windows", "收尾观察也应是可执行的只读步骤");
	// 原步骤不被修改
	assert.equal(steps.length, 2);
});

test("observe-only：只在最前面加一步", () => {
	const { steps: out } = applyTemplate("observe-only", steps);
	assert.equal(out.length, 3);
	assert.equal(out[0].tool, "list_windows");
});

test("id 冲突自动加后缀", () => {
	const conflict = [{ id: "auto-observe", tool: "list_windows" }];
	const { steps: out } = applyTemplate("observe-only", conflict);
	assert.deepEqual(out.map((step) => step.id), ["auto-observe-2", "auto-observe"]);
});

test("未知模板直接报错并列出可用值", () => {
	assert.throws(() => applyTemplate("nope", steps), /unknown plan template/);
	assert.ok(TEMPLATE_NAMES.includes("verify-around"));
});

test("空模板原样返回", () => {
	const { steps: out, applied } = applyTemplate("", steps);
	assert.deepEqual(out, steps);
	assert.deepEqual(applied, []);
});

test("suggestTemplate：按分层结果给建议", () => {
	assert.equal(suggestTemplate({ tier: "complex", matched: ["apps:2"] }), "cross-app");
	assert.equal(suggestTemplate({ tier: "complex", matched: ["流程"] }), "verify-around");
	assert.equal(suggestTemplate({ tier: "standard", matched: [] }), "verify-around");
	assert.equal(suggestTemplate({ tier: "simple", matched: [] }), null);
});
