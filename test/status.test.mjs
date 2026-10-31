import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { configurePlanStore, createPlan } from "../lib/planner.js";
import { collectStatus } from "../lib/status.js";

const home = mkdtempSync(join(tmpdir(), "dsh-operator-status-"));
const dataDir = join(home, "dsh-operator");
mkdirSync(join(dataDir, "skills"), { recursive: true });
mkdirSync(join(dataDir, "failures"), { recursive: true });
writeFileSync(join(dataDir, "skills", "a.json"), "{}\n");
writeFileSync(join(dataDir, "skills", "b.json"), "{}\n");
writeFileSync(join(dataDir, "failures", "2026-11-01.jsonl"), "{\"a\":1}\n{\"b\":2}\n");
writeFileSync(join(dataDir, "audit.jsonl"), "{\"event\":\"x\"}\n{\"event\":\"y\"}\n");
configurePlanStore({ dir: join(dataDir, "plans") });
createPlan({ goal: "状态测试计划：两步", steps: [{ id: "one", tool: "list_windows" }, { id: "two", tool: "list_windows" }] });
createPlan({ goal: "状态测试计划：一步", steps: [{ id: "one", tool: "list_windows" }] });
after(() => rmSync(home, { recursive: true, force: true }));

test("status：汇总技能/计划/失败样本/审计与配置", () => {
	const status = collectStatus({ home, config: { axMaxNodes: 80, failureSamples: false, browserCdpPort: 9222 }, version: "0.13.0" });
	assert.equal(status.version, "0.13.0");
	assert.equal(status.skills, 2);
	assert.equal(status.plans, 2);
	assert.equal(status.failureFiles, 1);
	assert.equal(status.failureRecords, 2);
	assert.equal(status.auditLines, 2);
	assert.ok(status.auditBytes > 0);
	assert.equal(status.axMaxNodes, 80);
	assert.equal(status.failureSamples, false);
	assert.equal(status.browserCdpPort, 9222);
	assert.match(status.text, /dsh-operator 0\.13\.0/);
	assert.match(status.text, /skills 2 · plans 1|skills 2 · plans 2/);
});

test("status：空目录也稳定返回 0，不抛错", () => {
	const emptyHome = mkdtempSync(join(tmpdir(), "dsh-operator-status-empty-"));
	after(() => rmSync(emptyHome, { recursive: true, force: true }));
	const status = collectStatus({ home: emptyHome });
	assert.equal(status.skills, 0);
	assert.equal(status.plans, 0);
	assert.equal(status.failureFiles, 0);
	assert.equal(status.failureRecords, 0);
	assert.equal(status.auditLines, 0);
	assert.equal(status.axMaxNodes, 120);
	assert.equal(status.failureSamples, true);
});
