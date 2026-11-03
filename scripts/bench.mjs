#!/usr/bin/env node
/**
 * dsh-operator 基准记录工具
 *
 * 用法：
 *   node scripts/bench.mjs report                      # 汇总 bench/results/*.json
 *   node scripts/bench.mjs check                       # 校验任务表与所有结果文件
 *   node scripts/bench.mjs record --file path.json     # 校验并落盘一条结果
 *
 * 结果文件约定（bench/results/<date>-<slug>.json）：
 *   { run, implementation, version, date, mode?, tasks: [{id, success, steps, seconds, note?}],
 *     totals?: { steps, seconds, costCny, outputTokens }, notes?: string[] }
 *
 * 任务定义在 bench/tasks.json（协议、任务 id、验收口径）。totals 缺失时由 record 自动补，
 * 但 report 只用显式落盘的 totals，避免「同一份数据两种口径」。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TASKS_PATH = join(root, "bench", "tasks.json");
const RESULTS_DIR = join(root, "bench", "results");

export function loadTasks(path = TASKS_PATH) {
	const data = JSON.parse(readFileSync(path, "utf8"));
	if (!Array.isArray(data.tasks) || data.tasks.length === 0) throw new Error(`${path}: tasks 为空`);
	return data;
}

export function loadResults(dir = RESULTS_DIR) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => {
			const path = join(dir, name);
			return { file: name, data: JSON.parse(readFileSync(path, "utf8")), path };
		});
}

/** @returns {{ok: boolean, errors: string[], totals?: object}} */
export function validateResult(result, tasks) {
	const errors = [];
	const taskIds = new Set(tasks.tasks.map((task) => task.id));
	if (typeof result?.run !== "string" || result.run.trim() === "") errors.push("run 必须是非空字符串");
	if (typeof result?.implementation !== "string" || result.implementation.trim() === "") errors.push("implementation 必须是非空字符串");
	if (typeof result?.version !== "string" || result.version.trim() === "") errors.push("version 必须是非空字符串");
	if (typeof result?.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(result.date)) errors.push("date 必须是 YYYY-MM-DD");
	const rows = Array.isArray(result?.tasks) ? result.tasks : undefined;
	if (rows === undefined) {
		errors.push("tasks 必须是数组");
		return { ok: false, errors };
	}
	if (rows.length !== taskIds.size) errors.push(`tasks 数量 ${String(rows.length)} ≠ 任务表 ${String(taskIds.size)}`);
	const seen = new Set();
	for (const [index, row] of rows.entries()) {
		const at = `tasks[${String(index)}]`;
		if (typeof row?.id !== "string" || taskIds.has(row.id) === false) errors.push(`${at}.id 不在任务表: ${String(row?.id)}`);
		if (seen.has(row?.id)) errors.push(`${at}.id 重复: ${String(row?.id)}`);
		seen.add(row?.id);
		if (typeof row?.success !== "boolean") errors.push(`${at}.success 必须是布尔`);
		if (Number.isInteger(row?.steps) === false || row.steps < 0) errors.push(`${at}.steps 必须是非负整数`);
		if (typeof row?.seconds !== "number" || Number.isFinite(row.seconds) === false || row.seconds < 0) errors.push(`${at}.seconds 必须是非负数字`);
		if (row?.note !== undefined && typeof row.note !== "string") errors.push(`${at}.note 必须是字符串`);
	}
	if (result?.notes !== undefined && !Array.isArray(result.notes)) errors.push("notes 必须是数组");

	const derived = aggregate(result.tasks);
	const totals = result?.totals;
	if (totals === undefined) {
		return { ok: errors.length === 0, errors, totals: derived };
	}
	for (const key of ["steps", "seconds", "costCny", "outputTokens"]) {
		if (typeof totals[key] !== "number" || Number.isFinite(totals[key]) === false || totals[key] < 0) {
			errors.push(`totals.${key} 必须是非负数字`);
		}
	}
	// steps / seconds 与任务明细必须自洽（墙钟允许 2% 或 3 秒以内的取舍误差）；
	// 费用与 token 由会话账面记录，无法从明细推导，故只校验数值。
	if (typeof totals.steps === "number" && totals.steps !== derived.steps) {
		errors.push(`totals.steps=${String(totals.steps)} 与明细合计 ${String(derived.steps)} 不一致`);
	}
	if (typeof totals.seconds === "number" && Math.abs(totals.seconds - derived.seconds) > Math.max(3, derived.seconds * 0.02)) {
		errors.push(`totals.seconds=${String(totals.seconds)} 与明细合计 ${String(derived.seconds)} 相差过大`);
	}
	return { ok: errors.length === 0, errors, totals: { ...derived, ...totals } };
}

