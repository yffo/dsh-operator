// dsh-operator：无内容审计日志（P1-11）
//
// 只记「发生了什么」——事件名、枚举、数量、布尔、耗时；不记截图、坐标、窗口标题、
// 用户输入文本、剪贴板内容。写入 ~/.dsh/dsh-operator/audit.jsonl，超过 5MB 轮转一份。
//
// 审计失败不影响主流程（写盘错误一律吞掉）；关闭开关由 config.auditLog 控制。

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const defaultPath = () => join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-operator", "audit.jsonl");
const MAX_BYTES = 5 * 1024 * 1024;

let settings = { enabled: true, path: void 0, maxBytes: MAX_BYTES };

/** 由 apply() 调用；path 可覆盖（测试用）。 */
export function configureAuditLog(options = {}) {
	settings = {
		enabled: options.enabled !== false,
		path: typeof options.path === "string" && options.path !== "" ? options.path : void 0,
		maxBytes: Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : MAX_BYTES
	};
}

export function auditLogPath() {
	return settings.path ?? defaultPath();
}

/**
 * 追加一条审计记录。
 * @param {string} event 事件名（如 action / plugin_start / verify_state）。
 * @param {Record<string, unknown>} [fields] 只保留标量；字符串截断到 40 字符，长数组只记长度。
 */
export function audit(event, fields = {}) {
	if (settings.enabled === false) return;
	const path = settings.path ?? defaultPath();
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify({ t: new Date().toISOString(), event, ...sanitize(fields) })}\n`, "utf8");
		if (statSync(path).size > settings.maxBytes) {
			renameSync(path, `${path}.1`);
		}
	} catch {
		// 审计是旁路，写不进去也不影响工具调用。
	}
}

function sanitize(fields) {
	const out = {};
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined || value === null) continue;
		if (typeof value === "number" || typeof value === "boolean") {
			out[key] = value;
			continue;
		}
		if (typeof value === "string") {
			out[key] = value.length > 40 ? `${value.slice(0, 40)}…` : value;
			continue;
		}
		if (Array.isArray(value)) {
			out[key] = `array:${String(value.length)}`;
			continue;
		}
		out[key] = typeof value;
	}
	return out;
}
