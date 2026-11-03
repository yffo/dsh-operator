// 0.79.0 技能自动候选：只记成功的 GUI 动作，敏感参数整条丢弃。

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { buildCandidateSkill, candidateCount, listCandidates, recordCandidate, resetCandidates, sessionKeyOf, setCandidateRecording } from "../lib/skill-candidates.js";

after(() => {
	setCandidateRecording(true);
	resetCandidates();
});

test("只收 GUI 工具的成功动作，参数原样保留", () => {
	resetCandidates();
	assert.equal(recordCandidate("open_app", { name: "系统设置" }), true);
	assert.equal(recordCandidate("plan_create", { goal: "x" }), false, "非 GUI 工具不进候选");
	assert.equal(candidateCount(), 1);
});

test("敏感参数整条丢弃", () => {
	resetCandidates();
	assert.equal(recordCandidate("input_text", { text: "hi", password: "hunter2" }), false);
	assert.equal(candidateCount(), 0, "命中敏感键的动作不能留下半条");
});

test("生成技能草案：名字/描述/步骤齐全且能被校验", () => {
	resetCandidates();
	recordCandidate("open_app", { name: "访达" });
	recordCandidate("ax_menu", { path: "文件/新建访达窗口" });
	const built = buildCandidateSkill({ name: "captured-finder-window", description: "访达新建窗口", now: new Date("2026-11-03T00:00:00Z") });
	assert.equal(built.ok, true);
	assert.equal(built.skill.name, "captured-finder-window");
	assert.equal(built.skill.steps.length, 2);
	assert.deepEqual(built.skill.steps[1], { tool: "ax_menu", args: { path: "文件/新建访达窗口" } });
});

test("空候选与关闭开关", () => {
	resetCandidates();
	assert.equal(buildCandidateSkill().ok, false);
	setCandidateRecording(false);
	assert.equal(recordCandidate("open_app", { name: "x" }), false);
	setCandidateRecording(true);
});

// 0.82.0：隐私与成功判定回归
import { instrumentDefineTool } from "../lib/recent-actions-define-tool.js";

test("嵌套敏感键与密钥形态的文本整条丢弃", () => {
	resetCandidates();
	assert.equal(recordCandidate("cua_act", { options: { password: "hunter2" } }), false, "嵌套 password 必须拦");
	assert.equal(recordCandidate("input_text", { text: "sk-live-SECRET-12345" }), false, "文本里的密钥形态必须拦");
	assert.equal(recordCandidate("input_text", { text: "普通一句话" }), true, "普通文本照常收");
	assert.equal(candidateCount(), 1);
});

test("包装器：返回值表达失败时不记候选（open_app 不存在的 App）", async () => {
	resetCandidates();
	const defineTool = instrumentDefineTool((definition) => definition);
	const tool = defineTool({
		name: "open_app",
		execute: async () => ({ ok: false, error: "app not found" })
	});
	await tool.execute({ name: "不存在的App" }, {});
	assert.equal(candidateCount(), 0, "失败动作不能进候选");

	const okTool = defineTool({ name: "open_app", execute: async () => ({ ok: true }) });
	await okTool.execute({ name: "访达" }, {});
	assert.equal(candidateCount(), 1);
});

test("包装器：回放（replay:true）不喂候选", async () => {
	resetCandidates();
	const defineTool = instrumentDefineTool((definition) => definition);
	const tool = defineTool({ name: "open_app", execute: async () => ({ ok: true }) });
	await tool.execute({ name: "访达" }, { replay: true });
	assert.equal(candidateCount(), 0);
});

// 0.83.0：候选按会话分桶
test("不同会话的候选互不可见；未标记条目对所有人可见", () => {
	resetCandidates();
	recordCandidate("open_app", { name: "A 的应用" }, "session-a");
	recordCandidate("open_app", { name: "B 的应用" }, "session-b");
	assert.equal(candidateCount("session-a"), 1);
	assert.equal(candidateCount("session-b"), 1);
	const draftA = buildCandidateSkill({ key: "session-a", description: "A 会话的草案" });
	assert.equal(draftA.ok, true);
	assert.deepEqual(draftA.skill.steps.map((step) => step.args.name), ["A 的应用"]);
	assert.equal(candidateCount(""), 2, "空 key 仍看到全部");
});

// RETRO #3：同一进程内两个 agent 共用一个桶——用真实 exec 形状走完整链路实测
test("两个 agent 交错操作时，候选按 agent 隔离且顺序正确", async () => {
	resetCandidates();
	const defineTool = instrumentDefineTool((definition) => definition);
	const tool = defineTool({ name: "open_app", execute: async () => ({ ok: true }) });
	const agentA = { agent: { id: "agent-a" } };
	const agentB = { agent: { id: "agent-b" } };
	await tool.execute({ name: "A1" }, agentA);
	await tool.execute({ name: "B1" }, agentB);
	await tool.execute({ name: "A2" }, agentA);
	await tool.execute({ name: "B2" }, agentB);
	assert.equal(candidateCount(sessionKeyOf(agentA)), 2);
	assert.equal(candidateCount(sessionKeyOf(agentB)), 2);
	const draftA = buildCandidateSkill({ key: sessionKeyOf(agentA) });
	const draftB = buildCandidateSkill({ key: sessionKeyOf(agentB) });
	assert.deepEqual(draftA.skill.steps.map((step) => step.args.name), ["A1", "A2"], "A 的草案不能夹 B 的动作");
	assert.deepEqual(draftB.skill.steps.map((step) => step.args.name), ["B1", "B2"]);
});

test("没有会话标识的动作会混进所有会话草案（已知边界，行为固定下来）", async () => {
	resetCandidates();
	const defineTool = instrumentDefineTool((definition) => definition);
	const tool = defineTool({ name: "open_app", execute: async () => ({ ok: true }) });
	await tool.execute({ name: "无主动作" }, {});
	await tool.execute({ name: "A 的动作" }, { agent: { id: "agent-a" } });
	const draft = buildCandidateSkill({ key: "agent-a" });
	assert.deepEqual(draft.skill.steps.map((step) => step.args.name), ["无主动作", "A 的动作"], "未标记条目对所有人可见是设计行为");
});

test("候选上限是全局共享的：两会话交错刷满后只留最近 24 步", () => {
	resetCandidates();
	for (let i = 0; i < 15; i += 1) recordCandidate("open_app", { name: `A${String(i)}` }, "a");
	for (let i = 0; i < 15; i += 1) recordCandidate("open_app", { name: `B${String(i)}` }, "b");
	assert.equal(candidateCount("a"), 9, "A 最早的 6 条被共享上限挤掉");
	assert.equal(candidateCount("b"), 15);
	assert.equal(listCandidates().length, 24);
});
