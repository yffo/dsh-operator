// 0.67.0 技能步数统计：给 G3 的「第二次 ≤ 首次 50%」一个可计算的口径。

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
	configureSkillStats,
	describeRun,
	evaluateRun,
	readSkillStats,
	recordSkillRun
} from "../lib/skill-stats.js";

let dir;

before(() => {
	dir = mkdtempSync(join(tmpdir(), "dsh-skill-stats-"));
	configureSkillStats({ file: join(dir, "stats.json") });
});

after(() => {
	configureSkillStats({ file: null });
	rmSync(dir, { recursive: true, force: true });
});

test("首次成功运行记为基线", () => {
	const result = recordSkillRun("demo-skill", { steps: 5, ok: true, now: 1_000 });
	assert.equal(result.first, 5);
	assert.equal(result.last, 5);
	assert.equal(result.runs, 1);
	assert.equal(result.targetMet, false, "首次运行没有可比对象，不算达标");
});

test("第二次步数减半即达标", () => {
	recordSkillRun("demo-skill", { steps: 5, ok: true, now: 1_000 });
	const second = recordSkillRun("demo-skill", { steps: 2, ok: true, now: 2_000 });
	assert.equal(second.first, 5);
	assert.equal(second.last, 2);
	assert.equal(second.best, 2);
	assert.equal(second.targetMet, true);
	assert.equal(second.deltaPercent, -60);
	assert.match(describeRun(second), /达标/);
});

test("失败的一轮不改基线", () => {
	recordSkillRun("flaky-skill", { steps: 4, ok: true, now: 1_000 });
	recordSkillRun("flaky-skill", { steps: 4, ok: false, now: 2_000 });
	const stats = readSkillStats("flaky-skill");
	assert.equal(stats.first, 4, "失败不该把基线冲掉");
	assert.equal(stats.runs, 2);
	assert.equal(stats.ok, 1);
});

test("evaluateRun 的边界", () => {
	assert.deepEqual(evaluateRun({ first: 0, last: 0 }), { targetMet: false, deltaPercent: 0 });
	assert.deepEqual(evaluateRun({ first: 4, last: 2 }), { targetMet: true, deltaPercent: -50 });
	assert.deepEqual(evaluateRun({ first: 4, last: 3 }), { targetMet: false, deltaPercent: -25 });
});


test("describeRun：没有成功基线时不说「已记录为基线」（0.76.0）", () => {
	const text = describeRun({ first: 0, last: 2, runs: 1 });
	assert.doesNotMatch(text, /已记录为基线/);
	assert.match(text, /尚无成功基线/);
});

test("基线：先失败后成功，仍能立起基线（0.77.0 回归）", () => {
	recordSkillRun("late-baseline", { steps: 3, ok: false, now: 1_000 });
	const second = recordSkillRun("late-baseline", { steps: 2, ok: true, now: 2_000 });
	assert.equal(second.first, 2, "失败轮不该把基线钉死在 0");
	assert.equal(second.best, 2);
	assert.equal(second.targetMet, false, "第一次成功只立基线，不判达标");
	assert.match(describeRun(second), /首次基线 2/);
});

// 0.81.0：技能健康度
import { judgeSkillHealth } from "../lib/skill-stats.js";

test("judgeSkillHealth：new / ok / flaky / stale", () => {
	assert.equal(judgeSkillHealth(undefined), "new");
	assert.equal(judgeSkillHealth({ runs: 0, ok: 0 }), "new");
	assert.equal(judgeSkillHealth({ runs: 1, ok: 0 }), "ok", "只失败过一次还不算失效");
	assert.equal(judgeSkillHealth({ runs: 2, ok: 0 }), "stale", "两次都没成功 → 失效");
	assert.equal(judgeSkillHealth({ runs: 4, ok: 1 }), "flaky", "成功不过半 → 不稳定");
	assert.equal(judgeSkillHealth({ runs: 4, ok: 2 }), "ok", "成功率 50% 不算 flaky");
});

test("失败轮不改写 last，也不刷出达标（0.82.0）", () => {
	recordSkillRun("no-gaming", { steps: 10, ok: true, now: 1_000 });
	const failed = recordSkillRun("no-gaming", { steps: 2, ok: false, now: 2_000 });
	assert.equal(failed.last, 10, "失败轮不能把 last 改成 2");
	assert.equal(failed.targetMet, false, "失败轮不能判达标");
	assert.equal(failed.deltaPercent, 0);
});

test("统计锁：残留锁会过期让路，写入照常成功（0.83.0）", async () => {
	const { mkdtempSync, writeFileSync, utimesSync, existsSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const dir = mkdtempSync(join(tmpdir(), "dsh-stats-lock-"));
	const { configureSkillStats } = await import("../lib/skill-stats.js");
	// configureSkillStats 收的是 file（不是 dir）
	const file = join(dir, "skill-stats.json");
	configureSkillStats({ file });
	try {
		const lock = `${file}.lock`;
		writeFileSync(lock, "");
		const old = new Date(Date.now() - 60_000);
		utimesSync(lock, old, old);
		const entry = recordSkillRun("lock-test", { steps: 2, ok: true, now: 5_000 });
		assert.equal(entry.runs, 1, "过期锁不该挡住写入");
		assert.equal(existsSync(lock), false, "写完要释放锁");
	} finally {
		configureSkillStats({ file: null });
	}
});

// RETRO #5：跨进程锁在真实竞争下的表现（之前只做了锁，没验证多进程同时写）
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("多进程同时记同一条统计：不丢更新、锁能释放", () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-stats-race-"));
	const modulePath = fileURLToPath(new URL("../lib/skill-stats.js", import.meta.url));
	const children = 8;
	const results = [];
	for (let i = 0; i < children; i += 1) {
		results.push(spawnSync(process.execPath, [
			"--input-type=module",
			"-e",
			`import { recordSkillRun } from ${JSON.stringify(`file://${modulePath}`)}; recordSkillRun("race", { steps: 3, ok: true });`
		], { env: { ...process.env, DSH_HOME: home }, encoding: "utf8", timeout: 15000 }));
	}
	try {
		const failed = results.filter((result) => result.status !== 0);
		assert.equal(failed.length, 0, `子进程失败: ${failed.map((item) => item.stderr).join(" | ").slice(0, 400)}`);
		configureSkillStats({ file: join(home, "dsh-operator", "skill-stats.json") });
		const stat = readSkillStats("race");
		assert.ok(stat !== null, "统计文件应该存在");
		assert.equal(stat.runs, children, `${children} 个进程各记一次，runs 必须是 ${children}（丢更新会小于它）`);
		assert.equal(stat.ok, children);
		// 锁文件必须被释放，否则下一次写会等满 2s 或报超时
		assert.equal(existsSync(join(home, "dsh-operator", "skill-stats.json.lock")), false, "锁文件必须已释放");
	} finally {
		configureSkillStats({ file: null });
		rmSync(home, { recursive: true, force: true });
	}
});
