import assert from "node:assert/strict";
import { test } from "node:test";
import { executeSteps, summarizeResults, summarizeValue } from "../lib/executor.js";

function makeHandlers() {
	const calls = [];
	const handlers = new Map([
		["echo", { execute: async (args) => { calls.push(["echo", args]); return { text: `echo:${String(args.value ?? "")}`, ok: true }; } }],
		["explode", { execute: async () => { calls.push(["explode", {}]); throw new Error("boom"); } }]
	]);
	return { handlers, calls };
}

const allowed = new Set(["echo", "explode"]);

test("executor：按顺序执行并汇总结果", async () => {
	const { handlers, calls } = makeHandlers();
	const run = await executeSteps(
		[
			{ id: "a", tool: "echo", args: { value: "one" } },
			{ id: "b", tool: "echo", args: { value: "two" } }
		],
		{ handlers, allowedTools: allowed }
	);
	assert.equal(run.ok, true);
	assert.equal(run.executed, 2);
	assert.equal(run.failed, 0);
	assert.equal(run.results[0].status, "ok");
	assert.equal(run.results[1].summary, "echo:two");
	assert.equal(calls.length, 2);
	assert.match(summarizeResults(run), /executed 2, failed 0/);
});

test("executor：失败即停，后续步骤标 skipped", async () => {
	const { handlers, calls } = makeHandlers();
	const run = await executeSteps(
		[
			{ id: "a", tool: "explode" },
			{ id: "b", tool: "echo", args: { value: "never" } }
		],
		{ handlers, allowedTools: allowed }
	);
	assert.equal(run.ok, false);
	assert.equal(run.failed, 1);
	assert.equal(run.skipped, 1);
	assert.equal(run.results[1].status, "skipped");
	assert.equal(calls.some(([name]) => name === "echo"), false);
});

test("executor：stopOnError=false 时继续执行后续步骤", async () => {
	const { handlers } = makeHandlers();
	const run = await executeSteps(
		[
			{ id: "a", tool: "explode" },
			{ id: "b", tool: "echo", args: { value: "ok" } }
		],
		{ handlers, allowedTools: allowed, stopOnError: false }
	);
	assert.equal(run.failed, 1);
	assert.equal(run.executed, 1);
	assert.equal(run.results[1].status, "ok");
});

test("executor：未注册/未授权工具直接失败；拒绝递归执行器", async () => {
	const { handlers } = makeHandlers();
	const run = await executeSteps(
		[
			{ id: "a", tool: "click", args: {} },
			{ id: "b", tool: "plan_run" }
		],
		{ handlers, allowedTools: allowed, stopOnError: false }
	);
	assert.equal(run.failed, 2);
	assert.match(run.results[0].error, /unsupported tool: click/);
	assert.match(run.results[1].error, /unsupported tool: plan_run/);
	await assert.rejects(() => executeSteps([], { handlers }), /non-empty steps/);
});

test("executor：dryRun 只预览、不调用 execute", async () => {
	const { handlers, calls } = makeHandlers();
	const run = await executeSteps([{ id: "a", tool: "echo", args: { value: "x", secret: "y" } }], { handlers, allowedTools: allowed, dryRun: true });
	assert.equal(run.executed, 1);
	assert.equal(run.results[0].status, "dry-run");
	assert.deepEqual(Object.keys(run.results[0]).sort(), ["id", "status", "tool"]);
	assert.equal(calls.length, 0);
});

test("executor：summarizeValue 只保留短文本，不展开对象", () => {
	assert.equal(summarizeValue(undefined), "");
	assert.equal(summarizeValue("plain text"), "plain text");
	assert.ok(summarizeValue("x".repeat(500)).length <= 200);
	assert.equal(summarizeValue({ error: "bad" }), "error: bad");
	assert.equal(summarizeValue({ text: "hello" }), "hello");
	assert.match(summarizeValue({ a: 1, b: 2 }), /a,b/);
	assert.equal(summarizeValue({ image: { base64: "AAAA" } }), "");
});

test("fallback 可以执行宿主 GUI 动作", async () => {
	const handlers = new Map([["operator_status", { execute: async () => ({ text: "ok" }) }]]);
	const calls = [];
	const fallback = new Map([["click", async (args) => {
		calls.push(args);
		return { ok: true };
	}]]);
	const run = await executeSteps([{ id: "a", tool: "click", args: { x: 1, y: 2 } }], { handlers, fallback });
	assert.equal(run.ok, true);
	assert.equal(run.executed, 1);
	assert.deepEqual(calls[0], { x: 1, y: 2 });
});

test("不在 fallback 也不在 handlers 的工具依然拒绝", async () => {
	const handlers = new Map();
	const run = await executeSteps([{ id: "a", tool: "nope" }], { handlers, fallback: new Map() });
	assert.equal(run.ok, false);
	assert.match(run.results[0].error, /unsupported tool/);
});
