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
		options.signal?.throwIfAborted?.();
		try {
			const execute = handlers.get(tool)?.execute ?? fallback.get(tool);
			const value = await execute(step.args ?? {}, { signal: options.signal });
			executed += 1;
			const summary = summarizeValue(value);
			results.push({ id, tool, status: "ok", ...(summary === "" ? {} : { summary }) });
			options.onStep?.({ id, tool, status: "ok" });
		} catch (error) {
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
