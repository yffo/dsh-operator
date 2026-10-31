import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { aggregate, compareRuns, formatReport, loadResults, loadTasks, validateResult } from "../scripts/bench.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const tasks = loadTasks();
const results = loadResults();
const byRun = new Map(results.map((entry) => [entry.data.run, entry.data]));

test("bench：三条历史结果全部通过校验", () => {
	assert.ok(results.length >= 3);
	for (const entry of results) {
		const verdict = validateResult(entry.data, tasks);
		assert.equal(verdict.ok, true, `${entry.file}: ${verdict.errors.join("; ")}`);
	}
});

test("bench：aggregate 汇总成功率/步数/耗时", () => {
	assert.deepEqual(aggregate([]), { tasks: 0, success: 0, steps: 0, seconds: 0 });
	assert.deepEqual(
		aggregate([
			{ id: "T1", success: true, steps: 2, seconds: 7.4 },
			{ id: "T2", success: false, steps: 3, seconds: 2.6 }
		]),
		{ tasks: 2, success: 1, steps: 5, seconds: 10 }
	);
});

test("bench：validateResult 拒绝坏数据", () => {
	const base = { ...byRun.get("2026-10-31-a2") };
	const cases = [
		[{ ...base, run: "" }, /run/],
		[{ ...base, date: "2026/10/31" }, /date/],
		[{ ...base, tasks: base.tasks.slice(0, 4) }, /数量/],
		[{ ...base, tasks: base.tasks.map((row, index) => (index === 0 ? { ...row, id: "TX" } : row)) }, /不在任务表/],
		[{ ...base, tasks: base.tasks.map((row, index) => (index === 0 ? { ...row, steps: "2" } : row)) }, /steps/],
		[{ ...base, tasks: base.tasks.map((row, index) => (index === 0 ? { ...row, success: "yes" } : row)) }, /success/],
		[{ ...base, totals: { ...base.totals, steps: 999 } }, /totals.steps/],
		[{ ...base, totals: { ...base.totals, seconds: 1 } }, /totals.seconds/]
	];
	for (const [sample, pattern] of cases) {
		const verdict = validateResult(sample, tasks);
		assert.equal(verdict.ok, false);
		assert.ok(
			verdict.errors.some((error) => pattern.test(error)),
			`期望命中的错误未出现: ${verdict.errors.join("; ")}`
		);
	}
});

test("bench：compareRuns 给出步数/耗时/费用/token 倍率", () => {
	const comparison = compareRuns(byRun.get("2026-10-31-b"), byRun.get("2026-10-31-a2"));
	assert.equal(comparison.baseline, "2026-10-31-b");
	assert.match(comparison.steps, /36 → 18（0\.50×）/);
	assert.match(comparison.costCny, /¥0\.7049 → ¥0\.2176（0\.31×）/);
	assert.match(comparison.outputTokens, /21000 → 5000（0\.24×）/);
});

test("bench：report 表格包含所有 run 且按日期排序", () => {
	const text = formatReport(results);
	for (const run of ["2026-10-31-a", "2026-10-31-a2", "2026-10-31-b"]) assert.ok(text.includes(run));
	const lines = text.split("\n").filter((line) => line.startsWith("2026-"));
	assert.deepEqual(
		lines.map((line) => line.slice(0, 19).trim()),
		["2026-10-31-a", "2026-10-31-a2", "2026-10-31-b"]
	);
});

test("bench：CLI check 对仓库内数据 exit 0", () => {
	const output = execFileSync(process.execPath, [join(root, "scripts", "bench.mjs"), "check"], { encoding: "utf8" });
	assert.match(output, /✓ bench 校验通过/);
});
