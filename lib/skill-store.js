/**
 * 技能库（0.11.2 起步版）：把可复用的操作序列存成 JSON，供后续录制/回放。
 *
 * 存储：~/.dsh/dsh-operator/skills/<name>.json（每个技能一个文件，默认最多 100 个）。
 * 设计约束：
 * - 只存「工具名 + 参数」，不存截图/剪贴板内容/密码；参数里疑似密钥字段一律拒绝。
 * - 名字限小写 kebab-case，避免路径穿越；写入用临时文件 + rename（原子）。
 * - 回放执行器在下一版接；本版只做增删查改与校验。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const MAX_SKILLS = 100;
const MAX_STEPS = 50;
const MAX_ARGS_BYTES = 8192;
const SENSITIVE_KEY_RE = /(password|passwd|secret|token|api[-_]?key|credential|cookie)/i;

let overrides = {};

/** 覆盖存储目录（测试用）。传 null 恢复默认。 */
export function configureSkillStore(options = {}) {
	overrides = { ...options };
}

export function skillDir() {
	return overrides.dir ?? process.env.DSH_OPERATOR_SKILL_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-operator", "skills");
}

function skillPath(name) {
	return join(skillDir(), `${name}.json`);
}

export function validateSkill(skill) {
	const errors = [];
	if (typeof skill !== "object" || skill === null) return { ok: false, errors: ["skill must be an object"] };
	if (typeof skill.name !== "string" || NAME_RE.test(skill.name) === false) errors.push("name must be kebab-case (2-64 chars: a-z0-9-)");
	if (typeof skill.description !== "string" || skill.description.trim().length < 4) errors.push("description is required (>=4 chars)");
	else if (skill.description.length > 200) errors.push("description too long (<=200)");
	if (Array.isArray(skill.steps) === false || skill.steps.length === 0) errors.push("steps must be a non-empty array");
	else if (skill.steps.length > MAX_STEPS) errors.push(`steps too many (<=${MAX_STEPS})`);
	else {
		skill.steps.forEach((step, index) => {
			if (typeof step?.tool !== "string" || step.tool.trim() === "") errors.push(`steps[${index}].tool is required`);
			if (step?.args !== undefined) {
				if (typeof step.args !== "object" || step.args === null || Array.isArray(step.args)) errors.push(`steps[${index}].args must be an object`);
				else {
					const bytes = Buffer.byteLength(JSON.stringify(step.args));
					if (bytes > MAX_ARGS_BYTES) errors.push(`steps[${index}].args too large (${bytes} > ${MAX_ARGS_BYTES})`);
					for (const key of Object.keys(step.args)) {
						if (SENSITIVE_KEY_RE.test(key)) errors.push(`steps[${index}].args.${key} looks sensitive; skills must not store secrets`);
					}
				}
			}
		});
	}
	if (skill.tags !== undefined) {
		if (Array.isArray(skill.tags) === false || skill.tags.some((tag) => typeof tag !== "string" || tag.length > 24)) errors.push("tags must be string array (<=24 chars each)");
	}
	return { ok: errors.length === 0, errors };
}

function ensureDir() {
	mkdirSync(skillDir(), { recursive: true });
}

export function listSkills() {
	const dir = skillDir();
	if (existsSync(dir) === false) return [];
	const skills = [];
	for (const entry of readdirSync(dir).sort()) {
		if (entry.endsWith(".json") === false) continue;
		try {
			const skill = JSON.parse(readFileSync(join(dir, entry), "utf8"));
			skills.push({ ...skill, file: join(dir, entry), bytes: statSync(join(dir, entry)).size });
		} catch {
			/* 坏文件跳过，report 里会体现在文件中但技能列表不炸 */
		}
	}
	return skills.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

export function readSkill(name) {
	if (NAME_RE.test(String(name ?? "")) === false) throw new Error(`invalid skill name: ${name}`);
	const path = skillPath(name);
	if (existsSync(path) === false) throw new Error(`skill not found: ${name}`);
	return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * @returns {{name: string, path: string, bytes: number, overwritten: boolean}}
 */
export function saveSkill(skill, options = {}) {
	const validation = validateSkill(skill);
	if (validation.ok === false) throw new Error(`invalid skill: ${validation.errors.join("; ")}`);
	const path = skillPath(skill.name);
	const existed = existsSync(path);
	if (existed && options.overwrite !== true) throw new Error(`skill already exists: ${skill.name} (pass overwrite:true to replace)`);
	ensureDir();
	if (listSkills().length >= MAX_SKILLS && existed === false) throw new Error(`too many skills (max ${MAX_SKILLS})`);
	const now = new Date().toISOString();
	const record = {
		name: skill.name,
		description: String(skill.description).trim(),
		steps: skill.steps.map((step) => ({ tool: step.tool, ...(step.args === undefined ? {} : { args: step.args }) })),
		...(skill.tags === undefined ? {} : { tags: skill.tags }),
		createdAt: existed ? JSON.parse(readFileSync(path, "utf8")).createdAt ?? now : now,
		updatedAt: now,
		version: 1
	};
	const body = `${JSON.stringify(record, null, 2)}\n`;
	const tmp = join(skillDir(), `.${skill.name}.${process.pid}.tmp`);
	writeFileSync(tmp, body);
	renameSync(tmp, path);
	return { name: record.name, path, bytes: Buffer.byteLength(body), overwritten: existed };
}

export function deleteSkill(name) {
	if (NAME_RE.test(String(name ?? "")) === false) throw new Error(`invalid skill name: ${name}`);
	const path = skillPath(name);
	if (existsSync(path) === false) return false;
	rmSync(path, { force: true });
	return true;
}
