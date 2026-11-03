// 计划模板（0.70.0）
//
// 复杂度分层（task_profile）已经能判断 simple / standard / complex，但计划还是全手写。
// 这一层把「观察在前、校验在后」这类固定护栏做成模板：
//
//   plan_create { goal, steps, template: "verify-around" }
//   → [auto-observe] + 你自己的步骤 + [auto-verify]
//
// 模板只做「加护栏」，不替你想业务动作；id 冲突时会自动加后缀。
//
// 注意（0.84.0）：auto-observe / auto-verify 只是**观察**（list_windows / screenshot），
// 它们本身**不带断言**——"verify" 指的是"执行前后各看一眼"，比对仍要靠你在步骤里写
// expect 或 verify。别把「计划 done」误当成「结果已验证」。

/** 观察步：先看当前有哪些窗口，避免盲点。 */
const OBSERVE_STEP = { id: "auto-observe", tool: "list_windows", args: {} };
/** 收尾观察步：动作前后各跑一次，比对窗口变化即为校验（永远可执行，无占位符）。 */
const VERIFY_STEP = { id: "auto-verify", tool: "list_windows", args: {} };
/** 跨应用收尾：额外留一张截图当证据。 */
const EVIDENCE_STEP = { id: "auto-evidence", tool: "screenshot", args: {} };

export const TEMPLATE_NAMES = Object.freeze(["verify-around", "observe-only", "cross-app"]);

/**
 * 把模板套到用户给定的步骤上。
 * @param {string} template
 * @param {Array<{id: string, tool: string, args?: object}>} steps
 * @returns {{ steps: Array<object>, applied: string[] }}
 */
export function applyTemplate(template, steps) {
	const list = Array.isArray(steps) ? steps.map((step) => ({ ...step })) : [];
	if (typeof template !== "string" || template === "") return { steps: list, applied: [] };
	const used = new Set(list.map((step) => String(step?.id ?? "")));
	const unique = (base) => {
		if (!used.has(base)) {
			used.add(base);
			return base;
		}
		let n = 2;
		while (used.has(`${base}-${String(n)}`)) n += 1;
		used.add(`${base}-${String(n)}`);
		return `${base}-${String(n)}`;
	};
	const withId = (step) => ({ ...step, id: unique(step.id) });

	switch (template) {
		case "observe-only":
			return { steps: [withId(OBSERVE_STEP), ...list], applied: ["observe-only"] };
		case "verify-around":
			return { steps: [withId(OBSERVE_STEP), ...list, withId(VERIFY_STEP)], applied: ["verify-around"] };
		case "cross-app":
			return {
				steps: [withId(OBSERVE_STEP), ...list, withId(VERIFY_STEP), withId(EVIDENCE_STEP)],
				applied: ["cross-app"]
			};
		default:
			throw new Error(`unknown plan template: ${template} (use ${TEMPLATE_NAMES.join(" / ")})`);
	}
}

/**
 * 按 task_profile 的结果给出建议模板。
 * @param {{ tier?: string, matched?: string[] }} profile
 * @returns {string | null}
 */
export function suggestTemplate(profile) {
	const tier = String(profile?.tier ?? "");
	const matched = Array.isArray(profile?.matched) ? profile.matched : [];
	const appsSignal = matched.some((item) => String(item).startsWith("apps:"));
	if (tier === "complex") return appsSignal ? "cross-app" : "verify-around";
	if (tier === "standard") return "verify-around";
	return null;
}
