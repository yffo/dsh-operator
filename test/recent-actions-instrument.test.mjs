// 0.64.2 回归：最近动作记录必须只发生在 operator 自己的 defineTool 上。
//
// 0.64.0 的实现替换了宿主的 `ctx.tools.register`，注册因此落到 global 作用域，
// 新建/恢复会话时会报 `tool "read" is already registered (for a per-agent variant, …)`。
// 这里钉住两条不变量：
//   1. 源码里不允许再出现对 ctx.tools.register 的赋值；
//   2. instrumentDefineTool 的包装只改 execute 行为，不改 name 与作用域。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { instrumentDefineTool } from "../lib/recent-actions-define-tool.js";
import { clearRecentActions, recentActions } from "../lib/recent-actions.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "lib/computer-use/index.js"), "utf8");

/** 最小 raw defineTool：原样返回定义对象。 */
const rawDefineTool = (definition) => definition;

test("源码不再给 ctx.tools.register 赋值（0.64.2 回归）", () => {
	assert.equal(/ctx\.tools\.register\s*=/.test(source), false, "不得替换宿主的 ctx.tools.register");
	assert.equal(/__dshOperatorRecentWrapped/.test(source), false, "旧的包装标记也应移除");
});

test("instrumentDefineTool 保留工具名与其它字段", () => {
	clearRecentActions();
	const defineTool = instrumentDefineTool(rawDefineTool);
	const definition = {
		name: "demo_tool",
		description: "demo",
		parameters: { x: { type: "number" } },
		execute: async () => "ok"
	};
	const built = defineTool(definition);
	assert.equal(built.name, "demo_tool");
	assert.equal(built.description, "demo");
	assert.deepEqual(built.parameters, { x: { type: "number" } });
	assert.notEqual(built.execute, definition.execute, "execute 应被包装");
	assert.equal(definition.execute === built.execute, false);
});

test("成功调用记一条 ok:true，返回值不变", async () => {
	clearRecentActions();
	const defineTool = instrumentDefineTool(rawDefineTool);
	const built = defineTool({ name: "demo_ok", execute: async (input) => ({ echoed: input }) });
	const value = await built.execute(7);
	assert.deepEqual(value, { echoed: 7 });
	assert.deepEqual(recentActions(5), [{ tool: "demo_ok", ok: true }]);
});

test("失败调用记一条 ok:false，异常原样抛出", async () => {
	clearRecentActions();
	const defineTool = instrumentDefineTool(rawDefineTool);
	const boom = new Error("kaboom");
	const built = defineTool({ name: "demo_fail", execute: async () => { throw boom; } });
	await assert.rejects(() => built.execute(), (error) => error === boom);
	assert.deepEqual(recentActions(5), [{ tool: "demo_fail", ok: false, note: "kaboom" }]);
});

test("没有 execute 的定义原样交给 rawDefineTool", () => {
	const defineTool = instrumentDefineTool(rawDefineTool);
	const definition = { name: "no_execute", description: "x" };
	assert.equal(defineTool(definition), definition);
});
