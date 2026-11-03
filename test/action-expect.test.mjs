// 0.98.0（P1-2）：单次动作的后置断言
import assert from "node:assert/strict";
import { test } from "node:test";

import { actionFacts, checkActionExpect } from "../lib/action-expect.js";

test("actionFacts：把回包压成可断言的键值事实串", () => {
	const text = actionFacts({ pressed: true, role: "AXButton", title: "保存", nested: { a: 1 } });
	assert.match(text, /pressed=true/);
	assert.match(text, /title=保存/);
	assert.doesNotMatch(text, /nested/, "对象字段跳过，避免噪音");
});

test("checkActionExpect：contains 命中/未命中", () => {
	assert.equal(checkActionExpect(undefined, { pressed: true }).ok, true, "不传 expect 永远通过");
	assert.equal(checkActionExpect({ contains: "pressed=true" }, { pressed: true }).ok, true);
	const miss = checkActionExpect({ contains: "开启" }, { pressed: true, title: "关闭" });
	assert.equal(miss.ok, false);
	assert.match(miss.reason, /没有「开启」/);
});

test("checkActionExpect：absent 出现即失败", () => {
	const hit = checkActionExpect({ absent: "error=" }, { pressed: false, error: "not found" });
	assert.equal(hit.ok, false);
	assert.match(hit.reason, /error=/);
});

test("checkActionExpect：非法 expect 形状直接报出来", () => {
	const bad = checkActionExpect({}, { pressed: true });
	assert.equal(bad.ok, false);
	assert.match(bad.reason, /expect 非法/);
});
