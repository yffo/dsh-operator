import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureAuditLog } from "../lib/audit-log.js";
import {
	configureOperatorToolsInternals,
	evaluatePredicate,
	registerOperatorTools,
	resetOperatorToolsInternals
} from "../lib/operator-tools.js";

const darwin = process.platform === "darwin";
let auditPath;

beforeEach(() => {
	auditPath = join(mkdtempSync(join(tmpdir(), "dsh-operator-tools-")), "audit.jsonl");
	configureAuditLog({ path: auditPath });
	resetOperatorToolsInternals();
});

afterEach(() => {
	resetOperatorToolsInternals();
	configureAuditLog({ enabled: true });
});

/** 构一个结构可解析的 JPEG（像素 1x1，仅供 jpegDimensions）。 */
function jpegBytes(width, height) {
	return Uint8Array.from([
		0xff, 0xd8,
		0xff, 0xc0, 0x00, 0x11, 0x08,
		(height >> 8) & 0xff, height & 0xff,
		(width >> 8) & 0xff, width & 0xff,
		0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
		0xff, 0xd9
	]);
}

const exec = { signal: new AbortController().signal };

function setupTools({ internals = {}, config = {}, backend = {}, writeImage = jpegBytes(120, 80) } = {}) {
	const calls = [];
	const tools = {};
	const registered = [];
	const ctx = {
		tools: {
			register(tool) {
				registered.push(tool.name);
				tools[tool.name] = tool;
			}
		},
		attachments: {
			async saveImage({ data, mediaType }) {
				return { attachmentId: "att-1", mediaType, bytes: data.length, width: 120, height: 80 };
			}
		}
	};
	const execFile = async (bin, args) => {
		calls.push({ bin, args });
		const output = args[args.length - 1];
		writeFileSync(output, writeImage);
	};
	const deps = {
		backend,
		defineTool: (definition) => definition,
		AttachmentId: (value) => value
	};
	configureOperatorToolsInternals({ execFileAsync: execFile, ...internals });
	registerOperatorTools(ctx, { axMaxNodes: 120, guard: true, ...config }, deps);
	return { tools, registered, calls };
}

const fixtureWindows = {
	frontmostPid: 12,
	frontmostApp: "DeepSeek Harness",
	truncated: false,
	displays: [{ index: 0, primary: true, scale: 2, bounds: { x: 0, y: 0, width: 100, height: 200 } }],
	windows: [
		{
			windowID: 5,
			pid: 12,
			app: "DeepSeek Harness",
			title: "自研 Computer Use",
			layer: 0,
			onScreen: true,
			bounds: { x: 10, y: 20, width: 300, height: 150 }
		}
	]
};

test("evaluatePredicate 正向路径：五种谓词都能从注入数据里命中", async (t) => {
	if (!darwin) {
		t.skip("darwin only");
		return;
	}
	configureOperatorToolsInternals({
		listWindows: async () => fixtureWindows,
		snapshotAx: async () => ({
			nodes: [
				{ index: 1, role: "AXButton", title: "显示器", value: "", frame: { x: 0, y: 0, width: 10, height: 10 } },
				{ index: 2, role: "AXStaticText", title: "", value: "内建显示器", frame: { x: 0, y: 0, width: 10, height: 10 } }
			]
		})
	});
	assert.equal((await evaluatePredicate({ kind: "window_title", contains: "Computer" })).ok, true);
	assert.equal((await evaluatePredicate({ kind: "frontmost_app", contains: "harness" })).ok, true);
	assert.equal((await evaluatePredicate({ kind: "app_running", contains: "Harness" })).ok, true);
	assert.equal((await evaluatePredicate({ kind: "ax_text", contains: "内建", pid: 4242 })).ok, true);
	assert.equal((await evaluatePredicate({ kind: "ax_element", role: "AXButton", title: "显示", pid: 4242 })).ok, true);
	assert.equal((await evaluatePredicate({ kind: "ax_element", role: "AXButton", title: "不存在", pid: 4242 })).ok, false);
});

