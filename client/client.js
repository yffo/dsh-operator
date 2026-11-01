/**
 * dsh-operator 客户端视图：一行状态。
 *
 * 决策（2026-11-02，杨总）：toolview 不再做活动卡片——只留「DSH 正在操作电脑」一行，
 * 避免步骤/缩略图/进度/日志这些重表达带来维护与 token 成本。需要细节时展开「调用详情」。
 *
 * 约束（test/client-bundle.test.mjs 盯着）：
 * - 经典脚本、零构建，只 require("react")；
 * - 不用 hooks（宿主可能直接当普通函数调用）；
 * - 每个 operator 工具一个 keyed 视图。
 */
window.__ModuleLoader__.load({
	id: "dsh-operator",
	factory(require) {
		const React = require("react");
		const h = React.createElement;

		/** 行标签：与 test/client-bundle.test.mjs 的 ROW_TOOLS 保持一致。 */
		const ROWS = {
			task_profile: "task profile",
			plan_create: "plan create",
			plan_update: "plan update",
			plan_run: "plan run",
			plan_list: "plan list",
			plan_delete: "plan delete",
			skill_save: "skill save",
			skill_run: "skill run",
			skill_list: "skill list",
			operator_status: "operator status",
			failure_list: "failures",
			ax_batch: "ax batch",
			browser_dom_probe: "browser probe",
			browser_dom_snapshot: "browser snapshot",
			browser_dom_click: "dom click",
			browser_dom_fill: "dom fill",
			cu_observe: "observe",
			cu_act: "act"
		};

		const KEYS = Object.keys(ROWS);
		const STYLE_ID = "dsh-operator-toolview-css";
		const CSS = [
			".dop-row{display:flex;align-items:center;gap:8px;padding:4px 2px;font-size:0.94em;line-height:1.5;color:inherit;flex-wrap:wrap}",
			".dop-row .dop-dot{flex:none;width:7px;height:7px;border-radius:50%;background:#94a3b8}",
			".dop-row[data-state=\"running\"] .dop-dot{background:#d97706;animation:dopBreath 1.8s ease-in-out infinite}",
			".dop-row[data-state=\"ok\"] .dop-dot{background:#16a34a}",
			".dop-row[data-state=\"error\"] .dop-dot{background:#dc2626}",
			".dop-row .dop-text{font-weight:520}",
			".dop-row .dop-tool{color:color-mix(in srgb,currentColor 55%,transparent);font-weight:400}",
			".dop-row .dop-state{color:color-mix(in srgb,currentColor 55%,transparent);font-weight:400}",
			"@keyframes dopBreath{0%,100%{opacity:1}50%{opacity:.35}}",
			"@media (prefers-reduced-motion: reduce){.dop-row[data-state=\"running\"] .dop-dot{animation:none}}"
		].join("\n");

		function ensureStyle() {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			(document.head || document.body).appendChild(style);
		}

		/** 结果文本：只要 text 块；没有就回退到 error 描述。 */
		function resultText(block) {
			if (block === null || typeof block !== "object") return null;
			const parts = [];
			if (Array.isArray(block.content)) {
				for (const item of block.content) {
					if (item && item.type === "text" && typeof item.text === "string") parts.push(item.text);
				}
			}
			if (parts.length > 0) return parts.join("\n").trim();
			const error = block.error;
			if (error && typeof error === "object") {
				return typeof error.message === "string" ? error.message : String(error.code ?? "");
			}
			return null;
		}

		function stripToolPrefix(text) {
			if (typeof text !== "string") return text;
			return text
				.replace(/^dsh[-_ ]?operator\s*[:：]\s*/i, "")
				.replace(/^operator\s*[:：]\s*/i, "")
				.trim();
		}

		function stateOf(block) {
			if (block === null || typeof block !== "object") return "running";
			if (!("kind" in block)) return "running";
			if (block.error && typeof block.error === "object" && block.error.code === "interrupted") return "stopped";
			return block.isError === true ? "error" : "ok";
		}

		function stateText(state) {
			if (state === "running") return "";
			if (state === "ok") return "已完成";
			if (state === "error") return "失败";
			return "已中断";
		}

		function durationText(block) {
			if (block === null || typeof block !== "object") return "";
			const start = typeof block.callTime === "number" ? block.callTime : null;
			const end = typeof block.time === "number" ? block.time : null;
			if (start === null || end === null) return "";
			const ms = Math.max(0, end - start);
			if (ms < 1000) return "";
			return `${(ms / 1000).toFixed(1)}s`;
		}

		function details(props, block) {
			const argsRaw = (block && (block.call?.argsRaw ?? block.argsRaw)) || "";
			const output = resultText(block);
			if (argsRaw === "" && output === null) return null;
			return h(
				"details",
				{ className: "dop-details" },
				h("summary", null, "调用详情"),
				argsRaw === "" ? null : h("pre", { className: "dop-pre" }, String(argsRaw).slice(0, 4000)),
				output === null ? null : h("pre", { className: "dop-pre" }, output.slice(0, 4000))
			);
		}

		function OperatorLine(props) {
			try {
				ensureStyle();
				const block = props && props.block;
				const tool = String((props && props.toolName) || (block && block.toolName) || "operator");
				const state = stateOf(block);
				const label = ROWS[tool] ?? tool;
				const stateLabel = stateText(state);
				const elapsed = durationText(block);
				return h(
					"div",
					{ className: "dop-row", "data-tool": tool, "data-state": state },
					h("span", { className: "dop-dot", "aria-hidden": "true" }),
					h("span", { className: "dop-text" }, "DSH 正在操作电脑"),
					h("span", { className: "dop-tool" }, label),
					stateLabel === "" ? null : h("span", { className: "dop-state" }, elapsed === "" ? stateLabel : `${stateLabel} ${elapsed}`),
					details(props, block)
				);
			} catch (error) {
				const message = error && error.message ? String(error.message) : String(error);
				const tool = props && typeof props.toolName === "string" ? props.toolName : "operator";
				return h(
					"div",
					{ "data-tool": tool, "data-state": "error", style: { padding: "4px 6px", fontSize: "0.92em", opacity: 0.8 } },
					"dsh-operator · ",
					message.slice(0, 160)
				);
			}
		}

		return {
			/**
			 * 客户端插件必须显式声明依赖的服务：宿主 ctx 默认不注入 slots，
			 * 直接读 ctx.slots 会抛 cannot get property "slots" without inject，
			 * 表现为启动时 "web boot: 1 entry did not activate / dsh-operator: failed"。
			 */
			inject: ["slots"],
			apply(ctx) {
				for (const key of KEYS) {
					ctx.slots.inject("tool.call.toolview", () =>
						ctx.slots.register({ name: "tool.call.toolview", key }, OperatorLine)
					);
				}
			}
		};
	}
});
