#!/usr/bin/env node
/**
 * 0.4.0 P0 冒烟检查：
 * - 精简策略体积 < 5KB，且 0–1000 坐标段仍是上游原文（backgroundPolicyFor 依赖）
 * - 图片准入降级、裁切元数据、结构化 actionEffect、工具名冲突检测都在
 * - fork 状态（docs/FORK.md 存在、修改点注释在、无补丁机制残留）
 *
 * 用法：node scripts/check-p0.mjs
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { slimPolicy } from "../lib/policy-slim.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = await readFile(join(root, "lib/computer-use/index.js"), "utf8");
const backend = await readFile(join(root, "lib/computer-use/backend-xLwiz83E.js"), "utf8");

const failures = [];
function check(ok, label) {
	if (!ok) failures.push(label);
	console.log(`${ok ? "✓" : "✗"} ${label}`);
}

function constant(name) {
	const match = src.match(new RegExp(`const ${name} = ("[\\s\\S]*?");`));
	return match === null ? void 0 : JSON.parse(match[1]);
}

const milli = constant("MILLIFRACTION_COORDINATES");
const pixel = constant("PIXEL_COORDINATES");
check(typeof milli === "string" && typeof pixel === "string", "坐标常量仍是上游原文");

const policy = slimPolicy("millifraction", milli ?? "", pixel ?? "");
const bytes = Buffer.byteLength(policy, "utf8");
check(bytes < 5120, `精简策略 < 5120 B（实际 ${bytes} B）`);
check(policy.includes(milli ?? "\u0000"), "策略保留 0–1000 坐标段原文（backgroundPolicyFor 依赖）");

check(src.includes("function actionEffectFor("), "actionEffectFor 已替换命令式 note");
check(src.includes('actionEffect: "suspected_noop"'), "suspected_noop 判定在");
check(src.includes("imageError"), "图片准入/存储失败降级为纯文本观察");
check(src.includes("BOUNDS_SCHEMA"), "裁切 bounds schema 已定义");
check(src.includes("COMPUTER_USE_TOOL_NAMES"), "工具名冲突检测在");
check(src.includes('clipped: { type: "boolean" }'), "screens schema 含 clipped");
check(src.includes("actionEffect: {"), "工具输出 schema 含 actionEffect");
check(backend.includes("clipped: true, sourceBounds"), "backend 跨屏窗口裁切元数据在");
check(src.includes('import { assertHotkeyGuarded } from "../guard.js";'), "0.9.0 guard 已接线");
check(src.includes('import { noteGuiActivity, shouldObserveFirstFrame } from "../observe-gate.js";'), "0.9.0 懒观察闸已接线");
check(src.includes('firstFrame: z.string().default("auto")'), "Config 含 firstFrame");
check(src.includes("noteGuiActivity(session);"), "recapture 记录 GUI 活动");
check(src.includes('screens: effect.actionEffect === "suspected_noop" ? [] : [...observation.screens]'), "noop 不重复附图");
check(src.includes("assertHotkeyGuarded(args.keys, args.confirm === true, config.guard !== false);"), "hotkey guard 调用在");
check(!/required:\s*false/.test(src), "schema 不用 required: false（DSH 只允许 true 或省略）");

check(existsSync(join(root, "docs", "FORK.md")), "docs/FORK.md 记录上游与差异");
check(src.includes("PATCH(computer-use)"), "fork 修改点注释（PATCH(computer-use)）在");
check(!existsSync(join(root, "scripts", "apply-vendor-patches.mjs")), "补丁器已移除（fork 化）");
check(!existsSync(join(root, "scripts", "vendor-patches")), "vendor-patches 目录已移除");

if (failures.length > 0) {
	console.error(`\n✗ P0 检查失败 ${failures.length} 项`);
	process.exitCode = 1;
} else {
	console.log("\n✓ P0 检查全部通过");
}
