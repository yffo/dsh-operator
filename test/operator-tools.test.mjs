import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePredicate, planWindowFrame, registerOperatorTools, resolveLayoutDisplay, V2_LEGACY_TOOL_NAMES, WINDOW_LAYOUTS } from "../lib/operator-tools.js";
import { configurePlanStore, createPlan } from "../lib/planner.js";
import { configureFailureStore, recordFailure } from "../lib/failure-store.js";

test("evaluatePredicate：未知 kind 返回事实而不抛错", async () => {
	const result = await evaluatePredicate({ kind: "nope" });
	assert.deepEqual(result, { ok: false, observed: "unknown kind: nope" });
});

test("evaluatePredicate：window_title / app_running 缺少 contains 时提前失败", async () => {
	assert.deepEqual(await evaluatePredicate({ kind: "window_title" }), {
		ok: false,
		observed: "contains is required for window_title"
	});
	assert.deepEqual(await evaluatePredicate({ kind: "app_running", contains: "   " }), {
		ok: false,
		observed: "contains is required for app_running"
	});
});

test("evaluatePredicate：ax_text/ax_element 在拿不到内容时降级", async () => {
	const text = await evaluatePredicate({ kind: "ax_text", contains: "x", pid: 999999 });
	assert.equal(text.ok, false);
	assert.match(text.observed, /AX/);
	const element = await evaluatePredicate({ kind: "ax_element", role: "AXButton", pid: 999999 });
	assert.equal(element.ok, false);
	assert.match(element.observed, /AX/);
});

function collectTools() {
	const registered = [];
	const ctx = {
		tools: {
			register(tool) {
				registered.push(tool);
			}
		}
	};
	registerOperatorTools(ctx, { axMaxNodes: 120, guard: true, failureSamples: false }, {
		backend: { listScreens: async () => [] },
		defineTool: (definition) => definition,
		AttachmentId: (value) => value,
		computerUseToolDefs: new Map([
			["ax_press", { execute: async (args) => ({ pressed: args.index !== 9, index: args.index, role: "AXButton", title: "Mock" }) }],
			["ax_set_value", { execute: async () => ({ set: true }) }],
			["ax_menu", { execute: async () => ({ ok: true }) }],
			["ax_scroll", { execute: async () => ({ ok: true, scrolled: true }) }],
			["click", { execute: async (args) => (args.position[0] === 999 ? { ok: false, note: "decorated window blocked" } : { ok: true }) }],
			["scroll", { execute: async () => ({ ok: true }) }],
			["input_text", { execute: async () => ({ ok: true }) }],
			["hotkey", { execute: async () => ({ ok: true }) }],
			["browser_open", { execute: async (args) => ({ ok: true, text: `open ${args.url}` }) }],
			["browser_click", { execute: async (args) => ({ ok: true, text: `click ${args.ref ?? args.text ?? ""}` }) }],
			["browser_type", { execute: async (args) => ({ ok: true, text: `type ${args.ref} ${args.text}` }) }]
		])
	});
	return registered;
}

test("legacyToolNames=false：被 v2 覆盖的旧工具不再直接暴露，其余扩展工具保留", () => {
	const collectNames = (config) => {
		const names = [];
		const ctx = { tools: { register: (tool) => names.push(tool.name) } };
		registerOperatorTools(ctx, config, {
			backend: { listScreens: async () => [] },
			defineTool: (definition) => definition,
			AttachmentId: (value) => value
		});
		return names;
	};
	const withLegacy = collectNames({ axMaxNodes: 120, guard: true, failureSamples: false, legacyToolNames: true });
	const withoutLegacy = collectNames({ axMaxNodes: 120, guard: true, failureSamples: false, legacyToolNames: false });
	const hidden = withLegacy.filter((name) => V2_LEGACY_TOOL_NAMES.has(name));
	assert.ok(hidden.length > 0);
	for (const name of hidden) assert.equal(withoutLegacy.includes(name), false, `${name} 应被隐藏`);
	// 非 legacy 的扩展工具保持不变
	for (const name of withLegacy.filter((item) => !V2_LEGACY_TOOL_NAMES.has(item))) {
		assert.ok(withoutLegacy.includes(name), `${name} 应保留`);
	}
});

