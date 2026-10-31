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
			browser_dom_probe: "Browser channels"
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

		/** 摘要：优先从结果里挑信息量最高的一行；运行中则用参数里最有辨识度的字段。 */
		function summaryOf(tool, block, args, output) {
			if (output !== null) {
				if (tool === "operator_status") {
					const versionLine = output.split("\n").find((line) => line.startsWith("dsh-operator")) ?? firstLine(output);
					return firstLine(versionLine);
				}
				if (tool === "task_profile") return firstLine(output);
				if (tool === "plan_list" || tool === "skill_list") return firstLine(output);
				return firstLine(output);
			}
			if (args !== null) {
				for (const key of ["goal", "id", "name", "kind", "expect_title"]) {
					const value = args[key];
					if (typeof value === "string" && value.trim() !== "") return firstLine(value);
				}
			}
			return block.callId ?? "";
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
			const tool = String(block.toolName ?? "operator");
			const label = ROWS[tool] ?? tool;
			const summary = summaryOf(tool, block, args, output);
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
					summary
				),
				expandable ? h("span", { style: { opacity: 0.5, flex: "0 0 auto", marginLeft: "auto" } }, "▾") : null
			);
			const body = expandable
				? h(
					"div",
					{ style: { marginTop: 6, display: "grid", gap: 6 } },
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
