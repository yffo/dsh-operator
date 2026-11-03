// 0.88.0：操作约定注入 + ax_menu 的 App 校验
import assert from "node:assert/strict";
import { test } from "node:test";

import { CONVENTIONS_SECTION_NAME, registerOperatingConventions } from "../lib/operating-conventions.js";

test("操作约定：注册到系统提示，内容含「复用窗口」与「菜单栏属于前台 App」", () => {
	const sections = [];
	const ctx = { systemPrompt: { section: (section) => sections.push(section) } };
	const verdict = registerOperatingConventions(ctx);
	assert.equal(verdict.injected, true);
	assert.equal(sections.length, 1);
	assert.equal(sections[0].name, CONVENTIONS_SECTION_NAME);
	const text = sections[0].text();
	assert.match(text, /复用窗口，不要新建/);
	assert.match(text, /菜单栏属于\*\*前台 App\*\*/);
	assert.match(text, /open_in_finder/);
});

test("操作约定：宿主没有 systemPrompt 时静默跳过", () => {
	assert.equal(registerOperatingConventions({}).injected, false);
	assert.equal(registerOperatingConventions(undefined).reason, "no-system-prompt");
});
