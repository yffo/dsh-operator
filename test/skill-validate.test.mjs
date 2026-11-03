// 0.67.0 技能预检：工具名漂移时，在动手之前就报清楚。

import assert from "node:assert/strict";
import { test } from "node:test";

import { describePreflight, preflightSkill } from "../lib/skill-validate.js";

test("全部工具可用时通过", () => {
	const result = preflightSkill([{ tool: "open_app" }, { tool: "screenshot" }], ["open_app", "screenshot", "click"]);
	assert.equal(result.ok, true);
	assert.deepEqual(result.problems, []);
});

test("缺工具时报出步序号与工具名", () => {
	const result = preflightSkill([{ tool: "open_app" }, { tool: "legacy_click" }], ["open_app", "click"]);
	assert.equal(result.ok, false);
	assert.equal(result.problems.length, 1);
	assert.equal(result.problems[0].index, 1);
	assert.equal(result.problems[0].tool, "legacy_click");
	assert.match(describePreflight(result.problems), /第 2 步「legacy_click」/);
});

test("空工具名也算问题", () => {
	const result = preflightSkill([{ tool: "" }], ["click"]);
	assert.equal(result.ok, false);
	assert.match(result.problems[0].reason, /缺少工具名/);
});
