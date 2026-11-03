import assert from "node:assert/strict";
import { test } from "node:test";

import { AX_DEDUPE_MAX_NOTES, AX_UNCHANGED_NOTE, dedupeAxText } from "../lib/ax-dedupe.js";

test("相同 AX 文本第二次起折叠成一行说明", () => {
	const session = {};
	const tree = '<ax_snapshot app="A" nodes="2">\n[0] AXButton "保存" @(10,10)\n</ax_snapshot>';
	assert.equal(dedupeAxText(session, tree), tree);
	assert.equal(dedupeAxText(session, tree), AX_UNCHANGED_NOTE);
});

test("连续折叠到上限后强制回全文", () => {
	const session = {};
	const tree = "<ax_snapshot nodes=\"1\">A</ax_snapshot>";
	dedupeAxText(session, tree);
	for (let i = 0; i < AX_DEDUPE_MAX_NOTES; i += 1) assert.equal(dedupeAxText(session, tree), AX_UNCHANGED_NOTE);
	assert.equal(dedupeAxText(session, tree), tree);
});

test("字符串键（cua:窗口）同样去重", () => {
	const tree = "<cua_window>tree</cua_window>";
	assert.equal(dedupeAxText("cua:42", tree), tree);
	assert.equal(dedupeAxText("cua:42", tree), AX_UNCHANGED_NOTE);
});

test("树变化时重新回全文", () => {
	const session = {};
	const first = "<ax_snapshot nodes=\"1\">A</ax_snapshot>";
	const second = "<ax_snapshot nodes=\"1\">B</ax_snapshot>";
	dedupeAxText(session, first);
	assert.equal(dedupeAxText(session, second), second);
});

test("不同 session 互不影响", () => {
	const one = {};
	const two = {};
	const tree = "<ax_snapshot nodes=\"1\">A</ax_snapshot>";
	assert.equal(dedupeAxText(one, tree), tree);
	assert.equal(dedupeAxText(two, tree), tree);
});

test("非字符串/空文本原样返回", () => {
	const session = {};
	assert.equal(dedupeAxText(session, undefined), undefined);
	assert.equal(dedupeAxText(session, ""), "");
	assert.equal(dedupeAxText(undefined, "x"), "x");
});
