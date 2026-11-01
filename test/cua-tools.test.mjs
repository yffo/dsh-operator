// cua-driver 工具面单测（0.22.0）：用假 cua-driver 二进制覆盖注册、观测、动作映射与失败提示。
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerCuaTools } from "../lib/cua-tools.js";

const fakeBin = join(import.meta.dirname, "fixtures", "fake-cua-driver.mjs");
chmodSync(fakeBin, 0o755);

/** 收集 register 进来的工具定义与 saveImage 调用。 */
function makeHarness() {
	const definitions = new Map();
	const saved = [];
	const ctx = {
		tools: {
			register(definition) {
				definitions.set(definition.name, definition);
				return {};
			}
		},
		attachments: {
			async saveImage(options) {
				saved.push(options);
				return { attachmentId: "att-1", mediaType: options.mediaType, bytes: options.data.length, width: 1, height: 1 };
			}
		}
	};
	return { ctx, definitions, saved };
}

/** 注册一套工具；返回工具定义与临时日志路径。 */
function setup(options = {}) {
	const bin = options.bin ?? fakeBin;
	process.env.DSH_OPERATOR_CUA_BIN = bin;
	if (options.disable === true) process.env.DSH_OPERATOR_CUA = "0";
	const dir = mkdtempSync(join(tmpdir(), "cua-tools-test-"));
	const logPath = join(dir, "calls.jsonl");
	process.env.FAKE_CUA_LOG = logPath;
	const harness = makeHarness();
	const result = registerCuaTools(harness.ctx, {}, { defineTool: (definition) => definition, AttachmentId: (value) => value, version: "test" });
	return { ...harness, result, logPath, dir };
}

