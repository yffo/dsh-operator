// 敏感数据识别（0.84.0 抽出，plan / 技能候选 / 技能校验共用）
//
// 背景：之前各处各自用 /(password|token|…)/ 查**顶层键名**，嵌套的
// `{options:{password:…}}` 和自由文本里的 `sk-…` 全部漏网。这里统一成两个函数。

/** 键名命中即视为敏感。 */
export const SENSITIVE_KEY_RE = /(password|passwd|secret|token|api[-_]?key|credential|cookie)/i;
/** 自由文本键：值可能承载用户输入，需要做密钥形态扫描。 */
const FREE_TEXT_KEYS = new Set(["text", "value", "content", "message", "note", "query", "answer"]);
/** 常见密钥形态（保守匹配，宁可多丢一条）。 */
const SECRET_PATTERNS = [
	/sk-[A-Za-z0-9_-]{16,}/,
	/(?:api[_-]?key|token|secret|password|passwd|bearer)\s*[:=]\s*\S{6,}/i,
	/AKIA[0-9A-Z]{16}/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/ghp_[A-Za-z0-9]{20,}/
];

/**
 * 递归查键名是否命中敏感词（深度上限 6 防环）。
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {boolean}
 */
export function containsSensitiveKey(value, depth = 0) {
	if (depth > 6 || value === null || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some((item) => containsSensitiveKey(item, depth + 1));
	for (const [key, item] of Object.entries(value)) {
		if (SENSITIVE_KEY_RE.test(key)) return true;
		if (containsSensitiveKey(item, depth + 1)) return true;
	}
	return false;
}

/**
 * 扫自由文本值里是否出现密钥形态。
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {boolean}
 */
export function containsSecretText(value, depth = 0) {
	if (depth > 6 || value === null || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some((item) => containsSecretText(item, depth + 1));
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "string" && FREE_TEXT_KEYS.has(key) && SECRET_PATTERNS.some((pattern) => pattern.test(item))) return true;
		if (containsSecretText(item, depth + 1)) return true;
	}
	return false;
}
