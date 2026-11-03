// 技能导出 / 导入（0.74.0）
//
// G3 要求「技能可导出/导入/校验失效」，之前只有本地增删查改与回放。
// 这里补齐迁移能力：一个自描述 JSON 包，导入时逐条过 validateSkill，
// 坏数据整条跳过并报原因，绝不半写进去。

import { listSkills, readSkill, saveSkill, validateSkill } from "./skill-store.js";

/** 导出包格式版本（结构变化时递增）。 */
export const SKILL_BUNDLE_VERSION = 1;
/** 单包最多携带的技能数（与本地库上限一致）。 */
export const MAX_BUNDLE_SKILLS = 100;

/**
 * 把技能打包成可迁移 JSON。
 * @param {string[]} [names] 省略则导出全部
 * @param {{ exportedAt?: string }} [options]
 * @returns {{ version: number, exportedAt: string, skills: Array<object> }}
 */
export function exportSkills(names, options = {}) {
	const wanted = Array.isArray(names) && names.length > 0 ? names.map((name) => String(name)) : null;
	const all = listSkills();
	const picked = wanted === null ? all : all.filter((skill) => wanted.includes(skill.name));
	const missing = wanted === null ? [] : wanted.filter((name) => all.some((skill) => skill.name === name) === false);
	if (missing.length > 0) throw new Error(`skill not found: ${missing.join(", ")}`);

	const truncated = picked.length > MAX_BUNDLE_SKILLS;
	const skills = picked.slice(0, MAX_BUNDLE_SKILLS).map((skill) => ({
		name: skill.name,
		description: skill.description,
		steps: skill.steps,
		...(Array.isArray(skill.variables) && skill.variables.length > 0 ? { variables: skill.variables } : {}),
		...(Array.isArray(skill.tags) && skill.tags.length > 0 ? { tags: skill.tags } : {})
	}));
	return {
		version: SKILL_BUNDLE_VERSION,
		exportedAt: typeof options.exportedAt === "string" ? options.exportedAt : new Date().toISOString(),
		// 0.82.0：截断要让调用方看得见，不能静默少导出
		...(truncated ? { truncated: true, exported: skills.length, available: picked.length } : {}),
		skills
	};
}

/**
 * 导入技能包。逐条校验：合法且不冲突才写入，冲突需 overwrite。
 * @param {object} bundle
 * @param {{ overwrite?: boolean }} [options]
 * @returns {{ imported: string[], skipped: Array<{name: string, reason: string}>, total: number }}
 */
export function importSkills(bundle, options = {}) {
	if (bundle === null || typeof bundle !== "object" || Array.isArray(bundle)) throw new Error("invalid skill bundle: expected an object");
	const version = Number(bundle.version ?? 0);
	if (!Number.isFinite(version) || version < 1) throw new Error("invalid skill bundle: missing version");
	if (version > SKILL_BUNDLE_VERSION) throw new Error(`unsupported skill bundle version ${String(version)}（当前支持 ≤ ${String(SKILL_BUNDLE_VERSION)}）`);
	if (Array.isArray(bundle.skills) === false) throw new Error("invalid skill bundle: skills must be an array");
	if (bundle.skills.length > MAX_BUNDLE_SKILLS) throw new Error(`too many skills in bundle (${String(bundle.skills.length)} > ${String(MAX_BUNDLE_SKILLS)})`);

	const imported = [];
	const skipped = [];
	const seen = new Set();
	for (const raw of bundle.skills) {
		const name = String(raw?.name ?? "");
		// 0.82.0：同名两条都写会「报 2/2 实际只剩 1 条」，改成第二条计入跳过
		if (name !== "" && seen.has(name)) {
			skipped.push({ name, reason: "duplicate name in bundle" });
			continue;
		}
		if (name !== "") seen.add(name);
		const validation = validateSkill(raw);
		if (validation.ok === false) {
			skipped.push({ name: name || "(unnamed)", reason: validation.errors.join("; ") });
			continue;
		}
		try {
			saveSkill(raw, { overwrite: options.overwrite === true });
			imported.push(name);
		} catch (error) {
			skipped.push({ name, reason: error instanceof Error ? error.message : String(error) });
		}
	}
	return { imported, skipped, total: bundle.skills.length };
}

/** 导入结果的人类可读摘要。 */
export function describeImport(result) {
	const lines = [`导入 ${String(result.imported.length)}/${String(result.total)} 条`];
	if (result.skipped.length > 0) {
		lines.push("跳过：");
		for (const item of result.skipped) lines.push(`- ${item.name}：${item.reason}`);
	}
	return lines.join("\n");
}