function assertSchemaShape(schema, path) {
	if (schema === null || typeof schema !== "object") return;
	if (Array.isArray(schema)) {
		schema.forEach((item, index) => {
			assertSchemaShape(item, `${path}[${String(index)}]`);
		});
		return;
	}
	if (schema.type === "object") {
		assert.equal(
			typeof schema.additionalProperties,
			"boolean",
			`object schema 必须显式 additionalProperties: ${path}`
		);
	}
	for (const [key, value] of Object.entries(schema)) {
		if (key === "properties" && typeof value === "object" && value !== null) {
			for (const [name, child] of Object.entries(value)) assertSchemaShape(child, `${path}.${key}.${name}`);
			continue;
		}
		if (key === "items") assertSchemaShape(value, `${path}.items`);
	}
}

test("registerOperatorTools：仅 darwin 注册二十七个扩展工具", (t) => {
	const tools = collectTools();
	if (process.platform !== "darwin") {
		assert.equal(tools.length, 0);
		t.diagnostic(`skipped: platform=${process.platform}`);
		return;
	}
	assert.deepEqual(
		tools.map((tool) => tool.name).sort(),
		["ax_batch", "ax_menu", "ax_press", "ax_scroll", "ax_set_value", "browser_dom_click", "browser_dom_fill", "browser_dom_probe", "browser_dom_snapshot", "failure_list", "list_windows", "operator_status", "plan_create", "plan_delete", "plan_list", "plan_run", "plan_update", "screenshot_window", "skill_delete", "skill_list", "skill_run", "skill_save", "skill_show", "task_profile", "verify_state", "window_move", "zoom_region"]
	);
	for (const tool of tools) {
		assert.equal(typeof tool.description, "string");
		assert.ok(tool.description.length > 20, `${tool.name} 描述过短`);
		assert.equal(typeof tool.execute, "function");
		assert.equal(typeof tool.isConcurrencySafe, "function");
		assert.equal(typeof tool.presentCall, "function");
		assert.equal(tool.output.schema.additionalProperties, false);
		assertSchemaShape(tool.output.schema, tool.name);
	}
	const windowMove = tools.find((tool) => tool.name === "window_move");
	assert.equal(typeof windowMove, "object");
	assert.equal(windowMove.parameters.layout.required, undefined, "layout 可选");
	assert.deepEqual(windowMove.parameters.layout.enum, [...WINDOW_LAYOUTS]);
	const blocks = windowMove.output.render({}, { schemaVersion: 1, ok: true, frame: { x: 1, y: 2, width: 3, height: 4 }, windowTitle: "dest" });
	assert.ok(Array.isArray(blocks) && blocks.length === 1 && blocks[0].type === "text", "window_move render 返回文本块数组");
	const layoutBlocks = windowMove.output.render({}, { schemaVersion: 1, ok: true, layout: "left-half", frame: { x: 0, y: 28, width: 756, height: 954 } });
	assert.match(layoutBlocks[0].text, /\[left-half\]/, "render 回显布局名");
	assert.match(windowMove.description, /layout preset/);
});

test("planWindowFrame：半屏/最大化/居中的几何按可用区域（顶部让出菜单栏）计算", () => {
	const display = { index: 0, primary: true, bounds: { x: 0, y: 0, width: 100, height: 200 } };
	assert.deepEqual(planWindowFrame({ layout: "left-half", display }), { x: 0, y: 28, width: 50, height: 172 });
	assert.deepEqual(planWindowFrame({ layout: "right-half", display }), { x: 50, y: 28, width: 50, height: 172 });
	assert.deepEqual(planWindowFrame({ layout: "top-half", display }), { x: 0, y: 28, width: 100, height: 86 });
	assert.deepEqual(planWindowFrame({ layout: "bottom-half", display }), { x: 0, y: 114, width: 100, height: 86 });
	assert.deepEqual(planWindowFrame({ layout: "maximize", display }), { x: 0, y: 28, width: 100, height: 172 });
	assert.deepEqual(planWindowFrame({ layout: "center", display }), { x: 25, y: 71, width: 50, height: 86 });
	assert.deepEqual(planWindowFrame({ layout: "center", display, width: 40, height: 60 }), { x: 30, y: 84, width: 40, height: 60 });
	// 带偏移的显示器同样以 bounds 为基准
	const offset = { index: 1, bounds: { x: 1000, y: 100, width: 200, height: 200 } };
	assert.deepEqual(planWindowFrame({ layout: "left-half", display: offset }), { x: 1000, y: 128, width: 100, height: 172 });
});

