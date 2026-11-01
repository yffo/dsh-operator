import assert from "node:assert/strict";
import { test } from "node:test";

import {
	CDP_UNAVAILABLE_HINT,
	cdpTargets,
	cdpVersion,
	isFailureStatus,
	pickTarget,
	summarizeConsoleEntry,
	summarizeNetworkEntry
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
