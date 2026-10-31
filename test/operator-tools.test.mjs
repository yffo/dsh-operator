import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePredicate, registerOperatorTools, V2_LEGACY_TOOL_NAMES } from "../lib/operator-tools.js";
import { configurePlanStore, createPlan } from "../lib/planner.js";

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
		AttachmentId: (value) => value
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

test("registerOperatorTools：仅 darwin 注册二十四个扩展工具", (t) => {
	const tools = collectTools();
	if (process.platform !== "darwin") {
		assert.equal(tools.length, 0);
		t.diagnostic(`skipped: platform=${process.platform}`);
		return;
	}
	assert.deepEqual(
		tools.map((tool) => tool.name).sort(),
		["ax_menu", "ax_press", "ax_scroll", "ax_set_value", "browser_dom_click", "browser_dom_fill", "browser_dom_probe", "browser_dom_snapshot", "list_windows", "operator_status", "plan_create", "plan_delete", "plan_list", "plan_run", "plan_update", "screenshot_window", "skill_delete", "skill_list", "skill_run", "skill_save", "skill_show", "task_profile", "verify_state", "zoom_region"]
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
		createPlan({ goal: "schema 回归计划：只预览不执行", steps: [{ id: "one", tool: "plan_list" }, { id: "two", tool: "plan_list" }] });
		const planId = createPlan({ goal: "schema 回归计划：单个", steps: [{ id: "only", tool: "plan_list" }] }).id;
		const cases = [
			["operator_status", {}],
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
