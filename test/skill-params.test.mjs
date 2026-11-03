// 技能参数化（0.66.0）回归：同一条技能换参数就能跑不同目标。
//
// 钉住四条不变量：
//   1. 收集占位符：嵌套对象/数组里的 {{name}} 都能找到，去重排序；
//   2. 替换：有值的占位符被替换，非字符串参数原样保留；
//   3. 缺参数：保留占位符原样，并报出缺了哪些名字；
//   4. 无占位符的技能：步骤结构不变（不能因为这次改动影响老技能）。

import assert from "node:assert/strict";
import { test } from "node:test";

import { applySkillArgs, collectVariables } from "../lib/skill-params.js";

test("收集嵌套的占位符并去重排序", () => {
	const steps = [
		{ tool: "open_app", args: { name: "{{app}}" } },
		{ tool: "input_text", args: { text: "{{query}}", position: ["{{x}}", "{{y}}"] } },
		{ tool: "screenshot", args: { note: "{{app}} {{ query }}" } }
	];
	assert.deepEqual(collectVariables(steps), ["app", "query", "x", "y"]);
});

test("替换有值的占位符，非字符串原样保留", () => {
	const steps = [
		{ tool: "open_app", args: { name: "{{app}}", flag: true, count: 3 } },
		{ tool: "browser_type", args: { text: "在 {{app}} 里搜 {{query}}" } }
	];
	const { steps: filled, missing, used } = applySkillArgs(steps, { app: "系统设置", query: "显示器" });
	assert.deepEqual(missing, []);
	assert.deepEqual(used, ["app", "query"]);
	assert.equal(filled[0].args.name, "系统设置");
	assert.equal(filled[0].args.flag, true);
	assert.equal(filled[0].args.count, 3);
	assert.equal(filled[1].args.text, "在 系统设置 里搜 显示器");
	// 原始步骤不被修改
	assert.equal(steps[0].args.name, "{{app}}");
});

test("缺参数：保留占位符并报出名字", () => {
	const { steps, missing } = applySkillArgs([{ tool: "open_app", args: { name: "{{app}}" } }], {});
	assert.deepEqual(missing, ["app"]);
	assert.equal(steps[0].args.name, "{{app}}");
});

test("没有占位符的技能步骤保持等价", () => {
	const steps = [{ tool: "hotkey", args: { keys: ["cmd", "c"] } }];
	const { steps: filled, missing, used } = applySkillArgs(steps, { unused: "x" });
	assert.deepEqual(missing, []);
	assert.deepEqual(used, []);
	assert.deepEqual(filled, steps);
});