test("planWindowFrame：非法布局或缺失显示器几何返回 undefined", () => {
	assert.equal(planWindowFrame({ layout: "nope", display: { bounds: { x: 0, y: 0, width: 10, height: 10 } } }), undefined);
	assert.equal(planWindowFrame({ display: { bounds: { x: 0, y: 0, width: 10, height: 10 } } }), undefined);
	assert.equal(planWindowFrame({ layout: "left-half" }), undefined);
	assert.equal(planWindowFrame({ layout: "left-half", display: { bounds: { x: 0, y: 0, width: 0, height: 10 } } }), undefined);
	assert.equal(planWindowFrame({ layout: "left-half", display: { bounds: { x: 0, y: Number.NaN, width: 10, height: 10 } } }), undefined);
});

test("resolveLayoutDisplay：优先主屏，缺省取第一块", () => {
	assert.equal(resolveLayoutDisplay([{ index: 0 }, { index: 1, primary: true }]).index, 1);
	assert.equal(resolveLayoutDisplay([{ index: 2 }, { index: 3 }]).index, 2);
	assert.equal(resolveLayoutDisplay(undefined), undefined);
	assert.equal(resolveLayoutDisplay([]), undefined);
});

test("registerOperatorTools：缺 deps/defineTool 时静默不注册", () => {
	const ctx = { tools: { register: () => assert.fail("不应注册") } };
	registerOperatorTools(ctx, {}, {});
	registerOperatorTools(ctx, {}, { backend: {} });
});

test("operator_status / plan_list：返回字段全部在 output schema 声明（防 invalid output）", async () => {
	const tools = collectTools();
	const home = mkdtempSync(join(tmpdir(), "dsh-operator-tools-schema-"));
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		const planDir = join(home, "plans");
		configurePlanStore({ dir: planDir });
		configureFailureStore({ dir: join(home, "failures") });
		createPlan({ goal: "schema 回归计划：只预览不执行", steps: [{ id: "one", tool: "plan_list" }, { id: "two", tool: "plan_list" }] });
		const planId = createPlan({ goal: "schema 回归计划：单个", steps: [{ id: "only", tool: "plan_list" }] }).id;
		const cases = [
			["operator_status", {}],
			["failure_list", { limit: 5 }],
			["ax_batch", { steps: [{ action: "ax_press", index: 1 }, { action: "ax_menu", path: "文件/关闭" }] }],
			["plan_list", {}],
			["plan_run", { id: planId, dryRun: true }],
			["plan_delete", { id: planId }]
		];
		for (const [name, args] of cases) {
			const tool = tools.find((entry) => entry.name === name);
			assert.ok(tool, `缺少工具 ${name}`);
			const value = await tool.execute(args, { signal: { throwIfAborted() {} } });
			const declared = Object.keys(tool.output.schema.properties ?? {});
			const extra = Object.keys(value).filter((key) => declared.includes(key) === false);
			assert.deepEqual(extra, [], `${name} 返回了未声明字段: ${extra.join(",")}`);
		}
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
		rmSync(home, { recursive: true, force: true });
	}
});

test("ax_batch：fork 动作顺序执行、失败即停并回显步骤摘要", async () => {
	const tools = collectTools();
	const batch = tools.find((tool) => tool.name === "ax_batch");
	assert.ok(batch, "ax_batch 已注册");
	const ok = await batch.execute({ steps: [{ action: "click", x: 10, y: 20 }, { action: "hotkey", keys: "cmd,4" }] });
	assert.equal(ok.steps.length, 2);
	assert.equal(ok.failedAt, undefined);
	assert.match(ok.text, /2\/2 ok/);
	const failed = await batch.execute({ steps: [{ action: "click", x: 999, y: 20 }, { action: "hotkey", keys: "cmd,4" }] });
	assert.equal(failed.failedAt, 0);
	assert.equal(failed.steps.length, 1);
	assert.match(failed.text, /failed at step 1/);
});

