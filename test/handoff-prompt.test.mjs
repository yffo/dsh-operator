// 0.65.0 交接自动注入：新窗口第一轮就该知道上一窗口做到哪。
//
// 这里钉住四条不变量：
//   1. 有交接文件 → 注册一节系统提示，内容含目标与未完成项；
//   2. 没有交接 → 静默跳过（不注册空节）；
//   3. 交接太旧（> 14 天）→ 跳过，别用过期信息误导；
//   4. 宿主没给 systemPrompt → 不抛错。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
	HANDOFF_PROMPT_MAX_CHARS,
	HANDOFF_SECTION_NAME,
	HANDOFF_START_PHRASE,
	registerHandoffPrompt
} from "../lib/handoff-prompt.js";
import { writeHandoff } from "../lib/state-handoff.js";

let home;
const previousHome = process.env.DSH_HOME;

before(() => {
	home = mkdtempSync(join(tmpdir(), "dsh-operator-handoff-"));
	process.env.DSH_HOME = home;
});

after(() => {
	if (previousHome === undefined) delete process.env.DSH_HOME;
	else process.env.DSH_HOME = previousHome;
	rmSync(home, { recursive: true, force: true });
});

/** 最小的 systemPrompt 桩，记录注册进来的节。 */
function fakeCtx() {
	const sections = [];
	return {
		sections,
		ctx: { systemPrompt: { section: (definition) => sections.push(definition) } }
	};
}

test("有交接：注入一节，内容含目标与未完成项", () => {
	writeHandoff({
		goal: "把 0.65 的交接注入做完",
		todos: [{ text: "写回归测试", status: "in_progress" }],
		open: ["跑全量测试"]
	});
	const { ctx, sections } = fakeCtx();
	const result = registerHandoffPrompt(ctx);
	assert.equal(result.injected, true);
	assert.equal(sections.length, 1);
	assert.equal(sections[0].name, HANDOFF_SECTION_NAME);
	const text = sections[0].text();
	assert.match(text, /把 0\.65 的交接注入做完/);
	assert.match(text, /写回归测试/);
	assert.match(text, /operator_resume/);
	// 启动暗号必须出现在注入文本里，新窗口才知道「接手」两个字是什么意思
	assert.ok(text.includes(HANDOFF_START_PHRASE), "注入文本缺少启动暗号");
});

test("太旧的交接不注入", () => {
	const { ctx, sections } = fakeCtx();
	const result = registerHandoffPrompt(ctx, { now: Date.now() + 30 * 86400000 });
	assert.equal(result.injected, false);
	assert.equal(result.reason, "stale");
	assert.equal(sections.length, 0);
});

test("宿主没有 systemPrompt 时安全跳过", () => {
	const result = registerHandoffPrompt({});
	assert.equal(result.injected, false);
	assert.equal(result.reason, "no-system-prompt");
});

test("摘要不超过上限", () => {
	const longGoal = "目标".repeat(500);
	writeHandoff({ goal: longGoal, todos: [], open: [] });
	const { ctx, sections } = fakeCtx();
	registerHandoffPrompt(ctx);
	const text = sections[0].text();
	// 注入正文 = 标题行 + 摘要（≤ maxChars）+ 尾注
	assert.ok(text.length <= HANDOFF_PROMPT_MAX_CHARS + 120, `注入文本过长：${text.length}`);
});

test("没有交接文件时什么都不注册", () => {
	rmSync(join(home, "dsh-operator"), { recursive: true, force: true });
	const { ctx, sections } = fakeCtx();
	const result = registerHandoffPrompt(ctx);
	assert.equal(result.injected, false);
	assert.equal(result.reason, "no-handoff");
	assert.equal(sections.length, 0);
});
