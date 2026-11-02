import assert from "node:assert/strict";
import { test } from "node:test";

import { IMAGE_UNCHANGED_NOTE, imageDedupeKey, rememberImage } from "../lib/image-dedupe.js";

const frame = (id, screenIndex = 0, bounds = { x: 0, y: 0, width: 100, height: 100 }) => ({
	screenIndex,
	visibleBounds: bounds,
	image: { attachmentId: id }
});

test("第一次附图，同一帧第二次不附图", () => {
	const store = new Map();
	assert.equal(rememberImage(frame("sha1"), store), true);
	assert.equal(rememberImage(frame("sha1"), store), false);
	assert.match(IMAGE_UNCHANGED_NOTE, /image_unchanged/);
});

test("像素变化（attachmentId 不同）继续附图", () => {
	const store = new Map();
	rememberImage(frame("sha1"), store);
	assert.equal(rememberImage(frame("sha2"), store), true);
});

test("不同区域/屏幕互不影响", () => {
	const store = new Map();
	rememberImage(frame("sha1", 0), store);
	assert.equal(rememberImage(frame("sha1", 1), store), true);
	assert.equal(rememberImage(frame("sha1", 0, { x: 5, y: 5, width: 10, height: 10 }), store), true);
});

test("没有 attachmentId 时保守附图", () => {
	const store = new Map();
	assert.equal(rememberImage({ screenIndex: 0, image: {} }, store), true);
	assert.equal(rememberImage({}, store), true);
});

test("imageDedupeKey 稳定", () => {
	const a = imageDedupeKey(frame("x", 2, { x: 1, y: 2, width: 3, height: 4 }));
	const b = imageDedupeKey(frame("y", 2, { x: 1, y: 2, width: 3, height: 4 }));
	assert.equal(a, b);
});