test("ax_batch：AX 步骤经 handlers 解析（不再报 not registered）", async () => {
	const tools = collectTools();
	const batch = tools.find((tool) => tool.name === "ax_batch");
	assert.ok(batch, "ax_batch 已注册");
	const result = await batch.execute({ steps: [{ action: "ax_press", index: 1 }, { action: "ax_press", index: 2 }] });
	assert.ok(result.steps.length >= 1);
	assert.notEqual(result.steps[0].note, "ax_press not registered", "ax_press 应从 handlers 解析");
});

test("ax_batch：浏览器动作与桌面动作可混跑（0.39.0）", async () => {
	const tools = collectTools();
	const batch = tools.find((tool) => tool.name === "ax_batch");
	const result = await batch.execute({
		steps: [
			{ action: "browser_open", url: "https://example.com/" },
			{ action: "browser_click", text: "More information" },
			{ action: "browser_type", ref: "p1:3", text: "hello" },
			{ action: "hotkey", keys: "cmd,l" }
		]
	});
	assert.equal(result.failedAt, undefined);
	assert.equal(result.steps.length, 4);
	assert.match(result.text, /4\/4 ok/);
	assert.match(result.steps[0].note, /open https:\/\/example\.com/);
	assert.match(result.steps[1].note, /click More information/);
	assert.match(result.steps[2].note, /type p1:3 hello/);
});

test("ax_batch：浏览器动作缺少必填字段时报 missing 并停在该步", async () => {
	const tools = collectTools();
	const batch = tools.find((tool) => tool.name === "ax_batch");
	const result = await batch.execute({ steps: [{ action: "browser_open", url: "https://example.com/" }, { action: "browser_type", ref: "p1:3" }] });
	assert.equal(result.failedAt, 1);
	assert.match(result.steps[1].note, /missing text/);
});

test("failure_list：给出 hot（工具·类型）一行摘要", async () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-fail-list-"));
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		configureFailureStore({ dir: join(home, "dsh-operator", "failures") });
		recordFailure({ tool: "browser_click", error: new Error("ref p1:2 is stale"), kind: "not_found" });
		recordFailure({ tool: "browser_click", error: new Error("ref p1:3 is stale"), kind: "not_found" });
		recordFailure({ tool: "click", error: new Error("guarded word"), kind: "guard_rejected" });
		const tools = collectTools();
		const list = tools.find((tool) => tool.name === "failure_list");
		const value = await list.execute({ limit: 5 }, {});
		assert.equal(value.total, 3);
		assert.match(value.text, /hot: browser_click·not_found\(2\), click·guard_rejected\(1\)/);
		assert.equal(value.hot[0].key, "browser_click·not_found");
	} finally {
		configureFailureStore({});
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
		rmSync(home, { recursive: true, force: true });
	}
});

test("plan_run：计划步骤可回放浏览器工具（共享工具表）", async () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-plan-browser-"));
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		configurePlanStore({ dir: join(home, "plans") });
		const tools = collectTools();
		const created = await tools.find((tool) => tool.name === "plan_create").execute({
			goal: "浏览器步骤回放（测试）",
			steps: [
				{ id: "open", tool: "browser_open", args: { url: "https://example.com/" } },
				{ id: "key", tool: "hotkey", args: { keys: "cmd,l" } }
			]
		}, { signal: { throwIfAborted() {} } });
		const run = await tools.find((tool) => tool.name === "plan_run").execute({ id: created.id }, { signal: { throwIfAborted() {} } });
		assert.equal(run.executed, 2);
		assert.equal(run.results.length, 2);
		assert.deepEqual(run.results.map((row) => row.status), ["ok", "ok"]);
		assert.match(String(run.text ?? ""), /executed 2, failed 0/);
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
		rmSync(home, { recursive: true, force: true });
	}
});
