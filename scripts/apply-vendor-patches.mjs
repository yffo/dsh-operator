#!/usr/bin/env node
/**
 * 给 vendored 上游代码（lib/computer-use/）打本包的补丁。
 *
 * 为什么要这一步：`lib/computer-use/` 是 dsh-orb 的原样代码，`scripts/sync-from-orb.sh`
 * 同步新版本时会整目录覆盖，所以补丁不能手打——每次同步后跑本脚本重新打上去。
 * 每个补丁都有「锚点字符串 + 幂等标记」：锚点找不到就报错退出（上游结构变了要人看一眼），
 * 已经打过（存在标记）就跳过。
 *
 * 用法：node scripts/apply-vendor-patches.mjs [--check]
 *   --check  只检查能否打上/是否已打上，不写文件
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = join(root, "lib/computer-use/index.js");
const typesPath = join(root, "lib/computer-use/index.d.ts");
const checkOnly = process.argv.includes("--check");

const MARK = "PATCH(computer-use)";

/** @type {{ file: string, name: string, marker?: string, occurrences?: number, find: string, replace: string }[]} */
const patches = [
	{
		file: "lib/computer-use/index.js",
		name: "导入补丁层与 createHash",
		marker: `${MARK}: import capture-downscale`,
		find: `import { AttachmentId } from "@deepseek-ai/dsh-attachment";\n//#region src/config.ts`,
		replace: `import { AttachmentId } from "@deepseek-ai/dsh-attachment";\n// ${MARK}: import capture-downscale\n// 本包补丁层：观察截图缩放/重编码（见 lib/capture-downscale.js）。\nimport { createHash } from "node:crypto";\nimport { withCaptureDownscale } from "../capture-downscale.js";\n//#region src/config.ts`
	},
	{
		file: "lib/computer-use/index.js",
		name: "Config schema 增加截图参数",
		marker: `${MARK}: config schema`,
		find: `const Config = z.object({ postActionWaitMs: z.number().default(600) });`,
		replace: `// ${MARK}: config schema\n// captureMaxEdge: 观察截图长边上限（0 = 不缩放）；jpegQuality: 重编码质量（100 = 不重编码）。\nconst Config = z.object({\n\tpostActionWaitMs: z.number().default(600),\n\tcaptureMaxEdge: z.number().default(1280),\n\tjpegQuality: z.number().default(80)\n});`
	},
	{
		file: "lib/computer-use/index.js",
		name: "resolveComputerUseConfig 解析截图参数",
		marker: `${MARK}: resolve config`,
		find: `function resolveComputerUseConfig(config = {}) {\n\treturn { postActionWaitMs: requireFiniteNonNegative(config.postActionWaitMs ?? 600, "postActionWaitMs") };\n}`,
		replace: `function resolveComputerUseConfig(config = {}) {\n\t// ${MARK}: resolve config\n\treturn {\n\t\tpostActionWaitMs: requireFiniteNonNegative(config.postActionWaitMs ?? 600, "postActionWaitMs"),\n\t\tcaptureMaxEdge: requireFiniteNonNegative(config.captureMaxEdge ?? 1280, "captureMaxEdge"),\n\t\tjpegQuality: Math.min(100, requireFiniteNonNegative(config.jpegQuality ?? 80, "jpegQuality"))\n\t};\n}`
	},
	{
		file: "lib/computer-use/index.js",
		name: "工具输出 schema 允许 note 字段",
		marker: `note: { type: "string" }`,
		find: `\tattachedWidth: { type: "integer" },\n\tattachedHeight: { type: "integer" }\n};`,
		replace: `\tattachedWidth: { type: "integer" },\n\tattachedHeight: { type: "integer" },\n\tnote: { type: "string" }\n};`
	},
	{
		file: "lib/computer-use/index.js",
		name: "工具结果拼装追加 note 文本块",
		marker: `${MARK}: result note block`,
		find: `function resultBlocks(intro, screens, foreground, outcome) {\n\treturn [{\n\t\ttype: "text",\n\t\ttext: intro\n\t}, ...observationContent(screens, foreground, outcome.coordinateMode)];\n}`,
		replace: `function resultBlocks(intro, screens, foreground, outcome) {\n\t// ${MARK}: result note block\n\treturn [\n\t\t{\n\t\t\ttype: "text",\n\t\t\ttext: intro\n\t\t},\n\t\t...observationContent(screens, foreground, outcome.coordinateMode),\n\t\t...outcome.note === void 0 ? [] : [{\n\t\t\ttype: "text",\n\t\t\ttext: outcome.note\n\t\t}]\n\t];\n}`
	},
	{
		file: "lib/computer-use/index.js",
		name: "observedFields 透传 note",
		marker: `${MARK}: observed note`,
		find: `function observedFields(session, observation) {\n\treturn {\n\t\tscreens: observation.screens,\n\t\tforeground: observation.foreground,\n\t\t...coordinateOutcome(session, observation.screens)\n\t};\n}`,
		replace: `function observedFields(session, observation) {\n\t// ${MARK}: observed note\n\treturn {\n\t\tscreens: observation.screens,\n\t\tforeground: observation.foreground,\n\t\t...observation.note === void 0 ? {} : { note: observation.note },\n\t\t...coordinateOutcome(session, observation.screens)\n\t};\n}`
	},
	{
		file: "lib/computer-use/index.js",
		name: "recapture 检测「画面无变化」",
		marker: `${MARK}: action effect`,
		find: `async function recapture(ctx, backend, exec, settleMs = 0) {\n\tconst session = sessionOf(exec);\n\tconst mode = coordinateModeOf(session);\n\tconst observation = await observeDesktop(ctx, backend, exec.signal, {\n\t\tsettleMs,\n\t\tcoordinateMode: mode\n\t});\n\trememberObservation(session, observation.screens);\n\treturn {\n\t\tscreens: [...observation.screens],\n\t\tforeground: compactForeground(observation.foreground),\n\t\tcaptures: [...observation.captures]\n\t};\n}`,
		replace: `// ${MARK}: unchanged detection\n// 动作后截图与上一次逐字节相同 → 提示模型别盲目重试（省 token、也避免连环失败）。\nconst lastCaptureDigest = new WeakMap();\nfunction unchangedActionNote(session, observation, settleMs) {\n\tconst data = observation.captures[0]?.data;\n\tif (session === void 0 || data === void 0) return;\n\tconst digest = createHash("sha1").update(data).digest("hex");\n\tconst previous = lastCaptureDigest.get(session);\n\tlastCaptureDigest.set(session, digest);\n\tif (settleMs <= 0 || previous === void 0 || previous !== digest) return;\n\treturn "No visible change was detected after this action. It may not have taken effect (target covered, off-screen, or slow). Re-examine the screenshot, change approach (keyboard shortcut, menu, open_app), or stop and report; do not repeat the same action more than twice.";\n}\nasync function recapture(ctx, backend, exec, settleMs = 0) {\n\tconst session = sessionOf(exec);\n\tconst mode = coordinateModeOf(session);\n\tconst observation = await observeDesktop(ctx, backend, exec.signal, {\n\t\tsettleMs,\n\t\tcoordinateMode: mode\n\t});\n\trememberObservation(session, observation.screens);\n\tconst note = unchangedActionNote(session, observation, settleMs);\n\treturn {\n\t\tscreens: [...observation.screens],\n\t\tforeground: compactForeground(observation.foreground),\n\t\tcaptures: [...observation.captures],\n\t\t...note === void 0 ? {} : { note }\n\t};\n}`
	},
	{
		file: "lib/computer-use/index.js",
		name: "策略提示词：先验证目标、失败不盲重试",
		marker: `Never repeat an identical failing GUI action a third time.`,
		find: `Drag sliders, window edges, and files with drag. Press and hold with long_press. Multi-select with click plus shift or cmd on each later click; do not hold a modifier across calls.\n`,
		replace: `Drag sliders, window edges, and files with drag. Press and hold with long_press. Multi-select with click plus shift or cmd on each later click; do not hold a modifier across calls.\n\nBefore clicking, verify in the latest screenshot that the target control or row is visible and in its final position; when a menu, popover, or dialog is open, read it from the attached image before choosing. If a tool result says no visible change was detected, do not repeat the same action blindly: re-read the screenshot, switch approach (keyboard shortcut, menu item, open_app), or stop and report. Never repeat an identical failing GUI action a third time.\n`
	},
	{
		file: "lib/computer-use/index.js",
		name: "apply() 套上截图缩放包装",
		marker: `${MARK}: apply wrap`,
		find: `\tapplyComputerUse(ctx, desktopBackend(ctx, createPlatformBackend(process.platform, excludedRegionCapture)), resolveComputerUseConfig(config));`,
		replace: `\t// ${MARK}: apply wrap\n\tconst resolvedConfig = resolveComputerUseConfig(config);\n\tapplyComputerUse(ctx, withCaptureDownscale(desktopBackend(ctx, createPlatformBackend(process.platform, excludedRegionCapture)), resolvedConfig), resolvedConfig);`
	},
	{
		file: "lib/computer-use/index.d.ts",
		name: "类型声明：Config 增加截图参数",
		marker: `readonly captureMaxEdge?: number;`,
		find: `  readonly postActionWaitMs?: number;\n}`,
		replace: `  readonly postActionWaitMs?: number;\n  /**\n   * Longest edge in pixels for observation captures. 0 disables downscaling. Default: 1280.\n   */\n  readonly captureMaxEdge?: number;\n  /**\n   * JPEG quality used when re-encoding captures (1–100). 100 disables re-encoding. Default: 80.\n   */\n  readonly jpegQuality?: number;\n}`
	},
	{
		file: "lib/computer-use/index.d.ts",
		name: "类型声明：Resolved 增加截图参数",
		marker: `readonly captureMaxEdge: number;`,
		find: `interface ResolvedComputerUseConfig {\n  readonly postActionWaitMs: number;\n}`,
		replace: `interface ResolvedComputerUseConfig {\n  readonly postActionWaitMs: number;\n  readonly captureMaxEdge: number;\n  readonly jpegQuality: number;\n}`
	},
	{
		file: "lib/computer-use/backend-xLwiz83E.js",
		name: "修复 list_apps / open_app：JXA 的 activationPolicy 是字符串",
		marker: `if (Number(app.activationPolicy) !== 0) continue`,
		occurrences: 2,
		find: `if (app.activationPolicy !== 0) continue`,
		replace: `if (Number(app.activationPolicy) !== 0) continue`
	},
	{
		file: "lib/computer-use/backend-xLwiz83E.js",
		name: "open_app：单匹配返回 bundle id（JXA 缺 activateWithOptions 桥接）",
		marker: `JSON.stringify({ kind: 'launch', name: matches[0].name, bundle:`,
		find: `} else if (matches.length === 1) {\n  matches[0].app.activateWithOptions_(2)\n  JSON.stringify({ kind: 'activated', name: matches[0].name })\n`,
		replace: `} else if (matches.length === 1) {\n  // ${MARK}: open_app bundle\n  var bundleId = ObjC.unwrap(matches[0].app.bundleIdentifier)\n  JSON.stringify({ kind: 'launch', name: matches[0].name, bundle: typeof bundleId === 'string' ? bundleId : '' })\n`
	},
	{
		file: "lib/computer-use/backend-xLwiz83E.js",
		name: "open_app：决策结果透传 bundle",
		marker: `...typeof row.bundle === "string"`,
		find: `\tif ((row.kind === "activated" || row.kind === "launch") && typeof row.name === "string" && row.name.trim() !== "") return {\n\t\tkind: row.kind,\n\t\tname: row.name.trim()\n\t};\n`,
		replace: `\tif ((row.kind === "activated" || row.kind === "launch") && typeof row.name === "string" && row.name.trim() !== "") return {\n\t\tkind: row.kind,\n\t\tname: row.name.trim(),\n\t\t...typeof row.bundle === "string" && row.bundle.trim() !== "" ? { bundle: row.bundle.trim() } : {}\n\t};\n`
	},
	{
		file: "lib/computer-use/backend-xLwiz83E.js",
		name: "open_app：用 open -b 激活已运行 App",
		marker: `${MARK}: open -b activate`,
		find: `\t\t\t\tawait run(OPEN, looksLikeBundleId(name) ? ["-b", name] : ["-a", name], { signal });\n`,
		replace: `\t\t\t\t// ${MARK}: open -b activate\n\t\t\t\tconst bundle = decision.kind === "launch" && typeof decision.bundle === "string" && decision.bundle !== "" ? decision.bundle : void 0;\n\t\t\t\tawait run(OPEN, bundle !== void 0 ? ["-b", bundle] : looksLikeBundleId(name) ? ["-b", name] : ["-a", name], { signal });\n`
	}
];

