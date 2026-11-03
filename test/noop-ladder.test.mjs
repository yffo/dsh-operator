// 0.99.0（P1-3）：noop 阶梯
import assert from "node:assert/strict";
import { test } from "node:test";

import { actionSignature, clearNoop, NOOP_TTL_MS, peekNoop, recordNoop, resetNoopLadder } from "../lib/noop-ladder.js";

test("阶梯：1 提示、2 升级、3 拒绝", () => {
	resetNoopLadder();
	const sig = actionSignature("click", { position: [10, 20] });
	assert.equal(recordNoop("s1", sig).action, "hint");
	assert.equal(recordNoop("s1", sig).action, "escalate");
	const third = recordNoop("s1", sig);
	assert.equal(third.action, "refuse");
	assert.equal(third.count, 3);
	assert.match(third.note, /拒绝继续重试/);
});

test("不同签名互不影响；成功的动作会清零", () => {
	resetNoopLadder();
	const a = actionSignature("click", { position: [1, 1] });
	const b = actionSignature("click", { position: [2, 2] });
	recordNoop("s1", a);
	recordNoop("s1", a);
	assert.equal(peekNoop("s1", a), 2);
	assert.equal(peekNoop("s1", b), 0, "不同动作各自计数");
	clearNoop("s1");
	assert.equal(peekNoop("s1", a), 0, "生效后清零");
});

test("过期记录不算数", () => {
	resetNoopLadder();
	const sig = actionSignature("click", { position: [3, 3] });
	recordNoop("s1", sig, 1000);
	assert.equal(peekNoop("s1", sig, 1000 + NOOP_TTL_MS + 1), 0, "超过 TTL 视为没有记录");
	assert.equal(recordNoop("s1", sig, 1000 + NOOP_TTL_MS + 1).count, 1, "重新从 1 开始");
});

test("签名包含工具与关键参数", () => {
	assert.match(actionSignature("click", { position: [5, 6] }), /^click\|position=5,6/);
	assert.match(actionSignature("ax_press", { index: 12 }), /index=12/);
});
