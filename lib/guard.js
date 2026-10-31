/**
 * 敏感动作 guard（0.9.0 初版）。
 *
 * 纯函数、无 I/O：规则集中在这里，方便单测和后续扩展。
 * 覆盖范围（v1）：
 * - 危险快捷键：退出应用 / 强制退出 / 锁屏 / 退出登录 / 清空废纸篓
 * - AXPress 目标标题命中危险词（删除/卸载/支付/发送…）
 * - 安全输入角色（只标记，不拦截）
 * 不覆盖：视觉 click/input_text 的语义目标（需要 AX hit-test，计划 v2）。
 */

/** 需要二次确认的快捷键组合（token 已归一化）。 */
export const DANGEROUS_HOTKEYS = [
	{ label: "退出应用", keys: ["cmd", "q"] },
	{ label: "强制退出", keys: ["cmd", "option", "escape"] },
	{ label: "锁屏", keys: ["ctrl", "cmd", "q"] },
	{ label: "退出登录", keys: ["cmd", "shift", "q"] },
	{ label: "清空废纸篓", keys: ["cmd", "shift", "delete"] }
];

/** 标题/描述里出现任一子串即视为危险目标。 */
export const DANGEROUS_WORDS = [
	"删除",
	"移除",
	"清空",
	"格式化",
	"抹掉",
	"卸载",
	"注销",
	"退出登录",
	"支付",
	"付款",
	"购买",
	"下单",
	"发送",
	"转账",
	"delete",
	"remove",
	"erase",
	"format",
	"uninstall",
	"pay",
	"purchase",
	"send"
];

/** 安全输入控件角色：只做标记，不参与拦截。 */
export const SECURE_ROLES = ["AXSecureTextField"];

/** 拒绝时回给模型的提示。 */
export const GUARD_HINT =
	"This action targets a destructive or irreversible control. If it is intended, call the same tool again with confirm: true; otherwise choose a safer path.";

const KEY_ALIASES = new Map([
	["command", "cmd"],
	["⌘", "cmd"],
	["control", "ctrl"],
	["⌃", "ctrl"],
	["option", "option"],
	["alt", "option"],
	["⌥", "option"],
	["esc", "escape"],
	["return", "enter"],
	["backspace", "delete"]
]);

/**
 * Normalize hotkey tokens for comparison.
 * @param keys - model-supplied key names.
 * @returns lower-case canonical tokens.
 */
export function normalizeKeys(keys) {
	if (!Array.isArray(keys)) return [];
	return keys
		.filter((key) => typeof key === "string")
		.map((key) => {
			const lower = key.trim().toLowerCase();
			return KEY_ALIASES.get(lower) ?? lower;
		})
		.filter((key) => key !== "");
}

/**
 * Match one hotkey against the dangerous list.
 * @param keys - model-supplied key names.
 * @returns the matched rule label, or undefined.
 */
export function matchDangerousHotkey(keys) {
	const wanted = new Set(normalizeKeys(keys));
	if (wanted.size === 0) return void 0;
	for (const rule of DANGEROUS_HOTKEYS) {
		if (rule.keys.length !== wanted.size) continue;
		if (rule.keys.every((key) => wanted.has(key))) return rule.label;
	}
	return void 0;
}

/**
 * Whether a hotkey needs explicit confirmation.
 * @param keys - model-supplied key names.
 * @param confirm - caller confirmation.
 * @param enabled - guard switch.
 * @returns `{ allowed, reason }`; `allowed:false` means the tool call should be refused.
 */
export function guardHotkey(keys, confirm, enabled = true) {
	if (enabled !== true) return { allowed: true };
	if (confirm === true) return { allowed: true };
	const label = matchDangerousHotkey(keys);
	if (label === void 0) return { allowed: true };
	return {
		allowed: false,
		reason: `${label} shortcut [${normalizeKeys(keys).join(" + ")}] is guarded. ${GUARD_HINT}`
	};
}

/**
 * Whether a native element title/description hits the dangerous list.
 * @param title - AX title or description.
 * @returns matched word, or undefined.
 */
export function matchDangerousTitle(title) {
	if (typeof title !== "string") return void 0;
	const lower = title.toLowerCase();
	for (const word of DANGEROUS_WORDS) {
		if (lower.includes(word.toLowerCase())) return word;
	}
	return void 0;
}

/** Whether the role is a secure input control. */
export function isSecureRole(role) {
	return typeof role === "string" && SECURE_ROLES.includes(role);
}

/**
 * Guard an AXPress target by its title/description.
 * @param input - `{ title, role, confirm, enabled }`.
 * @returns `{ allowed, reason?, secure? }`.
 */
export function guardTitlePress(input = {}) {
	const { title, role, confirm, enabled = true } = input;
	const secure = isSecureRole(role);
	if (enabled !== true) return { allowed: true, secure };
	if (confirm === true) return { allowed: true, secure };
	const word = matchDangerousTitle(title);
	if (word === void 0) return { allowed: true, secure };
	return {
		allowed: false,
		secure,
		reason: `Target "${String(title)}" matches guarded word "${word}". ${GUARD_HINT}`
	};
}

/**
 * Guard a hotkey from inside vendored tool code.
 * @param keys - model-supplied key names.
 * @param confirm - caller confirmation flag.
 * @param enabled - guard switch.
 * @throws Error when the hotkey needs confirmation.
 */
export function assertHotkeyGuarded(keys, confirm, enabled = true) {
	const verdict = guardHotkey(keys, confirm, enabled);
	if (verdict.allowed === true) return;
	throw new Error(`computer-use: ${verdict.reason}`);
}