const files = new Map();
async function read(file) {
	if (!files.has(file)) files.set(file, await readFile(join(root, file), "utf8"));
	return files.get(file);
}

/**
 * 额外补丁放在 scripts/vendor-patches/*.json：大段 find/replace 用 JSON 更好维护。
 * @returns {Promise<object[]>} 按文件名排序合并的补丁条目。
 */
async function loadVendorPatches() {
	const dir = join(root, "scripts/vendor-patches");
	let names;
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const extra = [];
	for (const name of names.filter((file) => file.endsWith(".json")).sort()) {
		const parsed = JSON.parse(await readFile(join(dir, name), "utf8"));
		if (!Array.isArray(parsed)) throw new Error(`scripts/vendor-patches/${name} 必须是数组`);
		extra.push(...parsed);
	}
	return extra;
}
for (const patch of await loadVendorPatches()) patches.push(patch);

let applied = 0;
let skipped = 0;
for (const patch of patches) {
	const source = await read(patch.file);
	if (patch.marker !== undefined && source.includes(patch.marker)) {
		skipped += 1;
		continue;
	}
	const count = source.split(patch.find).length - 1;
	const expected = patch.occurrences ?? 1;
	if (count !== expected) {
		console.error(`❌ [${patch.file}] ${patch.name}: 锚点出现 ${count} 次（期望 ${expected} 次），上游结构可能变了，需要人工核对。`);
		process.exit(1);
	}
	const next = expected === 1 ? source.replace(patch.find, patch.replace) : source.split(patch.find).join(patch.replace);
	files.set(patch.file, next);
	applied += 1;
}

if (!checkOnly) {
	for (const [file, content] of files) await writeFile(join(root, file), content);
}

console.log(`${checkOnly ? "检查" : "应用"}完成：新打 ${applied} 个补丁，已存在跳过 ${skipped} 个（共 ${patches.length} 个）。`);
