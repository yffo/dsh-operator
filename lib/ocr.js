// OCR 兜底：AX 树拿不到（canvas、Electron 自绘、远程桌面）时，用 macOS Vision 读截图。
// 只回文本行 + 居中坐标，不回原图，省 token；需要看图时再走 screenshot。

export const OCR_DEFAULT_MAX_LINES = 120;
export const OCR_MIN_CONFIDENCE = 0.25;

/**
 * 把 Vision OCR 结果格式化成模型可读的文本。
 * @param {{width:number,height:number,lines:Array<{text:string,x:number,y:number,width:number,height:number,confidence:number}>}} result
 * @param {{maxLines?:number, query?:string}} [options]
 * @returns {string}
 */
export function formatOcrText(result, options = {}) {
	const maxLines = Number.isInteger(options.maxLines) && options.maxLines > 0 ? options.maxLines : OCR_DEFAULT_MAX_LINES;
	const query = typeof options.query === "string" ? options.query.trim() : "";
	const width = Number(result?.width) > 0 ? Number(result.width) : 1;
	const height = Number(result?.height) > 0 ? Number(result.height) : 1;
	const all = Array.isArray(result?.lines) ? result.lines : [];
	const kept = all.filter((line) => typeof line?.text === "string" && line.text.trim() !== "" && Number(line.confidence ?? 0) >= OCR_MIN_CONFIDENCE);
	const matched = query === "" ? kept : kept.filter((line) => line.text.toLowerCase().includes(query.toLowerCase()));
	const shown = matched.slice(0, maxLines);
	const header = `<ocr lines="${String(matched.length)}" shown="${String(shown.length)}" image="${String(Math.round(width))}x${String(Math.round(height))}"${query === "" ? "" : ` query="${query.replaceAll('"', "'")}"`}/>`;
	const rows = shown.map((line, index) => {
		const cx = Math.round(((Number(line.x) + Number(line.width) / 2) / width) * 1000);
		const cy = Math.round(((Number(line.y) + Number(line.height) / 2) / height) * 1000);
		const text = String(line.text).replaceAll("\n", " ").slice(0, 200);
		return `${String(index + 1)}. "${text}" @(${String(cx)},${String(cy)}) conf ${Number(line.confidence ?? 0).toFixed(2)}`;
	});
	const footer = shown.length === 0 ? "（没有识别到文本；可以换 query、调大 max_lines，或直接看截图）" : "坐标是 0–1000，相对当前窗口截图；可直接用于 click / drag。";
	return [header, ...rows, footer].join("\n");
}

/**
 * 把 0–1000 的窗口相对区域换算成截图像素框（0.119.0）。
 * 越界会被夹到图像内；非法输入返回 undefined（调用方回退整图 OCR）。
 * @param {{x:number,y:number,width:number,height:number}} region
 * @param {number} width 截图像素宽
 * @param {number} height 截图像素高
 * @returns {{x:number,y:number,width:number,height:number}|undefined}
 */
export function cropRegionToPixels(region, width, height) {
	const w = Number(width);
	const h = Number(height);
	if (!(w > 0) || !(h > 0)) return undefined;
	if (region === null || typeof region !== "object") return undefined;
	const rx = Number(region.x);
	const ry = Number(region.y);
	const rw = Number(region.width);
	const rh = Number(region.height);
	if ([rx, ry, rw, rh].some((value) => Number.isFinite(value) === false) || rw <= 0 || rh <= 0) return undefined;
	const x = Math.max(0, Math.min(w - 1, Math.round((rx / 1000) * w)));
	const y = Math.max(0, Math.min(h - 1, Math.round((ry / 1000) * h)));
	const cropWidth = Math.max(1, Math.min(w - x, Math.round((rw / 1000) * w)));
	// 0.119.2：高度要留 1 像素余量——sips 在 offsetY + cropHeight == 原图高时会**静默返回原图**
	//（实测 820x770 / 462+308 触底即失败），之前没校验就加偏移，坐标会整体错位。
	const cropHeight = Math.max(1, Math.min(h - y - 1, Math.round((rh / 1000) * h)));
	return { x, y, width: cropWidth, height: cropHeight };
}

/**
 * 把「裁剪图 OCR 结果」的坐标偏移回整窗像素坐标（0.119.0），
 * 并把 width/height 换成整图尺寸，保证 formatOcrText 输出的 0–1000 坐标仍是整窗坐标。
 * @param {{lines?:Array<object>, width?:number, height?:number}} result 裁剪图的 OCR 结果
 * @param {number} offsetX 裁剪框左上角在整图中的像素 x
 * @param {number} offsetY 同上 y
 * @param {number} fullWidth 整图像素宽
 * @param {number} fullHeight 整图像素高
 */
export function offsetOcrLines(result, offsetX, offsetY, fullWidth, fullHeight) {
	const lines = Array.isArray(result?.lines) ? result.lines : [];
	const width = Number(fullWidth) > 0 ? Number(fullWidth) : Number(result?.width ?? 1);
	const height = Number(fullHeight) > 0 ? Number(fullHeight) : Number(result?.height ?? 1);
	const dx = Number.isFinite(Number(offsetX)) ? Number(offsetX) : 0;
	const dy = Number.isFinite(Number(offsetY)) ? Number(offsetY) : 0;
	return {
		width,
		height,
		lines: lines.map((line) => ({
			...line,
			x: Number(line?.x ?? 0) + dx,
			y: Number(line?.y ?? 0) + dy
		}))
	};
}
