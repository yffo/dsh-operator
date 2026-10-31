import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DANGEROUS_HOTKEYS,
	GUARD_HINT,
	SECURE_ROLES,
	assertHotkeyGuarded,
	guardHotkey,
	guardTitlePress,
	isSecureRole,
	matchDangerousHotkey,
	matchDangerousTitle,
	normalizeKeys
} from "../lib/guard.js";

test("normalizeKeys 归一别名并小写", () => {
	assert.deepEqual(normalizeKeys(["Command", "Q"]), ["cmd", "q"]);
	assert.deepEqual(normalizeKeys(["alt", "esc"]), ["option", "escape"]);
	assert.deepEqual(normalizeKeys(["⌘", "⌥", "⌃"]), ["cmd", "option", "ctrl"]);
	assert.deepEqual(normalizeKeys(["Control", "Backspace"]), ["ctrl", "delete"]);
	assert.deepEqual(normalizeKeys([]), []);
	assert.deepEqual(normalizeKeys("cmd"), []);
	assert.deepEqual(normalizeKeys([1, null, "Shift"]), ["shift"]);
});

test("危险快捷键全部命中且不误报普通组合", () => {
	for (const rule of DANGEROUS_HOTKEYS) {
		assert.equal(matchDangerousHotkey(rule.keys), rule.label, `规则未命中: ${rule.label}`);
	}
	assert.equal(matchDangerousHotkey(["cmd", "c"]), undefined);
	assert.equal(matchDangerousHotkey(["cmd", "shift", "3"]), undefined);
	assert.equal(matchDangerousHotkey(["cmd"]), undefined);
});

test("guardHotkey：默认拦截，confirm 放行，关闭开关放行", () => {
	const denied = guardHotkey(["cmd", "q"], false);
	assert.equal(denied.allowed, false);
	assert.match(denied.reason, /退出应用/);
	assert.ok(denied.reason.includes("confirm: true"));
	assert.ok(denied.reason.includes(GUARD_HINT));

	assert.equal(guardHotkey(["cmd", "q"], true).allowed, true);
	assert.equal(guardHotkey(["cmd", "q"], false, false).allowed, true);
	assert.equal(guardHotkey(["cmd", "c"], false).allowed, true);
});

test("assertHotkeyGuarded：拦截时抛错，放行时静默", () => {
	assert.throws(() => assertHotkeyGuarded(["cmd", "option", "esc"], false), /computer-use: /);
	assert.doesNotThrow(() => assertHotkeyGuarded(["cmd", "option", "escape"], true));
	assert.doesNotThrow(() => assertHotkeyGuarded(["cmd", "c"], false));
});

test("matchDangerousTitle：大小写不敏感，命中中英文危险词", () => {
	assert.equal(matchDangerousTitle("删除全部"), "删除");
	assert.equal(matchDangerousTitle("Delete File"), "delete");
	assert.equal(matchDangerousTitle("Uninstall App"), "uninstall");
	assert.equal(matchDangerousTitle("发送"), "发送");
	assert.equal(matchDangerousTitle("Save"), undefined);
	assert.equal(matchDangerousTitle(undefined), undefined);
	assert.equal(matchDangerousTitle(""), undefined);
});

test("guardTitlePress：危险标题需 confirm，安全角色只标记", () => {
	const denied = guardTitlePress({ title: "删除", role: "AXButton", confirm: false });
	assert.equal(denied.allowed, false);
	assert.match(denied.reason, /删除/);

	assert.equal(guardTitlePress({ title: "删除", role: "AXButton", confirm: true }).allowed, true);
	assert.equal(guardTitlePress({ title: "取消", role: "AXButton", confirm: false }).allowed, true);
	assert.equal(guardTitlePress({ title: "删除", enabled: false }).allowed, true);

	const secure = guardTitlePress({ title: "密码", role: "AXSecureTextField", confirm: false });
	assert.equal(secure.allowed, true);
	assert.equal(secure.secure, true);
});

test("isSecureRole 只认安全输入角色", () => {
	assert.equal(isSecureRole("AXSecureTextField"), true);
	assert.equal(isSecureRole("AXTextField"), false);
	assert.equal(isSecureRole(undefined), false);
	assert.deepEqual(SECURE_ROLES, ["AXSecureTextField"]);
});
