// 0.94.0：自适应稳定帧
import assert from "node:assert/strict";
import { test } from "node:test";

import { STABLE_MAX_MS, STABLE_POLL_MS, waitForStableFrame } from "../lib/stable-frame.js";

/** 造一个按序列返回截图的假后端。 */
function fakeBackend(frames) {
	let index = 0;
	const screen = { index: 0, bounds: { x: 0, y: 0, width: 100, height: 100 } };
	return {
		calls: 0,
		async listScreens() {
			return [screen];
		},
		async capture() {
			this.calls += 1;
			const frame = frames[Math.min(index, frames.length - 1)];
			index += 1;
			return { data: Buffer.from(frame), mediaType: "image/jpeg" };
		}
	};
}

test("静态画面：连续两帧相同即判定稳定，不会等满上限", async () => {
	const backend = fakeBackend(["AAAA", "AAAA", "AAAA"]);
	const result = await waitForStableFrame(backend, undefined, 0);
	assert.equal(result.stable, true);
	assert.ok(result.frames >= 2, "至少要看两帧");
});

test("动态画面：帧一直变就报不稳定（调用方据此判 unverifiable）", async () => {
	const backend = fakeBackend(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"]);
	const result = await waitForStableFrame(backend, undefined, 0);
	assert.equal(result.stable, false);
	assert.ok(result.waitedMs >= STABLE_MAX_MS - STABLE_POLL_MS, "应该跑到接近上限");
});

test("截图失败时安全退出，不抛错", async () => {
	const backend = {
		async listScreens() {
			throw new Error("boom");
		},
		async capture() {
			throw new Error("boom");
		}
	};
	const result = await waitForStableFrame(backend, undefined, 0);
	assert.equal(result.stable, false);
});
