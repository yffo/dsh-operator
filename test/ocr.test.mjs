import assert from "node:assert/strict";
import { test } from "node:test";

import { OCR_DEFAULT_MAX_LINES, formatOcrText } from "../lib/ocr.js";

const sample = {
	width: 1000,
	height: 500,
	lines: [
		{ text: "删除账户", x: 100, y: 50, width: 200, height: 40, confidence: 0.9 },
		{ text: "Cancel", x: 600, y: 400, width: 100, height: 30, confidence: 0.8 },
		{ text: "noise", x: 10, y: 10, width: 20, height: 10, confidence: 0.05 }
	]
};

test("坐标换算成 0–1000 中心点", () => {
	const text = formatOcrText(sample);
	assert.match(text, /lines="2"/);
	assert.match(text, /"删除账户" @\(200,140\)/);
	assert.match(text, /"Cancel" @\(650,830\)/);
});

test("低置信度行被过滤", () => {
	assert.doesNotMatch(formatOcrText(sample), /"noise"/);
});

test("query 只留命中行", () => {
	const text = formatOcrText(sample, { query: "cancel" });
	assert.match(text, /lines="1"/);
	assert.doesNotMatch(text, /删除账户/);
});

test("maxLines 截断并保持默认上限", () => {
	const text = formatOcrText(sample, { maxLines: 1 });
	assert.match(text, /shown="1"/);
	assert.equal(OCR_DEFAULT_MAX_LINES, 120);
	assert.match(formatOcrText({ width: 10, height: 10, lines: [] }), /没有识别到文本/);
});
