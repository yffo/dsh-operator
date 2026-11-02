import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIPBOARD_TOOL_NAMES, clampClipboardText, clipboardFileScript, registerClipboardTools } from "../lib/clipboard-tools.js";

function harness(run) {
	const tools = [];
	const ctx = { tools: { register: (def) => tools.push(def) } };
	registerClipboardTools(ctx, {}, { defineTool: (def) => def, version: "test", run });
	const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
	return { tools, byName };
}

test("注册两个剪贴板工具", () => {
	const { byName } = harness(async () => ({ ok: true, stdout: "", stderr: "" }));
	assert.deepEqual(Object.keys(byName).sort(), [...CLIPBOARD_TOOL_NAMES].sort());
});

test("读取文本并截断", async () => {
	const { byName } = harness(async () => ({ ok: true, stdout: "abcdef", stderr: "" }));
	const value = await byName.clipboard_read.execute({ max_chars: 3 });
	assert.match(value.text, /3 chars \(truncated\)/);
	assert.match(value.text, /abc$/);
});

test("读取时空剪贴板也有明确结果", async () => {
	const { byName } = harness(async () => ({ ok: true, stdout: "", stderr: "" }));
	const value = await byName.clipboard_read.execute({});
	assert.match(value.text, /empty text/);
});

test("写文本用 pbcopy，且要求恰好一个参数", async () => {
	const calls = [];
	const { byName } = harness(async (command, args, options) => {
		calls.push({ command, args, input: options?.input });
		return { ok: true, stdout: "", stderr: "" };
	});
	const value = await byName.clipboard_write.execute({ text: "hello" });
	assert.match(value.text, /text · 5 chars/);
	assert.equal(calls[0].command, "pbcopy");
	assert.equal(calls[0].input, "hello");
	const none = await byName.clipboard_write.execute({});
	assert.match(none.text, /exactly one/);
});

test("写文件要求绝对路径且存在", async () => {
	const { byName } = harness(async () => ({ ok: true, stdout: "", stderr: "" }));
	const relative = await byName.clipboard_write.execute({ file_path: "a.txt" });
	assert.match(relative.text, /absolute/);
	const missing = await byName.clipboard_write.execute({ file_path: "/definitely/not/here.txt" });
	assert.match(missing.text, /not found/);
});

test("AppleScript 转义引号", () => {
	const script = clipboardFileScript('/tmp/a"b.txt');
	assert.match(script, /POSIX file/);
	assert.match(script, /a\\"b/);
	assert.throws(() => clipboardFileScript("relative.txt"));
});

test("clampClipboardText 上限", () => {
	assert.deepEqual(clampClipboardText("abcdef", 4), { text: "abcd", truncated: true });
	assert.deepEqual(clampClipboardText("abc", 4), { text: "abc", truncated: false });
	assert.equal(clampClipboardText("abcdef", 999999).text.length, 6);
});


test("注册必须走宿主 ctx.tools.register（0.46.2 回归）", () => {
	const registered = [];
	registerClipboardTools({ tools: { register: (def) => registered.push(def) } }, {}, { defineTool: (def) => def, version: "test" });
	assert.deepEqual(registered.map((def) => def.name).sort(), ["clipboard_read", "clipboard_write"]);
});