export function aggregate(rows) {
	const list = Array.isArray(rows) ? rows : [];
	return {
		tasks: list.length,
		success: list.filter((row) => row?.success === true).length,
		steps: list.reduce((sum, row) => sum + Number(row?.steps ?? 0), 0),
		seconds: Math.round(list.reduce((sum, row) => sum + Number(row?.seconds ?? 0), 0))
	};
}

/** 相对基线（通常是官方实现或上一版）的对比行。 */
export function compareRuns(baseline, candidate) {
	const base = baseline?.totals;
	const next = candidate?.totals;
	if (base === undefined || next === undefined) throw new Error("compareRuns 需要带 totals 的结果");
	const ratio = (a, b) => (b === 0 ? "—" : `${(a / b).toFixed(2)}×`);
	return {
		baseline: baseline.run,
		candidate: candidate.run,
		steps: `${String(base.steps)} → ${String(next.steps)}（${ratio(next.steps, base.steps)}）`,
		seconds: `${String(base.seconds)}s → ${String(next.seconds)}s（${ratio(next.seconds, base.seconds)}）`,
		costCny: `¥${String(base.costCny)} → ¥${String(next.costCny)}（${ratio(next.costCny, base.costCny)}）`,
		outputTokens: `${String(base.outputTokens)} → ${String(next.outputTokens)}（${ratio(next.outputTokens, base.outputTokens)}）`
	};
}

export function formatReport(results) {
	const runs = results
		.slice()
		.sort((a, b) => String(a.data.date).localeCompare(String(b.data.date)) || String(a.data.run).localeCompare(String(b.data.run)));
	const lines = [];
	lines.push("run                  实现/版本                         成功率   步数   耗时     费用(¥)   输出token");
	lines.push("-------------------  -------------------------------  -------  -----  ------  --------  ---------");
	for (const { data } of runs) {
		const totals = data.totals ?? aggregate(data.tasks);
		const success = `${String(totals.success ?? aggregate(data.tasks).success)}/${String(totals.tasks ?? aggregate(data.tasks).tasks)}`;
		const impl = `${String(data.implementation)} ${String(data.version)}`;
		lines.push(
			[
				String(data.run).padEnd(19),
				impl.padEnd(31),
				success.padEnd(7),
				String(totals.steps).padEnd(5),
				`${String(totals.seconds)}s`.padEnd(7),
				`¥${String(totals.costCny)}`.padEnd(8),
				String(totals.outputTokens)
			].join("  ")
		);
	}
	return lines.join("\n");
}

function main(argv) {
	const command = argv[0] ?? "report";
	if (command === "check") {
		const tasks = loadTasks();
		const results = loadResults();
		const errors = [];
		for (const { file, data } of results) {
			const verdict = validateResult(data, tasks);
			if (verdict.ok === false) errors.push(`${file}: ${verdict.errors.join("; ")}`);
		}
		if (results.length === 0) errors.push(`${RESULTS_DIR} 下没有结果文件`);
		if (errors.length > 0) {
			console.error(`✗ bench 校验失败 ${String(errors.length)} 项`);
			for (const error of errors) console.error(`  - ${error}`);
			process.exitCode = 1;
			return;
		}
		console.log(`✓ bench 校验通过：${String(results.length)} 条结果 × ${String(tasks.tasks.length)} 个任务`);
		return;
	}
	if (command === "report") {
		const results = loadResults();
		if (results.length === 0) {
			console.error("没有结果文件");
			process.exitCode = 1;
			return;
		}
		console.log(formatReport(results));
		return;
	}
	if (command === "record") {
		const fileIndex = argv.indexOf("--file");
		if (fileIndex < 0 || argv[fileIndex + 1] === undefined) {
			console.error("用法：node scripts/bench.mjs record --file path.json");
			process.exitCode = 1;
			return;
		}
		const source = argv[fileIndex + 1];
		const data = JSON.parse(readFileSync(source, "utf8"));
		const tasks = loadTasks();
		const verdict = validateResult(data, tasks);
		if (verdict.ok === false) {
			console.error(`✗ 结果不合规：\n  - ${verdict.errors.join("\n  - ")}`);
			process.exitCode = 1;
			return;
		}
		const slug = `${data.date}-${data.run}`;
		mkdirSync(RESULTS_DIR, { recursive: true });
		const target = join(RESULTS_DIR, `${slug}.json`);
		writeFileSync(target, `${JSON.stringify({ ...data, totals: verdict.totals }, null, "\t")}\n`, "utf8");
		console.log(`✓ 已写入 ${target}`);
		return;
	}
	console.error(`未知命令：${command}`);
	process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
