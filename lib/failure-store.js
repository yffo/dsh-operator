/**
 * 失败样本库：只在工具执行失败时落一行 JSONL（结构，不含内容）。
 *
 * 目标（PROJECT-2026-11 §4.4 / 0.11-5）：
 * - 出问题时能回答「哪类操作、在哪个 App、什么错误码、常见吗」；
 * - 不落用户文本、截图内容、剪贴板内容——文本一律只记长度；
 * - 目录可被 `scripts/failures.mjs digest` 汇总成 top 错误；
 * - 5MB 轮转，最多保留 20 个历史文件。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 20;
let overrideDir;

/** 测试与自定义部署可覆盖目录；传 undefined 恢复默认。 */
export function configureFailureStore({ dir } = {}) {
	overrideDir = dir;
}

export function failureDir() {
	return overrideDir ?? join(homedir(), ".dsh", "dsh-operator", "failures");
}

/** 把异常归到稳定分类，便于 digest 聚合。 */
export function classifyFailure(error) {
	const message = String(error?.message ?? error ?? "");
	if (/guarded|guarded control/i.test(message)) return "guard_rejected";
	if (/timed out|timeout|ETIMEDOUT/i.test(message)) return "timeout";
	if (/unavailable|missing|permission denied|not authorized|EACCES|EPERM/i.test(message)) return "unavailable";
	if (/no matching|not found|element not found|no such window/i.test(message)) return "not_found";
	if (/cancel(?:led|ed)|aborted|SIGINT/i.test(message)) return "cancelled";
	return "error";
}

const SAFE_ENUM_KEYS = new Set(["direction", "action", "kind", "page", "confirm", "attach", "submit", "count"]);

/** 参数脱敏：只留数字/布尔/已知枚举；其余字符串折成 `<key>_len`。 */
export function sanitizeArgs(args) {
	const out = {};
	for (const [key, value] of Object.entries(args ?? {})) {
		if (typeof value === "number" || typeof value === "boolean") {
			out[key] = value;
		} else if (typeof value === "string") {
			if (SAFE_ENUM_KEYS.has(key) && value.length <= 32) out[key] = value;
			else out[`${key}_len`] = value.length;
		} else if (Array.isArray(value)) {
			out[`${key}_items`] = value.length;
		}
	}
	return out;
}

function rotateIfNeeded(file, deps = {}) {
	const stat = deps.stat ?? statSync;
	const rename = deps.rename ?? renameSync;
	const exists = deps.exists ?? existsSync;
	if (exists(file) && stat(file).size > MAX_BYTES) {
		rename(file, `${file}.${Date.now()}.old`);
	}
}

function pruneOldFiles(dir, deps = {}) {
	const readdir = deps.readdir ?? readdirSync;
	const files = readdir(dir)
		.filter((name) => name.endsWith(".jsonl") || name.includes(".jsonl."))
		.sort();
	const excess = files.length - MAX_FILES;
	if (excess <= 0) return;
	for (const name of files.slice(0, excess)) {
		try {
			(deps.unlink ?? (() => {}))(join(dir, name));
		} catch {
			/* best effort */
		}
	}
}

/**
 * 记录一次失败。永不抛错（失败样本库不能影响主链路）。
 * @returns {boolean} 是否写入
 */
export function recordFailure({ tool, error, args, kind, now = Date.now(), version } = {}, deps = {}) {
	try {
		const dir = deps.dir ?? failureDir();
		const mkdir = deps.mkdir ?? mkdirSync;
		const append = deps.append ?? appendFileSync;
		mkdir(dir, { recursive: true });
		const day = new Date(now).toISOString().slice(0, 10);
		const file = join(dir, `${day}.jsonl`);
		rotateIfNeeded(file, deps);
		const line = {
			t: new Date(now).toISOString(),
			event: "failure",
			tool: String(tool ?? ""),
			kind: kind ?? classifyFailure(error),
			message: String(error?.message ?? error ?? "").slice(0, 180),
			args: sanitizeArgs(args)
		};
		if (version !== undefined) line.version = version;
		append(file, `${JSON.stringify(line)}\n`);
		pruneOldFiles(dir, deps);
		return true;
	} catch {
		return false;
	}
}

function readAll(dir, deps = {}) {
	const readdir = deps.readdir ?? readdirSync;
	const read = deps.read ?? readFileSync;
	let names = [];
	try {
		names = readdir(dir);
	} catch {
		return [];
	}
	const rows = [];
	for (const name of names.filter((item) => item.endsWith(".jsonl")).sort()) {
		let text = "";
		try {
			text = String(read(join(dir, name), "utf8"));
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (line.trim().length === 0) continue;
			try {
				rows.push(JSON.parse(line));
			} catch {
				/* 跳过坏行 */
			}
		}
	}
	return rows;
}

/** 汇总失败样本：按 tool/kind/error 计数 + 每日趋势 + 最近样本。 */
export function digestFailures({ dir = failureDir(), top = 10, recent = 5 } = {}, deps = {}) {
	const rows = readAll(dir, deps);
	const byTool = {};
	const byKind = {};
	const byMessage = {};
	const byDay = {};
	for (const row of rows) {
		const tool = row.tool || "(unknown)";
		byTool[tool] = (byTool[tool] ?? 0) + 1;
		byKind[row.kind ?? "error"] = (byKind[row.kind ?? "error"] ?? 0) + 1;
		const message = row.message ?? "";
		byMessage[message] = (byMessage[message] ?? 0) + 1;
		const day = String(row.t ?? "").slice(0, 10);
		byDay[day] = (byDay[day] ?? 0) + 1;
	}
	const sort = (record) =>
		Object.entries(record)
			.sort((a, b) => b[1] - a[1])
			.slice(0, top);
	return {
		total: rows.length,
		byTool: sort(byTool),
		byKind: sort(byKind),
		byMessage: sort(byMessage),
		byDay: Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0])),
		recent: rows.slice(-recent).reverse()
	};
}