test("list_windows：输出文本结构与降级", async (t) => {
	if (!darwin) {
		t.skip("darwin only");
		return;
	}
	const { tools } = setupTools({ internals: { listWindows: async () => fixtureWindows } });
	assert.deepEqual(tools.list_windows, tools.list_windows);
	const value = await tools.list_windows.execute({ limit: 20 }, exec);
	assert.equal(value.schemaVersion, 1);
	assert.match(value.text, /<windows schema_version="1"/);
	assert.match(value.text, /<display index="0" primary="true" scale="2">0,0 100x200<\/display>/);
	assert.ok(value.text.includes('<window id="5" pid="12"'));
	assert.ok(value.text.includes("自研 Computer Use"));

	const degraded = setupTools({ internals: { listWindows: async () => undefined } });
	await assert.rejects(degraded.tools.list_windows.execute({}, exec), /window query unavailable/);
});

test("screenshot_window：attach=true 带图片、attach=false 只给路径、非法参数拒绝", async (t) => {
	if (!darwin) {
		t.skip("darwin only");
		return;
	}
	const { tools, calls } = setupTools();
	const value = await tools.screenshot_window.execute({ window_id: 33 }, exec);
	assert.equal(value.windowId, 33);
	assert.equal(value.width, 120);
	assert.equal(value.height, 80);
	assert.equal(value.image.attachmentId, "att-1");
	assert.equal(calls[0].args[calls[0].args.length - 2], "33");
	const blocks = tools.screenshot_window.output.render({}, value);
	assert.equal(blocks[0].type, "text");
	assert.equal(blocks[1].type, "image");
	assert.equal(blocks[1].attachment.attachmentId, "att-1");

	const noAttach = await tools.screenshot_window.execute({ window_id: 34, attach: false }, exec);
	assert.equal(noAttach.image, undefined);
	assert.ok(typeof noAttach.path === "string");

	await assert.rejects(tools.screenshot_window.execute({ window_id: "x" }, exec), /positive integer/);
});

test("screenshot_window：截屏失败会抛错", async (t) => {
	if (!darwin) {
		t.skip("darwin only");
		return;
	}
	const { tools } = setupTools({
		internals: {
			execFileAsync: async () => {
				throw new Error("screencapture failed");
			}
		}
	});
	await assert.rejects(tools.screenshot_window.execute({ window_id: 35 }, exec), /screencapture failed/);
});

test("zoom_region：优先用 listScreens 的区域做坐标换算", async (t) => {
	if (!darwin) {
		t.skip("darwin only");
		return;
	}
	const backend = {
		listScreens: async () => [{ windowId: 77, bounds: { x: 10, y: 20, width: 400, height: 300 } }]
	};
	const { tools, calls } = setupTools({ backend });
	const value = await tools.zoom_region.execute({ x: 500, y: 500, width: 300, height: 300, attach: false }, exec);
	// regionWidth=120, regionHeight=90 → x=150, y=125
	assert.equal(value.region, "150,125,120,90");
	assert.equal(value.windowId, 77);
	assert.ok(calls[0].args.includes("150,125,120,90"));
	assert.equal(value.image, undefined);
});

test("zoom_region：listScreens 不可用时回退前台窗口", async (t) => {
	if (!darwin) {
		t.skip("darwin only");
		return;
	}
	const backend = { listScreens: async () => undefined };
	const { tools } = setupTools({ backend, internals: { listWindows: async () => fixtureWindows } });
	const value = await tools.zoom_region.execute({ x: 500, y: 500, width: 300, height: 300 }, exec);
	assert.equal(value.windowId, 5);
	assert.equal(value.image.attachmentId, "att-1");
});

test("zoom_region：两条路都不可用时报错", async (t) => {
	if (!darwin) {
		t.skip("darwin only");
		return;
	}
	const { tools } = setupTools({ backend: {}, internals: { listWindows: async () => undefined } });
	await assert.rejects(tools.zoom_region.execute({}, exec), /window list unavailable/);
});

