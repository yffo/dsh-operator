// 动作级后置断言（0.98.0，路线图 P1-2）
//
// 现状：`expect` 只在技能与计划里可用（executor 的 afterStep），单次 click/ax_press 没有。
// 结果就是「点完要我自己截图看对不对」。这里把断言下沉到单次动作：
// 传 expect 时，动作执行后立刻按回包事实判断，没达标就把该结果标成失败并说明哪条没达成。
//
// 断言对象是**动作回包的事实**（role/title/pressed/error/text…），不是渲染文案——
// 渲染发生在之后，拿不到。

import { evaluateExpect, validateExpect } from "./skill-expect.js";

/**
 * 把一个动作的返回值压成可供断言的事实文本。
 * @param {unknown} value
 * @returns {string}
 */
export function actionFacts(value) {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value !== "object") return String(value);
	const parts = [];
	for (const [key, item] of Object.entries(value)) {
		if (item === null || item === undefined) continue;
		if (typeof item === "object") continue;
		parts.push(`${key}=${String(item)}`);
	}
	return parts.join(" ");
}

/**
 * 校验并求值一次动作断言。
 * @param {unknown} expect
 * @param {unknown} value 动作返回值
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkActionExpect(expect, value) {
	if (expect === undefined) return { ok: true };
	const shape = validateExpect(expect);
	if (shape.length > 0) return { ok: false, reason: `expect 非法：${shape.join("; ")}` };
	const verdict = evaluateExpect(expect, actionFacts(value));
	return verdict.ok === true ? { ok: true } : { ok: false, reason: verdict.reason };
}
