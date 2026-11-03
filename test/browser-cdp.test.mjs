import assert from "node:assert/strict";
import { test } from "node:test";

import {
	CDP_UNAVAILABLE_HINT,
	cdpTargets,
	cdpVersion,
	collectConsole,
	collectNetwork,
	consoleEntryLevel,
	isFailureStatus,
	pickTarget,
	readInteractiveText,
	readPageText,
	summarizeConsoleEntry,
	summarizeNetworkEntry,
	waitForNetworkIdle,
	waitForSelector,
	waitForText
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

test("readPageText：selector 只拼到固定骨架里、转义安全", async () => {
	const sent = [];
	const client = { send: async (method, params) => { sent.push({ method, params }); return { result: { value: "  main text  " } }; } };
	const out = await readPageText(client, { selector: "main #x" });
	assert.equal(out.ok, true);
	assert.equal(out.text, "main text");
	assert.match(sent[0].params.expression, /document\.querySelector\("main #x"\)/);
	const quoted = await readPageText(client, { selector: "a[title=\"x\"]" });
	assert.equal(quoted.ok, true);
	assert.match(sent[1].params.expression, /a\[title=/);
});


test("waitForText 命中即返回，文本走 JSON 转义", async () => {
	const seen = [];
	const client = {
		async send(method, params) {
			seen.push(params?.expression ?? "");
			return { result: { value: { found: true } } };
		}
	};
	const result = await waitForText(client, '他说"好了"', { timeoutMs: 1500, intervalMs: 100 });
	assert.equal(result.ok, true);
	assert.match(seen[0], /includes\("他说\\"好了\\""\)/);
});

test("waitForText 超时给可读错误", async () => {
	const client = fakeClient([{ found: false }]);
	const result = await waitForText(client, "永不出现", { timeoutMs: 800, intervalMs: 100 });
	assert.equal(result.ok, false);
	assert.match(String(result.error), /等文本超时/);
});


test("consoleEntryLevel：异常/assert 算 error，Log.warning 算 warning", () => {
	assert.equal(consoleEntryLevel({ kind: "exception", text: "x" }), "error");
	assert.equal(consoleEntryLevel({ kind: "console", type: "assert", args: [] }), "error");
	assert.equal(consoleEntryLevel({ kind: "console", type: "warning", args: [] }), "warning");
	assert.equal(consoleEntryLevel({ kind: "log", level: "warning", text: "w" }), "warning");
	assert.equal(consoleEntryLevel({ kind: "log", level: "error", text: "e" }), "error");
	assert.equal(consoleEntryLevel(null), "error");
});


test("readInteractiveText：固定表达式、按 maxChars 截断", async () => {
	const sent = [];
	const client = {
		send: async (method, params) => {
			sent.push({ method, params });
			return { result: { value: "a · Learn more\nbutton · 提交" } };
		}
	};
	const ok = await readInteractiveText(client, { maxChars: 200 });
	assert.equal(ok.ok, true);
	assert.match(ok.text, /Learn more/);
	assert.equal(sent[0].method, "Runtime.evaluate");
	const expression = sent[0].params.expression;
	assert.match(expression, /querySelectorAll/);
	assert.match(expression, /role="button"/);
	assert.doesNotMatch(expression, /eval\(/);
});


// 0.86.0：网络摘要不能把 token 查询串带进上下文
import { redactUrl } from "../lib/browser-cdp.js";

test("redactUrl：掩码敏感查询参数，保留普通参数", () => {
	assert.equal(redactUrl("https://x.test/a?access_token=abc123&page=2"), "https://x.test/a?access_token=<redacted>&page=2");
	assert.equal(redactUrl("https://x.test/a?code=SECRET"), "https://x.test/a?code=<redacted>");
	assert.equal(redactUrl("https://x.test/a"), "https://x.test/a");
});

// 第三轮只读审计（2026-11-03）M4 / M9 回归
test("readPageText：页面 JS 抛错不能当成「没有可见文本」（M9）", async () => {
	const client = {
		send: async () => ({ exceptionDetails: { text: "SyntaxError", exception: { description: "SyntaxError: bad selector" } } })
	};
	const result = await readPageText(client, {});
	assert.equal(result.ok, false);
	assert.match(String(result.error), /SyntaxError|执行出错/);
});

test("readPageText：选择器没命中与元素为空要分开报（M9）", async () => {
	const missing = { send: async () => ({ result: { value: null } }) };
	const missResult = await readPageText(missing, { selector: "#nope" });
	assert.equal(missResult.ok, false);
	assert.match(String(missResult.error), /没有命中/);
	const empty = { send: async () => ({ result: { value: "" } }) };
	const emptyResult = await readPageText(empty, { selector: "#empty" });
	assert.equal(emptyResult.ok, true, "元素存在但内容为空，仍算读取成功");
});

test("collectConsole：reload 期间的报错也要收到（先挂监听再 reload，M4）", async () => {
	const listeners = [];
	const client = {
		async send(method) {
			if (method === "Page.reload") {
				// 模拟「reload 刚开始就报错」：此时监听必须已经挂上
				for (const listener of [...listeners]) {
					listener({ method: "Runtime.consoleAPICalled", params: { type: "error", args: [{ value: "boom at load" }] } });
				}
			}
			return {};
		},
		on(fn) {
			listeners.push(fn);
			return () => listeners.splice(listeners.indexOf(fn), 1);
		}
	};
	const collected = await collectConsole(client, { durationMs: 150, reload: true });
	assert.equal(collected.entries.length, 1, "加载期报错不能因为监听晚了而消失");
});

test("collectConsole / collectNetwork：reload 失败要如实报错（M4）", async () => {
	const client = {
		async send(method) {
			if (method === "Page.reload") throw new Error("Page.reload failed");
			return {};
		},
		on() {
			return () => {};
		}
	};
	const consoleResult = await collectConsole(client, { durationMs: 120, reload: true });
	assert.equal(consoleResult.reloadError, "Page.reload failed");
	const networkResult = await collectNetwork(client, { durationMs: 120, reload: true });
	assert.equal(networkResult.reloadError, "Page.reload failed");
});

// 审计 L2：重定向复用 requestId 不能让在途计数泄漏
test("waitForNetworkIdle：同一 requestId 的重定向不留下在途请求（L2）", async () => {
	const listeners = [];
	let evaluated = 0;
	const client = {
		async send(method) {
			if (method === "Runtime.evaluate") {
				evaluated += 1;
				if (evaluated === 1) {
					// 模拟重定向：两次 requestWillBeSent 共用一个 requestId，最后只完成一次
					for (const listener of [...listeners]) {
						listener({ method: "Network.requestWillBeSent", params: { requestId: "R1" } });
						listener({ method: "Network.requestWillBeSent", params: { requestId: "R1" } });
						listener({ method: "Network.loadingFinished", params: { requestId: "R1" } });
					}
				}
				return { result: { value: "complete" } };
			}
			return {};
		},
		on(fn) {
			listeners.push(fn);
			return () => listeners.splice(listeners.indexOf(fn), 1);
		}
	};
	const waited = await waitForNetworkIdle(client, { timeoutMs: 1500, idleMs: 100 });
	assert.equal(waited.ok, true, "重定向场景不应永远超时");
	assert.equal(waited.readyState, "complete");
});
