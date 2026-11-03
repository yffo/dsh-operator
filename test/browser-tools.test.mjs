import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { configureAuditLog } from "../lib/audit-log.js";
import { configureOperatorToolsInternals, registerOperatorTools, resetOperatorToolsInternals } from "../lib/operator-tools.js";

const darwin = process.platform === "darwin";
let auditPath;
let dir;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dsh-operator-browser-tools-"));
	auditPath = join(dir, "audit.jsonl");
	configureAuditLog({ path: auditPath });
	resetOperatorToolsInternals();
});

afterEach(() => {
	resetOperatorToolsInternals();
	configureAuditLog({ enabled: true });
	rmSync(dir, { recursive: true, force: true });
});

const exec = { signal: new AbortController().signal };

function setup({ osascript, config = {} } = {}) {
	const tools = {};
	const ctx = { tools: { register: (tool) => { tools[tool.name] = tool; } } };
	configureOperatorToolsInternals(osascript ? { osascript } : {});
	registerOperatorTools(ctx, { axMaxNodes: 120, guard: true, failureSamples: false, ...config }, {
		backend: { listScreens: async () => [] },
		defineTool: (definition) => definition
	});
	return tools;
}

function runnerReturning(payload) {
	return (command, args) => {
		assert.equal(command, "/usr/bin/osascript");
		assert.equal(args[0], "-e");
		return Promise.resolve({ ok: true, stdout: typeof payload === "string" ? payload : JSON.stringify(payload), stderr: "", error: "" });
	};
}

test("browser_dom_snapshot：解析快照并格式化 links/interactive", async (t) => {
	if (!darwin) return t.diagnostic("skipped: darwin only");
	const tools = setup({
		osascript: runnerReturning({
			url: "https://example.com",
			title: "Example",
			ready: "complete",
			text: "hello world",
			links: [{ text: "Docs", href: "https://example.com/docs" }],
			interactive: [{ tag: "button", role: "", type: "", label: "登录", disabled: false }]
		})
	});
	const value = await tools.browser_dom_snapshot.execute({ browser: "Google Chrome" }, exec);
	assert.equal(value.ok, true);
	assert.equal(value.available, true);
	assert.equal(value.title, "Example");
	assert.deepEqual(value.links, ["Docs -> https://example.com/docs"]);
	assert.match(value.interactive[0], /button: 登录/);
});

test("browser_dom_snapshot：通道关闭时返回 available:false + hint", async (t) => {
	if (!darwin) return t.diagnostic("skipped: darwin only");
	const disabled = () => Promise.resolve({ ok: false, stdout: "", stderr: "通过 AppleScript 执行 JavaScript 的功能已关闭。", error: "" });
	const tools = setup({ osascript: disabled });
	const value = await tools.browser_dom_snapshot.execute({}, exec);
	assert.equal(value.ok, false);
	assert.equal(value.available, false);
	assert.equal(value.reason, "disabled");
	assert.match(value.hint, /允许 Apple 事件中的 JavaScript/);
});

test("browser_dom_click：普通文本可点，破坏性文本需 confirm", async (t) => {
	if (!darwin) return t.diagnostic("skipped: darwin only");
	const tools = setup({ osascript: runnerReturning({ ok: true, how: "text", matched: "登录" }) });
	const normal = await tools.browser_dom_click.execute({ text: "登录" }, exec);
	assert.equal(normal.ok, true);
	assert.equal(normal.how, "text");

	const guarded = await tools.browser_dom_click.execute({ text: "删除账号" }, exec);
	assert.equal(guarded.ok, false);
	assert.match(guarded.error, /guarded/);

	const allowed = await tools.browser_dom_click.execute({ text: "删除账号", confirm: true }, exec);
	assert.equal(allowed.ok, true);

	const empty = await tools.browser_dom_click.execute({}, exec);
	assert.equal(empty.ok, false);
	assert.match(empty.error, /required/);
});

test("browser_dom_fill：成功返回长度，密码框由页面侧拒绝", async (t) => {
	if (!darwin) return t.diagnostic("skipped: darwin only");
	const okTools = setup({ osascript: runnerReturning({ ok: true, valueLength: 3 }) });
	const filled = await okTools.browser_dom_fill.execute({ selector: "#q", value: "abc" }, exec);
	assert.equal(filled.ok, true);
	assert.equal(filled.valueLength, 3);

	const refusedTools = setup({ osascript: runnerReturning({ ok: false, reason: "password field refused" }) });
	const refused = await refusedTools.browser_dom_fill.execute({ selector: "input[type=password]", value: "x" }, exec);
	assert.equal(refused.ok, false);
	assert.match(refused.reason, /password/);
});

test("browser_dom_snapshot：AppleScript 关闭时按 browserCdpPort 回退 CDP", async (t) => {
	if (!darwin) return t.diagnostic("skipped: darwin only");
	const disabled = () => Promise.resolve({ ok: false, stdout: "", stderr: "通过 AppleScript 执行 JavaScript 的功能已关闭。", error: "" });
	const tools = setup({
		osascript: disabled,
		config: { browserCdpPort: 9222 },
		internals: {}
	});
	// 注入 CDP 假实现：setup 里还没接 internals，这里覆盖
	configureOperatorToolsInternals({
		cdpSnapshot: async ({ port }) => {
			assert.equal(port, 9222);
			return { url: "https://example.com/cdp", title: "CDP page", text: "cdp text", links: [], interactive: [] };
		}
	});
	const value = await tools.browser_dom_snapshot.execute({}, exec);
	assert.equal(value.ok, true);
	assert.equal(value.backend, "cdp");
	assert.equal(value.title, "CDP page");
});

test("browser_dom_probe：报告 AppleScript 与 CDP 两个通道状态", async (t) => {
	if (!darwin) return t.diagnostic("skipped: darwin only");
	const tools = setup({
		osascript: () => Promise.resolve({ ok: false, stdout: "", stderr: "通过 AppleScript 执行 JavaScript 的功能已关闭。", error: "" }),
		config: { browserCdpPort: 9222 }
	});
	configureOperatorToolsInternals({
		cdpProbe: async ({ port }) => {
			assert.equal(port, 9222);
			return { available: true, reason: "ok", browser: "Chrome/140" };
		}
	});
	const value = await tools.browser_dom_probe.execute({}, exec);
	assert.equal(value.ok, true);
	assert.equal(value.applescript.available, false);
	assert.equal(value.applescript.reason, "disabled");
	assert.equal(value.cdp.available, true);
	assert.equal(value.cdp.browser, "Chrome/140");
	assert.equal(value.browserCdpPort, 9222);
});

test("browser_dom_snapshot：通道 disabled 不写入失败样本（软不可用）", async (t) => {
	if (!darwin) return t.diagnostic("skipped: darwin only");
	const { configureFailureStore, digestFailures } = await import("../lib/failure-store.js");
	const failDir = join(dir, "failures");
	configureFailureStore({ dir: failDir });
	const disabled = () => Promise.resolve({ ok: false, stdout: "", stderr: "通过 AppleScript 执行 JavaScript 的功能已关闭。", error: "" });
	const tools = setup({ osascript: disabled, config: { failureSamples: true } });
	const value = await tools.browser_dom_snapshot.execute({}, exec);
	assert.equal(value.available, false);
	assert.equal(value.reason, "disabled");
	const digest = digestFailures({ dir: failDir });
	assert.equal(digest.total, 0);
	configureFailureStore({});
});
