import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "client", "client.js"), "utf8");

// ---- 极小的 React 兼容层：createElement 记成对象树，不碰 DOM ----
const MiniReact = {
	createElement(type, props, ...children) {
		return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true) };
	}
};

function loadClient() {
	let captured = null;
	let registered = 0;
	const sandbox = {
		window: { __ModuleLoader__: { load: (def) => { captured = def; } } },
		console,
		Date,
		JSON,
		Math,
		Object,
		Array,
		String,
		Number,
		Boolean,
		Error,
		Promise
	};
	vm.runInNewContext(source, sandbox, { filename: "client/client.js" });
	assert.ok(captured && typeof captured.factory === "function", "client.js 必须注册 factory");
	const mod = captured.factory((name) => {
		if (name === "react") return MiniReact;
		throw new Error(`unexpected require: ${name}`);
	});
	let Component = null;
	mod.apply({
		slots: {
			inject(slot, fn) {
				if (slot === "tool.call.toolview") fn();
			},
			register(_options, component) {
				registered += 1;
				Component = component;
				return () => {};
			}
		}
	});
	assert.equal(typeof Component, "function", "apply() 必须注册 tool.call.toolview 视图");
	return { Component, registered };
}

/** 把函数组件展开成普通元素树（refs / 事件不执行）。 */
function expand(node) {
	if (node === null || node === undefined || node === false || node === true) return null;
	if (typeof node === "string" || typeof node === "number") return { text: String(node) };
	if (Array.isArray(node)) return node.map(expand).filter(Boolean);
	const { type, props = {}, children = [] } = node;
	if (typeof type === "function") {
		const child = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
		return expand(type({ ...props, children: child }));
	}
	return { type, props, children: children.map(expand).filter(Boolean) };
}

function inspect(tree) {
	const texts = [];
	const nodes = [];
	const visit = (node) => {
		if (node === null || node === undefined) return;
		if (node.text !== undefined) {
			texts.push(node.text);
			return;
		}
		nodes.push(node);
		for (const child of node.children ?? []) visit(child);
	};
	visit(tree);
	return { texts, text: texts.join("\n"), nodes };
}

function startBlock(name, callId, args, time = Date.now()) {
	return { phase: "start", callId, name, turn: 1, step: 1, time, subCalls: [], args, argsRaw: JSON.stringify(args) };
}

function resultBlock(name, callId, args, { text = "", isError = false, error, callTime = Date.now() - 1200 } = {}) {
	return {
		kind: "tool-result",
		seq: 1,
		time: Date.now(),
		callId,
		name,
		callTime,
		args,
		call: { name, argsRaw: JSON.stringify(args) },
		content: text === "" ? [] : [{ type: "text", text }],
		isError,
		error,
		subCalls: []
	};
}

const { Component: view, registered } = loadClient();
const render = (toolName, block) => inspect(expand(view({ toolName, block })));

test("每个 operator 工具都注册了行视图", () => {
	assert.equal(registered, 18, "18 个工具的 keyed toolview");
});

test("运行中只显示一行「DSH 正在操作电脑」", () => {
	const { text, nodes } = render("ax_batch", startBlock("ax_batch", "c1", { steps: [{ action: "press" }] }));
	assert.match(text, /DSH 正在操作电脑/);
	assert.match(text, /ax batch/);
	assert.doesNotMatch(text, /第 1\/1 步|进度|截图/);
	assert.equal(nodes.filter((node) => node.props?.["data-state"] === "running").length, 1);
});

test("结算后同一行补状态与耗时", () => {
	const { text } = render("ax_batch", resultBlock("ax_batch", "c2", {}, { text: "ax_batch: 2/2 ok", callTime: Date.now() - 1200 }));
	assert.match(text, /DSH 正在操作电脑/);
	assert.match(text, /已完成/);
	assert.match(text, /1\.[0-9]s/);
});

test("失败与中断用状态词区分", () => {
	const failed = render("browser_dom_click", resultBlock("browser_dom_click", "c3", {}, { text: "permission denied", isError: true, error: { message: "permission denied" } }));
	assert.match(failed.text, /失败/);
	const stopped = render("screenshot_window", resultBlock("screenshot_window", "c4", {}, { isError: true, error: { code: "interrupted", message: "调用被中断" } }));
	assert.match(stopped.text, /已中断/);
	assert.doesNotMatch(stopped.text, /失败/);
});

test("渲染自身不会退化成错误行", () => {
	for (const [tool, block] of [
		["ax_batch", startBlock("ax_batch", "c5", { steps: [] })],
		["operator_status", resultBlock("operator_status", "c6", {}, { text: "dsh-operator 0.23.3 (darwin)" })]
	]) {
		const { text } = render(tool, block);
		assert.doesNotMatch(text, /card error|dsh-operator ·/);
	}
});
