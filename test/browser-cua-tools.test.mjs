import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";

import { configureAuditLog } from "../lib/audit-log.js";
import {
	BROWSER_TOOL_NAMES,
	compactJson,
	hintForBrowserError,
	registerBrowserTools,
	summarizeState
} from "../lib/browser-cua-tools.js";

let dir;
let fakeBin;
const previousBin = process.env.DSH_OPERATOR_CUA_BIN;
const previousOff = process.env.DSH_OPERATOR_BROWSER;

before(() => {
	dir = mkdtempSync(join(tmpdir(), "dsh-operator-browser-cua-"));
	fakeBin = join(dir, "cua-driver");
	writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n");
	chmodSync(fakeBin, 0o755);
	process.env.DSH_OPERATOR_CUA_BIN = fakeBin;
	delete process.env.DSH_OPERATOR_BROWSER;
	configureAuditLog({ enabled: false });
});

afterEach(() => {
	delete process.env.DSH_OPERATOR_BROWSER;
});

after(() => {
	if (previousBin === undefined) delete process.env.DSH_OPERATOR_CUA_BIN;
	else process.env.DSH_OPERATOR_CUA_BIN = previousBin;
	if (previousOff === undefined) delete process.env.DSH_OPERATOR_BROWSER;
	else process.env.DSH_OPERATOR_BROWSER = previousOff;
	configureAuditLog({ enabled: true });
	rmSync(dir, { recursive: true, force: true });
});

function setup() {
	const tools = {};
	const ctx = { tools: { register: (tool) => { tools[tool.name] = tool; } } };
	const handle = registerBrowserTools(ctx, {}, { defineTool: (definition) => definition, version: "0.24.0" });
	return { tools, handle };
}

test("注册 7 个 browser_* 工具，schema 与 execute 齐备", () => {
	const { tools, handle } = setup();
	assert.equal(handle.registered, true);
	assert.deepEqual(handle.names, [...BROWSER_TOOL_NAMES]);
	assert.equal(Object.keys(tools).length, BROWSER_TOOL_NAMES.length);
	for (const name of BROWSER_TOOL_NAMES) {
		assert.equal(typeof tools[name].description, "string");
		assert.ok(tools[name].description.length > 20);
		assert.equal(typeof tools[name].execute, "function");
		assert.equal(typeof tools[name].parameters, "object");
	}
});

test("DSH_OPERATOR_BROWSER=0 时不注册", () => {
	process.env.DSH_OPERATOR_BROWSER = "0";
	const { tools, handle } = setup();
	assert.equal(handle.registered, false);
	assert.equal(handle.reason, "disabled");
	assert.equal(Object.keys(tools).length, 0);
});

test("hintForBrowserError 把拒绝码翻成人话", () => {
	assert.match(hintForBrowserError("refused: browser_consent_required"), /browser_state/);
	assert.match(hintForBrowserError("browser_requires_setup: call browser_prepare"), /foreground/);
	assert.match(hintForBrowserError("background_unavailable"), /foreground/);
	assert.match(hintForBrowserError("stale ref p1:3"), /browser_state/);
	assert.equal(hintForBrowserError("unrelated failure"), undefined);
});

test("summarizeState 汇总 tab 与 target", () => {
	const text = summarizeState({
		target_id: "t1",
		tab_id: "tab-2",
		tabs: [
			{ tab_id: "tab-1", title: "首页", url: "https://example.com/", active: false },
			{ tab_id: "tab-2", title: "登录", url: "https://example.com/login", active: true }
		],
		outline: "button 登录"
	});
	assert.match(text, /target_id=t1/);
	assert.match(text, /tab_id=tab-2/);
	assert.match(text, /tab-2 \(active\): 登录/);
	assert.match(text, /button 登录/);
});

test("summarizeState 兜底为紧凑 JSON", () => {
	assert.match(summarizeState({ foo: "bar" }), /"foo":"bar"/);
});

test("compactJson 超长时截断并提示", () => {
	const text = compactJson({ blob: "x".repeat(50) }, 20);
	assert.ok(text.length < 120);
	assert.match(text, /已截断/);
});

test("browser_open 拒绝非 http(s) 协议", async () => {
	const { tools } = setup();
	const value = await tools.browser_open.execute({ url: "file:///etc/passwd" }, {});
	assert.equal(value.ok, false);
	assert.match(value.text, /http/);
});

test("browser_state 缺参时给出明确提示", async () => {
	const { tools } = setup();
	const value = await tools.browser_state.execute({}, {});
	assert.equal(value.ok, false);
	assert.match(value.text, /pid\+window_id|target_id/);
});

test("browser_select 要求 ref 且 label/value 二选一", async () => {
	const { tools } = setup();
	const missing = await tools.browser_select.execute({ ref: "p1:2" }, {});
	assert.equal(missing.ok, false);
	const both = await tools.browser_select.execute({ ref: "p1:2", label: "a", value: "b" }, {});
	assert.equal(both.ok, false);
});
