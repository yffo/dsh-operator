import { test } from "node:test";
import assert from "node:assert/strict";
import {
	configureAxObservation,
	axObservationAvailable,
	formatAxSnapshot,
	observeAxSnapshot,
	pressAx,
	pressAxMenu,
	scrollAx,
	setAxValue,
	snapshotAx,
	MAX_ANONYMOUS_NODES,
	MAX_TEXT_CHARS
} from "../lib/ax-observer.js";

// 一份可复现的 AX helper 输出：两处菜单栏节点应被过滤、无 frame 的节点应被过滤、
// 区域外节点应被过滤、非身份角色且无标题的容器应被过滤。
const snapshot = {
	pid: 4242,
	appName: "系统设置",
	windowTitle: "显示器",
	windowFrame: { x: 0, y: 0, width: 1000, height: 800 },
	truncated: false,
	nodes: [
		{ index: 0, depth: 0, role: "AXWindow", title: "显示器", frame: { x: 100, y: 50, width: 500, height: 400 } },
		{ index: 1, depth: 1, role: "AXButton", title: "通用", frame: { x: 150, y: 100, width: 100, height: 40 } },
		{ index: 2, depth: 1, role: "AXMenuBarItem", title: "File", frame: { x: 160, y: 100, width: 80, height: 20 } },
		{ index: 3, depth: 1, role: "AXImage", frame: { x: 160, y: 150, width: 40, height: 40 } },
		{ index: 4, depth: 1, role: "AXGroup", frame: { x: 160, y: 150, width: 40, height: 40 } },
		{ index: 5, depth: 1, role: "AXStaticText", title: 'a<b&"c"', frame: { x: 160, y: 200, width: 120, height: 20 } },
		{ index: 6, depth: 1, role: "AXButton", value: "值&<>", frame: { x: 160, y: 250, width: 60, height: 30 } },
		{ index: 7, depth: 1, role: "AXButton", title: "外面", frame: { x: 700, y: 600, width: 100, height: 40 } },
		{ index: 8, depth: 1, role: "AXButton", title: "没有 frame" }
	]
};

test("formatAxSnapshot：拒绝非法输入", () => {
	assert.equal(formatAxSnapshot(undefined), undefined);
	assert.equal(formatAxSnapshot(null), undefined);
	assert.equal(formatAxSnapshot({}), undefined);
	assert.equal(formatAxSnapshot({ nodes: "x" }), undefined);
});

test("formatAxSnapshot：过滤菜单栏/无 frame/区域外/无身份容器", () => {
	const region = { x: 100, y: 50, width: 500, height: 400 };
	const text = formatAxSnapshot(snapshot, { appName: "系统设置", windowTitle: "显示器" }, region);
	assert.ok(typeof text === "string");
	// 保留：窗口、通用按钮、AXImage、静态文本、带值的按钮 = 5
	assert.match(text, /nodes="5"/);
	assert.match(text, /schema_version="1"/);
	assert.match(text, /truncated="false"/);
	assert.match(text, /app="系统设置"/);
	assert.match(text, /window="显示器"/);
	assert.ok(text.includes('[1] AXButton "通用" @(200,175)'));
	assert.ok(text.includes("[3] AXImage @(160,300)"), "AXImage 位置应按截图区域换算");
	assert.ok(text.includes("外面") === false, "区域外节点应被过滤");
	assert.ok(text.includes("没有 frame") === false, "无 frame 节点应被过滤");
	assert.ok(text.includes('"File"') === false, "菜单栏节点应被过滤");
});

test("formatAxSnapshot：XML 转义与值输出", () => {
	const region = { x: 100, y: 50, width: 500, height: 400 };
	const text = formatAxSnapshot(snapshot, {}, region);
	assert.ok(text.includes("a&lt;b&amp;&quot;c&quot;"));
	assert.ok(text.includes(`value="值&amp;&lt;&gt;"`));
});

test("formatAxSnapshot：minimumNodes 阈值按保留节点数判断", () => {
	const region = { x: 100, y: 50, width: 500, height: 400 };
	assert.equal(formatAxSnapshot(snapshot, {}, region, 6), undefined);
	assert.ok(typeof formatAxSnapshot(snapshot, {}, region, 5) === "string");
	// 默认阈值 4：5 个节点应保留
	assert.ok(typeof formatAxSnapshot(snapshot, {}, region) === "string");
});

test("formatAxSnapshot：没有 region 时退回窗口 frame 归一化", () => {
	const text = formatAxSnapshot(snapshot, { appName: "系统设置" });
	assert.ok(typeof text === "string");
	// 同一节点中心 (200,120)：窗口 1000x800 → x=200, y=150
	assert.ok(text.includes('[1] AXButton "通用" @(200,150)'));
});