test("verify_state：命中即返回、超时只报事实、取消抛错", async (t) => {
	if (!darwin) {
		t.skip("darwin only");
		return;
	}
	const { tools } = setupTools({ internals: { listWindows: async () => fixtureWindows } });
	const ok = await tools.verify_state.execute({ kind: "frontmost_app", contains: "Harness" }, exec);
	assert.equal(ok.satisfied, true);
	assert.equal(ok.polls, 1);
	assert.equal(ok.kind, "frontmost_app");

	const timeout = await tools.verify_state.execute({ kind: "unknown_kind", timeout_ms: 0, interval_ms: 100 }, exec);
	assert.equal(timeout.satisfied, false);
	assert.equal(timeout.polls, 1);
	assert.match(timeout.observed, /unknown kind/);

	const controller = new AbortController();
	controller.abort();
	await assert.rejects(tools.verify_state.execute({ kind: "frontmost_app" }, { signal: controller.signal }), /abort/i);
});

test("ax_press：危险标题默认拒绝，confirm 放行，guard 关闭放行", async (t) => {
	if (!darwin) {
		t.skip("darwin only");
		return;
	}
	const snapshotInternals = {
		snapshotAx: async () => ({ nodes: [{ index: 3, role: "AXButton", title: "删除全部" }] })
	};
	const pressedCalls = [];
	const pressInternals = {
		...snapshotInternals,
		pressAx: async (args) => {
			pressedCalls.push(args);
			return { pressed: true, index: args.index, role: "AXButton", title: "删除全部" };
		}
	};
	const { tools } = setupTools({
		internals: { listWindows: async () => fixtureWindows, ...pressInternals }
	});
	const denied = await tools.ax_press.execute({ index: 3 }, exec);
	assert.equal(denied.pressed, false);
	assert.match(denied.error, /删除/);
	assert.equal(pressedCalls.length, 0);
	const auditText = readFileSync(auditPath, "utf8");
	assert.ok(auditText.includes("ax_press_guarded"));

	const allowed = await tools.ax_press.execute({ index: 3, confirm: true, expect_role: "AXButton" }, exec);
	assert.equal(allowed.pressed, true);
	assert.equal(pressedCalls[0].expectRole, "AXButton");

	const guardOff = setupTools({
		config: { guard: false },
		internals: { listWindows: async () => fixtureWindows, ...pressInternals }
	});
	const off = await guardOff.tools.ax_press.execute({ index: 3 }, exec);
	assert.equal(off.pressed, true);
});

test("ax_press：helper 失败事实透传、无前台 pid 时返回错误", async (t) => {
	if (!darwin) {
		t.skip("darwin only");
		return;
	}
	const { tools } = setupTools({
		internals: {
			listWindows: async () => fixtureWindows,
			snapshotAx: async () => ({ nodes: [] }),
			pressAx: async (args) => ({ pressed: false, index: args.index, error: "element not found" })
		}
	});
	const failed = await tools.ax_press.execute({ index: 99 }, exec);
	assert.equal(failed.pressed, false);
	assert.match(failed.error, /element not found/);

	const noPid = setupTools({ internals: { listWindows: async () => undefined } });
	const value = await noPid.tools.ax_press.execute({ index: 1 }, exec);
	assert.equal(value.pressed, false);
	assert.match(value.error, /no target pid/);
});

test("扩展工具输出 render：verify_state / ax_press / list_windows 文本", async (t) => {
	if (!darwin) {
		t.skip("darwin only");
		return;
	}
	const { tools } = setupTools();
	const verifyBlocks = tools.verify_state.output.render({}, {
		schemaVersion: 1,
		satisfied: true,
		kind: "window_title",
		polls: 2,
		elapsedMs: 111,
		observed: "1 window(s) matched title"
	});
	assert.match(verifyBlocks[0].text, /Verified \(window_title\) after 2 poll/);

	const pressBlocks = tools.ax_press.output.render({}, { schemaVersion: 1, pressed: true, index: 3, role: "AXButton", title: "通用" });
	assert.match(pressBlocks[0].text, /Pressed AX node \[3\] AXButton "通用"/);
});
