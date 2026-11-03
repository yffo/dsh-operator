// 跨窗口状态交接工具（0.63.0）：operator_brief 写、operator_resume 读。

import { audit } from "./audit-log.js";
import { readHandoff, summarizeHandoff, writeHandoff } from "./state-handoff.js";
import { recentActions } from "./recent-actions.js";
import { digestFailures, suggestForKind } from "./failure-store.js";

export const STATE_TOOL_NAMES = Object.freeze(["operator_brief", "operator_resume"]);

const SCHEMA_VERSION = 1;

function textOutput(description) {
	return {
		schema: {
			type: "object",
			additionalProperties: false,
			properties: {
				schemaVersion: { type: "number", required: true },
				text: { type: "string", required: true }
			}
		},
		render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }],
		_description: description
	};
}

/**
 * 注册交接工具。
 * @param {object} ctx 宿主上下文（需已注入 tools）。
 * @param {object} config 插件配置（未使用）。
 * @param {{defineTool:Function, version:string}} deps
 * @returns {{registered:boolean, names:string[]}}
 */
export function registerStateTools(ctx, config, { defineTool, version } = {}) {
	void config;
	void version;
	if (typeof ctx?.tools?.register !== "function") return { registered: false, names: [] };
	const register = (definition) => ctx.tools.register(defineTool(definition));

	register({
		name: "operator_brief",
		description:
			"Save a short handoff for the next window: goal, todos, open items and (optionally) the last few tool outcomes. Overwrites one file (~/.dsh/dsh-operator/state/handoff.json); never stores args or page text. Returns the saved summary.",
		parameters: {
			goal: { type: "string", description: "One line: what this window is trying to finish." },
			todos: { type: "array", items: { type: "string" }, description: "Checklist items (≤20); mark finished ones with the completed: prefix if needed." },
			open: { type: "array", items: { type: "string" }, description: "Things still owed (≤12)." },
			recent: { type: "array", items: { type: "object", additionalProperties: true }, description: "Optional recent tool outcomes, e.g. {tool:\"browser_click\", ok:true, note:\"p12:7\"}." }
		},
		output: textOutput("Save handoff"),
		isConcurrencySafe: () => false,
		presentCall: () => "Save handoff",
		execute: async (args) => {
			const todos = Array.isArray(args?.todos)
				? args.todos.map((item) => (typeof item === "string" ? { text: item.replace(/^completed:\s*/i, ""), status: /^completed:\s*/i.test(item) ? "completed" : "pending" } : item))
				: undefined;
			const explicitRecent = Array.isArray(args?.recent) && args.recent.length > 0 ? args.recent : undefined;
			// 0.84.0：本窗口没有动作时不要用空数组覆盖上一轮的 recent（会让交接里的「最近动作」永久丢失）
			const observedRecent = recentActions(5);
			const recent = explicitRecent ?? (observedRecent.length > 0 ? observedRecent : undefined);
			const saved = writeHandoff({ goal: args?.goal, todos, open: args?.open, recent });
			audit("operator_brief", { todos: saved.todos.length, open: saved.open.length });
			return { schemaVersion: SCHEMA_VERSION, text: summarizeHandoff(saved) };
		}
	});

	register({
		name: "operator_resume",
		description:
			"Read the handoff saved by a previous window (goal, todos, open items, recent tools) plus the current plugin/profile version gap. Use at the start of a new window before asking the user to re-explain.",
		parameters: {
			include_recent: { type: "boolean", default: true, description: "Include the current window's recent tool actions (last 3)." },
			include_failures: { type: "boolean", default: true, description: "Include the most common recent failure and its switch-strategy hint." }
		},
		output: textOutput("Read handoff"),
		isConcurrencySafe: () => true,
		presentCall: () => "Read handoff",
		execute: async (args) => {
			const handoff = readHandoff();
			audit("operator_resume", { found: handoff !== null });
			if (handoff === null) return { schemaVersion: SCHEMA_VERSION, text: "handoff: 无（新窗口第一次跑，还没有交接记录；可以用 operator_brief 写一条）" };
			const lines = [summarizeHandoff(handoff)];
			const current = args?.include_recent === false ? [] : recentActions(3);
			if (current.length > 0) lines.push(`本次窗口最近：${current.map((item) => `${item.tool}${item.ok === true ? "" : "(失败)"}`).join(", ")}`);
			try {
				if (args?.include_failures === false) throw new Error("skip");
				const digest = digestFailures({ recent: 3 });
				const hot = Array.isArray(digest.byPair) ? digest.byPair[0] : undefined;
				if (hot !== undefined && hot !== null && hot.count >= 2) {
					const kind = String(hot.key).split("·").pop();
					lines.push(`最近失败：${hot.key} ×${String(hot.count)} —— ${suggestForKind(kind)}`);
				}
			} catch {
				// 失败样本读不到就不提，别让 resume 失败。
			}
			const text = lines.join("\n");
			return { schemaVersion: SCHEMA_VERSION, text: text.length > 1200 ? `${text.slice(0, 1200)}…` : text };
		}
	});

	return { registered: true, names: [...STATE_TOOL_NAMES] };
}
