/**
 * 任务计划（0.12.0 起步）：把「目标 + 有序步骤」落成 JSON，供模型跨轮次/跨会话接着做。
 *
 * 存储：~/.dsh/dsh-operator/plans/<id>.json（默认最多 50 个）。
 * 只存工具名 + 参数（敏感键拒绝），不存截图/剪贴板/密码；写入用临时文件 + rename。
 * 执行器在 0.12.1 接（按步骤调用工具 + 校验 + 中断恢复）；本版负责建计划、推进状态、查询。
 */
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

export function validatePlan(plan) {
	const errors = [];
	if (typeof plan !== "object" || plan === null) return { ok: false, errors: ["plan must be an object"] };
	if (typeof plan.goal !== "string" || plan.goal.trim().length < 4) errors.push("goal is required (>=4 chars)");
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
			if (step?.args !== undefined) {
				for (const key of Object.keys(step.args)) if (SENSITIVE_KEY_RE.test(key)) errors.push(`steps[${index}].args.${key} looks sensitive`);
			}
			if (step?.verify !== undefined && (typeof step.verify !== "object" || step.verify === null)) errors.push(`steps[${index}].verify must be an object`);
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
	return {
		goal: String(goal).trim(),
		...(tier === undefined ? {} : { tier: String(tier) }),
		status: "pending",
		steps: steps.map((step) => ({
			id: String(step.id),
			tool: String(step.tool),
			...(step.args === undefined ? {} : { args: step.args }),
			...(step.verify === undefined ? {} : { verify: step.verify }),
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
	if (listPlans().length >= MAX_PLANS) throw new Error(`too many plans (max ${MAX_PLANS})`);
	const id = newPlanId();
	const path = planPath(id);
	const body = `${JSON.stringify({ id, ...candidate }, null, 2)}\n`;
	const tmp = join(planDir(), `.${id}.tmp`);
	writeFileSync(tmp, body);
	renameSync(tmp, path);
	return { id, path, plan: { id, ...candidate } };
}

export function listPlans({ limit = 20 } = {}) {
	const dir = planDir();
	if (existsSync(dir) === false) return [];
	const plans = [];
	for (const entry of readdirSync(dir)) {
		if (entry.endsWith(".json") === false) continue;
		try {
			plans.push(JSON.parse(readFileSync(join(dir, entry), "utf8")));
		} catch {
			/* 坏文件跳过 */
		}
	}
	return plans
		.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
		.slice(0, Math.max(1, Number(limit) || 20));
}

export function readPlan(id) {
	const path = planPath(id);
	if (existsSync(path) === false) throw new Error(`plan not found: ${id}`);
	return JSON.parse(readFileSync(path, "utf8"));
}

function summarize(plan) {
	const counts = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 };
	for (const step of plan.steps) counts[step.status ?? "pending"] += 1;
	const next = plan.steps.find((step) => (step.status ?? "pending") === "pending");
	return { id: plan.id, goal: plan.goal, status: plan.status, counts, nextStep: next?.id ?? null, updatedAt: plan.updatedAt };
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
	const tmp = join(planDir(), `.${id}.tmp`);
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
