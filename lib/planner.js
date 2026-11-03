/**
 * 任务计划（0.12.0 起步）：把「目标 + 有序步骤」落成 JSON，供模型跨轮次/跨会话接着做。
 *
 * 存储：~/.dsh/dsh-operator/plans/<id>.json（默认最多 50 个）。
 * 只存工具名 + 参数（敏感键拒绝），不存截图/剪贴板/密码；写入用临时文件 + rename。
 * 执行器在 0.12.1 接（按步骤调用工具 + 校验 + 中断恢复）；本版负责建计划、推进状态、查询。
 */
import { validateExpect, validateVerify } from "./skill-expect.js";
import { containsSensitiveKey } from "./sensitive.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

const ID_RE = /^plan-[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/;
const MAX_PLANS = 50;
const MAX_STEPS = 60;
const STATUSES = new Set(["pending", "running", "done", "failed", "skipped"]);
const SENSITIVE_KEY_RE = /(password|passwd|secret|token|api[-_]?key|credential|cookie)/i;

let overrides = {};

export function configurePlanStore(options = {}) {
	overrides = { ...options };
}

export function planDir() {
	return overrides.dir ?? process.env.DSH_OPERATOR_PLAN_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-operator", "plans");
}

function planPath(id) {
	if (ID_RE.test(String(id ?? "")) === false) throw new Error(`invalid plan id: ${id}`);
	return join(planDir(), `${id}.json`);
}

/** 单步参数上限（0.84.0，与技能 args 对齐）。 */
const MAX_STEP_ARGS_BYTES = 8192;
/** goal / note 上限（0.84.0）。 */
const MAX_TEXT_CHARS = 2000;

export function validatePlan(plan) {
	const errors = [];
	if (typeof plan !== "object" || plan === null) return { ok: false, errors: ["plan must be an object"] };
	if (typeof plan.goal !== "string" || plan.goal.trim().length < 4) errors.push("goal is required (>=4 chars)");
	else if (plan.goal.length > MAX_TEXT_CHARS) errors.push(`goal too long (<=${MAX_TEXT_CHARS} chars)`);
	if (plan.note !== undefined && String(plan.note).length > MAX_TEXT_CHARS) errors.push(`note too long (<=${MAX_TEXT_CHARS} chars)`);
	if (Array.isArray(plan.steps) === false || plan.steps.length === 0) errors.push("steps must be a non-empty array");
	else if (plan.steps.length > MAX_STEPS) errors.push(`steps too many (<=${MAX_STEPS})`);
	else {
		const seen = new Set();
		plan.steps.forEach((step, index) => {
			if (typeof step?.tool !== "string" || step.tool.trim() === "") errors.push(`steps[${index}].tool is required`);
			const id = String(step?.id ?? "");
			if (id === "" || /^[a-z0-9][a-z0-9-]{0,31}$/.test(id) === false) errors.push(`steps[${index}].id must be kebab-case (<=32 chars)`);
			else if (seen.has(id)) errors.push(`steps[${index}].id duplicated: ${id}`);
			seen.add(id);
			if (step?.args !== undefined && (typeof step.args !== "object" || step.args === null || Array.isArray(step.args))) errors.push(`steps[${index}].args must be an object`);
			// 0.84.0：递归扫描（嵌套 password 之前能绕过）
			if (step?.args !== undefined && containsSensitiveKey(step.args)) errors.push(`steps[${index}].args looks sensitive (nested keys included)`);
			// 0.84.0：expect/verify 与技能共用同一套校验，避免"建得进去、跑起来才报非法"
			for (const problem of validateVerify(step?.verify)) errors.push(`steps[${index}].${problem}`);
			for (const problem of validateExpect(step?.expect)) errors.push(`steps[${index}].${problem}`);
			// 0.84.0：字段大小上限（与技能 args 对齐）
			if (step?.args !== undefined && Buffer.byteLength(JSON.stringify(step.args)) > MAX_STEP_ARGS_BYTES) errors.push(`steps[${index}].args too large (<=${MAX_STEP_ARGS_BYTES} bytes)`);
		});
	}
	return { ok: errors.length === 0, errors };
}

function newPlanId() {
	const now = new Date();
	const pad = (value) => String(value).padStart(2, "0");
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const suffix = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
	return `plan-${stamp}-${suffix}`;
}

function normalizePlan({ goal, steps, tier, note }) {
	// 0.84.0：缺 steps 时给空数组（由校验报错），缺 id/tool 不要 String(undefined) 变成字面量
	const list = Array.isArray(steps) ? steps : [];
	return {
		goal: String(goal ?? "").trim(),
		...(tier === undefined ? {} : { tier: String(tier) }),
		status: "pending",
		steps: list.map((step) => ({
			id: typeof step?.id === "string" ? step.id : "",
			tool: typeof step?.tool === "string" ? step.tool : "",
			...(step?.args === undefined ? {} : { args: step.args }),
			...(step?.verify === undefined ? {} : { verify: step.verify }),
			// 0.82.0：expect 之前被悄悄丢掉，导致 plan_run 的断言永不执行
			...(step?.expect === undefined ? {} : { expect: step.expect }),
			status: "pending"
		})),
		...(note === undefined ? {} : { note: String(note) }),
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		version: 1
	};
}

export function createPlan(input) {
	const candidate = normalizePlan(input);
	const validation = validatePlan(candidate);
	if (validation.ok === false) throw new Error(`invalid plan: ${validation.errors.join("; ")}`);
	mkdirSync(planDir(), { recursive: true });
	// 0.84.0：listPlans 默认只取 20 条，用它判上限永远不触发
	if (countPlans() >= MAX_PLANS) throw new Error(`too many plans (max ${MAX_PLANS})`);
	// 0.84.0：用 wx 建文件，撞 id 就换一个，绝不覆盖已有计划
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const id = newPlanId();
		const path = planPath(id);
		const body = `${JSON.stringify({ id, ...candidate }, null, 2)}\n`;
		try {
			writeFileSync(path, body, { flag: "wx" });
			return { id, path, plan: { id, ...candidate } };
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
		}
	}
	throw new Error("could not allocate a unique plan id (5 attempts)");
}