/** 读假驱动收到的调用日志。 */
function calls(logPath) {
	if (existsSync(logPath) === false) return [];
	return readFileSync(logPath, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
}

function lastCall(logPath, tool) {
	const matches = calls(logPath).filter((entry) => entry.command === "call" && entry.tool === tool);
	return matches.at(-1);
}

function cleanup(dir) {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.DSH_OPERATOR_CUA_BIN;
	delete process.env.DSH_OPERATOR_CUA;
	delete process.env.FAKE_CUA_LOG;
	delete process.env.FAKE_CUA_RUN_STEPS;
	delete process.env.FAKE_CUA_GWS_FAIL;
}

test("找不到 cua-driver 时不注册任何工具（静默降级）", () => {
	const previous = { HOME: process.env.HOME, PATH: process.env.PATH };
	const home = mkdtempSync(join(tmpdir(), "cua-tools-home-"));
	process.env.HOME = home;
	process.env.PATH = "";
	const { definitions, result, dir } = setup({ bin: "/nonexistent/cua-driver" });
	cleanup(dir);
	rmSync(home, { recursive: true, force: true });
	process.env.HOME = previous.HOME;
	process.env.PATH = previous.PATH;
	assert.equal(result.registered, false);
	assert.equal(definitions.size, 0);
});

test("DSH_OPERATOR_CUA=0 不注册任何工具", () => {
	const { definitions, result, dir } = setup({ disable: true });
	cleanup(dir);
	assert.equal(result.registered, false);
	assert.equal(definitions.size, 0);
});

test("cua_windows：列窗口 + 前台窗口 + 显示器", async () => {
	const { definitions, dir, logPath } = setup();
	const tool = definitions.get("cua_windows");
	assert.ok(tool);
	const output = await tool.execute({}, {});
	const logged = lastCall(logPath, "list_windows");
	cleanup(dir);
	assert.equal(output.schemaVersion, 1);
	assert.match(output.text, /windows="1"/);
	assert.match(output.text, /frontmost window_id="7" pid="4242" app="FakeApp" title="Fake Report"/);
	assert.match(output.text, /<display index="0" primary="true" scale="2">1512x982<\/display>/);
	assert.ok(logged);
});

test("cua_observe：纯 AX 树输出 element_token 行", async () => {
	const { definitions, dir, saved } = setup();
	const tool = definitions.get("cua_observe");
	const output = await tool.execute({ window_id: 7, include_screenshot: false }, {});
	cleanup(dir);
	assert.match(output.text, /snapshot_id="s00000004"/);
	assert.match(output.text, /AXButton "Done"/);
	assert.ok(!("image" in output), "无截图时不应出现 image 字段（lossless JSON）");
	assert.ok(!("note" in output), "无 note 时不应出现 note 字段（lossless JSON）");
	assert.equal(saved.length, 0);
});

test("cua_observe：截图附件走 saveImage，并写 screenshot_out_file", async () => {
	const { definitions, dir, saved, logPath } = setup();
	const tool = definitions.get("cua_observe");
	const output = await tool.execute({ window_id: 7, include_screenshot: true }, {});
	const gws = lastCall(logPath, "get_window_state");
	cleanup(dir);
	assert.ok(output.image);
	assert.equal(output.image.attachmentId, "att-1");
	assert.equal(output.image.width, 1);
	assert.equal(output.image.height, 1);
	assert.equal(saved.length, 1);
	assert.equal(saved[0].mediaType, "image/jpeg");
	assert.ok(typeof gws.payload.screenshot_out_file === "string");
	assert.equal(gws.payload.tree_format, "markdown", "默认请求 markdown 树（elements 数组无树文本）");
});

test("cua_observe：tree_format=elements 时用数组兜底渲染", async () => {
	process.env.FAKE_CUA_TREE_FORMAT_ELEMENTS = "1";
	const { definitions, dir } = setup();
	const tool = definitions.get("cua_observe");
	const output = await tool.execute({ window_id: 7, include_screenshot: false }, {});
	delete process.env.FAKE_CUA_TREE_FORMAT_ELEMENTS;
	cleanup(dir);
	assert.match(output.text, /\[1\] AXButton \(Done\)/);
	assert.match(output.text, /tree_partial reason="max_elements"/);
});

test("cua_observe：TCC 挡住截图时退回纯 AX 并给提示", async () => {
	process.env.FAKE_CUA_GWS_FAIL = "direct_capture_consent_required";
	const { definitions, dir } = setup();
	const tool = definitions.get("cua_observe");
	const output = await tool.execute({ window_id: 7, include_screenshot: true }, {});
	cleanup(dir);
	assert.match(output.note ?? "", /permissions grant/);
	assert.ok(!("image" in output), "TCC 退回时不应出现 image 字段（lossless JSON）");
	assert.match(output.text, /AXButton "Done"/);
});

test("cua_act：element_token 点击映射到 click + background", async () => {
	const { definitions, dir, logPath } = setup();
	const tool = definitions.get("cua_act");
	const output = await tool.execute({ window_id: 7, action: "click", element_token: "s00000004:1" }, {});
	const runSteps = lastCall(logPath, "run_steps").payload;
	cleanup(dir);
	assert.equal(output.ok, true);
	assert.match(output.text, /action="click" delivery="background" ok="true"/);
	assert.equal(runSteps.steps[0].tool, "click");
	assert.equal(runSteps.steps[0].args.element_token, "s00000004:1");
	assert.equal(runSteps.delivery_mode, "background");
	assert.ok(runSteps.observe);
});

test("cua_act：count=2 映射 double_click、button=right 映射 right_click", async () => {
	const { definitions, dir, logPath } = setup();
	const tool = definitions.get("cua_act");
	await tool.execute({ window_id: 7, action: "click", x: 30, y: 40, count: 2 }, {});
	assert.equal(lastCall(logPath, "run_steps").payload.steps[0].tool, "double_click");
	await tool.execute({ window_id: 7, action: "click", x: 30, y: 40, button: "right" }, {});
	assert.equal(lastCall(logPath, "run_steps").payload.steps[0].tool, "right_click");
	cleanup(dir);
});

test("cua_act：type_text / hotkey / scroll / drag / set_value 映射", async () => {
	const { definitions, dir, logPath } = setup();
	const tool = definitions.get("cua_act");
	const cases = [
		{ args: { action: "type_text", element_token: "s00000004:1", text: "hello" }, tool: "type_text" },
		{ args: { action: "hotkey", keys: ["cmd", "c"] }, tool: "hotkey" },
		{ args: { action: "scroll", direction: "down", element_token: "s00000004:0", amount: 3 }, tool: "scroll" },
		{ args: { action: "drag", from_x: 1, from_y: 2, to_x: 30, to_y: 40, duration_ms: 700 }, tool: "drag" },
		{ args: { action: "set_value", element_token: "s00000004:1", value: "chosen" }, tool: "set_value" }
	];
	for (const item of cases) {
		await tool.execute({ window_id: 7, ...item.args }, {});
		assert.equal(lastCall(logPath, "run_steps").payload.steps[0].tool, item.tool);
	}
	cleanup(dir);
});

test("cua_act：background_unavailable 失败时附 fallback_foreground 提示", async () => {
	process.env.FAKE_CUA_RUN_STEPS = JSON.stringify({
		ok: false,
		steps: [{ ok: false, error: "background_unavailable: drag_and_drop_session" }],
		observe: void 0
	});
	const { definitions, dir } = setup();
	const tool = definitions.get("cua_act");
	const output = await tool.execute({ window_id: 7, action: "drag", from_x: 1, from_y: 2, to_x: 20, to_y: 30 }, {});
	cleanup(dir);
	assert.equal(output.ok, false);
	assert.match(output.hint ?? "", /fallback_foreground/);
});

test("cua_act：缺动作参数时报错信息可行动", async () => {
	const { definitions, dir } = setup();
	const tool = definitions.get("cua_act");
	await assert.rejects(() => tool.execute({ window_id: 7, action: "type_text", element_token: "s00000004:1" }, {}), /type_text 需要 text/);
	await assert.rejects(() => tool.execute({ window_id: 7, action: "click" }, {}), /需要 element_token、role\/name/);
	await assert.rejects(() => tool.execute({ window_id: 7, action: "move_mouse" }, {}), /action 只能是/);
	cleanup(dir);
});

test("未知 window_id 报错并提示先 cua_windows", async () => {
	const { definitions, dir } = setup();
	const tool = definitions.get("cua_act");
	await assert.rejects(() => tool.execute({ window_id: 999, action: "click", element_token: "x:1" }, {}), /先调用 cua_windows/);
	cleanup(dir);
});
