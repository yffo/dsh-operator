import assert from "node:assert/strict";
import { test } from "node:test";
import { PROFILES, classifyTask } from "../lib/task-profile.js";

test("task-profile：短单步任务判 simple", () => {
	const result = classifyTask("打开系统设置");
	assert.equal(result.tier, "simple");
	assert.equal(result.profile.maxSteps, PROFILES.simple.maxSteps);
	assert.equal(result.profile.requirePlan, false);
	assert.ok(result.profile.verifyAfterEach === false);
});

test("task-profile：多步骤但无跨应用信号判 standard", () => {
	const result = classifyTask("在系统设置里配置显示器参数并保存", { estSteps: 8 });
	assert.equal(result.tier, "standard");
	assert.equal(result.profile.maxSteps, 20);
	assert.equal(result.profile.verifyAfterEach, true);
});

test("task-profile：跨应用/登录/表单等信号判 complex", () => {
	const result = classifyTask("打开浏览器登录后台，填写表单并批量导出数据，然后整理成报告");
	assert.equal(result.tier, "complex");
	assert.equal(result.profile.maxSteps, 60);
	assert.equal(result.profile.requirePlan, true);
	assert.ok(result.matched.includes("登录"));
	assert.ok(result.matched.includes("批量"));
});

test("task-profile：显式 hint 优先，未知 hint 被忽略", () => {
	assert.equal(classifyTask("打开截图", { hint: "complex" }).tier, "complex");
	assert.equal(classifyTask("打开截图", { hint: "unknown-tier" }).tier, "simple");
});

test("task-profile：长文本与步数估计提高分数", () => {
	const longGoal = "把每个应用里的设置都过一遍，遇到需要登录的先记录，最后汇总成一份检查清单交给用户复核";
	assert.equal(classifyTask(longGoal).tier, "complex");
	const basic = classifyTask("点击按钮");
	const boosted = classifyTask("点击按钮", { estSteps: 20 });
	assert.equal(basic.tier, "simple");
	assert.equal(boosted.tier, "standard");
});

test("task-profile：返回值结构稳定（tier/profile/estSteps）", () => {
	const result = classifyTask("随便做点事", { estSteps: 3 });
	assert.equal(typeof result.tier, "string");
	assert.equal(typeof result.profile, "object");
	assert.equal(result.profile.tier, result.tier);
	assert.equal(result.estSteps, 3);
});
test("task-profile：多应用 + 多动作描述判 complex（0.14.1 回归）", () => {
	const result = classifyTask("从浏览器复制当前页面地址，打开备忘录记录标题和链接，再在日历创建明天上午的提醒");
	assert.equal(result.tier, "complex");
	assert.ok(result.matched.some((entry) => entry.startsWith("apps:")), `matched=${result.matched.join(",")}`);
	assert.ok(result.matched.some((entry) => entry.startsWith("actions:")), `matched=${result.matched.join(",")}`);
});

test("task-profile：单应用多动作仍按 standard（不误判 complex）", () => {
	const result = classifyTask("在备忘录里新建两条记录，保存后回到列表再打开第一条");
	assert.notEqual(result.tier, "complex");
});
