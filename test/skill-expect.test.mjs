// 0.75.0 步骤级校验：expect 断言回包、verify 独立确认、字段持久化。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { executeSteps } from "../lib/executor.js";
import { evaluateExpect, validateExpect, validateVerify } from "../lib/skill-expect.js";
import { configureSkillStore, readSkill, saveSkill, validateSkill } from "../lib/skill-store.js";

let dir;
before(() => {
	dir = mkdtempSync(join(tmpdir(), "dsh-skill-expect-"));
	configureSkillStore({ dir });
});
after(() => {
	configureSkillStore({ dir: null });
	rmSync(dir, { recursive: true, force: true });
});

test("expect：contains 命中 / 未命中", () => {
	assert.deepEqual(evaluateExpect({ contains: "成功" }, "执行成功，耗时 2s"), { ok: true });
	const miss = evaluateExpect({ contains: ["成功", "桌面"] }, "执行成功，耗时 2s");
	assert.equal(miss.ok, false);
	assert.match(miss.reason, /没有「桌面」/);
});

test("expect：absent 出现即失败", () => {
	const hit = evaluateExpect({ absent: "error" }, "ok but error inside");
	assert.equal(hit.ok, false);
	assert.match(hit.reason, /出现了「error」/);
	assert.deepEqual(evaluateExpect({ absent: "error" }, "all good"), { ok: true });
});

test("expect / verify：形状校验", () => {
	assert.deepEqual(validateExpect(undefined), []);
	assert.match(validateExpect({}).join(";"), /needs contains or absent/);
	assert.match(validateExpect({ contains: "" }).join(";"), /non-empty/);
	// 0.82.0：verify 现在要校验 kind 枚举与必需谓词
	assert.deepEqual(validateVerify({ kind: "window_title", contains: "x" }), []);
	assert.match(validateVerify({}).join(";"), /kind is required/);
	assert.match(validateVerify({ kind: "window_title" }).join(";"), /needs one of contains/);
	assert.match(validateVerify({ kind: "window_titel", contains: "x" }).join(";"), /verify.kind must be one of/);
	assert.match(validateVerify({ kind: "ax_element", role: "AXButton" }).join(";"), /^$/);
});

test("executor：afterStep 判失败时该步标 failed 并给原因", async () => {
	const handlers = new Map([
		["tick", { execute: async () => ({ text: "action ran" }) }]
	]);
	const run = await executeSteps(
		[{ id: "s1", tool: "tick", expect: { contains: "看得见的证据" } }, { id: "s2", tool: "tick" }],
		{ handlers, afterStep: async ({ step, summary }) => evaluateExpect(step.expect, summary) }
	);
	assert.equal(run.ok, false);
	assert.equal(run.executed, 1);
	assert.equal(run.failed, 1);
	assert.equal(run.skipped, 1, "失败后后续步骤应被跳过");
	assert.match(run.results[0].error, /expect 未满足/);
});

test("skill-store：verify / expect 随技能持久化，非法形状被拒", () => {
	saveSkill({
		name: "demo-verified",
		description: "带步骤级校验的技能",
		steps: [
			{ tool: "list_windows", expect: { contains: "window" } },
			{ tool: "open_app", args: { name: "系统设置" }, verify: { kind: "frontmost_app", contains: "系统设置" } }
		]
	});
	const saved = readSkill("demo-verified");
	assert.deepEqual(saved.steps[0].expect, { contains: "window" });
	assert.deepEqual(saved.steps[1].verify, { kind: "frontmost_app", contains: "系统设置" });
	assert.deepEqual(saved.steps[1].args, { name: "系统设置" });

	const bad = validateSkill({
		name: "demo-bad-verify",
		description: "非法 verify 形状",
		steps: [{ tool: "list_windows", verify: { nope: 1 } }]
	});
	assert.equal(bad.ok, false);
	assert.match(bad.errors.join(";"), /verify\.kind is required/);
});

// 0.76.0：步骤级校验的三个回归
test("executor：stepContext 透传给每一步（GUI 工具靠 exec.agent 解析路由）", async () => {
	const seen = [];
	const handlers = new Map([
		["tick", { execute: async (_args, context) => {
			seen.push(context);
			return { text: "ok" };
		} }]
	]);
	const agent = { id: "agent-1" };
	await executeSteps([{ id: "s1", tool: "tick" }], { handlers, stepContext: { agent } });
	assert.equal(seen.length, 1);
	assert.equal(seen[0].agent, agent, "agent 必须透传到步骤执行上下文");
});

test("executor：afterStep 判失败时汇总 executed/failed 计数正确", async () => {
	const handlers = new Map([["tick", { execute: async () => ({ text: "ran" }) }]]);
	const run = await executeSteps([{ id: "s1", tool: "tick" }], {
		handlers,
		afterStep: async () => ({ ok: false, reason: "verify 未通过（app_running）：app not visible" })
	});
	assert.equal(run.executed, 1);
	assert.equal(run.failed, 1);
	assert.equal(run.ok, false);
	assert.match(run.results[0].error, /verify 未通过/);
});

// 0.78.0：expect 断言渲染文案，而不是字段摘要
test("executor：afterStep 拿到 render 文案（text），expect 断言它", async () => {
	const handlers = new Map([
		["ax_menu", {
			execute: async () => ({ schemaVersion: 1, ok: true, path: "文件/新建窗口" }),
			render: () => [{ type: "text", text: "Invoked menu 文件/新建窗口 via AXPress (background)" }]
		}]
	]);
	const run = await executeSteps(
		[{ id: "s1", tool: "ax_menu", args: { path: "文件/新建窗口" }, expect: { contains: "Invoked" } }],
		{ handlers, afterStep: async ({ step, text }) => evaluateExpect(step.expect, text) }
	);
	assert.equal(run.ok, true, JSON.stringify(run.results));
	assert.equal(run.executed, 1);
});

test("executor：没有 render 时退回字段摘要", async () => {
	const handlers = new Map([["plain", { execute: async () => ({ ok: true, note: "fields-only" }) }]]);
	let seenText;
	await executeSteps([{ id: "s1", tool: "plain" }], {
		handlers,
		afterStep: async ({ text }) => {
			seenText = text;
			return { ok: true };
		}
	});
	assert.match(String(seenText), /ok/);
});
