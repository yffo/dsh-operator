import assert from "node:assert/strict";
import { test } from "node:test";

import { FRAME_UNCHANGED_NOTE, frameHash, isSameFrame } from "../lib/frame-dedupe.js";

test("frameHash 对同一字节稳定、不同字节不同", () => {
	const a = new Uint8Array([1, 2, 3]);
	const b = new Uint8Array([1, 2, 4]);
	assert.equal(frameHash(a), frameHash(new Uint8Array([1, 2, 3])));
	assert.notEqual(frameHash(a), frameHash(b));
	assert.equal(frameHash(undefined), undefined);
	assert.equal(frameHash(new Uint8Array()), undefined);
});

test("isSameFrame：第一次 false，同键同哈希第二次 true", () => {
	const store = new Map();
	const hash = frameHash(new Uint8Array([9, 9]));
	assert.equal(isSameFrame("0:{}", hash, store), false);
	assert.equal(isSameFrame("0:{}", hash, store), true);
});

test("画面变化/换区域都继续附图", () => {
	const store = new Map();
	isSameFrame("0:{}", frameHash(new Uint8Array([1])), store);
	assert.equal(isSameFrame("0:{}", frameHash(new Uint8Array([2])), store), false);
	assert.equal(isSameFrame("1:{}", frameHash(new Uint8Array([1])), store), false);
});

test("没有哈希时保守附图", () => {
	const store = new Map();
	assert.equal(isSameFrame("0:{}", undefined, store), false);
	assert.match(FRAME_UNCHANGED_NOTE, /image_unchanged/);
});