/** 计划文件总数（0.84.0：上限判定用，不再依赖 listPlans 的默认 limit）。 */
export function countPlans() {
	const dir = planDir();
	if (existsSync(dir) === false) return 0;
	return readdirSync(dir).filter((entry) => entry.endsWith(".json")).length;
}

/** 读计划目录，返回计划与坏文件数（0.84.0：坏文件不再无声消失）。 */
export function readPlans({ limit = 20 } = {}) {
	const dir = planDir();
	if (existsSync(dir) === false) return { plans: [], corrupt: 0 };
	const plans = [];
	let corrupt = 0;
	for (const entry of readdirSync(dir)) {
		if (entry.endsWith(".json") === false) continue;
		try {
			plans.push(JSON.parse(readFileSync(join(dir, entry), "utf8")));
		} catch {
			corrupt += 1;
		}
	}
	const sorted = plans
		.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
		.slice(0, Math.max(1, Number(limit) || 20));
	return { plans: sorted, corrupt };
}

export function listPlans({ limit = 20 } = {}) {
	return readPlans({ limit }).plans;
}

export function readPlan(id) {
	const path = planPath(id);
	if (existsSync(path) === false) throw new Error(`plan not found: ${id}`);
	return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * 计划的进度快照（0.68.0）：总数、完成数、下一步与它要用的工具。
 * 0.113.0：补 `runningStep`/`runningTool`——中断后能直接看出「停在哪一步」。
 * 纯函数，给 plan_run 与 operator_status 共用同一个口径。
 * @param {object} plan
 * @returns {{ total:number, done:number, pending:number, failed:number, skipped:number, running:number, runningStep:string|null, runningTool:string|null, nextStep:string|null, nextTool:string|null, remaining:number }}
 */
export function planProgress(plan) {
	const counts = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 };
	const steps = Array.isArray(plan?.steps) ? plan.steps : [];
	for (const step of steps) {
		const status = step?.status ?? "pending";
		if (Object.prototype.hasOwnProperty.call(counts, status)) counts[status] += 1;
		else counts.pending += 1;
	}
	const next = steps.find((step) => (step?.status ?? "pending") === "pending");
	const running = steps.find((step) => (step?.status ?? "pending") === "running");
	// 0.114.0：断言覆盖——有 expect/verify 的步数，「执行完」和「结果已验证」不该混为一谈
	const asserted = steps.filter((step) => step?.expect !== undefined || step?.verify !== undefined).length;
	return {
		total: steps.length,
		done: counts.done,
		pending: counts.pending,
		failed: counts.failed,
		skipped: counts.skipped,
		running: counts.running,
		asserted,
		runningStep: running?.id ?? null,
		runningTool: typeof running?.tool === "string" ? running.tool : null,
		nextStep: next?.id ?? null,
		nextTool: typeof next?.tool === "string" ? next.tool : null,
		remaining: counts.pending + counts.running
	};
}

function summarize(plan) {
	const progress = planProgress(plan);
	return {
		id: plan.id,
		goal: plan.goal,
		status: plan.status,
		counts: { pending: progress.pending, running: progress.running, done: progress.done, failed: progress.failed, skipped: progress.skipped },
		nextStep: progress.nextStep,
		// 0.68.0：下一步用什么工具，回包里直接可读
		nextTool: progress.nextTool,
		// 0.113.0：正在跑的那一步（中断后会留着，供上层提示「停在哪」）
		runningStep: progress.runningStep,
		runningTool: progress.runningTool,
		// 0.114.0：断言覆盖（有 expect/verify 的步数）
		asserted: progress.asserted,
		total: progress.total,
		doneSteps: progress.done,
		updatedAt: plan.updatedAt
	};
}

/**
 * 更新某一步的状态（以及计划整体状态）。返回新的计划摘要。
 */
export function updatePlan(id, { stepId, status, note } = {}) {
	const plan = readPlan(id);
	if (STATUSES.has(String(status)) === false) throw new Error(`invalid step status: ${status} (use ${[...STATUSES].join("/")})`);
	const step = plan.steps.find((item) => item.id === String(stepId));
	if (!step) throw new Error(`step not found: ${stepId}`);
	step.status = String(status);
	if (note !== undefined) step.note = String(note);
	const now = new Date().toISOString();
	plan.updatedAt = now;
	const anyFailed = plan.steps.some((item) => item.status === "failed");
	const anyRunning = plan.steps.some((item) => item.status === "running");
	const allDone = plan.steps.every((item) => item.status === "done" || item.status === "skipped");
	plan.status = anyFailed ? "failed" : allDone ? "done" : anyRunning ? "running" : plan.steps.some((item) => item.status === "done") ? "running" : "pending";
	const body = `${JSON.stringify(plan, null, 2)}\n`;
	const path = planPath(id);
	// 0.84.0：并发写同一计划时固定 tmp 名会互相覆盖
	const tmp = join(planDir(), `.${id}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
	writeFileSync(tmp, body);
	renameSync(tmp, path);
	return { plan, summary: summarize(plan) };
}

export function deletePlan(id) {
	const path = planPath(id);
	if (existsSync(path) === false) return false;
	rmSync(path, { force: true });
	return true;
}

export function planSummary(plan) {
	return summarize(plan);
}

export function planFileSize(id) {
	return statSync(planPath(id)).size;
}
