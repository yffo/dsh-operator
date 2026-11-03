import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRunSheet, filterScenarios, groupByLayer, loadScenarios, parseRecords, recordLine, renderSummaryTable, summarizeRecords, validateRecord } from "../lib/scenarios.js";

test("scenarios 工具：加载全部 32 条且分层齐全", () => {
	const items = loadScenarios();
	assert.equal(items.length, 32);
	const groups = groupByLayer(items);
	assert.equal(groups.L0.length, 8);
	assert.equal(groups.L1.length, 8);
	assert.equal(groups.L2.length, 8);
	assert.equal(groups.exception.length, 8);
});

test("scenarios 工具：按层/按 id/关键词筛选", () => {
	const items = loadScenarios();
	assert.equal(filterScenarios(items, { layer: "L2" }).length, 8);
	assert.equal(filterScenarios(items, { id: "L0-01" }).length, 1);
	assert.ok(filterScenarios(items, { search: "系统设置" }).length >= 2);
});

test("scenarios 工具：跑分表包含全部目标层与成功标准", () => {
	const items = loadScenarios();
	const sheet = buildRunSheet(filterScenarios(items, { layer: "exception" }), { date: "2026-11-01" });
	assert.match(sheet, /# dsh-operator 场景跑分表 · 2026-11-01/);
	assert.match(sheet, /## exception（8 条）/);
	assert.ok(sheet.includes("EX-01"));
	assert.ok(sheet.includes("成功标准："));
	assert.ok(sheet.includes("- [ ]"));
});

test("scenarios 工具：记录校验与汇总计算", () => {
	assert.equal(validateRecord({ id: "L0-01", success: true, steps: 3, seconds: 12 }).ok, true);
	assert.equal(validateRecord({ id: "bad", success: true, steps: 3, seconds: 12 }).ok, false);
	assert.equal(validateRecord({ id: "L0-01", success: "yes", steps: 3, seconds: 12 }).ok, false);
	assert.equal(validateRecord({ id: "L0-01", success: true, steps: -1, seconds: 12 }).ok, false);
	const line = recordLine({ id: "L0-01", success: true, steps: 3, seconds: 12, costCny: 0.12, date: "2026-11-01" });
	const parsed = JSON.parse(line);
	assert.equal(parsed.id, "L0-01");
	const records = parseRecords([
		recordLine({ id: "L0-01", success: true, steps: 3, seconds: 12, costCny: 0.12 }),
		recordLine({ id: "L1-01", success: false, steps: 7, seconds: 30, failureKind: "not_found" }),
		"not json",
		""
	].join("\n"));
	const summary = summarizeRecords(records);
	assert.equal(summary.total, 2);
	assert.equal(summary.success, 1);
	assert.equal(summary.failed, 1);
	assert.equal(summary.avgSteps, 5);
	assert.equal(summary.failures.not_found, 1);
	assert.match(renderSummaryTable(summary), /\| 合计 \| 2 \| 50% \|/);
});
