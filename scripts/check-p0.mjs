#!/usr/bin/env node
/**
 * 0.4.0 P0 冒烟检查：
 * - 精简策略体积 < 5KB，且 0–1000 坐标段仍是上游原文（backgroundPolicyFor 依赖）
 * - 图片准入降级、裁切元数据、结构化 actionEffect、工具名冲突检测都在
 * - fork 状态（docs/FORK.md 存在、修改点注释在、无补丁机制残留）
 * - 0.9.0 懒观察/guard/actionEffect、0.10.0 ax_set_value/ax_menu/文本预算、0.10.1 ax_scroll/重定位/匿名裁剪
 *
 * 用法：node scripts/check-p0.mjs
 */

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { slimPolicy } from "../lib/policy-slim.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = await readFile(join(root, "lib/computer-use/index.js"), "utf8");
check(!/SCHEMA_VERSION/.test(src), "computer-use/index.js 内联 schemaVersion 用字面量（SCHEMA_VERSION 仅在 browser-cua-tools）");
const backend = await readFile(join(root, "lib/computer-use/backend-xLwiz83E.js"), "utf8");
const operatorTools = await readFile(join(root, "lib/operator-tools.js"), "utf8");
const axObserver = await readFile(join(root, "lib/ax-observer.js"), "utf8");
const cuaTools = await readFile(join(root, "lib", "cua-tools.js"), "utf8");
const cuaDriver = await readFile(join(root, "lib", "cua-driver.js"), "utf8");

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
check(/import \{[^}]*assertHotkeyGuarded[^}]*\} from "\.\.\/guard\.js";/.test(src), "0.9.0 guard 已接线");
check(src.includes("guardPointTarget") && src.includes("await assertPointGuarded(config, args, screen, position);"), "坐标点击 guard 已接线");
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

check(operatorTools.includes('name: "ax_set_value"'), "ax_set_value 工具在");
check(operatorTools.includes('name: "ax_menu"'), "ax_menu 工具在");
check(operatorTools.includes('name: "ax_scroll"'), "ax_scroll 工具在");
check(operatorTools.includes("scrollAx"), "operator-tools 接 scrollAx");
check(axObserver.includes("export async function scrollAx"), "ax-observer 导出 scrollAx");
check(axObserver.includes("MAX_ANONYMOUS_NODES"), "匿名节点裁剪上限在");
check(axObserver.includes("export async function setAxValue"), "setAxValue 包装在");
check(axObserver.includes("export async function pressAxMenu"), "pressAxMenu 包装在");
check(axObserver.includes("MAX_TEXT_CHARS"), "AX 文本字符预算在");
check(src.includes("PATCH(computer-use): tool output schemaVersion"), "GUI 工具输出 schemaVersion 注入在（0.21.11 / PLAN A4）");
check(src.includes('schemaVersion: { type: "integer" }'), "schemaVersion 字段声明在");
check(src.includes("PATCH(computer-use): computer-use seam provider"), "seam provider 接入在（0.21.12 / PLAN 0.11-4）");
check(src.includes("claimSeamProvider(ctx, SEAM_PROVIDER_NAME)"), "apply 启动时占用 seam 槽位");
check(existsSync(join(root, "lib", "cua-tools.js")), "lib/cua-tools.js 在（0.22.0 cua-driver 工具面）");
check(existsSync(join(root, "lib", "cua-driver.js")), "lib/cua-driver.js 在（daemon/CLI 客户端）");
check(cuaTools.includes("export function registerCuaTools"), "导出 registerCuaTools");
check(cuaTools.includes("cua_windows") && cuaTools.includes("cua_observe") && cuaTools.includes("cua_act"), "注册 cua_windows/cua_observe/cua_act 三个工具");
check(cuaDriver.includes("ensureCuaDaemon") && cuaDriver.includes("DSH_OPERATOR_CUA_BIN"), "cua-driver 客户端含 daemon 懒启动与二进制解析");
check(src.includes("registerCuaTools(ctx, resolvedConfig"), "apply 里注册 cua 工具面");
check(backend.includes("resolveBundleId"), "open_app 本地化名回退 bundle id（0.22.4）");
check(cuaTools.includes("cua_act_token_retry"), "cua_act stale token 自动重试（0.22.4）");
	check(cuaTools.includes("cua_launch"), "cua_launch 后台启动工具（0.22.6）");
	check(cuaDriver.includes("cuaLaunchApp"), "cua-driver launch_app 封装（0.22.6）");
	check(cuaTools.includes("error.stdout"), "stale 检测覆盖被截断的异常输出（0.22.5）");
check(existsSync(join(root, "lib", "seam-provider.js")), "lib/seam-provider.js 在");
const platformSrc = readFileSync(join(root, "lib", "platform.js"), "utf8");
check(platformSrc.includes('win32: { base: true, extended: false, verified: false }'), "平台矩阵：Windows 基础面已知、未验证（0.33.0）");
check(platformSrc.includes('linux: { base: false, extended: false, verified: false }'), "平台矩阵：Linux 无桌面后端（0.33.0）");
check(existsSync(join(root, "scripts", "inspect.mjs")), "巡检脚本 scripts/inspect.mjs 在（0.45.0）");

if (failures.length > 0) {
	console.error(`\n✗ P0 检查失败 ${failures.length} 项`);
	process.exitCode = 1;
} else {
	console.log("\n✓ P0 检查全部通过");
}
