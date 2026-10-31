/**
 * dsh-operator —— Web 客户端半侧（0.15.0，手写、零构建链）。
 *
 * 客户端模块系统要求的格式就是一句 `window.__ModuleLoader__.load({ id, factory })`；
 * factory 里 `require('react')` 拿到的是外壳冻结的平台基座，因此本文件不引入任何依赖，
 * 也不走打包器。它只做一件事：把本插件自己的 wire 工具在对话里的卡片换成一个紧凑的行视图
 * （工具名 / 状态 / 一行摘要 / 展开看参数与结果全文）。
 *
 * 数据全部来自 ToolCallOwnerProps 的冻结 `block`，不从宿主拉取额外状态；
 * 渲染失败时保持最小信息（工具名 + 状态），不会影响其他卡片。
 *
 * 改这个文件后刷新页面即可生效（客户端 bundle 走 HMR 的 rebuilt 通道）；
 * 但 dsh.client 声明首次生效需要重启 App。
 */
window.__ModuleLoader__.load({
	id: "dsh-operator",
	factory: (require) => {
		const React = require("react");
		const h = React.createElement;

		const ROWS = {
			task_profile: "Task profile",
			plan_create: "Create plan",
			plan_update: "Update plan",
			plan_run: "Run plan",
			plan_list: "List plans",
			plan_delete: "Delete plan",
			skill_save: "Save skill",
			skill_run: "Run skill",
			skill_list: "List skills",
			operator_status: "Operator status",
			failure_list: "Failures",
			browser_dom_probe: "Browser channels",
			browser_dom_snapshot: "DOM snapshot",
			browser_dom_click: "DOM click",
			browser_dom_fill: "DOM fill",
			cu_observe: "cu observe",
			cu_act: "cu act"
		};
		const KEYS = Object.keys(ROWS);

		function parseArgs(raw) {
			if (typeof raw !== "string" || raw.trim() === "") return null;
			try {
				return JSON.parse(raw);
			} catch {
				return null;
			}
		}

		/** 已结算块的状态；未结算（还在运行）时返回 running。 */
		function stateOf(block) {
			if (!("kind" in block)) return "running";
			if (block.error?.code === "interrupted") return "stopped";
			return block.isError === true ? "error" : "ok";
		}

		/** 结果文本：只取 text 内容，忽略图片等二进制块。 */
		function resultText(block) {
			if (!("kind" in block)) return null;
			const parts = [];
			for (const item of Array.isArray(block.content) ? block.content : []) {
				if (item?.type === "text" && typeof item.text === "string") parts.push(item.text);
			}
			if (parts.length === 0 && block.error !== void 0) parts.push(`${block.error.name}: ${block.error.code}`);
			const text = parts.join("\n").trim();
			return text === "" ? null : text;
		}

		function firstLine(text) {
			if (typeof text !== "string") return "";
			const line = text.split("\n").find((entry) => entry.trim() !== "") ?? "";
			return line.length > 160 ? `${line.slice(0, 157)}…` : line;
		}

		/** 结果文本首行常带 "tool: " 前缀，展示时去掉，避免和左侧标签重复。 */
		function stripToolPrefix(line, tool) {
			const prefix = `${tool}: `;
			return line.startsWith(prefix) ? line.slice(prefix.length) : line;
		}

		/** 摘要：优先从结果里挑信息量最高的一行；运行中则用参数里最有辨识度的字段。 */
		function summaryOf(tool, block, args, output) {
			if (output !== null) {
				if (tool === "operator_status") {
					const versionLine = output.split("\n").find((line) => line.startsWith("dsh-operator")) ?? firstLine(output);
					return firstLine(versionLine);
				}
				return stripToolPrefix(firstLine(output), tool);
			}
			if (args !== null) {
				for (const key of ["goal", "id", "name", "kind", "expect_title"]) {
					const value = args[key];
					if (typeof value === "string" && value.trim() !== "") return firstLine(value);
				}
			}
			return block.callId ?? "";
		}

		/**
		 * 三类富卡片：失败样本/浏览器通道/技能列表。
		 * 只解析工具已经返回的文本（不额外拉宿主状态），解析失败时回退到通用首行摘要。
		 */
		function richSummary(tool, output) {
			if (output === null) return null;
			if (tool === "browser_dom_probe") {
				const applescript = /AppleScript: ([^;]+)/.exec(output)?.[1] ?? "unknown";
				const cdp = /CDP: ([^;]+?); config browserCdpPort/.exec(output)?.[1] ?? "unknown";
				const ready = applescript.startsWith("ready") || cdp.startsWith("ready");
				return {
					summary: `channels · AppleScript ${applescript} · CDP ${cdp}`,
					tone: ready ? "ok" : "warn"
				};
			}
			if (tool === "browser_dom_snapshot") {
				const match = /^DOM snapshot: (.*) \((.*)\) — (\d+) links, (\d+) controls$/.exec(output);
				if (match === null) return { summary: firstLine(output), tone: "ok" };
				return {
					summary: `${match[1]} — ${match[3]} links / ${match[4]} controls`,
					extra: [`url: ${match[2]}`],
					tone: "ok"
				};
			}
			if (tool === "skill_list") {
				if (/^No saved skills yet/.test(output)) return { summary: "no saved skills", tone: "ok" };
				const skills = [...output.matchAll(/(^|[\s,])?([\w][\w-]*)\((\d+) steps\)/g)].map((m) => `${m[2]}(${m[3]})`);
				return {
					summary: `${skills.length} skill(s)${skills.length === 0 ? "" : ` · ${skills.join(", ")}`}`,
					extra: skills.length === 0 ? [] : [`skills: ${skills.join(", ")}`],
					tone: "ok"
				};
			}
			if (tool === "failure_list") {
				const total = Number(/^failures: (\d+)/m.exec(output)?.[1] ?? "0");
				const kindLine = /by kind: (.+)/.exec(output)?.[1];
				if (total === 0) return { summary: "no failures", tone: "ok" };
				return {
					summary: `${total} failure(s)${kindLine === void 0 ? "" : ` · ${kindLine}`}`,
					extra: output
						.split("\n")
						.filter((line) => line.startsWith("by tool:") || line.startsWith("recent:"))
						.slice(0, 2),
					tone: "warn"
				};
			}
			if (tool === "operator_status") {
				const versionLine = /dsh-operator[^\n]*/.exec(output)?.[0] ?? firstLine(output);
				const counts = /skills:? [^\n]*/.exec(output)?.[0];
				const failures = /failures?[^\n]*/i.exec(output)?.[0];
				const parts = [versionLine, counts, failures].filter((entry) => typeof entry === "string" && entry.trim() !== "");
				return {
					summary: parts.join(" · "),
					extra: output.split("\n").filter((line) => /failure|audit/i.test(line)),
					tone: "ok"
				};
			}
			return null;
		}

		const COLORS = {
			running: "#d97706",
			ok: "#16a34a",
			error: "#dc2626",
			stopped: "#64748b"
		};

		function Dot({ state }) {
			return h("span", {
				"aria-hidden": true,
				style: {
					display: "inline-block",
					width: 7,
					height: 7,
					borderRadius: "50%",
					background: COLORS[state] ?? COLORS.stopped,
					flex: "0 0 auto"
				}
			});
		}

		function OperatorRow(props) {
			try {
				return renderRow(props);
			} catch (error) {
				const message = error && error.message ? String(error.message) : String(error);
				const tool = props && typeof props.toolName === "string" ? props.toolName : "operator";
				return h(
					"div",
					{ "data-tool": tool, "data-state": "error", style: { padding: "5px 8px", fontSize: "0.92em", opacity: 0.8 } },
					h(Dot, { state: "error" }),
					" ",
					tool,
					" · card error: ",
					message.slice(0, 160)
				);
			}
		}

		/** 无 hooks 版本：用原生 <details> 做展开，避免宿主以普通函数方式调用视图时 hook 报错。 */
		function renderRow(props) {
			const block = props && props.block;
			if (block === null || typeof block !== "object") throw new Error(`unexpected block: ${typeof block}`);
			const state = stateOf(block);
			const settled = "kind" in block;
			const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? "";
			const args = parseArgs(argsRaw);
			const output = resultText(block);
			const tool = String((props && props.toolName) || block.toolName || "operator");
			const label = ROWS[tool] ?? tool;
			const summary = summaryOf(tool, block, args, output);
			const rich = richSummary(tool, output);
			const headSummary = rich === null ? summary : rich.summary;
			const expandable = args !== null || output !== null;
			const head = h(
				"summary",
				{
					style: {
						display: "flex",
						alignItems: "baseline",
						gap: 8,
						cursor: expandable ? "pointer" : "default",
						listStyle: "none",
						minWidth: 0
					}
				},
				h(Dot, { state }),
				h("span", { style: { fontWeight: 600, flex: "0 0 auto" } }, label),
				h(
					"span",
					{ style: { opacity: 0.72, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 } },
					headSummary
				),
				expandable ? h("span", { style: { opacity: 0.5, flex: "0 0 auto", marginLeft: "auto" } }, "▾") : null
			);
			const extraNodes = rich !== null && Array.isArray(rich.extra) && rich.extra.length > 0
				? [
					h(
						"div",
						{ style: { opacity: 0.66, fontSize: "0.88em", display: "grid", gap: 2 } },
						...rich.extra.map((line, index) => h("div", { key: `extra-${index}` }, line))
					)
				]
				: [];
			const body = expandable
				? h(
					"div",
					{ style: { marginTop: 6, display: "grid", gap: 6 } },
					...extraNodes,
					args !== null
						? h(
							"pre",
							{
								style: {
									margin: 0,
									padding: "6px 8px",
									borderRadius: 6,
									background: "color-mix(in srgb, currentColor 7%, transparent)",
									overflow: "auto",
									maxHeight: 200,
									fontSize: "0.9em",
									whiteSpace: "pre-wrap",
									wordBreak: "break-word"
								}
							},
							JSON.stringify(args, null, 2)
						)
						: null,
					output !== null
						? h(
							"pre",
							{
								style: {
									margin: 0,
									padding: "6px 8px",
									borderRadius: 6,
									background: "color-mix(in srgb, currentColor 5%, transparent)",
									overflow: "auto",
									maxHeight: 260,
									fontSize: "0.9em",
									whiteSpace: "pre-wrap",
									wordBreak: "break-word"
								}
							},
							output
						)
						: null
				)
				: null;
			return h(
				"details",
				{
					"data-tool": tool,
					"data-state": state,
					"data-expandable": expandable ? "true" : void 0,
					"data-tone": rich === null ? void 0 : rich.tone,
					style: {
						padding: "5px 8px",
						borderTop: "1px dashed color-mix(in srgb, currentColor 16%, transparent)",
						fontSize: "0.92em"
					}
				},
				head,
				body
			);
		}

		return {
			name: "dsh-operator-client",
			inject: ["slots"],
			apply(ctx) {
				for (const key of KEYS) {
					ctx.slots.inject("tool.call.toolview", () =>
						ctx.slots.register({ name: "tool.call.toolview", key }, OperatorRow)
					);
				}
			}
		};
	}
});
