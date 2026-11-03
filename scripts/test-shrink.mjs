#!/usr/bin/env node
/**
 * lib/capture-downscale.js 的冒烟测试（不依赖测试框架）。
 * 需要 macOS：用 screencapture 造一张大 JPEG，用 sips 造小图/PNG。
 * 用法：node scripts/test-shrink.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CAPTURE_MAX_EDGE,
	jpegDimensions,
	shrinkCapture,
	withCaptureDownscale
} from "../lib/capture-downscale.js";

const work = mkdtempSync(join(tmpdir(), "shrink-test-"));
let failures = 0;
function check(name, condition, detail = "") {
	if (condition) console.log(`ok   ${name}`);
	else {
		failures += 1;
		console.error(`FAIL ${name}${detail === "" ? "" : ` (${detail})`}`);
	}
}

function newestLargeAttachment() {
	const objects = join(homedir(), ".dsh", "attachments", "v1", "objects");
	let best;
	let bestSize = 0;
	let prefixes = [];
	try {
		prefixes = readdirSync(objects);
	} catch {
		return;
	}
	for (const prefix of prefixes) {
		const prefixDir = join(objects, prefix);
		let names = [];
		try {
			names = readdirSync(prefixDir);
		} catch {
			continue;
		}
		for (const name of names) {
			const path = join(prefixDir, name);
			try {
				const size = statSync(path).size;
				if (size > bestSize) {
					bestSize = size;
					best = path;
				}
			} catch {
				// ignore
			}
		}
	}
	return bestSize > 100_000 ? best : undefined;
}

function findBigJpeg() {
	// 1) 现场截一张 Retina 图（2x，通常 ≥2400px 宽）。
	const shot = join(work, "big.jpg");
	try {
		execFileSync("/usr/sbin/screencapture", ["-x", "-R0,0,1200,800", shot], { timeout: 15_000 });
		const dims = jpegDimensions(readFileSync(shot));
		if (dims !== undefined && Math.max(dims.width, dims.height) >= DEFAULT_CAPTURE_MAX_EDGE) return shot;
	} catch {
		// 没有屏幕录制权限时退回附件缓存。
	}
	return newestLargeAttachment();
}

const bigPath = findBigJpeg();
if (bigPath === undefined) {
	console.error("找不到可用于测试的大 JPEG（截屏失败且附件缓存里没有大图），跳过。");
	rmSync(work, { recursive: true, force: true });
	process.exit(0);
}
const big = readFileSync(bigPath);
const bigDims = jpegDimensions(big);
console.log(`源图：${bigPath} ${bigDims.width}x${bigDims.height} ${(big.length / 1024).toFixed(0)}KB`);

// 1. 默认参数：缩到长边 ≤ 1280，字节变小。
const shrunk = await shrinkCapture({ data: big, mediaType: "image/jpeg" }, {});
check("默认缩放返回结果", shrunk !== undefined);
if (shrunk !== undefined) {
	const dims = jpegDimensions(shrunk.data);
	check("长边 ≤ 1280", Math.max(dims.width, dims.height) <= DEFAULT_CAPTURE_MAX_EDGE, `${dims.width}x${dims.height}`);
	check("字节数变小", shrunk.data.length < big.length, `${big.length} → ${shrunk.data.length}`);
	check("mediaType 为 image/jpeg", shrunk.mediaType === "image/jpeg");

	// 2. 已是缩略图：不应再变大。
	const again = await shrinkCapture(shrunk, {});
	if (again !== undefined) {
		const dims2 = jpegDimensions(again.data);
		check("二次缩放尺寸不变", dims2.width === dims.width && dims2.height === dims.height, `${dims2.width}x${dims2.height}`);
		check("二次缩放不放大字节", again.data.length <= shrunk.data.length, `${shrunk.data.length} → ${again.data.length}`);
	} else {
		console.log("ok   二次缩放直接跳过（无需处理）");
	}
}

// 3. 只重编码：captureMaxEdge=0 + jpegQuality=50，尺寸不变、字节变小。
const reencoded = await shrinkCapture({ data: big, mediaType: "image/jpeg" }, { captureMaxEdge: 0, jpegQuality: 50 });
check("只重编码返回结果", reencoded !== undefined);
if (reencoded !== undefined) {
	const dims = jpegDimensions(reencoded.data);
	check("只重编码尺寸不变", dims.width === bigDims.width && dims.height === bigDims.height);
	check("只重编码字节变小", reencoded.data.length < big.length, `${big.length} → ${reencoded.data.length}`);
}

// 4. 全部关掉：直接跳过。
const disabled = await shrinkCapture({ data: big, mediaType: "image/jpeg" }, { captureMaxEdge: 0, jpegQuality: 100 });
check("缩放与重编码都关掉时不做处理", disabled === undefined);

// 5. 非 JPEG（Windows 后端的 PNG）原样放行。
const pngPath = join(work, "big.png");
execFileSync("/usr/bin/sips", ["-s", "format", "png", bigPath, "--out", pngPath], { timeout: 15_000 });
const png = readFileSync(pngPath);
check("PNG 不做处理", (await shrinkCapture({ data: png, mediaType: "image/png" }, {})) === undefined);

// 6. 包装后端：默认参数下 capture 返回缩小图；非 JPEG 结果原样透传。
const wrapped = withCaptureDownscale({ capture: async () => ({ data: big, mediaType: "image/jpeg" }) }, {});
const wrappedResult = await wrapped.capture(0, undefined);
const wrappedDims = jpegDimensions(wrappedResult.data);
check("包装后端生效", Math.max(wrappedDims.width, wrappedDims.height) <= DEFAULT_CAPTURE_MAX_EDGE, `${wrappedDims.width}x${wrappedDims.height}`);

const passthrough = withCaptureDownscale({ capture: async () => ({ data: png, mediaType: "image/png" }) }, {});
const passthroughResult = await passthrough.capture(0, undefined);
check("包装后端透传非 JPEG", Buffer.compare(Buffer.from(passthroughResult.data), Buffer.from(png)) === 0);

// 7. 小图不放大：把源图缩到 400px 再跑默认参数（会重编码，但尺寸不能变大）。
const smallPath = join(work, "small.jpg");
execFileSync("/usr/bin/sips", ["-Z", "400", bigPath, "--out", smallPath], { timeout: 15_000 });
const small = readFileSync(smallPath);
const smallDims = jpegDimensions(small);
const smallResult = await shrinkCapture({ data: small, mediaType: "image/jpeg" }, {});
if (smallResult !== undefined) {
	const dims = jpegDimensions(smallResult.data);
	check("小图不放大", dims.width <= smallDims.width && dims.height <= smallDims.height, `${smallDims.width}x${smallDims.height} → ${dims.width}x${dims.height}`);
} else {
	console.log("ok   小图无需处理");
}

rmSync(work, { recursive: true, force: true });
if (failures > 0) {
	console.error(`\n${failures} 个断言失败。`);
	process.exit(1);
}
console.log("\n全部通过 ✅");
