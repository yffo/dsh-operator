// 0.71.0 场景覆盖度：矩阵不能悄悄腐烂——没有记录、太久没跑、或不是当前版本跑的，
// 都要在 `npm run scenarios:coverage` 里显形。

import assert from "node:assert/strict";
import { test } from "node:test";

import { renderCoverageTable, summarizeCoverage } from "../lib/scenarios.js";

const scenarios = [{ id: "L0-01" }, { id: "L0-02" }, { id: "L1-01" }];

test("版本一致且在有效期内：全部算当前可用", () => {
	const records = [
		{ id: "L0-01", date: "2026-11-02", version: "0.71.0", success: true },
		{ id: "L0-02", date: "2026-11-02", version: "0.71.0", success: true },
		{ id: "L1-01", date: "2026-11-02", version: "0.71.0", success: true }
	];
	const coverage = summarizeCoverage(scenarios, records, { version: "0.71.0", today: "2026-11-02" });
	assert.equal(coverage.total, 3);
	assert.equal(coverage.current, 3);
	assert.deepEqual(coverage.missing, []);
	assert.deepEqual(coverage.stale, []);
});

test("没有记录的场景进 missing", () => {
	const records = [{ id: "L0-01", date: "2026-11-02", version: "0.71.0", success: true }];
	const coverage = summarizeCoverage(scenarios, records, { version: "0.71.0", today: "2026-11-02" });
	assert.deepEqual(coverage.missing.sort(), ["L0-02", "L1-01"]);
	assert.equal(coverage.current, 1);
});

test("旧记录没带版本 → 需要重跑", () => {
	const records = [{ id: "L0-01", date: "2026-11-02", success: true }];
	const coverage = summarizeCoverage([{ id: "L0-01" }], records, { version: "0.71.0", today: "2026-11-02" });
	assert.equal(coverage.current, 0);
	assert.equal(coverage.stale.length, 1);
	assert.match(coverage.stale[0].reason, /没带版本/);
});

test("版本不一致 / 超期 / 上次失败都算 stale", () => {
	const records = [
		{ id: "L0-01", date: "2026-11-02", version: "0.60.0", success: true },
		{ id: "L0-02", date: "2026-09-01", version: "0.71.0", success: true },
		{ id: "L1-01", date: "2026-11-02", version: "0.71.0", success: false }
	];
	const coverage = summarizeCoverage(scenarios, records, { version: "0.71.0", today: "2026-11-02", maxAgeDays: 30 });
	assert.equal(coverage.current, 0);
	const byId = Object.fromEntries(coverage.stale.map((item) => [item.id, item.reason]));
	assert.match(byId["L0-01"], /记录版本 0\.60\.0/);
	assert.match(byId["L0-02"], /超过 30 天/);
	assert.match(byId["L1-01"], /上次失败/);
});

test("渲染：全绿与有问题的两种文案", () => {
	const ok = renderCoverageTable({ total: 2, covered: 2, current: 2, missing: [], stale: [] }, { version: "0.71.0" });
	assert.match(ok, /全部场景都在有效期内且版本一致/);

	const bad = renderCoverageTable(
		{ total: 2, covered: 1, current: 0, missing: ["L0-02"], stale: [{ id: "L0-01", reason: "旧记录没带版本，需在当前版本重跑", lastDate: "2026-11-01" }] },
		{ version: "0.71.0" }
	);
	assert.match(bad, /从未跑过：L0-02/);
	assert.match(bad, /需要重跑：/);
	assert.match(bad, /L0-01：旧记录没带版本/);
});

// 0.71.1：EX-xx 记录必须归到 exception 层，否则报表会少一整层
import { summarizeRecords } from "../lib/scenarios.js";

test("summarizeRecords：EX 记录归入 exception 层，各层合计等于总数", () => {
	const summary = summarizeRecords([
		{ id: "L0-01", success: true, steps: 1, seconds: 2 },
		{ id: "EX-02", success: true, steps: 1, seconds: 1 },
		{ id: "EX-05", success: true, steps: 1, seconds: 1 }
	]);
	assert.equal(summary.total, 3);
	assert.equal(summary.byLayer.exception.total, 2);
	const buckets = Object.values(summary.byLayer).reduce((sum, bucket) => sum + bucket.total, 0);
	assert.equal(buckets, summary.total, "各层条数之和必须等于总数");
});
