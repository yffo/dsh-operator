import assert from "node:assert/strict";
import { test } from "node:test";
import { executeSteps, summarizeResults, summarizeValue } from "../lib/executor.js";
import { evaluateExpect } from "../lib/skill-expect.js";

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

// 0.82.0：判定契约与长文本断言
test("afterStep 返回 false 或 {ok:\"false\"} 都算失败", async () => {
	const handlers = new Map([["tick", { execute: async () => ({ text: "ok" }) }]]);
	const a = await executeSteps([{ id: "s1", tool: "tick" }], { handlers, afterStep: async () => false });
	assert.equal(a.ok, false, "返回 false 必须判失败");
	const b = await executeSteps([{ id: "s1", tool: "tick" }], { handlers, afterStep: async () => ({ ok: "false" }) });
	assert.equal(b.ok, false, "非严格 ok:true 必须判失败");
	const c = await executeSteps([{ id: "s1", tool: "tick" }], { handlers, afterStep: async () => ({ ok: true }) });
	assert.equal(c.ok, true);
});

test("长文本：400 字以后的 absent 也能被判出来", async () => {
	const long = `${"x".repeat(500)}ERROR`;
	const handlers = new Map([["ocr", { execute: async () => ({ text: long }), render: () => [{ type: "text", text: long }] }]]);
	const run = await executeSteps([{ id: "s1", tool: "ocr", expect: { absent: "ERROR" } }], {
		handlers,
		afterStep: async ({ step, text }) => evaluateExpect(step.expect, text)
	});
	assert.equal(run.ok, false, "第 501 字符里的 ERROR 不能漏判");
});

// 0.113.0：每步开始先落 running，中断时退回 pending（计划才不会卡在「永远正在跑」）
test("executor：onStep 先报 running 再报终态", async () => {
	const { handlers } = makeHandlers();
	const seen = [];
	await executeSteps(
		[
			{ id: "a", tool: "echo", args: { value: "1" } },
			{ id: "b", tool: "echo", args: { value: "2" } }
		],
		{ handlers, allowedTools: allowed, onStep: (update) => seen.push(`${update.id}:${update.status}`) }
	);
	assert.deepEqual(seen, ["a:running", "a:ok", "b:running", "b:ok"]);
});

test("executor：中断时 onStep 用 pending 回退 running", async () => {
	const handlers = new Map([
		["wait", { execute: async () => { const error = new Error("aborted"); error.name = "AbortError"; throw error; } }]
	]);
	const seen = [];
	const run = await executeSteps([{ id: "a", tool: "wait" }], {
		handlers,
		allowedTools: new Set(["wait"]),
		onStep: (update) => seen.push(`${update.id}:${update.status}`)
	});
	assert.deepEqual(seen, ["a:running", "a:pending"], "中断必须把 running 退回去");
	assert.equal(run.skipped, 1);
});
