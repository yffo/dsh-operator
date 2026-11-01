import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "client", "client.js"), "utf8");

// ---- 极小的 React 兼容层：createElement 记成对象树，不碰 DOM（卡片是纯函数组件） ----
const MiniReact = {
	createElement(type, props, ...children) {
		return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true) };
	}
};

function loadClient() {
	let captured = null;
	const sandbox = {
		window: { __ModuleLoader__: { load: (def) => { captured = def; } } },
		console,
		setInterval,
		clearInterval,
		queueMicrotask,
		Date,
		JSON,
		Math,
		Object,
		Array,
		String,
		Number,
		Boolean,
		Error,
		Promise,
		encodeURIComponent
	};
	vm.runInNewContext(source, sandbox, { filename: "client/client.js" });
	assert.ok(captured && typeof captured.factory === "function", "client.js 必须注册 factory");
	const requireShim = (name) => {
		if (name === "react") return MiniReact;
		throw new Error(`unexpected require: ${name}`);
	};
	const mod = captured.factory(requireShim);
	let Component = null;
	mod.apply({
		slots: {
			inject(slot, fn) {
				if (slot === "tool.call.toolview") fn();
			},
			register(_options, component) {
				Component = component;
				return () => {};
			}
		}
	});
	assert.equal(typeof Component, "function", "apply() 必须注册 tool.call.toolview 视图");
	return Component;
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

const image = { type: "image", attachment: { attachmentId: "att-1", mediaType: "image/png", bytes: 2048, width: 800, height: 520, name: "shot.png" } };
const loadImage = Object.assign(() => Promise.resolve("data:image/png;base64,"), { peek: () => "data:image/png;base64," });

function startBlock(name, callId, args, time = Date.now()) {
	return { phase: "start", callId, name, turn: 1, step: 1, time, subCalls: [], args, argsRaw: JSON.stringify(args) };
}

function resultBlock(name, callId, args, { text = "", isError = false, error, content, callTime = Date.now() - 1200 } = {}) {
	return {
		kind: "tool-result",
		seq: 1,
		time: Date.now(),
		callId,
		name,
		callTime,
		args,
		call: { name, argsRaw: JSON.stringify(args) },
		content: content ?? (text === "" ? [] : [{ type: "text", text }]),
		isError,
		error,
		subCalls: []
	};
}

const view = loadClient();
const render = (toolName, block) => inspect(expand(view({ toolName, block, loadImage })));

test("运行中的 ax_batch 展示标题/步骤/实时耗时，且不把内部字段当目标", () => {
	const { text, nodes } = render("ax_batch", startBlock("ax_batch", "c1", {
		steps: [{ action: "press", role: "AXButton" }, { action: "set_value", title: "搜索框" }, { action: "press", title: "提交" }]
	}));
	assert.match(text, /正在操作 · 第 1\/3 步/);
	assert.match(text, /按下控件/);
	assert.match(text, /写入字段/);
	assert.match(text, /后台执行 · 不影响你/);
	assert.doesNotMatch(text, /目标：/);
	assert.equal(nodes.filter((node) => node.props?.["data-dop-elapsed"] !== undefined).length, 1, "运行卡片要有实时耗时节点");
});

test("需要确认的高危工具展示确认门与前台徽标", () => {
	const { text } = render("ax_press", startBlock("ax_press", "c2", { role: "AXButton", title: "保存", delivery_mode: "foreground" }));
	assert.match(text, /需要你确认/);
	assert.match(text, /前台执行 · 短暂占用/);
	assert.match(text, /目标：保存 › AXButton/);
});

test("已确认的高危工具不再显示确认门", () => {
	const { text } = render("ax_press", startBlock("ax_press", "c3", { role: "AXButton", title: "保存", confirm: true }));
	assert.doesNotMatch(text, /需要你确认/);
});

test("带截图的结果卡片展示缩略图与张数", () => {
	const block = resultBlock("cu_observe", "c4", { action: "screenshot" }, {
		text: "Safari › 天气 · 主窗口\n页面显示 26°C，晴。",
		content: [{ type: "text", text: "Safari › 天气 · 主窗口\n页面显示 26°C，晴。" }, image]
	});
	const { text, nodes } = render("cu_observe", block);
	assert.match(text, /已完成/);
	assert.match(text, /1 张截图/);
	const img = nodes.find((node) => node.type === "img");
	assert.ok(img, "应渲染 img 缩略图");
	assert.equal(img.props["data-dop-attach"], "0");
});

test("失败卡片给出原因与可执行建议", () => {
	const block = resultBlock("browser_dom_click", "c5", { selector: "#submit" }, {
		text: "Error: permission denied — AppleScript JavaScript channel is disabled (not allowed).",
		isError: true,
		error: { name: "Error", message: "permission denied" }
	});
	const { text } = render("browser_dom_click", block);
	assert.match(text, /失败/);
	assert.match(text, /权限没开/);
	assert.match(text, /结果：/);
});

test("ax_batch 失败的第 2/2 步：进度条 + 失败行 + 建议", () => {
	const block = resultBlock("ax_batch", "c6", { steps: [{ action: "press" }, { action: "press" }] }, {
		text: "ax_batch: 1/2 ok (failed at step 2)\n  1. press ok — opened\n  2. press FAILED — element not found (stale token)",
		isError: true,
		error: { name: "Error", message: "failed at step 2" }
	});
	const { text, nodes } = render("ax_batch", block);
	assert.match(text, /失败 · 第 2\/2 步/);
	assert.match(text, /1\/2 step\(s\) ok · failed at step 2/);
	assert.match(text, /重新观察窗口/);
	const segments = nodes.filter((node) => node.props?.["data-state"] !== undefined && (node.props?.className === "done" || node.props?.className === "err"));
	assert.equal(segments.length, 2, "两段进度条：done + err");
});

test("中断的调用显示已中断而不是失败", () => {
	const block = resultBlock("screenshot_window", "c7", { window_id: 14397 }, {
		isError: true,
		error: { name: "InterruptedError", code: "interrupted", message: "调用被中断" }
	});
	const { text } = render("screenshot_window", block);
	assert.match(text, /已中断/);
	assert.doesNotMatch(text, /失败 ·/);
});

test("卡片渲染自身不会退化成 card error", () => {
	for (const [tool, block] of [
		["ax_batch", startBlock("ax_batch", "c8", { steps: [{ action: "press" }] })],
		["operator_status", resultBlock("operator_status", "c9", {}, { text: "dsh-operator 0.23.0 (darwin)\nskills: 0 · plans: 0" })]
	]) {
		const { text } = render(tool, block);
		assert.doesNotMatch(text, /card error/);
	}
});
