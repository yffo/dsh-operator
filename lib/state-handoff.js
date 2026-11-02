// 跨窗口状态交接（0.63.0）：只保存「本窗口做到了哪」，不保存对话正文。
//
// 为什么只存工具级信息：插件看不到对话，只能看到自己注册的工具调用；
// 语义记忆交给 tabellio。这里的目标是让新窗口第一次 operator_status/operator_resume
// 就知道「上个窗口在干什么、还差什么」。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const HANDOFF_MAX_RECENT = 20;
export const HANDOFF_MAX_CHARS = 1200;
export const HANDOFF_MAX_BYTES = 16 * 1024;

function homeRoot() {
	return process.env.DSH_HOME && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".dsh");
}

/** handoff.json 路径（尊重 DSH_HOME，测试可隔离）。 */
export function handoffPath() {
	return join(homeRoot(), "dsh-operator", "state", "handoff.json");
}

/**
 * 读 handoff；文件不存在或损坏时返回 null（宁可为空，不要报错）。
 * @returns {object | null}
 */
export function readHandoff(path = handoffPath()) {
	try {
		if (!existsSync(path)) return null;
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function trimmedList(value, limit) {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item) => typeof item === "string" && item.trim() !== "")
		.map((item) => item.trim().slice(0, 200))
		.slice(0, limit);
}

/**
 * 写 handoff：列表字段截断、recent 只留最近 N 条、整体不超过 16KB。
 * @param {{ goal?: string, todos?: Array<{text: string, status?: string}>, open?: string[], recent?: Array<{tool: string, ok: boolean, note?: string}> }} input
 * @param {string} [path]
 * @returns {object} 实际落盘的对象
 */
export function writeHandoff(input = {}, path = handoffPath()) {
	const previous = readHandoff(path) ?? {};
	const recent = Array.isArray(input.recent) ? input.recent : Array.isArray(previous.recent) ? previous.recent : [];
	const next = {
		updatedAt: new Date().toISOString(),
		goal: typeof input.goal === "string" && input.goal.trim() !== "" ? input.goal.trim().slice(0, 200) : typeof previous.goal === "string" ? previous.goal : "",
		todos: Array.isArray(input.todos)
			? input.todos
				.filter((item) => item !== null && typeof item === "object" && typeof item.text === "string" && item.text.trim() !== "")
				.map((item) => ({ text: item.text.trim().slice(0, 160), status: ["pending", "in_progress", "completed"].includes(item.status) ? item.status : "pending" }))
				.slice(0, 20)
			: Array.isArray(previous.todos) ? previous.todos : [],
		open: trimmedList(input.open ?? previous.open, 12),
		recent: recent
			.filter((item) => item !== null && typeof item === "object" && typeof item.tool === "string")
			.map((item) => ({ tool: item.tool.slice(0, 60), ok: item.ok === true, ...(typeof item.note === "string" && item.note !== "" ? { note: item.note.slice(0, 80) } : {}) }))
			.slice(-HANDOFF_MAX_RECENT)
	};
	let text = `${JSON.stringify(next, null, 2)}\n`;
	if (Buffer.byteLength(text, "utf8") > HANDOFF_MAX_BYTES) {
		next.recent = next.recent.slice(-5);
		next.open = next.open.slice(0, 5);
		text = `${JSON.stringify(next, null, 2)}\n`;
	}
	mkdirSync(join(homeRoot(), "dsh-operator", "state"), { recursive: true });
	writeFileSync(path, text, "utf8");
	return next;
}

/**
 * 生成给新窗口看的一段摘要（≤1200 字符）。
 * @param {object | null} handoff
 * @returns {string}
 */
export function summarizeHandoff(handoff) {
	if (handoff === null) return "handoff: 无（新窗口第一次跑，还没有交接记录）";
	const lines = [];
	const updated = String(handoff.updatedAt ?? "").replace("T", " ").slice(0, 19);
	lines.push(`handoff: 上次 ${updated}${typeof handoff.goal === "string" && handoff.goal !== "" ? ` · 目标 ${handoff.goal}` : ""}`);
	const todos = Array.isArray(handoff.todos) ? handoff.todos : [];
	const openTodos = todos.filter((item) => item.status !== "completed");
	if (openTodos.length > 0) lines.push(`未完成：${openTodos.map((item) => item.text).join("；")}`);
	const open = Array.isArray(handoff.open) ? handoff.open : [];
	if (open.length > 0) lines.push(`待办：${open.join("；")}`);
	const recent = Array.isArray(handoff.recent) ? handoff.recent.slice(-5) : [];
	if (recent.length > 0) lines.push(`最近动作：${recent.map((item) => `${item.tool}${item.ok === true ? "" : "(失败)"}`).join(", ")}`);
	const text = lines.join("\n");
	return text.length > HANDOFF_MAX_CHARS ? `${text.slice(0, HANDOFF_MAX_CHARS)}…` : text;
}
