// 稳定帧等待（0.94.0）
//
// 动作后固定死等 600ms 有两个问题：静态界面白等、动态界面（视频/游戏/动画）又没等够。
// 这里改成「先等一个下限，再轮询截图，连续两帧相同即稳定」；到上限仍不稳定就明确回报，
// 让调用方把 actionEffect 记为 unverifiable，而不是拿每一帧都不同的截图去判 confirmed。

import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/** 轮询间隔。 */
export const STABLE_POLL_MS = 100;
/** 等待上限（从下限之后开始计）。 */
export const STABLE_MAX_MS = 900;

/**
 * 等画面稳定。
 * @param {{ listScreens: Function, capture: Function }} backend
 * @param {AbortSignal|undefined} signal
 * @param {number} minDelayMs 先等多久再开始轮询
 * @returns {Promise<{stable: boolean, waitedMs: number, frames: number}>}
 */
export async function waitForStableFrame(backend, signal, minDelayMs) {
	await delay(minDelayMs, { signal });
	const started = Date.now();
	let previous;
	let frames = 0;
	while (Date.now() - started < STABLE_MAX_MS) {
		signal?.throwIfAborted?.();
		let digest;
		try {
			const screens = (await backend.listScreens(signal)).slice(0, 1);
			if (screens.length === 0) break;
			const shot = await backend.capture(screens[0], signal);
			if (shot?.data === undefined) break;
			digest = createHash("sha1").update(shot.data).digest("hex");
		} catch {
			break;
		}
		frames += 1;
		if (previous !== undefined && previous === digest) return { stable: true, waitedMs: Date.now() - started, frames };
		previous = digest;
		await delay(STABLE_POLL_MS, { signal });
	}
	return { stable: false, waitedMs: Date.now() - started, frames };
}