test("formatAxSnapshot：truncated 透传", () => {
	const region = { x: 100, y: 50, width: 500, height: 400 };
	const text = formatAxSnapshot({ ...snapshot, truncated: true }, {}, region);
	assert.match(text, /truncated="true"/);
});

test("formatAxSnapshot：标题缺失时用 foreground 兜底", () => {
	const region = { x: 100, y: 50, width: 500, height: 400 };
	const text = formatAxSnapshot({ ...snapshot, appName: undefined, windowTitle: undefined }, { appName: "访达", windowTitle: "目录" }, region);
	assert.match(text, /app="访达"/);
	assert.match(text, /window="目录"/);
});

test("pressAx/snapshotAx/observeAxSnapshot：参数不合法时安全返回", async () => {
	assert.deepEqual(await pressAx({ pid: 0, index: 1 }), { pressed: false, index: 1, error: "invalid pid" });
	assert.deepEqual(await pressAx({ pid: 10, index: -1 }), { pressed: false, index: -1, error: "invalid index" });
	assert.equal(await snapshotAx(0), undefined);
	assert.equal(await snapshotAx("x"), undefined);
	assert.equal(typeof axObservationAvailable(), "boolean");
	assert.equal(await observeAxSnapshot({}), undefined);
	assert.equal(await observeAxSnapshot({ pid: 0 }), undefined);
});

test("configureAxObservation：关闭后 observeAxSnapshot 直接降级", async () => {
	configureAxObservation({ enabled: false });
	assert.equal(await observeAxSnapshot({ pid: 4242 }), undefined);
	configureAxObservation({ enabled: true, maxNodes: 200, minNodes: 16 });
});

test("formatAxSnapshot：字符预算超出时截断并标 truncated", () => {
	const many = {
		pid: 1,
		appName: "测试",
		windowTitle: "窗口",
		windowFrame: { x: 0, y: 0, width: 1000, height: 800 },
		nodes: Array.from({ length: 400 }, (_, i) => ({
			index: i,
			depth: 1,
			role: "AXButton",
			title: `按钮${String(i)}${"很长的标题".repeat(8)}`,
			value: "",
			frame: { x: 10, y: 10, width: 40, height: 20 }
		})),
		truncated: false
	};
	const text = formatAxSnapshot(many, {}, { x: 0, y: 0, width: 1000, height: 800 });
	assert.ok(typeof text === "string");
	assert.match(text, /truncated="true"/);
	assert.ok(text.length < MAX_TEXT_CHARS + 2000);
});

test("setAxValue/pressAxMenu：参数不合法时安全返回", async () => {
	assert.deepEqual(await setAxValue({ pid: 0, index: 1, value: "x" }), { ok: false, index: 1, error: "invalid pid" });
	assert.deepEqual(await setAxValue({ pid: 10, index: -1, value: "x" }), { ok: false, index: -1, error: "invalid index" });
	assert.deepEqual(await setAxValue({ pid: 10, index: 0, value: 3 }), { ok: false, index: 0, error: "value must be a string" });
	assert.deepEqual(await pressAxMenu({ pid: 0, path: ["文件"] }), { ok: false, path: ["文件"], error: "invalid pid" });
	assert.deepEqual(await pressAxMenu({ pid: 10, path: [] }), { ok: false, path: [], error: "empty menu path" });
});

test("formatAxSnapshot：匿名节点超过上限时裁剪并标 truncated", () => {
	const anonymous = {
		pid: 1,
		appName: "测试",
		windowTitle: "窗口",
		windowFrame: { x: 0, y: 0, width: 1000, height: 800 },
		nodes: Array.from({ length: MAX_ANONYMOUS_NODES + 20 }, (_, i) => ({
			index: i,
			depth: 1,
			role: "AXImage",
			frame: { x: 10, y: 10, width: 20, height: 20 }
		})),
		truncated: false
	};
	const text = formatAxSnapshot(anonymous, {}, { x: 0, y: 0, width: 1000, height: 800 });
	assert.ok(typeof text === "string");
	assert.match(text, /truncated="true"/);
	const shown = (text.match(/\[\d+\] AXImage/g) ?? []).length;
	assert.equal(shown, MAX_ANONYMOUS_NODES);
});

test("scrollAx：参数不合法时安全返回", async () => {
	assert.equal((await scrollAx({ pid: 0, index: 1, direction: "down" })).error, "invalid pid");
	assert.equal((await scrollAx({ pid: 10, index: -1, direction: "down" })).error, "invalid index");
	assert.equal((await scrollAx({ pid: 10, index: 0, direction: "diagonal" })).error, "direction must be up/down/left/right");
});
