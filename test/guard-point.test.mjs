import assert from "node:assert/strict";
import { test } from "node:test";

import { guardPointTarget } from "../lib/guard.js";

test("坐标点击命中危险词时要求确认", () => {
	const verdict = guardPointTarget({ role: "AXButton", title: "删除" });
	assert.equal(verdict.allowed, false);
	assert.match(verdict.reason, /guarded word/);
});

test("confirm:true 放行危险词", () => {
	const verdict = guardPointTarget({ role: "AXButton", title: "删除", confirm: true });
	assert.equal(verdict.allowed, true);
});

test("安全输入框即使没有危险词也要确认", () => {
	const verdict = guardPointTarget({ role: "AXSecureTextField", title: "密码" });
	assert.equal(verdict.allowed, false);
	assert.equal(verdict.secure, true);
});

test("普通按钮直接放行", () => {
	const verdict = guardPointTarget({ role: "AXButton", title: "保存" });
	assert.equal(verdict.allowed, true);
});

test("guard 关闭时不拦截", () => {
	const verdict = guardPointTarget({ role: "AXButton", title: "删除", enabled: false });
	assert.equal(verdict.allowed, true);
});
