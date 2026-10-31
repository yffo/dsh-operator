import { test } from "node:test";
import assert from "node:assert/strict";

import { hasTool, mergeToolRegistries, registryNames } from "../lib/tool-registry.js";
import { registerOperatorTools, registerV2Tools } from "../lib/operator-tools.js";

function forkDefs() {
	return new Map([
		["screenshot", { name: "screenshot", execute: async () => ({ schemaVersion: 1 }), output: { render: () => [] } }],
		["click", { name: "click", execute: async () => ({ schemaVersion: 1 }), output: { render: () => [] } }],
		["open_app", { name: "open_app", execute: async () => ({ schemaVersion: 1 }) }]
	]);
}

function registerWithFork(defs) {
	const registered = [];
	const ctx = { tools: { register: (tool) => registered.push(tool.name) } };
	const result = registerOperatorTools(ctx, { axMaxNodes: 120, guard: false, failureSamples: false }, {
		backend: { listScreens: async () => [] },
		defineTool: (definition) => definition,
		AttachmentId: (value) => value,
		computerUseToolDefs: defs
	});
	return { registered, result };
}

test("mergeToolRegistries：按顺序合并、重名先到先得、跳过非法输入", () => {
	const a = new Map([
		["alpha", { execute: 1 }],
		["dup", { execute: "first" }]
	]);
	const b = new Map([
		["beta", { execute: 2 }],
		["dup", { execute: "second" }]
	]);
	const merged = mergeToolRegistries(a, undefined, null, b, "not-a-map");
	assert.deepEqual(registryNames(merged), ["alpha", "beta", "dup"]);
	assert.equal(merged.get("dup").execute, "first");
	assert.equal(hasTool(merged, "beta"), true);
	assert.equal(hasTool(merged, "missing"), false);
	assert.equal(mergeToolRegistries().size, 0);
});

test("mergeToolRegistries：忽略空名/非字符串名", () => {
	const merged = mergeToolRegistries(new Map([["", {}], [42, {}], ["ok", {}]]));
	assert.deepEqual(registryNames(merged), ["ok"]);
});

test("registerOperatorTools 返回惰性 buildRegistry，能合并 fork 工具而不覆盖扩展工具", { skip: process.platform !== "darwin" }, () => {
	const defs = forkDefs();
	const { registered, result } = registerWithFork(defs);
	assert.ok(result !== undefined, "应返回 { handlers, registerExtra, buildRegistry }");
	assert.ok(result.handlers instanceof Map);
	const registry = result.buildRegistry();
	assert.ok(registry instanceof Map);
	// 扩展工具都在 registry 里且为同一描述符
	assert.ok(result.handlers.has("operator_status"));
	assert.equal(registry.get("operator_status"), result.handlers.get("operator_status"));
	// fork 的工具被并入 registry，但不在 handlers（回放白名单仍只限扩展工具）
	for (const name of ["screenshot", "click", "open_app"]) {
		assert.ok(registry.has(name), `registry 应包含 ${name}`);
		assert.ok(!result.handlers.has(name), `handlers 不应包含 ${name}`);
	}
	assert.equal(registry.size, result.handlers.size + defs.size);
	assert.equal(registered.length, result.handlers.size);
});

test("registerV2Tools 注册 cu_observe：action 枚举、输出并集、分派到旧工具", { skip: process.platform !== "darwin" }, async () => {
	const defs = forkDefs();
	const { result } = registerWithFork(defs);
	const registered = [];
	const ctxRegisterExtra = result.registerExtra;
	// 借 registerExtra 捕获注册结果
	const handle = {
		handlers: result.handlers,
		buildRegistry: result.buildRegistry,
		registerExtra: (definition) => {
			registered.push(definition);
			register(ctxRegisterExtra(definition));
		}
	};
	function register(definition) {
		return definition;
	}
	const cuObserve = registerV2Tools({ handle, defineTool: (definition) => definition });
	assert.equal(cuObserve.name, "cu_observe");
	assert.deepEqual(cuObserve.parameters.action.enum, ["screenshot", "windows", "window_screenshot", "zoom", "verify"]);
	assert.equal(cuObserve.parameters.action.required, true);
	// 并集参数来自被合并工具（list_windows 的 pid、screenshot_window 的 window_id）
	assert.ok(cuObserve.parameters.pid !== void 0);
	assert.ok(cuObserve.parameters.window_id !== void 0);
	// 输出 schema：additionalProperties=false 且包含关键字段，不能带 required（否则某个 action 缺字段会失败）
	const schema = cuObserve.output.schema;
	assert.equal(schema.additionalProperties, false);
	assert.ok(schema.properties.schemaVersion !== void 0);
	assert.ok(schema.properties.text !== void 0);
	assert.equal(JSON.stringify(schema).includes('"required":true'), false);
	// 分派：screenshot → fake fork def 的 execute
	const value = await cuObserve.execute({ action: "screenshot" }, {});
	assert.deepEqual(value, { schemaVersion: 1 });
	await assert.rejects(() => cuObserve.execute({ action: "nope" }, {}), /unknown action/);
});

test("registerV2Tools 在缺少 fork 工具时抛错（注册表不完整要快速暴露）", { skip: process.platform !== "darwin" }, () => {
	const handle = {
		handlers: new Map([["list_windows", { execute() {} }]]),
		buildRegistry: () => new Map([["list_windows", { execute() {} }]]),
		registerExtra: () => {}
	};
	assert.throws(() => registerV2Tools({ handle, defineTool: (definition) => definition }), /missing tools for dispatch/);
});
