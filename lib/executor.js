/**
 * 步骤执行器（0.12.1）：把技能/计划里的 {tool, args} 列表按顺序交给已注册工具执行。
 *
 * 约定：
 * - 优先执行「本插件自己注册的扩展工具」（handlers 表）；0.31.1 起允许经 fallback 传入
 *   宿主基础的 GUI 动作（click / input_text / hotkey 等），让技能能回放真实操作；
 * - 不允许递归执行 skill_run / plan_run 自身；
 * - 每步结果只保留状态 + 简短文本（不回显图片/base64），避免日志膨胀和敏感值外泄；
 * - stopOnError 默认 true：任一步失败即停，后续步标 skipped。
 */

const MAX_SUMMARY_CHARS = 200;
/** 渲染文案上限（0.82.0 提高到 20000，断言不再受 400 字限制）。 */
const MAX_RENDER_CHARS = 20000;

/**
 * 取工具的人类可读文案（output.render 的拼接结果），用于步骤级 expect 断言。
 * 0.78.0：expect 原先只能看到字段摘要（如 "schemaVersion,ok,path"），看不到
 * 「Invoked menu …」这类真正写给用户看的文案。
 * @param {{render?: Function}|undefined} entry
 * @param {object} args
 * @param {unknown} value
 * @returns {string|undefined}
 */
function renderText(entry, args, value) {
	try {
		const blocks = entry?.render?.(args, value);
		if (Array.isArray(blocks) === false) return undefined;
		const text = blocks
			.map((block) => (block !== null && typeof block === "object" && typeof block.text === "string" ? block.text : ""))
			.filter((item) => item !== "")
			.join("\n");
		// 0.82.0：展示可截断，但断言必须看全文——否则 absent 会假成功、contains 会假失败
		return text === "" ? undefined : text.slice(0, MAX_RENDER_CHARS);
	} catch {
		return undefined;
	}
}

/**
 * 不截断的摘要（0.84.0）：expect 断言要用全文。
 * fallback 工具（GUI/浏览器）没有 render，只能靠它。
 * @param {unknown} value
 * @returns {string}
 */
export function summarizeValueFull(value) {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value.slice(0, MAX_RENDER_CHARS);
	if (typeof value !== "object") return String(value).slice(0, MAX_RENDER_CHARS);
	if (typeof value.error === "string" && value.error.length > 0) return `error: ${value.error}`.slice(0, MAX_RENDER_CHARS);
	if (typeof value.text === "string") return value.text.slice(0, MAX_RENDER_CHARS);
	const keys = Object.keys(value).filter((key) => typeof value[key] !== "object");
	return `${keys.slice(0, 6).join(",")}${keys.length > 6 ? ",…" : ""}`.slice(0, MAX_RENDER_CHARS);
}

export function summarizeValue(value) {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value.slice(0, MAX_SUMMARY_CHARS);
	if (typeof value !== "object") return String(value).slice(0, MAX_SUMMARY_CHARS);
	if (typeof value.error === "string" && value.error.length > 0) return `error: ${value.error}`.slice(0, MAX_SUMMARY_CHARS);
	if (typeof value.text === "string") return value.text.slice(0, MAX_SUMMARY_CHARS);
	const keys = Object.keys(value).filter((key) => typeof value[key] !== "object");
	return `${keys.slice(0, 6).join(",")}${keys.length > 6 ? ",…" : ""}`.slice(0, MAX_SUMMARY_CHARS);
}

/**
 * @param {{id?: string, tool: string, args?: object}[]} steps
 * @param {{
 *   handlers: Map<string, {execute: Function}>,
 *   allowedTools?: Set<string>,
 *   signal?: {throwIfAborted?: Function},
 *   stopOnError?: boolean,
 *   dryRun?: boolean,
 *   onStep?: (update: {id: string, tool: string, status: string, error?: string}) => void
 * }} options
 */
