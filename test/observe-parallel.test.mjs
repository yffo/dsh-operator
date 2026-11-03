// 0.10.5 观察链路并行化的静态守卫：
// captureRegion 必须在截图循环外一次算好（否则会退回串行），且不能再在循环里重新赋值。
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "computer-use", "index.js");

test("observeDesktop：AX 快照与截图并行，captureRegion 只计算一次", async () => {
	const text = await readFile(source, "utf8");
	assert.match(text, /const captureRegion = selected\.length > 0 \? selected\[0\]\.bounds : undefined;/);
	assert.match(text, /const axTextPromise = observeAxSnapshot\(foreground, captureRegion\)/);
	assert.equal(/^\s*captureRegion\s*=/m.test(text), false, "captureRegion 不应在循环里重新赋值（会触发 const 赋值错误）");
});
