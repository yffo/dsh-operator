/**
 * dsh-operator 优化补丁层：观察截图在交给模型前先缩放/重编码。
 *
 * 为什么单独放这里：`lib/computer-use/` 是上游 dsh-orb 的原样 vendored 代码，
 * `scripts/sync-from-orb.sh` 随时会整目录替换；本文件在 vendored 目录之外，
 * 不会被同步覆盖。vendored 代码里的接线点由 `scripts/apply-vendor-patches.mjs`
 * 幂等打补丁（带 "PATCH(computer-use)" 标记）。
 *
 * 背景：上游每次动作后截当前前台窗口的 JPEG（Retina 2x，约 2558x1639），
 * 直接交给视觉模型。图片 token 大致随像素数增长，而坐标用的是 0–1000 归一化
 * 空间（与像素无关），所以把长边缩到 1280 对点击精度几乎无影响，却能省掉
 * 大部分图片 token，顺带让附件/剪贴板更轻。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);
const SIPS = "/usr/bin/sips";

export const DEFAULT_CAPTURE_MAX_EDGE = 1280;
export const DEFAULT_JPEG_QUALITY = 80;

/**
 * 从 JPEG 字节里读 SOF 段宽高，不引入图片解码依赖。
 * @param {Uint8Array} data
 * @returns {{ width: number, height: number } | undefined}
 */
export function jpegDimensions(data) {
	if (!(data instanceof Uint8Array) || data.length < 4) return;
	if (data[0] !== 0xff || data[1] !== 0xd8) return;
	let offset = 2;
	while (offset + 9 < data.length) {
		if (data[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		const marker = data[offset + 1];
		// 填充字节与无长度段。
		if (marker === 0xff) {
			offset += 1;
			continue;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
			offset += 2;
			continue;
		}
		const length = (data[offset + 2] << 8) | data[offset + 3];
		if (length < 2) return;
		const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isSof) {
			const height = (data[offset + 5] << 8) | data[offset + 6];
			const width = (data[offset + 7] << 8) | data[offset + 8];
			if (width <= 0 || height <= 0) return;
			return { width, height };
		}
		offset += 2 + length;
	}
	return;
}

/**
 * 包装一个桌面后端，让 capture() 返回缩放/重编码后的图片。
 * 失败时永远回退到原图——宁可不省 token，也不能让截图链路挂掉。
 *
 * @param {object} backend 上游 createPlatformBackend 返回对象（含 capture(screen, signal)）
 * @param {{ captureMaxEdge?: number, jpegQuality?: number }} options
 * @returns {object} 包装后的后端
 */
export function withCaptureDownscale(backend, options = {}) {
	const captureMaxEdge = Number.isFinite(options.captureMaxEdge) ? options.captureMaxEdge : DEFAULT_CAPTURE_MAX_EDGE;
	const jpegQuality = Number.isFinite(options.jpegQuality) ? options.jpegQuality : DEFAULT_JPEG_QUALITY;
	if (captureMaxEdge <= 0 && (jpegQuality <= 0 || jpegQuality >= 100)) return backend;
	return {
		...backend,
		async capture(screen, signal) {
			const captured = await backend.capture(screen, signal);
			try {
				const shrunk = await shrinkCapture(captured, { captureMaxEdge, jpegQuality }, signal);
				return shrunk ?? captured;
			} catch (error) {
				if (signal?.aborted) throw error;
				return captured;
			}
		}
	};
}

/**
 * 用 sips 把一张 capture 缩到长边不超过 captureMaxEdge，并按 jpegQuality 重编码。
 * 只处理 JPEG（macOS 截图为 JPEG；Windows 后端返回 PNG，这里原样放行）。
 *
 * @param {{ data: Uint8Array, mediaType: string }} captured
 * @param {{ captureMaxEdge?: number, jpegQuality?: number }} options
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{ data: Uint8Array, mediaType: string } | undefined>} undefined 表示不变
 */
export async function shrinkCapture(captured, options = {}, signal) {
	const captureMaxEdge = Number.isFinite(options.captureMaxEdge) ? options.captureMaxEdge : DEFAULT_CAPTURE_MAX_EDGE;
	const jpegQuality = Number.isFinite(options.jpegQuality) ? options.jpegQuality : DEFAULT_JPEG_QUALITY;
	const data = captured?.data;
	const dimensions = jpegDimensions(data);
	if (dimensions === undefined) return;
	const needResize = captureMaxEdge > 0 && Math.max(dimensions.width, dimensions.height) > captureMaxEdge;
	const needEncode = jpegQuality > 0 && jpegQuality < 100;
	if (!needResize && !needEncode) return;

	const directory = await mkdtemp(join(tmpdir(), "dsh-cu-shrink-"));
	try {
		const source = join(directory, "in.jpg");
		const output = join(directory, "out.jpg");
		await writeFile(source, data);
		const args = [source];
		if (needResize) args.push("-Z", String(captureMaxEdge));
		if (needEncode) args.push("-s", "format", "jpeg", "-s", "formatOptions", String(jpegQuality));
		args.push("--out", output);
		await execFileAsync(SIPS, args, {
			timeout: 15_000,
			...(signal === undefined ? {} : { signal })
		});
		const shrunk = await readFile(output);
		const shrunkDimensions = jpegDimensions(shrunk);
		if (shrunkDimensions === undefined) return;
		// sips 正常不会放大；万一是更大/更差的图就退回原图。
		if (shrunkDimensions.width > dimensions.width || shrunkDimensions.height > dimensions.height) return;
		if (!needResize && shrunk.length >= data.length) return;
		return { data: shrunk, mediaType: "image/jpeg" };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
