// 坐标吸附（0.100.0，路线图 P1-4）
//
// 问题：模型给的是 0–1000 归一化坐标，落到真实像素时有误差；小图标（24×24）差几个像素就点空。
// 做法：动作前用 AX hit-test 命中的控件边界，若控件足够小就吸附到它的中心。
//
// 只在「命中了一个具体的小控件」时吸附——桌面/窗口这种大块目标不动，避免把点击拖偏。

/** 默认吸附阈值（点）：控件长边小于它就吸附到中心。 */
export const SNAP_MAX_SIZE = 48;

/**
 * 0–1000 归一化坐标 → 屏幕点（点单位）。
 * @param {number} fractionX
 * @param {number} fractionY
 * @param {{x:number,y:number,width:number,height:number}} bounds
 * @returns {{x:number, y:number}}
 */
export function fractionToPoint(fractionX, fractionY, bounds) {
	return {
		x: bounds.x + (fractionX / 1000) * bounds.width,
		y: bounds.y + (fractionY / 1000) * bounds.height
	};
}

/**
 * 屏幕点 → 0–1000 归一化坐标。
 * @param {number} x
 * @param {number} y
 * @param {{x:number,y:number,width:number,height:number}} bounds
 * @returns {[number, number]}
 */
export function pointToFraction(x, y, bounds) {
	const fx = bounds.width === 0 ? 0 : ((x - bounds.x) / bounds.width) * 1000;
	const fy = bounds.height === 0 ? 0 : ((y - bounds.y) / bounds.height) * 1000;
	return [clampFraction(fx), clampFraction(fy)];
}

/** 归一化坐标夹到 0–1000。 */
export function clampFraction(value) {
	if (Number.isFinite(value) === false) return 0;
	return Math.min(1000, Math.max(0, value));
}

/**
 * 计算吸附后的点击位置。
 * @param {{bounds?: {x:number,y:number,width:number,height:number}|null, role?: string}} hit AX hit-test 结果
 * @param {{bounds: {x:number,y:number,width:number,height:number}}} screen 观察到的屏幕/窗口
 * @param {[number, number]} position 原始归一化坐标
 * @param {{maxSize?: number, enabled?: boolean}} [options]
 * @returns {{position: [number, number], snapped: boolean, reason?: string}}
 */
export function snapToElementCenter(hit, screen, position, options = {}) {
	const enabled = options.enabled !== false;
	const maxSize = Number.isFinite(options.maxSize) && options.maxSize > 0 ? options.maxSize : SNAP_MAX_SIZE;
	if (enabled === false) return { position, snapped: false, reason: "disabled" };
	const target = hit?.bounds;
	const area = screen?.bounds;
	if (target === undefined || target === null || area === undefined || area === null) return { position, snapped: false, reason: "no-bounds" };
	if (target.width <= 0 || target.height <= 0) return { position, snapped: false, reason: "degenerate" };
	if (Math.max(target.width, target.height) > maxSize) return { position, snapped: false, reason: "too-large" };
	const centerX = target.x + target.width / 2;
	const centerY = target.y + target.height / 2;
	// 只在屏幕/窗口范围内吸附
	if (centerX < area.x || centerY < area.y || centerX > area.x + area.width || centerY > area.y + area.height) {
		return { position, snapped: false, reason: "out-of-screen" };
	}
	return { position: pointToFraction(centerX, centerY, area), snapped: true };
}
