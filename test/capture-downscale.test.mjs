import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_CAPTURE_MAX_EDGE,
	DEFAULT_JPEG_QUALITY,
	DEFAULT_SIPS,
	jpegDimensions,
	shrinkCapture,
	withCaptureDownscale
} from "../lib/capture-downscale.js";

/** 构一个只含 SOI + 可选段 + SOF0 + EOI 的“合法结构”JPEG（够 jpegDimensions 解析）。 */
function jpegBytes(width, height, extras = []) {
	const parts = [0xff, 0xd8, ...extras];
	parts.push(
		0xff,
		0xc0,
		0x00,
		0x11, // 段长 17
		0x08, // 精度
		(height >> 8) & 0xff,
		height & 0xff,
		(width >> 8) & 0xff,
		width & 0xff,
		0x03, // 分量数
		0x01,
		0x22,
		0x00,
		0x02,
		0x11,
		0x01,
		0x03,
		0x11,
		0x01
	);
	parts.push(0xff, 0xd9);
	return Uint8Array.from(parts);
}

function fakeSips(writes) {
	return async (_bin, args, _options) => {
		const output = args[args.length - 1];
		const bytes = typeof writes === "function" ? writes(args) : writes;
		const { writeFile } = await import("node:fs/promises");
		await writeFile(output, bytes);
	};
}

test("jpegDimensions：拒绝非 JPEG / 截断数据", () => {
	assert.equal(jpegDimensions(undefined), undefined);
	assert.equal(jpegDimensions(new Uint8Array([0xff])), undefined);
	assert.equal(jpegDimensions(new Uint8Array([0x00, 0x00, 0x00, 0x00])), undefined);
	assert.equal(jpegDimensions(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])), undefined);
});

test("jpegDimensions：解析 SOF0 宽高，跳过填充与 APP 段", () => {
	const plain = jpegDimensions(jpegBytes(1200, 800));
	assert.deepEqual(plain, { width: 1200, height: 800 });
	// APP0 段（FF E0 + 长度）
	const app0 = [0xff, 0xe0, 0x00, 0x10, ...Array.from({ length: 14 }, () => 0x00)];
	const withApp = jpegDimensions(jpegBytes(1280, 720, [app0]));
	assert.deepEqual(withApp, { width: 1280, height: 720 });
});

test("jpegDimensions：非法长度/零尺寸返回 undefined", () => {
	const badLength = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00]);
	assert.equal(jpegDimensions(badLength), undefined);
	assert.equal(jpegDimensions(jpegBytes(0, 100)), undefined);
});

test("shrinkCapture：非 JPEG / 不需缩放时返回 undefined", async () => {
	const png = { data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), mediaType: "image/png" };
	assert.equal(await shrinkCapture(png), undefined);
	assert.equal(await shrinkCapture(undefined), undefined);
	const small = { data: jpegBytes(640, 480), mediaType: "image/jpeg" };
	// 默认参数：640 长边 < 1280 但 q=80 需要重编码 → 不走“无需处理”分支；
	// 这里验证显式关掉两者时返回 undefined。
	assert.equal(await shrinkCapture(small, { captureMaxEdge: 0, jpegQuality: 100 }), undefined);
});

test("shrinkCapture：调用 sips 缩放并返回更小图", async () => {
	const input = { data: jpegBytes(2048, 1024), mediaType: "image/jpeg" };
	const shrunk = jpegBytes(1280, 640);
	let seenArgs;
	const result = await shrinkCapture(input, { captureMaxEdge: DEFAULT_CAPTURE_MAX_EDGE, jpegQuality: DEFAULT_JPEG_QUALITY }, undefined, {
		runSips: fakeSips((args) => {
			seenArgs = args;
			return shrunk;
		})
	});
	assert.ok(Array.isArray(seenArgs));
	assert.equal(seenArgs[seenArgs.length - 2], "--out");
	assert.ok(seenArgs.includes("-Z"));
	assert.ok(seenArgs.includes(String(DEFAULT_CAPTURE_MAX_EDGE)));
	assert.ok(seenArgs.includes(String(DEFAULT_JPEG_QUALITY)));
	assert.equal(result.mediaType, "image/jpeg");
	assert.deepEqual(Array.from(result.data), Array.from(shrunk));
});

test("shrinkCapture：sips 输出更大尺寸时退回原图", async () => {
	const input = { data: jpegBytes(2000, 1000), mediaType: "image/jpeg" };
	const bigger = jpegBytes(3000, 1500);
	const result = await shrinkCapture(input, { captureMaxEdge: 1280, jpegQuality: 80 }, undefined, { runSips: fakeSips(bigger) });
	assert.equal(result, undefined);
});

test("shrinkCapture：sips 失败会抛错（由包装层决定是否回退）", async () => {
	const input = { data: jpegBytes(2000, 1000), mediaType: "image/jpeg" };
	await assert.rejects(
		shrinkCapture(input, { captureMaxEdge: 1280, jpegQuality: 80 }, undefined, {
			runSips: async () => {
				throw new Error("sips boom");
			}
		}),
		/sips boom/
	);
});

test("withCaptureDownscale：禁用时原样返回后端", () => {
	const backend = { capture: async () => ({ data: jpegBytes(10, 10) }), marker: 1 };
	const wrapped = withCaptureDownscale(backend, { captureMaxEdge: 0, jpegQuality: 100 });
	assert.equal(wrapped, backend);
});

test("withCaptureDownscale：失败回退原图", async () => {
	const original = jpegBytes(2400, 1200);
	const backend = { capture: async () => ({ data: original, mediaType: "image/jpeg" }) };
	const wrapped = withCaptureDownscale(backend, { captureMaxEdge: 1280, jpegQuality: 80 }, {
		runSips: async () => {
			throw new Error("sips boom");
		}
	});
	const result = await wrapped.capture({ windowId: 1 }, undefined);
	assert.deepEqual(Array.from(result.data), Array.from(original));
});

test("withCaptureDownscale：取消信号下错误向上抛", async () => {
	const controller = new AbortController();
	controller.abort();
	const backend = {
		capture: async () => {
			throw new Error("aborted by caller");
		}
	};
	const wrapped = withCaptureDownscale(backend, { captureMaxEdge: 1280, jpegQuality: 80 });
	await assert.rejects(wrapped.capture({ windowId: 1 }, controller.signal), /aborted/);
});

test("DEFAULT_SIPS / 默认参数常量", () => {
	assert.equal(DEFAULT_SIPS, "/usr/bin/sips");
	assert.equal(DEFAULT_CAPTURE_MAX_EDGE, 1280);
	assert.equal(DEFAULT_JPEG_QUALITY, 80);
});
