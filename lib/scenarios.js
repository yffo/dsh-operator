/**
 * 场景矩阵工具（0.12.3）：加载/筛选 32 条场景，生成可打印的跑分表，校验并汇总跑分记录。
 * 纯函数优先，CLI 在 scripts/scenarios.mjs。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LAYERS = ["L0", "L1", "L2", "exception"];
const SCENARIOS_PATH = fileURLToPath(new URL("../bench/scenarios.json", import.meta.url));
const ID_RE = /^[A-Z0-9]+-\d{2}$/;

export function loadScenarios(path = SCENARIOS_PATH) {
	const data = JSON.parse(readFileSync(path, "utf8"));
	return Array.isArray(data?.scenarios) ? data.scenarios : [];
}

export function filterScenarios(scenarios, { layer, id, search } = {}) {
	return scenarios.filter((item) => {
		if (layer !== undefined && item.layer !== layer) return false;
		if (id !== undefined && item.id !== id) return false;
		if (typeof search === "string" && search !== "") {
			const haystack = `${item.id} ${item.title} ${item.goal}`;
			if (haystack.includes(search) === false) return false;
		}
		return true;
	});
}

export function groupByLayer(scenarios) {
	const groups = {};
	for (const layer of LAYERS) groups[layer] = [];
	for (const item of scenarios) (groups[item.layer] ??= []).push(item);
	return groups;
}

export function localDate(now = new Date()) {
	const pad = (value) => String(value).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function buildRunSheet(scenarios, { date = localDate() } = {}) {
	const groups = groupByLayer(scenarios);
	const lines = [
		`# dsh-operator 场景跑分表 · ${date}`,
		"",
		`共 ${scenarios.length} 条：` + LAYERS.map((layer) => `${layer} ${groups[layer].length}`).join(" / "),
		"",
		"口径：同一实现、同一模型、同一账号；记录成功率、GUI 动作数、墙钟秒数、会话成本增量、失败分类（failure-store kind）。",
		""
	];
	for (const layer of LAYERS) {
		if (groups[layer].length === 0) continue;
		lines.push(`## ${layer}（${groups[layer].length} 条）`, "");
		for (const item of groups[layer]) {
			lines.push(`- [ ] **${item.id} ${item.title}**`);
			lines.push(`  - 目标：${item.goal}`);
			if (item.stepsHint) lines.push(`  - 参考路径：${item.stepsHint}`);
			lines.push(`  - 成功标准：${(item.success ?? []).map((line, index) => `${index + 1}) ${line}`).join("；")}`);
			lines.push(`  - 超时：${item.timeoutSec}s`);
			lines.push("  - 结果：成功〔是 / 否〕 动作数 ___ 耗时 ___s 成本 ¥___ 失败分类 ___ 备注 ___");
			lines.push("");
		}
	}
	return lines.join("\n").trimEnd() + "\n";
}

export function validateRecord(record) {
	const errors = [];
	const item = record ?? {};
	if (typeof item.id !== "string" || ID_RE.test(item.id) === false) errors.push("id must look like L0-01");
	if (typeof item.success !== "boolean") errors.push("success must be boolean");
	if (Number.isInteger(item.steps) === false || item.steps < 0) errors.push("steps must be a non-negative integer");
	if (typeof item.seconds !== "number" || Number.isFinite(item.seconds) === false || item.seconds < 0) errors.push("seconds must be a non-negative number");
	if (item.costCny !== undefined && (typeof item.costCny !== "number" || item.costCny < 0)) errors.push("costCny must be a non-negative number");
	if (item.failureKind !== undefined && typeof item.failureKind !== "string") errors.push("failureKind must be a string");
	if (item.note !== undefined && typeof item.note !== "string") errors.push("note must be a string");
	if (item.date !== undefined && typeof item.date !== "string") errors.push("date must be a string");
	return { ok: errors.length === 0, errors };
}

export function recordLine(record) {
	const validation = validateRecord(record);
	if (validation.ok === false) throw new Error(`invalid scenario record: ${validation.errors.join("; ")}`);
	return JSON.stringify({
		date: record.date ?? localDate(),
		id: record.id,
		success: record.success,
		steps: record.steps,
		seconds: record.seconds,
		...(record.costCny === undefined ? {} : { costCny: record.costCny }),
		...(record.failureKind === undefined ? {} : { failureKind: record.failureKind }),
		...(record.note === undefined ? {} : { note: record.note })
	});
}

export function parseRecords(text) {
	const records = [];
	for (const line of String(text ?? "").split("\n")) {
		if (line.trim() === "") continue;
		try {
			const parsed = JSON.parse(line);
			if (validateRecord(parsed).ok) records.push(parsed);
		} catch {
			/* 坏行跳过 */
		}
	}
	return records;
}

export function summarizeRecords(records) {
	const summary = { total: records.length, success: 0, failed: 0, avgSteps: 0, avgSeconds: 0, costCny: 0, byLayer: {}, failures: {} };
	let steps = 0;
	let seconds = 0;
	for (const record of records) {
		const layer = String(record.id).split("-")[0];
		summary.byLayer[layer] ??= { total: 0, success: 0, avgSteps: 0, avgSeconds: 0 };
		const bucket = summary.byLayer[layer];
		bucket.total += 1;
		steps += record.steps;
		seconds += record.seconds;
		if (record.success === true) {
			summary.success += 1;
			bucket.success += 1;
		} else {
			summary.failed += 1;
			const kind = record.failureKind ?? "unknown";
			summary.failures[kind] = (summary.failures[kind] ?? 0) + 1;
		}
		summary.costCny += record.costCny ?? 0;
		bucket.avgSteps += record.steps;
		bucket.avgSeconds += record.seconds;
	}
	if (summary.total > 0) {
		summary.avgSteps = Math.round((steps / summary.total) * 10) / 10;
		summary.avgSeconds = Math.round((seconds / summary.total) * 10) / 10;
	}
	for (const bucket of Object.values(summary.byLayer)) {
		bucket.avgSteps = bucket.total === 0 ? 0 : Math.round((bucket.avgSteps / bucket.total) * 10) / 10;
		bucket.avgSeconds = bucket.total === 0 ? 0 : Math.round((bucket.avgSeconds / bucket.total) * 10) / 10;
		bucket.successRate = bucket.total === 0 ? 0 : Math.round((bucket.success / bucket.total) * 100);
	}
	summary.costCny = Math.round(summary.costCny * 10000) / 10000;
	summary.successRate = summary.total === 0 ? 0 : Math.round((summary.success / summary.total) * 100);
	return summary;
}

export function renderSummaryTable(summary) {
	const lines = [
		"| 层 | 条数 | 成功率 | 平均动作数 | 平均耗时(s) |",
		"| --- | --- | --- | --- | --- |"
	];
	for (const layer of LAYERS) {
		const bucket = summary.byLayer[layer];
		if (!bucket) continue;
		lines.push(`| ${layer} | ${bucket.total} | ${bucket.successRate}% | ${bucket.avgSteps} | ${bucket.avgSeconds} |`);
	}
	lines.push(`| 合计 | ${summary.total} | ${summary.successRate}% | ${summary.avgSteps} | ${summary.avgSeconds} |`);
	lines.push("");
	lines.push(`成本合计：¥${summary.costCny}`);
	if (summary.failed > 0) lines.push(`失败分类：${Object.entries(summary.failures).map(([kind, count]) => `${kind}×${count}`).join("，")}`);
	return lines.join("\n");
}
