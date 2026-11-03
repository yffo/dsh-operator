// 0.74.0 技能导出/导入：迁移与备份的最小闭环。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { configureSkillStore, saveSkill } from "../lib/skill-store.js";
import { describeImport, exportSkills, importSkills, SKILL_BUNDLE_VERSION } from "../lib/skill-transfer.js";

let dir;
before(() => {
	dir = mkdtempSync(join(tmpdir(), "dsh-skill-transfer-"));
	configureSkillStore({ dir });
	saveSkill({ name: "demo-alpha", description: "第一个演示技能", steps: [{ tool: "list_windows" }, { tool: "verify_state", args: { kind: "app_running", contains: "X" } }], tags: ["demo"] });
	saveSkill({ name: "demo-beta", description: "第二个演示技能", steps: [{ tool: "screenshot" }] });
});
after(() => {
	configureSkillStore({ dir: null });
	rmSync(dir, { recursive: true, force: true });
});

test("导出全部：带版本与导出时间", () => {
	const bundle = exportSkills(undefined, { exportedAt: "2026-11-02T14:00:00.000Z" });
	assert.equal(bundle.version, SKILL_BUNDLE_VERSION);
	assert.equal(bundle.exportedAt, "2026-11-02T14:00:00.000Z");
	assert.deepEqual(bundle.skills.map((skill) => skill.name).sort(), ["demo-alpha", "demo-beta"]);
	assert.ok(Array.isArray(bundle.skills[0].steps));
});

test("按名字导出：只带指定的，找不到就报错", () => {
	const bundle = exportSkills(["demo-beta"]);
	assert.deepEqual(bundle.skills.map((skill) => skill.name), ["demo-beta"]);
	assert.throws(() => exportSkills(["nope"]), /skill not found: nope/);
});

test("导入：新技能直接落盘，重复需要 overwrite", () => {
	const bundle = exportSkills(["demo-beta"]);
	const renamed = { ...bundle, skills: [{ ...bundle.skills[0], name: "demo-gamma" }] };
	const first = importSkills(renamed);
	assert.deepEqual(first.imported, ["demo-gamma"]);

	const again = importSkills(renamed);
	assert.deepEqual(again.imported, []);
	assert.match(again.skipped[0].reason, /already exists/);

	const forced = importSkills(renamed, { overwrite: true });
	assert.deepEqual(forced.imported, ["demo-gamma"]);
});

test("导入：坏条目整条跳过并说明原因，好条目照常写入", () => {
	const bundle = {
		version: SKILL_BUNDLE_VERSION,
		exportedAt: "2026-11-02T14:00:00.000Z",
		skills: [
			{ name: "demo-delta", description: "合法描述文本", steps: [{ tool: "list_windows" }] },
			{ name: "Bad Name", description: "名字非法", steps: [{ tool: "x" }] },
			{ name: "demo-epsilon", description: "有密钥", steps: [{ tool: "x", args: { password: "hunter2" } }] }
		]
	};
	const result = importSkills(bundle);
	assert.deepEqual(result.imported, ["demo-delta"]);
	assert.equal(result.skipped.length, 2);
	assert.match(describeImport(result), /导入 1\/3 条/);
	assert.match(describeImport(result), /password/);
});

test("导入：包格式非法时直接拒绝", () => {
	assert.throws(() => importSkills(null), /expected an object/);
	assert.throws(() => importSkills({ skills: [] }), /missing version/);
	assert.throws(() => importSkills({ version: 99, skills: [] }), /unsupported skill bundle version/);
	assert.throws(() => importSkills({ version: 1, skills: {} }), /skills must be an array/);
});

test("包内同名两条：第二条计入跳过，不重复写（0.82.0）", () => {
	const bundle = {
		version: SKILL_BUNDLE_VERSION,
		exportedAt: "2026-11-02T14:00:00.000Z",
		skills: [
			{ name: "dup-one", description: "第一条同名", steps: [{ tool: "list_windows" }] },
			{ name: "dup-one", description: "第二条同名", steps: [{ tool: "screenshot" }] }
		]
	};
	const result = importSkills(bundle, { overwrite: true });
	assert.deepEqual(result.imported, ["dup-one"]);
	assert.equal(result.skipped.length, 1);
	assert.match(result.skipped[0].reason, /duplicate name/);
});
