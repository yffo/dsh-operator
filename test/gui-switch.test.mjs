// 0.69.0 只读模式（GUI 总开关）：需要「只看不动」时不必卸载插件。

import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
	guiToolsAllowed,
	instrumentDefineTool,
	isGuiToolName,
	setGuiToolsEnabled
} from "../lib/recent-actions-define-tool.js";

const rawDefineTool = (definition) => definition;

after(() => setGuiToolsEnabled(true));

test("GUI 工具识别：键鼠/窗口/浏览器算，纯状态工具不算", () => {
	for (const name of ["click", "ax_press", "cua_observe", "cu_act", "browser_click", "list_windows", "open_app", "hotkey", "screenshot"]) {
		assert.equal(isGuiToolName(name), true, `${name} 应算 GUI 工具`);
	}
	for (const name of ["operator_brief", "operator_resume", "plan_create", "plan_run", "skill_save", "skill_run", "failure_list"]) {
		assert.equal(isGuiToolName(name), false, `${name} 不应算 GUI 工具`);
	}
	assert.equal(isGuiToolName(""), false);
});

test("关掉后：GUI 工具执行前被拒，状态工具照常", async () => {
	setGuiToolsEnabled(false);
	assert.equal(guiToolsAllowed(), false);
	const defineTool = instrumentDefineTool(rawDefineTool);

	const click = defineTool({ name: "click", execute: async () => ({ ok: true }) });
	await assert.rejects(() => click.execute(), /guiTools=false/);

	const brief = defineTool({ name: "operator_brief", execute: async () => ({ ok: true }) });
	assert.deepEqual(await brief.execute(), { ok: true });
});

test("重新打开后 GUI 工具恢复", async () => {
	setGuiToolsEnabled(true);
	const defineTool = instrumentDefineTool(rawDefineTool);
	const click = defineTool({ name: "click", execute: async () => ({ ok: true }) });
	assert.deepEqual(await click.execute(), { ok: true });
});
