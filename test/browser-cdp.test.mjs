import assert from "node:assert/strict";
import { test } from "node:test";

import {
	CDP_UNAVAILABLE_HINT,
	cdpTargets,
	cdpVersion,
	isFailureStatus,
	pickTarget,
	readPageText,
	summarizeConsoleEntry,
	summarizeNetworkEntry,
	waitForSelector
} from "../lib/browser-cdp.js";

const targets = [
	{ id: "a", type: "page", url: "https://example.com/", title: "Example", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/a" },
	{ id: "b", type: "page", url: "https://example.com/docs", title: "Docs", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/b" },
	{ id: "c", type: "service_worker", url: "https://example.com/sw.js", title: "", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/c" }
];

test("isFailureStatus 只看 4xx/5xx", () => {
	assert.equal(isFailureStatus(204), false);
	assert.equal(isFailureStatus(404), true);
	assert.equal(isFailureStatus(503), true);
	assert.equal(isFailureStatus(undefined), false);
});

test("pickTarget 按 url/title/index 过滤，忽略非 page target", () => {
	assert.equal(pickTarget(targets).id, "a");
	assert.equal(pickTarget(targets, { urlContains: "docs" }).id, "b");
	assert.equal(pickTarget(targets, { titleContains: "Docs" }).id, "b");
	assert.equal(pickTarget(targets, { index: 1 }).id, "b");
	assert.equal(pickTarget(targets, { urlContains: "missing" }), undefined);
	assert.equal(pickTarget([targets[2]]), undefined);
});

test("summarizeConsoleEntry 压成一行", () => {
	assert.equal(summarizeConsoleEntry({ kind: "exception", text: "boom" }), "异常: boom");
	assert.match(summarizeConsoleEntry({ kind: "log", level: "error", text: "nope" }), /^error: nope/);
	assert.match(summarizeConsoleEntry({ type: "error", args: [{ value: "x" }, { description: "y" }] }), /^error: x y/);
});

test("summarizeNetworkEntry 带状态与失败原因", () => {
	assert.equal(summarizeNetworkEntry({ method: "POST", url: "https://a/b", status: 500 }), "POST https://a/b 500");
	assert.match(summarizeNetworkEntry({ url: "https://a/c", errorText: "net::ERR_FAILED" }), /net::ERR_FAILED/);
});

test("cdpVersion/cdpTargets 连不上时返回 ok:false 而不是抛错", async () => {
	const version = await cdpVersion(1, { timeoutMs: 800 });
	assert.equal(version.ok, false);
	const listed = await cdpTargets(1, { timeoutMs: 800 });
	assert.equal(listed.ok, false);
	assert.match(CDP_UNAVAILABLE_HINT, /remote-debugging-port/);
});

function fakeClient(sequence) {
	let calls = 0;
	return {
		sent: [],
		async send(method, params) {
			this.sent.push(method);
			const value = sequence[Math.min(calls, sequence.length - 1)];
			calls += 1;
			if (method !== "Runtime.evaluate") return { result: {} };
			return { result: { value } };
		}
	};
}

test("waitForSelector 命中即返回，选择器走 JSON 转义", async () => {
	const client = fakeClient([{ found: true, visible: true }]);
	const result = await waitForSelector(client, 'a[href="x"]', { timeoutMs: 2000 });
	assert.equal(result.ok, true);
	assert.equal(result.found, true);
	assert.equal(result.visible, true);
});

test("waitForSelector 先把选择器安全嵌进固定表达式", async () => {
	const seen = [];
	const client = {
		async send(method, params) {
			seen.push(params?.expression ?? "");
			return { result: { value: { found: false } } };
		}
	};
	await waitForSelector(client, 'x"y', { timeoutMs: 1000, intervalMs: 100 });
	assert.match(seen[0], /document\.querySelector\("x\\"y"\)/);
});

test("waitForSelector 要 visible 时等到可见才成功", async () => {
	const client = fakeClient([{ found: true, visible: false }, { found: true, visible: true }]);
	const result = await waitForSelector(client, "#ok", { timeoutMs: 3000, visible: true, intervalMs: 100 });
	assert.equal(result.ok, true);
	assert.equal(result.visible, true);
});

test("waitForSelector 超时给可读错误", async () => {
	const client = fakeClient([{ found: false }]);
	const result = await waitForSelector(client, "#never", { timeoutMs: 1000, intervalMs: 100 });
	assert.equal(result.ok, false);
	assert.match(result.error, /等待选择器超时/);
	assert.equal(result.elapsedMs >= 900, true);
});

test("readPageText：只跑固定表达式、规范化空白、按 maxChars 截断", async () => {
	const sent = [];
	const value = `  Hello\r\n\n\n\nWorld ${"x".repeat(300)}  `;
	const client = {
		send: async (method, params) => {
			sent.push({ method, params });
			return { result: { value } };
		}
	};
	const ok = await readPageText(client, { maxChars: 200 });
	assert.equal(ok.ok, true);
	assert.equal(sent[0].method, "Runtime.evaluate");
	assert.match(sent[0].params.expression, /document\.body/);
	assert.equal(ok.text.startsWith("Hello\n\nWorld"), true);
	assert.equal(ok.text.length, 200);
	assert.equal(ok.truncated, true);
});

test("readPageText：CDP 报错时返回 ok:false", async () => {
	const client = { send: async () => { throw new Error("CDP Runtime.evaluate timeout"); } };
	const failed = await readPageText(client, {});
	assert.equal(failed.ok, false);
	assert.match(failed.error, /读取页面文本失败/);
});
