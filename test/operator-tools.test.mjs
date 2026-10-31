import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePredicate, registerOperatorTools } from "../lib/operator-tools.js";

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
	registerOperatorTools(ctx, { axMaxNodes: 120, guard: true }, {
		backend: { listScreens: async () => [] },
		defineTool: (definition) => definition,
		AttachmentId: (value) => value
	});
	return registered;
}

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

test("registerOperatorTools：仅 darwin 注册七个扩展工具", (t) => {
	const tools = collectTools();
	if (process.platform !== "darwin") {
		assert.equal(tools.length, 0);
		t.diagnostic(`skipped: platform=${process.platform}`);
		return;
	}
	assert.deepEqual(
		tools.map((tool) => tool.name).sort(),
		["ax_menu", "ax_press", "ax_set_value", "list_windows", "screenshot_window", "verify_state", "zoom_region"]
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
