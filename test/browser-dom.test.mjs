import assert from "node:assert/strict";
import { test } from "node:test";

import {
	APPLESCRIPT_DISABLED_HINT,
	buildAppleScriptEval,
	buildClickScript,
	buildFillScript,
	buildSnapshotScript,
	cdpConnect,
	clickDom,
	escapeAppleScriptString,
	evalAppleScriptDom,
	fillDom,
	parseDevToolsActivePort,
	probeAppleScriptDom,
	readDomSnapshot
} from "../lib/browser-dom.js";

function fakeRunner({ ok = true, stdout = "", stderr = "", error = "" } = {}) {
	return (command, args) => {
		assert.equal(command, "/usr/bin/osascript");
		assert.equal(args[0], "-e");
		return Promise.resolve({ ok, stdout, stderr, error });
	};
}

test("browser-dom：AppleScript 字符串转义与单行化", () => {
	assert.equal(escapeAppleScriptString('a"b'), 'a\\"b');
	assert.equal(escapeAppleScriptString("a\\b"), "a\\\\b");
	assert.equal(escapeAppleScriptString("line1\nline2\r\nline3"), "line1 line2 line3");
	const script = buildAppleScriptEval('JSON.stringify(1)');
	assert.match(script, /^tell application "Google Chrome" to execute front window's active tab javascript "/);
	const safari = buildAppleScriptEval('document.title', "Safari");
	assert.match(safari, /^tell application "Safari"/);
});

test("browser-dom：快照脚本只读且带上限", () => {
	const script = buildSnapshotScript({ maxText: 1234, maxLinks: 7, maxInteractive: 9 });
	assert.match(script, /1234/);
	assert.match(script, /a\[href\]/);
	assert.match(script, /input, select, textarea/);
	assert.equal(script.includes("innerHTML"), false);
});

test("browser-dom：点击/填表脚本正确转义选择器与文本", () => {
	const click = buildClickScript({ text: 'Say "hi"' });
	assert.match(click, /Say \\"hi\\"/);
	const fill = buildFillScript({ selector: 'input[name="q"]', value: 'a"b' });
	assert.match(fill, /input\[name=\\"q\\"\]/);
	assert.match(fill, /dispatchEvent/);
});

test("browser-dom：probeAppleScriptDom 识别三种状态", async () => {
	const enabled = await probeAppleScriptDom({ runner: fakeRunner({ ok: true, stdout: '{"title":"t"}' }) });
	assert.deepEqual(enabled, { available: true, reason: "ok" });

	const disabled = await probeAppleScriptDom({
		runner: fakeRunner({ ok: false, stderr: "通过 AppleScript 执行 JavaScript 的功能已关闭。" })
	});
	assert.equal(disabled.available, false);
	assert.equal(disabled.reason, "disabled");
	assert.equal(disabled.hint, APPLESCRIPT_DISABLED_HINT);

	const broken = await probeAppleScriptDom({ runner: fakeRunner({ ok: false, stderr: "syntax error" }) });
	assert.equal(broken.available, false);
	assert.equal(broken.reason, "error");
});

test("browser-dom：eval/read/click/fill 走同一 Runner 且解析 JSON", async () => {
	const ok = fakeRunner({ ok: true, stdout: '{"url":"https://x","title":"T","text":"hello","links":[]}' });
	const evaluated = await evalAppleScriptDom({ js: "1", runner: ok });
	assert.equal(evaluated.ok, true);
	assert.match(evaluated.value, /https:\/\/x/);

	const snapshot = await readDomSnapshot({ runner: ok });
	assert.equal(snapshot.title, "T");

	const click = await clickDom({ runner: fakeRunner({ ok: true, stdout: '{"ok":true,"how":"text"}' }), text: "登录" });
	assert.equal(click.ok, true);

	const fill = await fillDom({ runner: fakeRunner({ ok: true, stdout: '{"ok":true,"valueLength":3}' }), selector: "#q", value: "abc" });
	assert.equal(fill.valueLength, 3);

	const disabled = await evalAppleScriptDom({ js: "1", runner: fakeRunner({ ok: false, stderr: "JavaScript from Apple Events" }) });
	assert.equal(disabled.code, "disabled");
	assert.equal(disabled.hint, APPLESCRIPT_DISABLED_HINT);

	await assert.rejects(() => readDomSnapshot({ runner: fakeRunner({ ok: true, stdout: "not-json" }) }), /non-JSON/);
});

test("browser-dom：DevToolsActivePort 解析", () => {
	assert.deepEqual(parseDevToolsActivePort("9222\n/devtools/browser/abc"), { port: 9222, wsPath: "/devtools/browser/abc" });
	assert.deepEqual(parseDevToolsActivePort("1234\n"), { port: 1234, wsPath: "/devtools/browser" });
	assert.equal(parseDevToolsActivePort(""), null);
	assert.equal(parseDevToolsActivePort("not-a-port\nx"), null);
});

test("browser-dom：CDP 连接在 Node 22+ 可用（类型自检，不连网）", async (t) => {
	if (typeof WebSocket !== "function") {
		t.diagnostic(`skipped: Node ${process.version} 无全局 WebSocket（CI 的 Node 20 正常）`);
		await assert.rejects(() => cdpConnect("ws://127.0.0.1:1/x"), /WebSocket unavailable/);
		return;
	}
	await assert.rejects(() => cdpConnect("ws://127.0.0.1:1/devtools/browser/none"), /CDP connect failed|ECONNREFUSED|error/i);
});
