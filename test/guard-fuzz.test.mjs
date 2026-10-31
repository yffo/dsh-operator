import assert from "node:assert/strict";
import { test } from "node:test";

import {
	DANGEROUS_HOTKEYS,
	DANGEROUS_WORDS,
	SECURE_ROLES,
	guardHotkey,
	guardTitlePress,
	isSecureRole,
	matchDangerousHotkey,
	matchDangerousTitle,
	normalizeKeys
} from "../lib/guard.js";

/** 小而确定的 PRNG，保证 fuzz 可复现。 */
function mulberry32(seed) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const KEY_POOL = [
	"cmd", "command", "⌘", "ctrl", "control", "⌃", "option", "alt", "⌥", "shift", "⇧",
	"q", "Q", "escape", "esc", "return", "enter", "backspace", "delete", "space", "tab", "f4", "a", "x", "1", ""
];

test("guard：任意键组合都不会抛错，危险组合必须拦", () => {
	const random = mulberry32(42);
	for (let round = 0; round < 500; round += 1) {
		const size = Math.floor(random() * 5);
		const keys = Array.from({ length: size }, () => KEY_POOL[Math.floor(random() * KEY_POOL.length)]);
		const verdict = guardHotkey(keys, false, true);
		assert.equal(typeof verdict.allowed, "boolean");
		if (verdict.allowed === false) assert.match(verdict.reason, /guarded/);
		// 带 confirm 一定放行
		assert.equal(guardHotkey(keys, true, true).allowed, true);
		// guard 关闭一定放行
		assert.equal(guardHotkey(keys, false, false).allowed, true);
	}
});

test("guard：危险快捷键在别名/大小写/顺序变化下仍被识别", () => {
	const variants = [
		["cmd", "q"],
		["Command", "Q"],
		["⌘", "q"],
		["q", "cmd"],
		["command", "q", "q"]
	];
	for (const keys of variants) assert.equal(guardHotkey(keys, false).allowed, false, JSON.stringify(keys));
	assert.equal(matchDangerousHotkey(["cmd", "shift", "q"]), "退出登录");
	assert.equal(matchDangerousHotkey(["ctrl", "cmd", "q"]), "锁屏");
	assert.equal(matchDangerousHotkey(["cmd", "option", "escape"]), "强制退出");
	assert.equal(matchDangerousHotkey(["cmd", "q", "x"]), undefined);
	assert.equal(matchDangerousHotkey(null), undefined);
	assert.equal(matchDangerousHotkey("cmd+q"), undefined);
});

test("guard：normalizeKeys 只接受字符串数组且去空", () => {
	assert.deepEqual(normalizeKeys(["  CMD ", "Q", "", null, 3, "⌘"]), ["cmd", "q", "cmd"]);
	assert.deepEqual(normalizeKeys(undefined), []);
	assert.deepEqual(normalizeKeys({ 0: "cmd" }), []);
});

test("guard：危险标题 fuzz（大小写/子串/空格）都必须命中", () => {
	for (const word of DANGEROUS_WORDS) {
		const variants = [word, word.toUpperCase(), `  ${word}  `, `确认${word}吗`];
		for (const title of variants) {
			assert.equal(matchDangerousTitle(title), word, `${word} <= ${title}`);
			assert.equal(guardTitlePress({ title, confirm: false }).allowed, false);
			assert.equal(guardTitlePress({ title, confirm: true }).allowed, true);
			assert.equal(guardTitlePress({ title, confirm: false, enabled: false }).allowed, true);
		}
	}
	const random = mulberry32(7);
	for (let round = 0; round < 300; round += 1) {
		const title = Array.from({ length: 8 }, () => String.fromCharCode(33 + Math.floor(random() * 90))).join("");
		assert.equal(typeof guardTitlePress({ title, confirm: false }).allowed, "boolean");
	}
});

test("guard：安全输入角色只标记不拦截", () => {
	for (const role of SECURE_ROLES) {
		assert.equal(isSecureRole(role), true);
		const plain = guardTitlePress({ title: "密码", role });
		assert.equal(plain.allowed, true, "安全角色本身不拦截");
		assert.equal(plain.secure, true);
		const risky = guardTitlePress({ title: "删除密码", role, confirm: false });
		assert.equal(risky.allowed, false, "标题命中危险词仍要确认");
		assert.equal(risky.secure, true);
	}
	assert.equal(isSecureRole("AXTextField"), false);
	assert.equal(isSecureRole(undefined), false);
	assert.equal(guardTitlePress({ title: "普通按钮", confirm: false }).allowed, true);
});