export async function executeSteps(steps, options) {
	const handlers = options.handlers;
	const fallback = options.fallback instanceof Map ? options.fallback : new Map();
	const resolvable = (name) => handlers.has(name) || fallback.has(name);
	const allowed = options.allowedTools ?? new Set([...handlers.keys(), ...fallback.keys()]);
	const stopOnError = options.stopOnError !== false;
	const dryRun = options.dryRun === true;
	// 0.76.0：把调用者上下文透传给每一步（GUI 工具要靠 exec.agent 解析模型路由）
	const stepContext = { ...(options.stepContext === undefined ? {} : options.stepContext) };
	if (!(handlers instanceof Map)) throw new Error("executeSteps: handlers Map is required");
	if (Array.isArray(steps) === false || steps.length === 0) throw new Error("executeSteps: non-empty steps array is required");

	const results = [];
	let failed = 0;
	let executed = 0;
	let skipped = 0;
	let stopped = false;
	for (const [index, rawStep] of steps.entries()) {
		const step = rawStep ?? {};
		const id = String(step.id ?? `step-${index + 1}`);
		const tool = String(step.tool ?? "");
		if (stopped) {
			skipped += 1;
			results.push({ id, tool, status: "skipped", ...(dryRun ? { dryRun: true } : {}) });
			options.onStep?.({ id, tool, status: "skipped" });
			continue;
		}
		if (tool === "" || resolvable(tool) === false || tool === "skill_run" || tool === "plan_run" || allowed.has(tool) === false) {
			failed += 1;
			stopped = stopOnError;
			const error = `unsupported tool: ${tool}`;
			results.push({ id, tool, status: "failed", error, ...(dryRun ? { dryRun: true } : {}) });
			options.onStep?.({ id, tool, status: "failed", error });
			continue;
		}
		if (dryRun) {
			executed += 1;
			results.push({ id, tool, status: "dry-run" });
			options.onStep?.({ id, tool, status: "dry-run" });
			continue;
		}
		// 0.113.0：执行前先落「正在跑」，中断后计划里才看得出死在第几步（见 plan_run 的残留检测）。
		options.onStep?.({ id, tool, status: "running" });
		try {
			// 0.84.0：放进 try，abort 时也能返回已完成的 results
			options.signal?.throwIfAborted?.();
			const entry = handlers.get(tool);
			const execute = entry?.execute ?? fallback.get(tool);
			const value = await execute(step.args ?? {}, { ...stepContext, signal: options.signal });
			executed += 1;
			const summary = summarizeValue(value);
			// 0.75.0：步骤级校验——动作执行成功不代表达到预期
			if (typeof options.afterStep === "function") {
				const displayText = renderText(entry, step.args ?? {}, value);
				// 0.84.0：fallback 工具没有 render，之前只能拿到 200 字摘要 → 长文本断言假绿
				const fullText = displayText ?? summarizeValueFull(value);
				const verdict = await options.afterStep({ id, tool, step, value, summary, text: fullText });
				// 0.82.0：判失败的条件放宽成「明确不是 ok」，避免实现写错时静默全绿
				const failedVerdict = verdict === false
					|| (verdict !== null && typeof verdict === "object" && verdict.ok !== true);
				if (failedVerdict) {
					failed += 1;
					stopped = stopOnError;
					const reason = String(verdict.reason ?? "expectation not met").slice(0, 300);
					results.push({ id, tool, status: "failed", error: reason, ...(summary === "" ? {} : { summary }) });
					options.onStep?.({ id, tool, status: "failed", error: reason });
					continue;
				}
			}
			results.push({ id, tool, status: "ok", ...(summary === "" ? {} : { summary }) });
			options.onStep?.({ id, tool, status: "ok" });
		} catch (error) {
			const aborted = error?.name === "AbortError" || error?.code === "ABORT_ERR";
			if (aborted) {
				// 0.84.0：中断不是失败，也不该吞掉已完成的步骤
				// 0.113.0：onStep 用 pending 把刚落的 running 退回去，别把计划卡在「永远正在跑」
				stopped = true;
				skipped += 1;
				results.push({ id, tool, status: "skipped", ...(dryRun ? { dryRun: true } : {}) });
				options.onStep?.({ id, tool, status: "pending", error: "aborted" });
				continue;
			}
			failed += 1;
			stopped = stopOnError;
			const message = error instanceof Error ? error.message : String(error);
			results.push({ id, tool, status: "failed", error: message.slice(0, 300) });
			options.onStep?.({ id, tool, status: "failed", error: message.slice(0, 300) });
		}
	}
	return { ok: failed === 0 && skipped === 0, executed, failed, skipped, results };
}

export function summarizeResults(run) {
	const parts = run.results.map((item) => `${item.id}:${item.status}${item.error ? `(${item.error.slice(0, 60)})` : ""}`);
	return `executed ${run.executed}, failed ${run.failed}, skipped ${run.skipped} — ${parts.join("; ")}`.slice(0, 600);
}
