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

// 0.119.0：region 参数（只 OCR 截图的一块区域）
import { cropRegionToPixels, offsetOcrLines } from "../lib/ocr.js";

test("cropRegionToPixels：0–1000 区域换算成像素框、越界被夹住", () => {
	assert.deepEqual(cropRegionToPixels({ x: 250, y: 100, width: 500, height: 400 }, 1000, 500), { x: 250, y: 50, width: 500, height: 200 });
	// 右边越界：宽度被夹到图像内
	assert.deepEqual(cropRegionToPixels({ x: 900, y: 0, width: 500, height: 100 }, 1000, 500), { x: 900, y: 0, width: 100, height: 50 });
	// 0.119.2：触底要留 1 像素——sips 在 offsetY+height==原高时会静默返回原图
	const bottom = cropRegionToPixels({ x: 0, y: 600, width: 1000, height: 400 }, 1280, 886);
	assert.equal(bottom.y, 532);
	assert.equal(bottom.height, 886 - 532 - 1);
	// 非法输入
	assert.equal(cropRegionToPixels({ x: 1, y: 2, width: 0, height: 10 }, 1000, 500), undefined);
	assert.equal(cropRegionToPixels(null, 1000, 500), undefined);
	assert.equal(cropRegionToPixels({ x: 0, y: 0, width: 10, height: 10 }, 0, 500), undefined);
});

test("offsetOcrLines：裁剪图坐标偏移回整窗，且归一化用整图尺寸", () => {
	const cropped = { width: 500, height: 200, lines: [{ text: "终止", x: 100, y: 50, width: 80, height: 20, confidence: 0.9 }] };
	const full = offsetOcrLines(cropped, 250, 50, 1000, 500);
	assert.equal(full.width, 1000);
	assert.equal(full.height, 500);
	assert.equal(full.lines[0].x, 350);
	assert.equal(full.lines[0].y, 100);
	// 端到端：formatOcrText 输出整窗 0–1000 坐标
	assert.match(formatOcrText(full), /"终止" @\(390,220\)/);
});

// 0.122.3：双坐标——pixel 打开时每行附带截图内像素与全局屏幕逻辑点
test("formatOcrText：pixel 模式给出像素坐标与屏幕坐标", () => {
	const text = formatOcrText(sample, { pixel: true, window: { x: 100, y: 50, scale: 2 } });
	// 「删除账户」中心像素 (200,70)；窗口逻辑原点 (100,50) + 200/2 → screen(200,85)
	assert.match(text, /"删除账户" @\(200,140\) px\(200,70\) screen\(200,85\)/);
	assert.match(text, /"Cancel" @\(650,830\) px\(650,415\)/);
	// 拿不到窗口信息时只给像素，不给 screen
	const noWindow = formatOcrText(sample, { pixel: true });
	assert.match(noWindow, /px\(200,70\)/);
	assert.doesNotMatch(noWindow, /screen\(/);
	// 默认不开，省 token
	assert.doesNotMatch(formatOcrText(sample), /px\(/);
});
