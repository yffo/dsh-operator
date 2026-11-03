// 0.100.0（P1-4）：坐标吸附与 0–1000 映射
import assert from "node:assert/strict";
import { test } from "node:test";

import { clampFraction, fractionToPoint, pointToFraction, SNAP_MAX_SIZE, snapToElementCenter } from "../lib/point-snap.js";

const screen = { bounds: { x: 100, y: 50, width: 1000, height: 800 } };

test("归一化 ↔ 屏幕点：往返一致（这是坐标偏移类 bug 的防线）", () => {
	const point = fractionToPoint(250, 500, screen.bounds);
	assert.deepEqual(point, { x: 350, y: 450 });
	const back = pointToFraction(point.x, point.y, screen.bounds);
	assert.deepEqual(back, [250, 500]);
});

test("越界坐标夹到 0–1000", () => {
	assert.equal(clampFraction(-20), 0);
	assert.equal(clampFraction(1200), 1000);
	assert.equal(clampFraction(Number.NaN), 0);
});

test("小控件：吸附到中心", () => {
	const hit = { bounds: { x: 300, y: 200, width: 24, height: 24 }, role: "AXButton" };
	const result = snapToElementCenter(hit, screen, [200, 200]);
	assert.equal(result.snapped, true);
	const centerPoint = fractionToPoint(result.position[0], result.position[1], screen.bounds);
	assert.deepEqual(centerPoint, { x: 312, y: 212 }, "应落在控件中心");
});

test("大目标（窗口/桌面）不吸附，避免把点击拖偏", () => {
	const hit = { bounds: { x: 100, y: 50, width: 900, height: 700 }, role: "AXWindow" };
	const result = snapToElementCenter(hit, screen, [500, 500]);
	assert.equal(result.snapped, false);
	assert.equal(result.reason, "too-large");
	assert.deepEqual(result.position, [500, 500]);
});

test("控件在屏幕外/没有边界时不动", () => {
	assert.equal(snapToElementCenter({ bounds: { x: 5000, y: 5000, width: 10, height: 10 } }, screen, [1, 1]).snapped, false);
	assert.equal(snapToElementCenter(undefined, screen, [1, 1]).snapped, false);
	assert.equal(snapToElementCenter({ bounds: { x: 0, y: 0, width: 0, height: 0 } }, screen, [1, 1]).snapped, false);
});

test("阈值可调：把 maxSize 调到 8 时 24×24 不再吸附", () => {
	const hit = { bounds: { x: 300, y: 200, width: 24, height: 24 } };
	assert.equal(snapToElementCenter(hit, screen, [200, 200], { maxSize: 8 }).snapped, false);
	assert.equal(snapToElementCenter(hit, screen, [200, 200], { maxSize: SNAP_MAX_SIZE }).snapped, true);
	assert.equal(snapToElementCenter(hit, screen, [200, 200], { enabled: false }).snapped, false);
});
