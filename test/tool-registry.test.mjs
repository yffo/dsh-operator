import { test } from "node:test";
import assert from "node:assert/strict";

import { hasTool, mergeToolRegistries, registryNames } from "../lib/tool-registry.js";
import { registerOperatorTools, registerV2Tools } from "../lib/operator-tools.js";
import { mergeParameters, parameterSpecs } from "../lib/tool-surface.js";

function forkDefs() {
	const def = (name, execute = async () => ({ schemaVersion: 1 })) => ({ name, execute, output: { render: () => [] } });
	return new Map([
		["screenshot", def("screenshot")],
		["click", def("click")],
		["open_app", def("open_app")],
		["drag", def("drag")],
		["scroll", def("scroll")],
		["input_text", def("input_text")],
		["hotkey", def("hotkey")],
		["window_list", def("window_list")]
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
	const { cuObserve, cuAct } = registerV2Tools({ handle, defineTool: (definition) => definition });
	assert.equal(cuObserve.name, "cu_observe");
	assert.deepEqual(cuObserve.parameters.action.enum, ["screenshot", "windows", "window_screenshot", "zoom", "verify"]);
	assert.equal(cuObserve.parameters.action.required, true);
	// 并集参数全部可选：只有 action 是 required（0.18.2 回归：合并成员自带的 required 不能带进来）
	assert.ok(cuObserve.parameters.pid !== void 0);
	assert.ok(cuObserve.parameters.window_id !== void 0);
	assert.equal(cuObserve.parameters.window_id.required, void 0);
	assert.equal(cuObserve.parameters.kind.required, void 0);
	assert.deepEqual(Object.keys(cuObserve.parameters).filter((key) => cuObserve.parameters[key].required === true), ["action"]);
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
	// verify 需要 kind；window_screenshot 需要 window_id；其余 action 不强制
	await assert.rejects(() => cuObserve.execute({ action: "verify" }, {}), /missing parameter\(s\) for action "verify": kind/);
	await assert.rejects(() => cuObserve.execute({ action: "window_screenshot" }, {}), /missing parameter\(s\) for action "window_screenshot": window_id/);
	const windowsValue = await cuObserve.execute({ action: "windows" }, {});
	assert.equal(windowsValue.schemaVersion, 1);
	// cu_act：9 个动作、显式参数并集、按 action 校验必填、分派到旧工具
	assert.equal(cuAct.name, "cu_act");
	assert.deepEqual(cuAct.parameters.action.enum, ["click", "drag", "scroll", "input", "hotkey", "ax_press", "ax_set_value", "ax_menu", "ax_scroll"]);
	assert.ok(cuAct.parameters.position !== void 0);
	assert.ok(cuAct.parameters.keys !== void 0);
	assert.ok(cuAct.parameters.index !== void 0);
	await assert.rejects(() => cuAct.execute({ action: "click" }, {}), /missing parameter\(s\) for action "click": screen_index, position/);
	await assert.rejects(() => cuAct.execute({ action: "hotkey", keys: [] }, {}), /./);
});

test("mergeParameters 兼容 defineTool 编译后的 JSON Schema 形态（0.17.1 回归）", () => {
	// 真实宿主里 defineTool 返回的 definition.parameters 是 JSON Schema：
	// { type: "object", properties: {...}, required: [...] }，不能把 type/properties 当成参数名
	const compiled = {
		definition: {
			parameters: {
				type: "object",
				properties: { pid: { type: "integer", description: "process id" }, attach: { type: "boolean" } },
				required: ["pid"],
				additionalProperties: false
			}
		}
	};
	const legacy = { definition: { parameters: { limit: { type: "number", required: false, description: "max" } } } };
	const specs = parameterSpecs(compiled.definition);
	assert.deepEqual(Object.keys(specs).sort(), ["attach", "pid"]);
	assert.equal(specs.pid.required, true);
	assert.equal(specs.attach.required, void 0, "DSL 不接受 required:false");
	const { properties } = mergeParameters([compiled, legacy]);
	assert.deepEqual(Object.keys(properties).sort(), ["attach", "limit", "pid"]);
	assert.equal(properties.type, void 0);
	assert.equal(properties.properties, void 0);
	assert.ok(properties.pid !== void 0);
	assert.ok(properties.limit !== void 0);
});

test("registerV2Tools 在缺少 fork 工具时抛错（注册表不完整要快速暴露）", { skip: process.platform !== "darwin" }, () => {
	const handle = {
		handlers: new Map([["list_windows", { execute() {} }]]),
		buildRegistry: () => new Map([["list_windows", { execute() {} }]]),
		registerExtra: () => {}
	};
	assert.throws(() => registerV2Tools({ handle, defineTool: (definition) => definition }), /missing tools for dispatch/);
});
