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
