import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { HANDOFF_MAX_RECENT, readHandoff, summarizeHandoff, writeHandoff } from "../lib/state-handoff.js";
import { registerStateTools } from "../lib/state-tools.js";
import { clearRecentActions, recordRecentAction } from "../lib/recent-actions.js";

async function withHome(fn) {
	const home = mkdtempSync(join(tmpdir(), "dsh-handoff-"));
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		return await fn(home);
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
	}
}

test("writeHandoff → readHandoff round-trip（goal/todos/open）", async () => {
	await withHome(() => {
		const saved = writeHandoff({ goal: "把浏览器链路跑通", todos: [{ text: "绑定 Chrome", status: "completed" }, { text: "验证点击", status: "in_progress" }], open: ["补文档"] });
		assert.equal(saved.goal, "把浏览器链路跑通");
		const back = readHandoff();
		assert.equal(back.goal, "把浏览器链路跑通");
		assert.equal(back.todos[1].status, "in_progress");
		assert.deepEqual(back.open, ["补文档"]);
	});
});

test("recent 截断到上限、不存参数正文", async () => {
	await withHome(() => {
		const recent = Array.from({ length: 40 }, (_, index) => ({ tool: `t${index}`, ok: true, note: "x".repeat(200) }));
		const saved = writeHandoff({ recent });
		assert.equal(saved.recent.length, HANDOFF_MAX_RECENT);
		assert.equal(saved.recent.at(-1).tool, "t39");
		assert.ok(saved.recent[0].note.length <= 80);
		assert.equal("args" in saved.recent[0], false);
	});
});

test("summarizeHandoff：给新窗口 ≤1200 字符的摘要", async () => {
	await withHome(() => {
		const saved = writeHandoff({ goal: "长任务", todos: [{ text: "a", status: "completed" }, { text: "b", status: "pending" }], open: ["c"], recent: [{ tool: "browser_click", ok: true }] });
		const text = summarizeHandoff(saved);
		assert.match(text, /handoff: 上次/);
		assert.match(text, /未完成：b/);
		assert.match(text, /待办：c/);
		assert.match(text, /最近动作：browser_click/);
		assert.ok(text.length <= 1200);
		assert.match(summarizeHandoff(null), /handoff: 无/);
	});
});

test("registerStateTools：operator_brief 写、operator_resume 读", async () => {
	await withHome(async () => {
		const tools = new Map();
		const ctx = { tools: { register: (definition) => tools.set(definition.name, definition) } };
		const handle = registerStateTools(ctx, {}, { defineTool: (definition) => definition, version: "0.63.0" });
		assert.equal(handle.registered, true);
		const brief = tools.get("operator_brief");
		const resume = tools.get("operator_resume");
		assert.ok(brief !== undefined && resume !== undefined);
		await brief.execute({ goal: "接着干", todos: ["写测试", "completed: 补文档"], open: ["发版"] });
		const value = await resume.execute({});
		assert.match(value.text, /目标 接着干/);
		assert.match(value.text, /未完成：写测试/);
		assert.match(value.text, /待办：发版/);
	});
});


test("operator_brief 自动带上最近动作；operator_resume 补充失败建议", async () => {
	await withHome(async () => {
		clearRecentActions();
		recordRecentAction("browser_state", true);
		recordRecentAction("browser_click", false, "ref stale");
		const tools = new Map();
		const ctx = { tools: { register: (definition) => tools.set(definition.name, definition) } };
		registerStateTools(ctx, {}, { defineTool: (definition) => definition, version: "0.64.0" });
		await tools.get("operator_brief").execute({ goal: "验证", todos: ["A"], open: [] });
		const value = await tools.get("operator_resume").execute({});
		assert.match(value.text, /最近动作：browser_state, browser_click\(失败\)/);
		assert.match(value.text, /本次窗口最近：browser_state, browser_click\(失败\)/);
	});
});
