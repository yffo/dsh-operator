import assert from "node:assert/strict";
import { test } from "node:test";

import { RECENT_LIMIT, clearRecentActions, recentActions, recordRecentAction } from "../lib/recent-actions.js";

test("recordRecentAction：保留最近 N 条、忽略空工具名", () => {
	clearRecentActions();
	for (let index = 0; index < RECENT_LIMIT + 10; index += 1) recordRecentAction(`tool${index}`, index % 2 === 0, "x".repeat(200));
	recordRecentAction("", true);
	const rows = recentActions();
	assert.equal(rows.length, RECENT_LIMIT);
	assert.equal(rows.at(-1).tool, `tool${RECENT_LIMIT + 9}`);
	assert.ok(rows[0].note.length <= 80);
});

test("recentActions(limit)：limit 生效且不改缓冲", () => {
	clearRecentActions();
	recordRecentAction("a", true);
	recordRecentAction("b", false);
	assert.deepEqual(recentActions(2).map((row) => row.tool), ["a", "b"]);
	assert.equal(recentActions(10).length, 2);
});
