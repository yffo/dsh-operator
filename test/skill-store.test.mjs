import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { configureSkillStore, deleteSkill, listSkills, readSkill, saveSkill, skillDir, validateSkill } from "../lib/skill-store.js";
import { registerOperatorTools, resetOperatorToolsInternals } from "../lib/operator-tools.js";

let dir;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dsh-operator-skills-"));
	configureSkillStore({ dir });
	resetOperatorToolsInternals();
});

afterEach(() => {
	configureSkillStore({});
	resetOperatorToolsInternals();
	rmSync(dir, { recursive: true, force: true });
});

const SKILL = {
	name: "open-display-settings",
	description: "Open System Settings → Displays and report panel state",
	steps: [
		{ tool: "open_app", args: { name: "系统设置" } },
		{ tool: "ax_press", args: { index: 32, expect_role: "AXButton", expect_title: "显示器" } }
	],
	tags: ["settings", "macos"]
};

test("skill-store：validate 正常与异常", () => {
	assert.deepEqual(validateSkill(SKILL), { ok: true, errors: [] });
	const badName = validateSkill({ ...SKILL, name: "../etc/passwd" });
	assert.equal(badName.ok, false);
	assert.match(badName.errors[0], /kebab-case/);
	const badSteps = validateSkill({ ...SKILL, steps: [] });
	assert.equal(badSteps.ok, false);
	const badArgs = validateSkill({ ...SKILL, steps: [{ tool: "x", args: [] }] });
	assert.equal(badArgs.ok, false);
	const secret = validateSkill({ ...SKILL, steps: [{ tool: "x", args: { apiKey: "k" } }] });
	assert.equal(secret.ok, false);
	assert.match(secret.errors.join(";"), /sensitive/);
});

test("skill-store：save/read/list/delete 全流程", () => {
	const saved = saveSkill(SKILL);
	assert.equal(saved.name, SKILL.name);
	assert.equal(saved.overwritten, false);
	assert.equal(existsSync(join(dir, `${SKILL.name}.json`)), true);
	const read = readSkill(SKILL.name);
	assert.equal(read.description, SKILL.description);
	assert.equal(read.steps.length, 2);
	assert.equal(read.tags[0], "settings");
	assert.equal(read.version, 1);
	assert.equal(listSkills().length, 1);
	assert.throws(() => saveSkill(SKILL), /already exists/);
	const again = saveSkill({ ...SKILL, description: "updated" }, { overwrite: true });
	assert.equal(again.overwritten, true);
	assert.equal(readSkill(SKILL.name).description, "updated");
	assert.equal(deleteSkill(SKILL.name), true);
	assert.equal(deleteSkill(SKILL.name), false);
	assert.equal(listSkills().length, 0);
});

test("skill-store：非法名字与不存在技能明确报错", () => {
	assert.throws(() => readSkill("../x"), /invalid skill name/);
	assert.throws(() => readSkill("never-saved"), /skill not found/);
	assert.equal(skillDir(), dir);
});

function collectTools() {
	const tools = {};
	const ctx = { tools: { register: (tool) => { tools[tool.name] = tool; } } };
	registerOperatorTools(ctx, { axMaxNodes: 120, guard: false, failureSamples: false }, { backend: { listScreens: async () => [] }, defineTool: (definition) => definition });
	return tools;
}

test("skill 工具：save → list → show → delete（含 schema 形状）", async () => {
	if (process.platform !== "darwin") return;
	const tools = collectTools();
	const exec = { signal: new AbortController().signal };
	for (const name of ["skill_save", "skill_list", "skill_show", "skill_delete"]) assert.equal(typeof tools[name]?.execute, "function");

	const saved = await tools.skill_save.execute({ ...SKILL }, exec);
	assert.equal(saved.ok, true);
	assert.equal(saved.bytes > 0, true);

	const listed = await tools.skill_list.execute({}, exec);
	assert.equal(listed.total, 1);
	assert.deepEqual(listed.skills[0], { name: SKILL.name, description: SKILL.description, steps: 2, tags: SKILL.tags, updatedAt: listed.skills[0].updatedAt });

	const shown = await tools.skill_show.execute({ name: SKILL.name }, exec);
	assert.equal(shown.ok, true);
	assert.match(shown.json, /open_app/);

	const removed = await tools.skill_delete.execute({ name: SKILL.name }, exec);
	assert.equal(removed.deleted, true);
	const missing = await tools.skill_delete.execute({ name: SKILL.name }, exec);
	assert.equal(missing.ok, true);
	assert.equal(missing.deleted, false);
	const bad = await tools.skill_save.execute({ name: "Bad Name", description: "x", steps: [{ tool: "t" }] }, exec);
	assert.equal(bad.ok, false);
});
