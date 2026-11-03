// 技能步骤级校验（0.75.0）
//
// 「动作执行成功」不等于「达到预期」：点到了按钮但页面没变、输入框拿到焦点但字没进去，
// 这些在回放里都表现为 ok。这里给技能步骤两种校验：
//   expect: { contains: "关键词", absent: "错误词" }   —— 对步骤回包文本做断言（零成本）
//   verify: { kind: "window_title", contains: "设置" } —— 额外跑一次 verify_state 做独立确认
//
// 断言失败会把该步标成 failed 并给出原因，回放据此停在第几步。

/** expect 条数上限（0.82.0）。 */
const MAX_EXPECT_TERMS = 32;
/** expect/verify 序列化后的字节上限（0.82.0）。 */
const MAX_EXPECT_BYTES = 4096;
/** verify 允许的谓词种类（与 verify_state 的枚举一致）。 */
export const VERIFY_KINDS = Object.freeze(["window_title", "frontmost_app", "app_running", "ax_text", "ax_element"]);
/** 每种谓词至少要带的字段之一。 */
const VERIFY_REQUIRED = {
	window_title: ["contains"],
	frontmost_app: ["contains"],
	app_running: ["contains"],
	ax_text: ["contains"],
	ax_element: ["role", "title", "value"]
};

/**
 * 把 string | string[] 归一成字符串数组。
 * @param {unknown} value
 * @returns {string[]}
 */
function asList(value) {
	if (typeof value === "string") return value.trim() === "" ? [] : [value];
	if (Array.isArray(value)) return value.filter((item) => typeof item === "string" && item.trim() !== "");
	return [];
}

/**
 * 校验 expect 形状（供 skill 保存时使用）。
 * @param {unknown} expect
 * @returns {string[]} 错误列表（空 = 合法）
 */
export function validateExpect(expect) {
	if (expect === undefined) return [];
	if (expect === null || typeof expect !== "object" || Array.isArray(expect)) return ["expect must be an object"];
	const errors = [];
	const contains = asList(expect.contains);
	const absent = asList(expect.absent);
	if (contains.length === 0 && absent.length === 0) errors.push("expect needs contains or absent");
	// 0.82.0：args 有 8KB 上限，expect 之前完全没有
	if (contains.length + absent.length > MAX_EXPECT_TERMS) errors.push(`expect too many terms (<=${MAX_EXPECT_TERMS})`);
	if (Buffer.byteLength(JSON.stringify(expect)) > MAX_EXPECT_BYTES) errors.push(`expect too large (<=${MAX_EXPECT_BYTES} bytes)`);
	if (expect.contains !== undefined && contains.length === 0) errors.push("expect.contains must be a non-empty string or string array");
	if (expect.absent !== undefined && absent.length === 0) errors.push("expect.absent must be a non-empty string or string array");
	for (const text of [...contains, ...absent]) {
		if (text.length > 200) errors.push("expect text too long (<=200)");
	}
	return errors;
}

/**
 * 对一步的回包文本做断言。
 * @param {unknown} expect
 * @param {string} summary 步骤回包摘要
 * @returns {{ ok: boolean, reason?: string }}
 */
export function evaluateExpect(expect, summary) {
	const errors = validateExpect(expect);
	if (errors.length > 0) return { ok: false, reason: `expect 非法：${errors.join("; ")}` };
	if (expect === undefined) return { ok: true };
	const text = String(summary ?? "");
	const contains = asList(expect.contains);
	const absent = asList(expect.absent);
	const missing = contains.filter((needle) => text.includes(needle) === false);
	if (missing.length > 0) return { ok: false, reason: `expect 未满足：回包里没有「${missing.join("、")}」` };
	const hit = absent.filter((needle) => text.includes(needle));
	if (hit.length > 0) return { ok: false, reason: `expect 未满足：回包里出现了「${hit.join("、")}」` };
	return { ok: true };
}

/**
 * 校验 verify 形状。
 * @param {unknown} verify
 * @returns {string[]}
 */
export function validateVerify(verify) {
	if (verify === undefined) return [];
	if (verify === null || typeof verify !== "object" || Array.isArray(verify)) return ["verify must be an object"];
	if (typeof verify.kind !== "string" || verify.kind.trim() === "") return ["verify.kind is required"];
	const errors = [];
	// 0.82.0：拼错的 kind 会被静默轮询到超时，必须在保存时就拦下
	if (VERIFY_KINDS.includes(verify.kind) === false) errors.push(`verify.kind must be one of ${VERIFY_KINDS.join("/")}`);
	else {
		const required = VERIFY_REQUIRED[verify.kind] ?? [];
		if (required.every((field) => verify[field] === undefined)) errors.push(`verify.${verify.kind} needs one of ${required.join("/")}`);
	}
	if (Buffer.byteLength(JSON.stringify(verify)) > MAX_EXPECT_BYTES) errors.push(`verify too large (<=${MAX_EXPECT_BYTES} bytes)`);
	return errors;
}
