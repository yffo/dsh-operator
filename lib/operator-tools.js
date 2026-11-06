// dsh-operator：扩展工具（P1-7 verify_state / P1-8 list_windows + 按窗口截图）
//
// 这层工具不碰 vendored 代码里的动作实现，只做「查询与验证」：
// - list_windows：列可见窗口 + 显示器 + 前台 App（多屏显式标注在这里）
// - screenshot_window：只截指定窗口（对话框/弹层/单窗口场景，多窗口并集不再干扰）
// - verify_state：轮询一个谓词（窗口标题 / 前台 App / AX 文本 / AX 元素），等状态到位
// - ax_press：按 AX 快照节点 index 后台触发 AXPress（原生控件，不动光标）
// - zoom_region：对当前前台窗口的局部区域做原生分辨率放大截图（读小字/图标细节）
//
// 全部只在 darwin 上注册；Windows 侧仅保留 vendored 的基础工具（见 README 已知限制）。

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir as mkdirAsync, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { closeSync, existsSync as fsExistsSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { audit } from "./audit-log.js";
import { deleteSkill, listSkills, readSkill, saveSkill, skillDir } from "./skill-store.js";
import { applySkillArgs, collectVariables } from "./skill-params.js";
import { describePreflight, preflightSkill } from "./skill-validate.js";
import { describeRun, judgeSkillHealth, readStats, recordSkillRun } from "./skill-stats.js";
import { describeImport, exportSkills, importSkills } from "./skill-transfer.js";
import { buildCandidateSkill, candidateCount, listCandidates, resetCandidates, sessionKeyOf } from "./skill-candidates.js";
import { evaluateExpect } from "./skill-expect.js";
import { checkActionExpect } from "./action-expect.js";
import { describeTask } from "./execution-state.js";
import { describeExecutionProjection, EXECUTION_PROJECTION_KEY } from "./execution-projection.js";
import { applyTemplate } from "./plan-templates.js";
import { classifyTask } from "./task-profile.js";
import { planDir, createPlan, deletePlan, listPlans, planSummary, readPlan, readPlans, updatePlan } from "./planner.js";
import { collectStatus } from "./status.js";
import { browserToolsStatus } from "./browser-cua-tools.js";
import { executeSteps, summarizeResults } from "./executor.js";
import { classifyFailure, digestFailures, failureDir, recordFailure } from "./failure-store.js";
import { readFileSync } from "node:fs";
import { jpegDimensions } from "./capture-downscale.js";
import { mergeToolRegistries } from "./tool-registry.js";
import { buildDispatcher } from "./tool-surface.js";
import { invalidateWindowCache, listWindows } from "./macos-query.js";
import { pressAx, pressAxMenu, scrollAx, setAxValue, setWindowFrame, snapshotAx } from "./ax-observer.js";
import { guardTitlePress, matchDangerousTitle } from "./guard.js";
import { areExtendedToolsSupported, extendedToolsSkipReason } from "./platform.js";
import { clickCdpDom, clickDom, fillCdpDom, fillDom, probeAppleScriptDom, probeCdp, readCdpSnapshot, readDomSnapshot } from "./browser-dom.js";

const SCHEMA_VERSION = 1;
const execFileAsync = promisify(execFile);
const SCREENSHOT_BIN = "/usr/sbin/screencapture";
const DELAY_MAX_MS = 30000;

// 可注入的内部依赖：单测用假实现覆盖工具执行路径（真实运行时用上面的默认值）。
const DEFAULT_INTERNALS = {
	listWindows,
	snapshotAx,
	pressAx,
	setAxValue,
	pressAxMenu,
	scrollAx,
	setWindowFrame,
	execFileAsync,
	screenshotBin: SCREENSHOT_BIN,
	osascript: undefined,
	cdpSnapshot: readCdpSnapshot,
	cdpClick: clickCdpDom,
	cdpFill: fillCdpDom,
	cdpProbe: probeCdp
};
let internals = { ...DEFAULT_INTERNALS };

/** 测试用：替换内部依赖；传 {} 之外的键覆盖默认实现。 */
export function configureOperatorToolsInternals(overrides = {}) {
	internals = { ...internals, ...overrides };
}

/** 测试用：恢复真实实现。 */
export function resetOperatorToolsInternals() {
	internals = { ...DEFAULT_INTERNALS };
}

function delay(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted === true) {
			reject(new Error(`${delay.name}: aborted`));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener?.(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error(`${delay.name}: aborted`));
			},
			{ once: true }
		);
	});
}

function presentCall(title, rawInput) {
	return { card: "generic", title, kind: "execute", rawInput };
}

function formatBounds(bounds) {
	if (bounds === undefined) return "";
	return `${String(bounds.x)},${String(bounds.y)} ${String(bounds.width)}x${String(bounds.height)}`;
}

function truncate(text, limit) {
	const value = String(text ?? "");
	return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function axTextOf(snapshot) {
	const rows = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
	return rows
		.map((node) => [node.role, node.title, node.value].filter((part) => typeof part === "string" && part !== "").join(" "))
		.join("\n");
}

/** 取少量可读标题做「失败现场」提示，避免模型盲猜。 */
function previewTitles(items, limit = 3) {
	const values = (Array.isArray(items) ? items : [])
		.map((item) => String(item ?? "").trim())
		.filter((item) => item !== "");
	return values.length === 0 ? "none" : values.slice(0, limit).join(" | ");
}

function axTitlesOf(snapshot, limit = 3) {
	const rows = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
	const titles = rows.filter((node) => typeof node.title === "string" && node.title !== "").map((node) => node.title);
	return previewTitles([...new Set(titles)], limit);
}

/** window_move 的布局预设（屏幕逻辑点，左上原点）。 */
export const WINDOW_LAYOUTS = Object.freeze(["left-half", "right-half", "top-half", "bottom-half", "maximize", "center"]);

/** 预留菜单栏高度，避免窗口顶边被菜单栏遮住。 */
const LAYOUT_TOP_INSET = 28;

/** 从显示器列表里挑主屏（缺省取第一块）——布局预设只针对单屏做几何。 */
export function resolveLayoutDisplay(displays) {
	const list = Array.isArray(displays) ? displays : [];
	return list.find((display) => display?.primary === true) ?? list[0];
}

/**
 * 纯函数：按布局预设算窗口帧；无有效显示器几何时返回 undefined。
 * @param {{layout?:string, display?:object, width?:number, height?:number}} [options]
 * @returns {{x:number,y:number,width:number,height:number}|undefined}
 */
export function planWindowFrame(options = {}) {
	const bounds = options.display?.bounds;
	if (bounds === undefined || [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) === false) return undefined;
	if (bounds.width <= 0 || bounds.height <= 0) return undefined;
	const top = bounds.y + LAYOUT_TOP_INSET;
	const usableHeight = Math.max(1, bounds.height - LAYOUT_TOP_INSET);
	const halfWidth = Math.max(1, Math.round(bounds.width / 2));
	const halfHeight = Math.max(1, Math.round(usableHeight / 2));
	switch (options.layout) {
		case "left-half":
			return { x: bounds.x, y: top, width: halfWidth, height: usableHeight };
		case "right-half":
			return { x: bounds.x + halfWidth, y: top, width: bounds.width - halfWidth, height: usableHeight };
		case "top-half":
			return { x: bounds.x, y: top, width: bounds.width, height: halfHeight };
		case "bottom-half":
			return { x: bounds.x, y: top + halfHeight, width: bounds.width, height: usableHeight - halfHeight };
		case "maximize":
			return { x: bounds.x, y: top, width: bounds.width, height: usableHeight };
		case "center": {
			const width = Number.isFinite(options.width) ? options.width : halfWidth;
			const height = Number.isFinite(options.height) ? options.height : halfHeight;
			return {
				x: Math.round(bounds.x + (bounds.width - width) / 2),
				y: Math.round(top + (usableHeight - height) / 2),
				width,
				height
			};
		}
		default:
			return undefined;
	}
}

async function frontmostPid(options = {}) {
	if (Number.isInteger(options.pid) && options.pid > 0) return options.pid;
	const value = await internals.listWindows({});
	const pid = Number(value?.frontmostPid);
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * 评估一次谓词（verify_state 的一轮）。
 * @param {object} args 工具参数（扁平谓词）。
 * @returns {Promise<{ok:boolean, observed:string}>}
 */
export async function evaluatePredicate(args) {
	const kind = String(args.kind ?? "");
	const needle = typeof args.contains === "string" ? args.contains.trim() : "";
	const caseSensitive = args.case_sensitive === true;
	const normalize = (text) => (caseSensitive ? String(text ?? "") : String(text ?? "").toLowerCase());
	const wanted = normalize(needle);
	switch (kind) {
		case "window_title": {
			if (wanted === "") return { ok: false, observed: "contains is required for window_title" };
			const value = await internals.listWindows({ titleContains: needle });
			const count = Array.isArray(value?.windows) ? value.windows.length : 0;
			if (count > 0) return { ok: true, observed: `${count} window(s) matched title` };
			const all = await internals.listWindows({});
			const titles = (Array.isArray(all?.windows) ? all.windows : []).map((entry) => entry?.title ?? entry?.app);
			return { ok: false, observed: `no window title matched (visible: ${previewTitles(titles)})` };
		}
		case "frontmost_app": {
			const value = await internals.listWindows({});
			const app = normalize(value?.frontmostApp);
			const ok = wanted !== "" && app.includes(wanted);
			return { ok, observed: ok ? `frontmost app is ${String(value?.frontmostApp)}` : `frontmost app is ${String(value?.frontmostApp ?? "unknown")}` };
		}
		case "app_running": {
			if (wanted === "") return { ok: false, observed: "contains is required for app_running" };
			const value = await internals.listWindows({ appContains: needle });
			const count = Array.isArray(value?.windows) ? value.windows.length : 0;
			if (count > 0) return { ok: true, observed: `${count} window(s) of the app` };
			const all = await internals.listWindows({});
			const apps = [...new Set((Array.isArray(all?.windows) ? all.windows : []).map((entry) => entry?.app))];
			return { ok: false, observed: `app not visible (visible apps: ${previewTitles(apps)})` };
		}
		case "ax_text": {
			const pid = await frontmostPid(args);
			const snapshot = pid === undefined ? undefined : await internals.snapshotAx(pid, args.max_nodes ?? 200);
			if (snapshot === undefined) return { ok: false, observed: "no AX snapshot" };
			const text = normalize(axTextOf(snapshot));
			const ok = wanted !== "" && text.includes(wanted);
			return { ok, observed: ok ? "AX text matched" : `AX text not matched (sample titles: ${axTitlesOf(snapshot)})` };
		}
		case "ax_element": {
			const pid = await frontmostPid(args);
			const snapshot = pid === undefined ? undefined : await internals.snapshotAx(pid, args.max_nodes ?? 200);
			if (snapshot === undefined) return { ok: false, observed: "no AX snapshot" };
			const rows = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
			const roleNeedle = normalize(args.role);
			const titleNeedle = normalize(args.title);
			const valueNeedle = normalize(args.value);
			const hits = rows.filter((node) => {
				if (roleNeedle !== "" && normalize(node.role).includes(roleNeedle) === false) return false;
				if (titleNeedle !== "" && normalize(node.title).includes(titleNeedle) === false) return false;
				if (valueNeedle !== "" && normalize(node.value).includes(valueNeedle) === false) return false;
				return roleNeedle !== "" || titleNeedle !== "" || valueNeedle !== "";
			});
			return { ok: hits.length > 0, observed: hits.length > 0 ? `${hits.length} AX element(s) matched` : `no AX element matched (sample titles: ${axTitlesOf(snapshot)})` };
		}
		default:
			return { ok: false, observed: `unknown kind: ${kind}` };
	}
}

/**
 * 注册扩展工具。
 * @param {object} ctx Cordis 插件上下文（需已注入 tools / attachments）。
 * @param {object} config 解析后的插件配置。
 * @param {{ backend: object }} deps vendored 后端（listScreens/capture/inspectForeground）。
 */
/**
 * 按快照 index 读目标节点的 role/title（用于敏感动作 guard）。
 * @param {number} pid 目标进程号。
 * @param {number} index 快照节点 index。
 * @param {number} maxNodes 节点上限。
 * @returns {Promise<{role?: string, title?: string} | undefined>}
 */
async function resolvePressTarget(pid, index, maxNodes) {
	try {
		const snapshot = await internals.snapshotAx(pid, maxNodes);
		const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
		const node = nodes.find((item) => Number(item?.index) === index);
		if (node === undefined) return void 0;
		return {
			...(typeof node.role === "string" && node.role !== "" ? { role: node.role } : {}),
			...(typeof node.title === "string" && node.title !== "" ? { title: node.title } : {})
		};
	} catch {
		return void 0;
	}
}


/** 失败后附一份「最新 AX 节点」摘要，省掉一次重新观察的往返（索引会漂移，必须给新索引）。 */
async function axRecoveryHint(pid, { limit = 15 } = {}) {
	try {
		const snapshot = await internals.snapshotAx(pid, 120);
		const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
		if (nodes.length === 0) return "";
		const rows = nodes.slice(0, limit).map((node) => {
			const title = String(node?.title ?? "").slice(0, 60);
			return `- [${String(node?.index ?? "?")}] ${String(node?.role ?? "?")}${title === "" ? "" : ` "${title}"`}`;
		});
		return `最新 AX 快照（前 ${String(rows.length)} 个节点，直接用这些 index）：\n${rows.join("\n")}`;
	} catch {
		return "";
	}
}


/**
 * P0-3（0.121.8）：全屏截图 + 按窗口 bounds 裁剪，作为 `screencapture -l` 失败的兜底。
 * 成功时把结果写到 outPath，返回 {width,height,scale,note}；任何一步不成立返回 undefined
 * （调用方保留原始错误——兜底不能把「窗口真的没了」伪装成成功）。
 */
async function captureFullscreenCrop(listed, windowId, dir, outPath) {
	const row = (Array.isArray(listed?.windows) ? listed.windows : []).find((item) => Number(item?.windowID ?? item?.id) === windowId);
	const bounds = row?.bounds;
	if (bounds === undefined) return void 0;
	const bw = Number(bounds.width);
	const bh = Number(bounds.height);
	if (!(bw > 0) || !(bh > 0)) return void 0;
	const fullPath = join(dir, `full-${String(windowId)}.jpg`);
	await internals.execFileAsync(internals.screenshotBin, ["-x", "-t", "jpg", fullPath], { timeout: 5000, maxBuffer: 1024 * 1024 });
	const dims = jpegDimensions(await readFile(fullPath));
	if (dims === undefined) return void 0;
	const display = Array.isArray(listed?.displays) ? listed.displays[0] : undefined;
	const logicalWidth = Number(display?.logicalWidth ?? display?.bounds?.width ?? 0);
	const scale = logicalWidth > 0 ? dims.width / logicalWidth : 2;
	const x = Math.max(0, Math.round(Number(bounds.x ?? 0) * scale));
	const y = Math.max(0, Math.round(Number(bounds.y ?? 0) * scale));
	const w = Math.min(dims.width - x, Math.round(bw * scale));
	// sips 在裁剪高度刚好触底时静默返回原图（0.119.2 实测），高度留 1 像素。
	const h = Math.min(dims.height - y - 1, Math.round(bh * scale));
	if (w <= 0 || h <= 0) return void 0;
	await internals.execFileAsync("/usr/bin/sips", ["-c", String(h), String(w), "--cropOffset", String(y), String(x), fullPath, "--out", outPath], { timeout: 5000, maxBuffer: 1024 * 1024 });
	const size = jpegDimensions(await readFile(outPath));
	if (size === undefined || Math.abs(size.width - w) > 1 || Math.abs(size.height - h) > 1) return void 0;
	return {
		width: size.width,
		height: size.height,
		scale,
		note: "fallback: window capture failed, used a full-screen capture cropped to the window bounds (overlapping windows may appear)"
	};
}


// P1（0.121.8）：AX 动作也有 effect。`AXPress` 返回成功只代表「动作被投递」，
// 不代表界面真的变了；这里用「动作前后 AX 结构摘要」报事实（与 click 的截图对比同源思路），
// 只比 role/title/index 骨架、不比 value——流式文本会让 value 一直变，那不代表动作生效。
const lastAxDigestByPid = new Map();

function digestAxNodes(nodes) {
	return createHash("sha1")
		.update(nodes.map((node) => `${String(node?.index ?? "")}|${String(node?.role ?? "")}|${String(node?.title ?? "")}`).join("\n"))
		.digest("hex");
}

/**
 * 动作后拍一次 AX 结构摘要并与上一次比较。
 * @returns {Promise<{actionEffect: "confirmed" | "suspected_noop" | "unverifiable"}>}
 */
async function axActionEffect(pid, maxNodes = 120) {
	try {
		await new Promise((resolve) => setTimeout(resolve, 120));
		const snapshot = await internals.snapshotAx(pid, maxNodes);
		const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
		if (nodes.length === 0) return { actionEffect: "unverifiable" };
		const digest = digestAxNodes(nodes);
		const previous = lastAxDigestByPid.get(pid);
		lastAxDigestByPid.set(pid, digest);
		if (previous === undefined) return { actionEffect: "unverifiable" };
		return previous === digest ? { actionEffect: "suspected_noop" } : { actionEffect: "confirmed" };
	} catch {
		return { actionEffect: "unverifiable" };
	}
}


/**
 * 在最新 AX 快照里按 role/title 找**唯一**匹配节点（0.121.8）。
 * 多候选一律不猜——返回 suggestion 让模型自己用新快照挑，避免自动重试点到别的东西。
 * @returns {Promise<{index?: number, suggestion?: string}>}
 */
async function rematchAxIndex(pid, { expectRole, expectTitle } = {}, maxNodes = 120) {
	const wantedRole = String(expectRole ?? "").trim();
	const wantedTitle = String(expectTitle ?? "").trim();
	if (wantedRole === "" && wantedTitle === "") return { suggestion: "没有 expect_role / expect_title，无法安全重匹配" };
	let nodes;
	try {
		const snapshot = await internals.snapshotAx(pid, maxNodes);
		nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
	} catch {
		return { suggestion: "重新快照失败（App 可能已退出或无响应）" };
	}
	let candidates = nodes;
	if (wantedRole !== "") candidates = candidates.filter((node) => String(node?.role ?? "") === wantedRole);
	if (wantedTitle !== "") candidates = candidates.filter((node) => String(node?.title ?? "").includes(wantedTitle));
	if (candidates.length !== 1) {
		return {
			suggestion: candidates.length === 0
				? `重新快照后没有同时匹配 role=${wantedRole === "" ? "*" : wantedRole} / title~${wantedTitle === "" ? "*" : wantedTitle} 的节点`
				: `重新快照后有 ${String(candidates.length)} 个节点匹配 role=${wantedRole === "" ? "*" : wantedRole} / title~${wantedTitle === "" ? "*" : wantedTitle}，不自动猜测，请用最新快照里的 index 重试`
		};
	}
	const index = Number(candidates[0]?.index);
	return Number.isInteger(index) ? { index } : { suggestion: "重新快照里的匹配节点没有有效 index" };
}


/**
 * P0-2（0.121.8）：AXPress 失败后自动重新快照、按 role/title 重匹配一次。
 *
 * 为什么：AX index 只在一次快照内稳定——新消息、流式文本、菜单弹出都会让整棵树漂移，
 * 模型拿旧 index 去点只会得到 not found，然后被迫再花一轮重新观察。这里把「重读快照」
 * 这一步自动化，但只在**恰好一个节点**同时匹配 role 与 title 时才重试（多候选一律不猜，
 * 只回刷新提示）——自动刷新不能变成「点错东西」的新来源。
 *
 * @param {number} pid 目标进程。
 * @param {number} index 原 index。
 * @param {{expectRole?: string, expectTitle?: string}} expect 角色/标题断言（重匹配依据）。
 * @param {number} maxNodes 快照节点上限。
 * @returns {Promise<{result: object, refreshed: boolean, index?: number, originalIndex?: number, suggestion?: string}>}
 */
async function pressAxWithRefresh(pid, index, { expectRole, expectTitle } = {}, maxNodes = 120) {
	let first;
	try {
		first = await internals.pressAx({ pid, index, expectRole, expectTitle });
	} catch (error) {
		first = { pressed: false, index, error: error instanceof Error ? error.message : String(error) };
	}
	if (first?.pressed === true) return { result: first, refreshed: false };
	const message = String(first?.error ?? "").toLowerCase();
	if (!/(not.?found|no such|stale|index|过期|不存在|找不到)/.test(message)) return { result: first, refreshed: false };
	const rematched = await rematchAxIndex(pid, { expectRole, expectTitle }, maxNodes);
	if (rematched.index === void 0) return { result: first, refreshed: false, suggestion: rematched.suggestion };
	if (rematched.index === index) return { result: first, refreshed: false };
	const retry = await internals.pressAx({ pid, index: rematched.index, expectRole, expectTitle });
	return { result: retry, refreshed: true, index: rematched.index, originalIndex: index };
}

/** 磁盘上安装副本的版本；与运行中版本不同说明改了但没重启 App。 */
function installedPluginVersion() {
	try {
		const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
		const parsed = JSON.parse(raw);
		return typeof parsed.version === "string" ? parsed.version : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 执行状态一行：优先读会话投影（唯一真相源），投影缺席时回退到进程内状态表。
 * 投影在 `turn/end` 收尾，状态表要靠 expireIdle 收尾——而 expireIdle 从来没有调用点，
 * 所以旧实现会在动作结束后一直显示 working（2026-11-03 发现）。
 * @param {object} exec 工具执行上下文。
 * @returns {string} 一行人话。
 */
function executionLineOf(ctx, exec) {
	try {
		const projections = typeof ctx?.get === "function" ? ctx.get("sessionProjections") : undefined;
		const session = exec?.agent?.session;
		if (projections !== undefined && typeof projections.stateOf === "function" && session !== undefined && session !== null) {
			const line = describeExecutionProjection(projections.stateOf(session, EXECUTION_PROJECTION_KEY));
			if (line !== null) return line;
		}
	} catch {
		// 投影读不到就走回退，状态行不能因为投影挂了整行消失
	}
	return describeTask(sessionKeyOf(exec));
}

export function registerOperatorTools(ctx, config, deps) {
	if (areExtendedToolsSupported() === false) {
		// Windows/Linux 守卫：扩展工具（含 AX 系列）只在 macOS 注册，这里明确提示而不是静默消失。
		console.warn(`[dsh-operator] ${extendedToolsSkipReason()}`);
		return;
	}
	const backend = deps?.backend;
	const defineTool = deps?.defineTool;
	const AttachmentId = deps?.AttachmentId;
	if (backend === undefined || typeof defineTool !== "function") return;
	const axMaxNodes = Number.isInteger(config?.axMaxNodes) ? config.axMaxNodes : 120;
	// PATCH(operator-tools): failure samples
	// 只记录失败结构（工具/分类/脱敏参数），永不抛错、不影响主链路；0.11.0 先在扩展工具面接入。
	const failureSamples = config?.failureSamples !== false;
	const failureVersion = deps?.version;
	/** 失败记录附带的 App 上下文；取不到就省略，不能影响主链路。 */
	async function foregroundAppName() {
		try {
			const listed = await internals.listWindows({});
			return typeof listed?.frontmostApp === "string" && listed.frontmostApp !== "" ? listed.frontmostApp : void 0;
		} catch {
			return void 0;
		}
	}
	const captureFailures = (definition) => {
		if (!failureSamples) return definition;
		return {
			...definition,
			async execute(args, exec) {
				try {
					const value = await definition.execute(args, exec);
					// 浏览器通道未开启属于「能力不可用」而非执行失败，不记失败样本避免噪音。
					const softUnavailable = value !== null && typeof value === "object" && value.available === false && value.reason === "disabled";
					if (softUnavailable !== true && value !== null && typeof value === "object" && typeof value.error === "string" && value.error.length > 0) {
						recordFailure({
							tool: definition.name,
							args,
							error: new Error(value.error),
							kind: classifyFailure(value.error),
							version: failureVersion,
							app: await foregroundAppName()
						});
					}
					return value;
				} catch (error) {
					recordFailure({ tool: definition.name, args, error, app: await foregroundAppName(), version: failureVersion });
					throw error;
				}
			}
		};
	};
		// 步骤执行器需要用到的工具实现表（0.12.1）：记录本插件注册的扩展工具，供 skill_run/plan_run 回放。
	const handlers = new Map();
	const exposeLegacy = config?.legacyToolNames !== false;
	const register = (definition) => {
		// 0.17：同时记录定义/渲染器，供未来 cu_* 分派器复用（回放只用到 execute）。
		handlers.set(definition.name, {
			execute: definition.execute,
			render: definition.output?.render,
			definition
		});
		// 0.19：旧名过渡开关 —— legacyToolNames=false 时不再直接暴露被 v2 覆盖的旧工具，
		// 但 definition/execute 仍保留在 registry 里供 cu_observe/cu_act 分派与 skill/plan 回放。
		if (!exposeLegacy && V2_LEGACY_TOOL_NAMES.has(definition.name)) return void 0;
		return ctx.tools.register(captureFailures(definition));
	};

	// 0.31.1：技能/计划回放时，除了本插件工具，也允许宿主基础 GUI 动作（click/input_text/hotkey…）。
	const forkExecute = (name) => {
		const entry = deps?.computerUseToolDefs?.get?.(name);
		if (entry === undefined) return undefined;
		if (typeof entry.execute === "function") return entry.execute;
		return typeof entry.definition?.execute === "function" ? entry.definition.execute : undefined;
	};
	const forkSteps = () => {
		const map = new Map();
		for (const name of deps?.computerUseToolDefs?.keys?.() ?? []) {
			const execute = forkExecute(name);
			if (typeof execute === "function") map.set(name, execute);
		}
		return map;
	};

	register(
		defineTool({
			name: "list_windows",
			description:
				"List on-screen windows (window_id, pid, app, title, bounds, layer) plus displays and the frontmost app. Read-only. Use this to find a dialog/popover window_id for screenshot_window, or to check multi-display layout before acting.",
			parameters: {
				pid: { type: "integer", description: "Only list windows of this process id." },
				title_contains: { type: "string", description: "Only windows whose title contains this text (case-insensitive)." },
				app_contains: { type: "string", description: "Only windows whose app name contains this text (case-insensitive)." },
				limit: { type: "integer", description: "Max windows to return (default 20, max 200)." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						text: { type: "string", required: true }
					}
				},
				render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
			},
			isConcurrencySafe: () => true,
			presentCall: (args) => presentCall("List windows", args),
			async execute(args) {
				const value = await internals.listWindows({
					pid: args.pid,
					titleContains: args.title_contains,
					appContains: args.app_contains,
					limit: args.limit ?? 20
				});
				if (value === undefined) throw new Error("list_windows: window query unavailable (helper missing or permission denied)");
				const displays = Array.isArray(value.displays) ? value.displays : [];
				const lines = [
					`<windows schema_version="1" frontmost_pid="${String(value.frontmostPid)}" frontmost_app="${String(value.frontmostApp ?? "")}" displays="${String(displays.length)}" windows="${String(value.windows.length)}"${value.truncated === true ? ' truncated="true"' : ""}>`
				];
				for (const [index, display] of displays.entries()) {
					lines.push(
						`<display index="${String(index)}" primary="${display.primary === true ? "true" : "false"}" scale="${String(display.scale)}">${formatBounds(display.bounds)}</display>`
					);
				}
				for (const window of value.windows) {
					lines.push(
						`<window id="${String(window.windowID)}" pid="${String(window.pid)}" app="${truncate(window.app, 40)}" layer="${String(window.layer)}" on_screen="${window.onScreen === true ? "true" : "false"}">${truncate(window.title, 120) || "(no title)"} @${formatBounds(window.bounds)}</window>`
					);
				}
				lines.push("</windows>");
				audit("list_windows", { windows: value.windows.length, displays: displays.length, frontmost: value.frontmostApp });
				return { schemaVersion: SCHEMA_VERSION, text: lines.join("\n") };
			}
		})
	);

	register(
		defineTool({
			name: "screenshot_window",
			description:
				"Capture one specific window by window_id (from list_windows) and attach it. Use this for dialogs, popovers, or one window of a multi-window app; prefer the regular screenshot tool for the current frontmost app. Set attach false to only save a file.",
			parameters: {
				window_id: { type: "integer", required: true, description: "CGWindowID from list_windows." },
				attach: { type: "boolean", default: true, description: "Attach the image to the tool result. Default: true." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						windowId: { type: "integer", required: true },
						width: { type: "integer", required: true },
						height: { type: "integer", required: true },
						scale: { type: "number" },
						path: { type: "string" },
						// P0-3（0.121.8）：`screencapture -l` 失败时回退「全屏 + 按窗口 bounds 裁剪」
						fallback: { type: "string" },
						image: {
							type: "object",
							additionalProperties: false,
							properties: {
								attachmentId: { type: "string", required: true },
								mediaType: { type: "string", required: true },
								bytes: { type: "number", required: true },
								width: { type: "number", required: true },
								height: { type: "number", required: true }
							}
						}
					}
				},
				render: (_args, value) => {
					const blocks = [
						{
							type: "text",
							text: `Captured window ${String(value.windowId)} (${String(value.width)}x${String(value.height)} px${value.scale === undefined ? "" : `, scale ${String(value.scale)}`}).${value.path === undefined ? "" : ` Saved to ${value.path}.`}`
						}
					];
					if (value.image !== undefined) {
						blocks.push({
							type: "image",
							attachment: {
								attachmentId: AttachmentId(value.image.attachmentId),
								mediaType: value.image.mediaType,
								bytes: value.image.bytes,
								width: value.image.width,
								height: value.image.height
							}
						});
					}
					return blocks;
				}
			},
			isConcurrencySafe: () => false,
			presentCall: (args) => presentCall("Screenshot window", args),
			async execute(args, exec) {
				const windowId = Number(args.window_id);
				if (Number.isInteger(windowId) === false || windowId <= 0) throw new Error("screenshot_window: window_id must be a positive integer");
				const attach = args.attach !== false;
				const dir = await mkdtemp(join(tmpdir(), "dsh-operator-window-"));
				const path = join(dir, `window-${String(windowId)}.jpg`);
				let fallbackInfo;
				try {
					await internals.execFileAsync(internals.screenshotBin, ["-x", "-t", "jpg", "-l", String(windowId), path], {
						timeout: 5000,
						maxBuffer: 1024 * 1024
					}).catch(async (error) => {
						// 0.121.7：窗口可能已关闭 / 最小化 / 在别的 Space / 被裁到屏幕外。
						// 过去只抛 `Command failed: ... could not create image from`，用户不知道下一步做什么。
						const detail = error instanceof Error ? error.message : String(error);
						audit("screenshot_window_failed", { window_id: windowId, detail: detail.slice(0, 160) });
						// P0-3（0.121.8）：先尝试「全屏 + 按 bounds 裁剪」兜底，仍不行才报错。
						// 为什么：`-l` 依赖窗口当前可被合成；全屏图总能拿到。代价是可能拍到重叠窗口，
						// 所以结果里带 fallback 说明，并且不改变原始报错的措辞（两者都保留）。
						const listed = await internals.listWindows({}).catch(() => undefined);
						fallbackInfo = listed === undefined
							? undefined
							: await captureFullscreenCrop(listed, windowId, dir, path).catch(() => undefined);
						if (fallbackInfo !== undefined) {
							audit("screenshot_window_fallback", { window_id: windowId, detail: detail.slice(0, 120) });
							return;
						}
						throw new Error(`screenshot_window: capture_failed (window ${String(windowId)}) — ${detail}. 该窗口可能已关闭、最小化、在别的 Space 或被移到屏幕外。下一步：先 list_windows 确认它仍 on_screen；确认后重试，或改用全屏 screenshot 兜底。`);
					});
					const data = await readFile(path);
					const size = fallbackInfo === undefined ? jpegDimensions(data) ?? { width: 0, height: 0 } : { width: fallbackInfo.width, height: fallbackInfo.height };
					const result = {
						schemaVersion: SCHEMA_VERSION,
						windowId,
						width: size.width,
						height: size.height,
						...(fallbackInfo === undefined ? {} : { fallback: fallbackInfo.note })
					};
					if (attach === false) {
						audit("screenshot_window", { window_id: windowId, attach: false, bytes: data.length });
						return { ...result, path };
					}
					const saved = await ctx.attachments.saveImage({
						data,
						mediaType: "image/jpeg",
						name: `window-${String(windowId)}`
					});
					audit("screenshot_window", { window_id: windowId, attach: true, bytes: data.length });
					return {
						...result,
						path,
						image: {
							attachmentId: String(saved.attachmentId),
							mediaType: saved.mediaType,
							bytes: saved.bytes,
							width: saved.width,
							height: saved.height
						}
					};
				} finally {
					await rm(dir, { recursive: true, force: true });
				}
			}
		})
	);

	register(
		defineTool({
			name: "zoom_region",
			description:
				"Capture a zoomed-in, native-resolution crop of a region inside the frontmost window and attach it. Coordinates are 0–1000 fractions of that window (same space as the attached screenshot). Use this to read small text, icon details, or to disambiguate crowded controls before clicking; the crop keeps Retina pixels instead of shrinking the whole screenshot.",
			parameters: {
				x: { type: "number", default: 500, description: "Region center x, 0–1000 fraction of the frontmost window." },
				y: { type: "number", default: 500, description: "Region center y, 0–1000 fraction of the frontmost window." },
				width: { type: "number", default: 300, description: "Region width, 0–1000 fraction of the window width (clamped 50–1000)." },
				height: { type: "number", default: 300, description: "Region height, 0–1000 fraction of the window height (clamped 50–1000)." },
				attach: { type: "boolean", default: true, description: "Attach the image to the tool result. Default: true." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						windowId: { type: "integer" },
						width: { type: "integer", required: true },
						height: { type: "integer", required: true },
						region: { type: "string", required: true },
						path: { type: "string" },
						image: {
							type: "object",
							additionalProperties: false,
							properties: {
								attachmentId: { type: "string", required: true },
								mediaType: { type: "string", required: true },
								bytes: { type: "number", required: true },
								width: { type: "number", required: true },
								height: { type: "number", required: true }
							}
						}
					}
				},
				render: (_args, value) => {
					const blocks = [
						{
							type: "text",
							text: `Zoomed ${value.windowId === undefined ? "frontmost window" : `window ${String(value.windowId)}`} region ${String(value.region)} → ${String(value.width)}x${String(value.height)} px (native).${value.path === undefined ? "" : ` Saved to ${value.path}.`}`
						}
					];
					if (value.image !== undefined) {
						blocks.push({
							type: "image",
							attachment: {
								attachmentId: AttachmentId(value.image.attachmentId),
								mediaType: value.image.mediaType,
								bytes: value.image.bytes,
								width: value.image.width,
								height: value.image.height
							}
						});
					}
					return blocks;
				}
			},
			isConcurrencySafe: () => false,
			presentCall: (args) => presentCall("Zoom region", args),
			async execute(args, exec) {
				exec.signal.throwIfAborted();
				const attach = args.attach !== false;
				// 坐标空间必须和模型看到的那张截图一致：优先用观察链路的 listScreens
				// （前台 App 窗口 union），拿不到时再退回前台窗口查询。
				let bounds;
				let windowId;
				try {
					const screens = await backend?.listScreens?.(exec.signal);
					const screen = Array.isArray(screens) ? screens[0] : undefined;
					if (screen !== undefined && screen.bounds !== undefined) {
						bounds = screen.bounds;
						windowId = screen.windowId;
					}
				} catch {
					bounds = undefined;
				}
				if (bounds === undefined) {
					const listed = await internals.listWindows({});
					if (listed === undefined) throw new Error("zoom_region: window list unavailable");
					const frontmostPid = Number(listed.frontmostPid);
					const window = (listed.windows ?? []).find((item) => Number(item.pid) === frontmostPid && (item.onScreen === undefined || item.onScreen === true));
					if (window === undefined) throw new Error("zoom_region: no frontmost window");
					bounds = window.bounds;
					windowId = window.windowID;
				}
				const clampPercent = (value, min, max, fallback) => {
					const number = Number(value);
					if (Number.isFinite(number) === false) return fallback;
					return Math.min(max, Math.max(min, number));
				};
				const centerX = clampPercent(args.x, 0, 1000, 500);
				const centerY = clampPercent(args.y, 0, 1000, 500);
				const widthPct = clampPercent(args.width, 50, 1000, 300);
				const heightPct = clampPercent(args.height, 50, 1000, 300);
				const regionWidth = Math.max(8, Math.round((bounds.width * widthPct) / 1000));
				const regionHeight = Math.max(8, Math.round((bounds.height * heightPct) / 1000));
				const maxX = bounds.x + bounds.width - regionWidth;
				const maxY = bounds.y + bounds.height - regionHeight;
				const regionX = Math.round(Math.min(maxX, Math.max(bounds.x, bounds.x + (bounds.width * centerX) / 1000 - regionWidth / 2)));
				const regionY = Math.round(Math.min(maxY, Math.max(bounds.y, bounds.y + (bounds.height * centerY) / 1000 - regionHeight / 2)));
				const region = `${String(regionX)},${String(regionY)},${String(regionWidth)},${String(regionHeight)}`;
				const dir = await mkdtemp(join(tmpdir(), "dsh-operator-zoom-"));
				const path = join(dir, `zoom-${String(windowId ?? 0)}.jpg`);
				try {
					await internals.execFileAsync(internals.screenshotBin, ["-x", "-C", "-R", region, "-t", "jpg", path], {
						timeout: 5000,
						maxBuffer: 1024 * 1024
					});
					const data = await readFile(path);
					const size = jpegDimensions(data) ?? { width: 0, height: 0 };
					const result = {
						schemaVersion: SCHEMA_VERSION,
						...(Number.isInteger(Number(windowId)) ? { windowId: Number(windowId) } : {}),
						width: size.width,
						height: size.height,
						region
					};
					if (attach === false) {
						audit("zoom_region", { bytes: data.length, width: size.width, height: size.height });
						return { ...result, path };
					}
					const saved = await ctx.attachments.saveImage({
						data,
						mediaType: "image/jpeg",
						name: `zoom-${String(windowId ?? 0)}`
					});
					audit("zoom_region", { bytes: data.length, width: size.width, height: size.height });
					return {
						...result,
						path,
						image: {
							attachmentId: String(saved.attachmentId),
							mediaType: saved.mediaType,
							bytes: saved.bytes,
							width: saved.width,
							height: saved.height
						}
					};
				} finally {
					await rm(dir, { recursive: true, force: true });
				}
			}
		})
	);

	register(
		defineTool({
			name: "verify_state",
			description:
				"Poll a state predicate until it holds or the timeout expires, then report only the facts. Predicates: window_title (contains), frontmost_app (contains), app_running (contains), ax_text (contains), ax_element (role/title/value contains). Read-only, no screenshot attached. Use after an action when you need to wait for a window/state rather than guessing with wait.",
			parameters: {
				kind: {
					type: "string",
					required: true,
					enum: ["window_title", "frontmost_app", "app_running", "ax_text", "ax_element"],
					description: "Predicate kind."
				},
				contains: { type: "string", description: "Substring to match (window_title/frontmost_app/app_running/ax_text)." },
				role: { type: "string", description: "ax_element: AX role substring, e.g. AXButton." },
				title: { type: "string", description: "ax_element: AX title substring." },
				value: { type: "string", description: "ax_element: AX value substring." },
				pid: { type: "integer", description: "Target process id for AX predicates (defaults to frontmost app)." },
				max_nodes: { type: "integer", description: "AX node cap for AX predicates (default 200)." },
				timeout_ms: { type: "integer", default: 5000, description: "Poll deadline in ms (default 5000, max 30000)." },
				interval_ms: { type: "integer", default: 400, description: "Poll interval in ms (default 400)." },
				case_sensitive: { type: "boolean", default: false, description: "Match case-sensitively." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						satisfied: { type: "boolean", required: true },
						kind: { type: "string", required: true },
						polls: { type: "integer", required: true },
						elapsedMs: { type: "integer", required: true },
						observed: { type: "string" }
					}
				},
				render: (_args, value) =>
					[
						{
							type: "text",
							text: value.satisfied === true
								? `Verified (${String(value.kind)}) after ${String(value.polls)} poll(s) in ${String(value.elapsedMs)} ms: ${String(value.observed ?? "")}`
								: `Timed out (${String(value.kind)}) after ${String(value.polls)} poll(s) in ${String(value.elapsedMs)} ms: ${String(value.observed ?? "")}`
						}
					]
			},
			isConcurrencySafe: () => true,
			presentCall: (args) => presentCall("Verify state", args),
			async execute(args, exec) {
				const kind = String(args.kind ?? "");
				const timeoutMs = Math.min(DELAY_MAX_MS, Math.max(0, Number(args.timeout_ms ?? 5000)));
				const intervalMs = Math.min(2000, Math.max(100, Number(args.interval_ms ?? 400)));
				const started = Date.now();
				let polls = 0;
				let last = { ok: false, observed: "not evaluated" };
				while (true) {
					exec.signal.throwIfAborted();
					polls += 1;
					last = await evaluatePredicate(args);
					if (last.ok === true) break;
					if (Date.now() - started >= timeoutMs) break;
					await delay(intervalMs, exec.signal);
				}
				audit("verify_state", { kind, satisfied: last.ok, polls, elapsed_ms: Date.now() - started });
				void axMaxNodes;
				return {
					schemaVersion: SCHEMA_VERSION,
					satisfied: last.ok === true,
					kind,
					polls,
					elapsedMs: Date.now() - started,
					observed: last.observed
				};
			}
		})
	);

	register(
		defineTool({
			name: "ax_snapshot",
			description:
				"List the accessibility nodes of a native app with the index that ax_press / ax_set_value / ax_scroll expect. Take a fresh snapshot before an AX action and again after the UI changed: an index is valid only for the snapshot it came from. Read-only; does not move the pointer or focus. For web/Electron content the tree is usually shallow — use browser_* or click/input_text there instead.",
			parameters: {
				pid: { type: "integer", description: "Target process id (defaults to the frontmost app)." },
				query: { type: "string", description: "Only keep nodes whose role/title/description/value contains this text (case-insensitive)." },
				max_nodes: { type: "integer", description: "Max nodes to return (default 60, cap 200)." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						pid: { type: "integer", required: true },
						app: { type: "string" },
						total: { type: "integer", required: true },
						matched: { type: "integer", required: true },
						truncated: { type: "boolean" },
						nodes: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									index: { type: "integer", required: true },
									role: { type: "string", required: true },
									title: { type: "string" },
									description: { type: "string" },
									value: { type: "string" }
								}
							}
						},
						error: { type: "string" },
						recovery: { type: "string" }
					}
				},
				render: (_args, value) => {
					const nodes = Array.isArray(value.nodes) ? value.nodes : [];
					if (typeof value.error === "string" && nodes.length === 0) {
						const hint = typeof value.recovery === "string" && value.recovery !== "" ? `\n${value.recovery}` : "";
						return [{ type: "text", text: `ax_snapshot (pid ${String(value.pid)}): ${value.error}${hint}` }];
					}
					const head = `AX 快照 (pid ${String(value.pid)}${typeof value.app === "string" ? ` · ${value.app}` : ""})：${String(value.matched)}/${String(value.total)} 个节点${value.truncated === true ? `（只显示前 ${String(nodes.length)} 个）` : ""}`;
					const rows = nodes.map((node) => {
						const title = typeof node.title === "string" ? ` "${node.title.slice(0, 60)}"` : "";
						return `- [${String(node.index)}] ${String(node.role)}${title}`;
					});
					return [{ type: "text", text: `${head}\n${rows.join("\n")}` }];
				}
			},
			isConcurrencySafe: () => true,
			presentCall: (args) => presentCall("Read AX tree", args),
			async execute(args, exec) {
				exec.signal.throwIfAborted();
				let pid = Number(args.pid);
				let app;
				if (Number.isInteger(pid) === false || pid <= 0) {
					const listed = await internals.listWindows({});
					pid = Number(listed?.frontmostPid);
					app = typeof listed?.frontmostApp === "string" ? listed.frontmostApp : undefined;
				}
				if (Number.isInteger(pid) === false || pid <= 0) {
					return { schemaVersion: SCHEMA_VERSION, pid: -1, total: 0, matched: 0, nodes: [], error: "no target pid" };
				}
				const cap = Math.min(200, Math.max(1, Number(args.max_nodes ?? 60)));
				// 抓取上限跟随 max_nodes：默认配置只有 120 个节点，工具栏按钮常在 120 之后被截断。
				const snapshot = await internals.snapshotAx(pid, Math.max(axMaxNodes, cap));
				const raw = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
				if (raw.length === 0) {
					return {
						schemaVersion: SCHEMA_VERSION,
						pid,
						...(app === void 0 ? {} : { app }),
						total: 0,
						matched: 0,
						nodes: [],
						error: "AX tree is empty or unreadable",
						recovery: "该进程可能不是原生 AppKit 应用（Electron/Web 内容请用 browser_* 或 click/input_text），或没有辅助功能权限。下一步：确认目标 App 在前台，并检查 系统设置 > 隐私与安全性 > 辅助功能。"
					};
				}
				const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
				const rows = [];
				for (const node of raw) {
					const role = String(node?.role ?? "");
					const title = String(node?.title ?? "");
					const description = String(node?.description ?? "");
					const rawValue = String(node?.value ?? "");
					if (query !== "" && `${role}\n${title}\n${description}\n${rawValue}`.toLowerCase().includes(query) === false) continue;
					rows.push({
						index: Number(node?.index),
						role,
						...(title === "" ? {} : { title }),
						...(description === "" ? {} : { description }),
						...(rawValue === "" ? {} : { value: rawValue.slice(0, 120) })
					});
				}
				const nodes = rows.slice(0, cap);
				return {
					schemaVersion: SCHEMA_VERSION,
					pid,
					...(app === void 0 ? {} : { app }),
					total: raw.length,
					matched: rows.length,
					truncated: rows.length > nodes.length,
					nodes
				};
			}
		})
	);

	register(
		defineTool({
			name: "ax_press",
			description:
				"Press one native accessibility element by its index from the latest <ax_snapshot> (for example [32]), through AXPress. This is a background delivery: the pointer and focus do not move, and no screenshot timing is involved. Provide expect_role / expect_title to refuse a stale or mismatched node. Use this for native AppKit controls (System Settings, Notes, Calendar); for web/Electron content keep using click/input_text. Facts only in the result.",
			parameters: {
				index: { type: "integer", required: true, description: "Node index from the latest <ax_snapshot>, e.g. 32." },
				expect_role: { type: "string", description: "Expected AX role (exact, e.g. AXButton); refuses on mismatch." },
				expect_title: { type: "string", description: "Expected title/description substring; refuses on mismatch." },
				pid: { type: "integer", description: "Target process id (defaults to the frontmost app)." },
				confirm: { type: "boolean", description: "Pass true to allow pressing a guarded control (delete/remove/pay/send…)." },
				// 0.98.0（P1-2）：动作后置断言，断言对象是本工具回包的事实字段
				expect: { type: "object", additionalProperties: true, description: "Assertions on this call's result facts: {contains: string|string[], absent: string|string[]}." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						pressed: { type: "boolean", required: true },
						expectError: { type: "string" },
						index: { type: "integer", required: true },
						role: { type: "string" },
						title: { type: "string" },
						// P0-2（0.121.8）：index 过期时自动重匹配的结果
						refreshed: { type: "boolean", description: "True when the index was stale and the press was retried on a freshly matched node." },
						originalIndex: { type: "integer", description: "The stale index that was replaced, when refreshed=true." },
						refreshHint: { type: "string", description: "Why automatic re-matching was skipped or ambiguous." },
						// P1（0.121.8）：动作后界面是否真的变了（AX 结构摘要对比）
						actionEffect: { type: "string", enum: ["confirmed", "suspected_noop", "unverifiable"] },
						error: { type: "string" },
						recovery: { type: "string" }
					}
				},
				render: (_args, value) => {
					const refreshed = value.refreshed === true && Number.isInteger(value.originalIndex)
						? ` (index ${String(value.originalIndex)} 已过期，自动刷新为 ${String(value.index)})`
						: "";
					const hint = typeof value.refreshHint === "string" && value.refreshHint !== "" ? `\n${value.refreshHint}` : "";
					const effect = {
						confirmed: "\n界面已变化——这次动作生效了。",
						suspected_noop: "\n界面看起来没变——动作可能没生效。下一步：截图或重新 ax_snapshot 确认目标控件；不要用同一个 index 重复按。",
						unverifiable: "\n这次无法判定是否生效（没有可比的基线）。下一步：重新 ax_snapshot 看界面有没有变。"
					}[value.actionEffect] ?? "";
					return [
						{
							type: "text",
							text: value.pressed === true
								? `Pressed AX node [${String(value.index)}] ${String(value.role)} "${String(value.title ?? "")}" via AXPress (background)${refreshed}${effect}`
								: `AXPress failed for node [${String(value.index)}]: ${String(value.error ?? "unknown error")}${hint}${typeof value.recovery === "string" && value.recovery !== "" ? `\n${value.recovery}` : ""}`
						}
					];
				}
			},
			isConcurrencySafe: () => true,
			presentCall: (args) => presentCall("Press AX element", args),
			async execute(args, exec) {
				exec.signal.throwIfAborted();
				let pid = Number(args.pid);
				if (Number.isInteger(pid) === false || pid <= 0) {
					const listed = await internals.listWindows({});
					pid = Number(listed?.frontmostPid);
				}
				if (Number.isInteger(pid) === false || pid <= 0) {
					return { schemaVersion: SCHEMA_VERSION, pressed: false, index: Number(args.index ?? -1), error: "no target pid" };
				}
				const index = Number(args.index ?? -1);
				if (config?.guard !== false) {
					const target = await resolvePressTarget(pid, index, axMaxNodes);
					const verdict = guardTitlePress({
						title: target?.title,
						role: target?.role,
						confirm: args.confirm === true,
						enabled: true
					});
					if (verdict.allowed !== true) {
						audit("ax_press_guarded", { index });
						return {
							schemaVersion: SCHEMA_VERSION,
							pressed: false,
							index,
							...(target?.role === void 0 ? {} : { role: target.role }),
							...(target?.title === void 0 ? {} : { title: target.title }),
							error: verdict.reason
						};
					}
				}
				const attempt = await pressAxWithRefresh(pid, Number(args.index ?? -1), {
					expectRole: typeof args.expect_role === "string" ? args.expect_role : undefined,
					expectTitle: typeof args.expect_title === "string" ? args.expect_title : undefined
				}, axMaxNodes);
				const result = attempt.result;
				audit("ax_press", {
					index: Number(args.index ?? -1),
					pressed: result.pressed === true,
					refreshed: attempt.refreshed === true,
					expect_role: typeof args.expect_role === "string",
					expect_title: typeof args.expect_title === "string"
				});
				const failed = result.pressed !== true;
				const recovery = failed ? await axRecoveryHint(pid) : "";
				const value = {
					schemaVersion: SCHEMA_VERSION,
					recovery,
					pressed: result.pressed === true,
					index: Number(result.index ?? args.index ?? -1),
					...(attempt.refreshed === true ? { refreshed: true, originalIndex: attempt.originalIndex } : {}),
					...(typeof attempt.suggestion === "string" ? { refreshHint: attempt.suggestion } : {}),
					...(typeof result.role === "string" && result.role !== "" ? { role: result.role } : {}),
					...(typeof result.title === "string" && result.title !== "" ? { title: result.title } : {}),
					...(typeof result.error === "string" && result.error !== "" ? { error: result.error } : {})
				};
				// P1（0.121.8）：成功只代表 AXPress 被投递，用 AX 结构摘要再报一次事实
				if (result.pressed === true) {
					value.actionEffect = (await axActionEffect(pid, axMaxNodes)).actionEffect;
				}
				// 0.98.0（P1-2）：后置断言——动作成功也要验「是否达到预期」
				const verdict = checkActionExpect(args.expect, value);
				if (verdict.ok !== true) {
					audit("action_expect_failed", { tool: "ax_press", reason: String(verdict.reason ?? "").slice(0, 120) });
					return { ...value, pressed: false, expectError: String(verdict.reason ?? "expect not met") };
				}
				return value;
			}
		})
	);

	register(
		defineTool({
			name: "ax_set_value",
			description:
				"Set the value of a native text field by its index from the latest <ax_snapshot> (background AXUIElementSetAttributeValue: pointer and focus do not move). Only AXTextField / AXTextArea / AXComboBox / AXSearchField are accepted; secure fields are refused. Prefer this over click + input_text for native AppKit text fields.",
			parameters: {
				index: { type: "integer", required: true, description: "Node index from the latest <ax_snapshot>." },
				value: { type: "string", required: true, description: "Text to write into the field." },
				expect_role: { type: "string", description: "Expected AX role (exact, e.g. AXTextField); refuses on mismatch." },
				pid: { type: "integer", description: "Target process id (defaults to the frontmost app)." },
				confirm: { type: "boolean", description: "Pass true to allow writing into a guarded control (labeled delete/pay/send…)." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						ok: { type: "boolean", required: true },
						index: { type: "integer", required: true },
						role: { type: "string" },
						title: { type: "string" },
						// 0.121.8：index 过期时按 expect_role 自动重匹配的结果
						refreshed: { type: "boolean" },
						originalIndex: { type: "integer" },
						// P1（0.121.8）：动作后界面是否真的变了（AX 结构摘要对比）
						actionEffect: { type: "string", enum: ["confirmed", "suspected_noop", "unverifiable"] },
						error: { type: "string" },
						recovery: { type: "string" }
					}
				},
				render: (_args, value) => {
					const effect = {
						confirmed: "\n界面已变化——写入生效了。",
						suspected_noop: "\n界面看起来没变——写入可能没生效。下一步：重新 ax_snapshot 确认这个控件是否可写（只读控件会静默失败）。",
						unverifiable: "\n这次无法判定是否生效（没有可比的基线）。下一步：重新 ax_snapshot 看界面有没有变。"
					}[value.actionEffect] ?? "";
					return [
						{
							type: "text",
							text: value.ok === true
								? `Set value on AX node [${String(value.index)}] ${String(value.role)} "${String(value.title ?? "")}" (background)${effect}`
								: `AX set-value failed for node [${String(value.index)}]: ${String(value.error ?? "unknown error")}${typeof value.recovery === "string" && value.recovery !== "" ? `\n${value.recovery}` : ""}`
						}
					];
				}
			},
			isConcurrencySafe: () => true,
			presentCall: (args) => presentCall("Set AX value", args),
			async execute(args, exec) {
				exec.signal.throwIfAborted();
				const index = Number(args.index ?? -1);
				const pid = await frontmostPid(args);
				if (Number.isInteger(pid) === false) {
					return { schemaVersion: SCHEMA_VERSION, ok: false, index, error: "no target pid" };
				}
				if (config?.guard !== false) {
					const target = await resolvePressTarget(pid, index, axMaxNodes);
					if (target?.role === "AXSecureTextField") {
						audit("ax_set_value_guarded", { index, reason: "secure" });
						return { schemaVersion: SCHEMA_VERSION, ok: false, index, role: target.role, error: "secure input fields cannot be set through this tool" };
					}
					const verdict = guardTitlePress({
						title: target?.title,
						role: target?.role,
						confirm: args.confirm === true,
						enabled: true
					});
					if (verdict.allowed !== true) {
						audit("ax_set_value_guarded", { index });
						return {
							schemaVersion: SCHEMA_VERSION,
							ok: false,
							index,
							...(target?.role === void 0 ? {} : { role: target.role }),
							...(target?.title === void 0 ? {} : { title: target.title }),
							error: verdict.reason
						};
					}
				}
				const expectRole = typeof args.expect_role === "string" ? args.expect_role : undefined;
				let result = await internals.setAxValue({
					pid,
					index,
					value: String(args.value ?? ""),
					expectRole
				});
				let refreshed = false;
				let originalIndex;
				if (result.ok !== true) {
					// 0.121.8：index 过期时按 expect_role 重匹配一次；多候选不猜。
					const stale = /(not.?found|no such|stale|index|过期|不存在|找不到)/i.test(String(result.error ?? ""));
					if (stale && expectRole !== undefined) {
						const rematched = await rematchAxIndex(pid, { expectRole });
						if (rematched.index !== void 0 && rematched.index !== index) {
							result = await internals.setAxValue({ pid, index: rematched.index, value: String(args.value ?? ""), expectRole });
							refreshed = true;
							originalIndex = index;
						}
					}
				}
				audit("ax_set_value", { index, ok: result.ok === true, refreshed, expect_role: typeof args.expect_role === "string" });
				const recovery = result.ok === true ? "" : await axRecoveryHint(pid);
				// P1（0.121.8）：写入成功也只代表 AX 被设置，界面是否真的变了由效果字段报事实
				const effect = result.ok === true ? await axActionEffect(pid, axMaxNodes) : undefined;
				return {
					schemaVersion: SCHEMA_VERSION,
					recovery,
					ok: result.ok === true,
					index: Number(result.index ?? index),
					...(effect === undefined ? {} : { actionEffect: effect.actionEffect }),
					...(refreshed ? { refreshed: true, originalIndex } : {}),
					...(typeof result.role === "string" && result.role !== "" ? { role: result.role } : {}),
					...(typeof result.title === "string" && result.title !== "" ? { title: result.title } : {}),
					...(typeof result.error === "string" && result.error !== "" ? { error: result.error } : {})
				};
			}
		})
	);

	register(
		defineTool({
			name: "ax_scroll",
			description:
				"Scroll a native scroll area (AXScrollArea). Pass a node index from the latest <ax_snapshot>, or omit it and pass expect_role/expect_title so the largest matching scroll area is picked automatically (handy when the container is filtered out of the snapshot). Tries the native AX scroll action first (background, no focus change). Apps that do not support AX scroll actions (e.g. Finder icon view) fall back to wheel events — that fallback raises and activates the target app, so prefer the native path when possible.",
			parameters: {
				index: { type: "integer", description: "AXScrollArea node index from the latest <ax_snapshot>; omit when using expect_role/expect_title." },
				direction: { type: "string", required: true, enum: ["up", "down", "left", "right"], description: "Scroll direction." },
				page: { type: "boolean", description: "Scroll a full page instead of a few lines." },
				expect_role: { type: "string", description: "Expected AX role (exact, e.g. AXScrollArea); refuses on mismatch." },
				expect_title: { type: "string", description: "Expected AX title substring." },
				pid: { type: "integer", description: "Target process id (defaults to the frontmost app)." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						ok: { type: "boolean", required: true },
						index: { type: "integer", required: true },
						role: { type: "string" },
						direction: { type: "string" },
						page: { type: "boolean" },
						resolved: { type: "string" },
						error: { type: "string" },
						recovery: { type: "string" }
					}
				},
				render: (_args, value) =>
					[
						{
							type: "text",
							text: value.ok === true
								? `Scrolled ${String(value.role ?? "AXScrollArea")} [${String(value.index)}] ${String(value.direction)}${value.page === true ? " (page)" : ""}${typeof value.resolved === "string" ? ` (${value.resolved})` : ""}`
								: `AX scroll failed for node [${String(value.index)}]: ${String(value.error ?? "unknown error")}${typeof value.recovery === "string" && value.recovery !== "" ? `\n${value.recovery}` : ""}`
						}
					]
			},
			isConcurrencySafe: () => false,
			presentCall: (args) => presentCall("Scroll AX area", args),
			async execute(args, exec) {
				exec.signal.throwIfAborted();
				const index = Number(args.index ?? -1);
				const expectRole = typeof args.expect_role === "string" && args.expect_role !== "" ? args.expect_role : undefined;
				const expectTitle = typeof args.expect_title === "string" && args.expect_title !== "" ? args.expect_title : undefined;
				const hasIndex = Number.isInteger(index) && index >= 0;
				if (hasIndex === false && expectRole === undefined && expectTitle === undefined) {
					return { schemaVersion: SCHEMA_VERSION, ok: false, index: Number.isFinite(index) ? index : -1, error: "pass index or expect_role/expect_title" };
				}
				const pid = await frontmostPid(args);
				if (Number.isInteger(pid) === false) {
					return { schemaVersion: SCHEMA_VERSION, ok: false, index, error: "no target pid" };
				}
				const result = await internals.scrollAx({
					pid,
					...(hasIndex === true ? { index } : {}),
					direction: String(args.direction ?? ""),
					page: args.page === true,
					expectRole,
					expectTitle
				});
				audit("ax_scroll", {
					index: Number(result.index ?? index),
					ok: result.ok === true,
					direction: String(args.direction ?? ""),
					page: args.page === true,
					autoPick: hasIndex === false
				});
				const recovery = result.ok === true ? "" : await axRecoveryHint(pid);
				return {
					schemaVersion: SCHEMA_VERSION,
					recovery,
					ok: result.ok === true,
					index: Number(result.index ?? index),
					...(typeof result.role === "string" && result.role !== "" ? { role: result.role } : {}),
					...(typeof result.direction === "string" && result.direction !== "" ? { direction: result.direction } : {}),
					page: result.page === true,
					...(typeof result.resolved === "string" && result.resolved !== "" ? { resolved: result.resolved } : {}),
					...(typeof result.error === "string" && result.error !== "" ? { error: result.error } : {})
				};
			}
		})
	);

	register(
		defineTool({
			name: "ax_menu",
			description:
				"Invoke a menu bar command in a native AppKit app by path, e.g. \"文件/关闭\" or \"显示/显示路径栏\", through background AXPress. Menu items containing destructive words (delete/remove/pay/send…) require confirm: true. The target app should be frontmost (background menu bars do not open reliably). Electron/Web apps usually expose no usable menu bar; use keyboard shortcuts there.",
			parameters: {
				path: { type: "string", required: true, description: "Menu path, \"/\"-separated, e.g. 文件/关闭." },
				app: { type: "string", description: "Expected frontmost app name (substring). Refuses when another app is frontmost — this catches the classic mistake of invoking a Finder menu while DeepSeek Harness is still in front." },
				pid: { type: "integer", description: "Target process id (defaults to the frontmost app)." },
				confirm: { type: "boolean", description: "Pass true to allow a guarded menu item (delete/remove/pay/send…)." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						ok: { type: "boolean", required: true },
						path: { type: "string", required: true },
						app: { type: "string" },
						error: { type: "string" }
					}
				},
				render: (_args, value) =>
					[
						{
							type: "text",
							text: value.ok === true
								? `Invoked menu ${String(value.path)} in ${String(value.app ?? "frontmost app")} via AXPress (background)`
								: `Menu invocation failed for ${String(value.path)}: ${String(value.error ?? "unknown error")}`
						}
					]
			},
			isConcurrencySafe: () => true,
			presentCall: (args) => presentCall("Invoke AX menu", args),
			async execute(args, exec) {
				exec.signal.throwIfAborted();
				const segments = String(args.path ?? "")
					.split("/")
					.map((part) => part.trim())
					.filter((part) => part !== "");
				const label = segments.join("/");
				if (segments.length === 0) {
					return { schemaVersion: SCHEMA_VERSION, ok: false, path: "", error: "empty menu path" };
				}
				// 0.93.0：先记一笔再动作——两次「文件菜单被点开」的投诉都没法归因，先留住证据
				audit("ax_menu_attempt", {
					path: label,
					expectedApp: typeof args.app === "string" ? args.app : "",
					pid: Number.isInteger(args.pid) ? args.pid : null,
					session: sessionKeyOf(exec).slice(0, 12)
				});
				// 0.88.0：菜单栏属于前台 App——先校验期望的 App，避免「想点访达，实际点了 DSH 的文件菜单」
				const windowsInfo = await internals.listWindows({});
				const frontmostApp = String(windowsInfo?.frontmostApp ?? "");
				const expected = typeof args.app === "string" ? args.app.trim() : "";
				if (expected !== "" && Number.isInteger(args.pid) !== true && frontmostApp !== "" && frontmostApp.includes(expected) === false) {
					audit("ax_menu_wrong_app", { expected, frontmost: frontmostApp, path: label });
					return {
						schemaVersion: SCHEMA_VERSION,
						ok: false,
						path: label,
						app: frontmostApp,
						error: `前台是「${frontmostApp}」，不是「${expected}」——菜单栏属于前台 App，先 open_app ${expected}（并用 verify_state {kind:"frontmost_app"} 确认）再调本工具；或传 pid 指定目标。`
					};
				}
				// 0.93.0：既不传 app 也不传 pid = 对「当前前台」动手，正是两次误点文件菜单的形态。
				// 默认要求显式指定目标；确实需要对前台操作时传 app: "<前台应用名>" 即可。
				if (expected === "" && Number.isInteger(args.pid) !== true) {
					audit("ax_menu_no_target", { path: label, frontmost: frontmostApp });
					return {
						schemaVersion: SCHEMA_VERSION,
						ok: false,
						path: label,
						app: frontmostApp,
						error: `菜单操作必须显式指定目标：传 app:"${frontmostApp || "应用名"}"（前台应用名）或 pid。\n这样可避免「想操作别的 App，却点开了 ${frontmostApp || "前台"} 的菜单」。`
					};
				}
				const pid = await frontmostPid(args);
				if (Number.isInteger(pid) === false) {
					return { schemaVersion: SCHEMA_VERSION, ok: false, path: label, app: frontmostApp, error: "no target pid" };
				}
				if (config?.guard !== false) {
					const verdict = guardTitlePress({ title: label, confirm: args.confirm === true, enabled: true });
					if (verdict.allowed !== true) {
						audit("ax_menu_guarded", { path: label });
						return { schemaVersion: SCHEMA_VERSION, ok: false, path: label, error: verdict.reason };
					}
				}
				const result = await internals.pressAxMenu({ pid, path: segments });
				audit("ax_menu", { path: label, ok: result.ok === true, app: frontmostApp, pid });
				return {
					schemaVersion: SCHEMA_VERSION,
					ok: result.ok === true,
					path: label,
					// 0.88.0：回包里带上实际在哪个 App 上执行的，便于事后判断点没点错地方
					app: frontmostApp,
					...(typeof result.error === "string" && result.error !== "" ? { error: result.error } : {})
				};
			}
		})
	);


	register(
		defineTool({
			name: "window_move",
			description:
				"Move and resize a native window via AXPosition/AXSize (background; cursor and focus do not move). Pass an exact frame (x/y/width/height) or a layout preset (left-half / right-half / top-half / bottom-half / maximize / center) computed from the primary display; for center, width/height optionally set the window size. Targets the frontmost app by default; pass pid or window_title to pick another app's window. Useful to line up two windows side by side before a cross-window drag.",
			parameters: {
				x: { type: "number", description: "Target window x in screen points (required unless layout is set)." },
				y: { type: "number", description: "Target window y in screen points (required unless layout is set)." },
				width: { type: "number", description: "Target width in points (required unless layout is set; optional window width for layout=center)." },
				height: { type: "number", description: "Target height in points (required unless layout is set; optional window height for layout=center)." },
				layout: {
					type: "string",
					enum: [...WINDOW_LAYOUTS],
					description: "Layout preset computed from the primary display: left-half/right-half/top-half/bottom-half/maximize/center."
				},
				pid: { type: "integer", description: "Target process id (defaults to the frontmost app)." },
				window_title: { type: "string", description: "Match a window whose title contains this text (defaults to the app's first window)." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						ok: { type: "boolean", required: true },
						windowTitle: { type: "string" },
						layout: { type: "string" },
						frame: {
							type: "object",
							additionalProperties: false,
							properties: {
								x: { type: "number", required: true },
								y: { type: "number", required: true },
								width: { type: "number", required: true },
								height: { type: "number", required: true }
							}
						},
						retried: { type: "boolean" },
						error: { type: "string" }
					}
				},
				render: (_args, value) => {
					if (value.ok !== true) return [{ type: "text", text: `Window move failed: ${String(value.error ?? "unknown error")}` }];
					const frame = value.frame;
					const bounds = frame === undefined ? "" : `${String(frame.x)},${String(frame.y)} ${String(frame.width)}x${String(frame.height)}`;
					const layout = value.layout === undefined ? "" : ` [${String(value.layout)}]`;
					const retried = value.retried === true ? " (frame re-applied after first attempt differed)" : "";
					return [{ type: "text", text: `Moved window to ${bounds}${layout}${retried}${value.windowTitle === undefined ? "" : ` (${String(value.windowTitle)})`}. Coordinates remain 0–1000.` }];
				}
			},
			isConcurrencySafe: () => true,
			presentCall: (args) => presentCall("Move window", args),
			async execute(args, exec) {
				exec.signal.throwIfAborted();
				const layout = typeof args.layout === "string" && args.layout !== "" ? args.layout : undefined;
				if (layout !== undefined && WINDOW_LAYOUTS.includes(layout) === false) {
					return { schemaVersion: SCHEMA_VERSION, ok: false, error: `layout must be one of: ${WINDOW_LAYOUTS.join(", ")}` };
				}
				const pid = await frontmostPid(args);
				if (Number.isInteger(pid) === false) {
					return { schemaVersion: SCHEMA_VERSION, ok: false, error: "no target pid" };
				}
				let frame;
				if (layout !== undefined) {
					const listed = await internals.listWindows({});
					const display = resolveLayoutDisplay(listed?.displays);
					frame = planWindowFrame({ layout, display, width: Number(args.width), height: Number(args.height) });
					if (frame === undefined) return { schemaVersion: SCHEMA_VERSION, ok: false, error: "no display geometry for layout" };
				} else {
					frame = { x: Number(args.x), y: Number(args.y), width: Number(args.width), height: Number(args.height) };
					if (Object.values(frame).every((value) => Number.isFinite(value)) === false) {
						return { schemaVersion: SCHEMA_VERSION, ok: false, error: "x/y/width/height must be numbers, or pass layout" };
					}
					if (frame.width <= 0 || frame.height <= 0) {
						return { schemaVersion: SCHEMA_VERSION, ok: false, error: "width/height must be positive" };
					}
				}
				const windowTitle = typeof args.window_title === "string" ? args.window_title : undefined;
				const closeToWanted = (actual) =>
					actual !== undefined &&
					["x", "y", "width", "height"].every((key) => Number.isFinite(Number(actual[key])) && Math.abs(Number(actual[key]) - frame[key]) <= 2);
				let result = await internals.setWindowFrame({ pid, frame, windowTitle });
				let retried = false;
				if (result.ok === true && closeToWanted(result.frame) === false) {
					retried = true;
					const second = await internals.setWindowFrame({ pid, frame, windowTitle });
					if (second.ok === true) result = second;
				}
				audit("window_move", {
					ok: result.ok === true,
					frame,
					layout,
					retried,
					windowTitlePresent: windowTitle !== undefined
				});
				return {
					schemaVersion: SCHEMA_VERSION,
					ok: result.ok === true,
					...(layout === undefined ? {} : { layout }),
					...(retried ? { retried: true } : {}),
					...(typeof result.windowTitle === "string" && result.windowTitle !== "" ? { windowTitle: result.windowTitle } : {}),
					...(result.frame === undefined ? {} : { frame: result.frame }),
					...(typeof result.error === "string" && result.error !== "" ? { error: result.error } : {})
				};
			}
		})
	);

	register(
		defineTool({
			name: "skill_save",
			description:
				"Save a reusable desktop/browser skill (an ordered list of tool calls) to the local skill library at ~/.dsh/dsh-operator/skills. Skills store only tool names + args — never screenshots, clipboard contents or secrets. Use this after you work out a reliable sequence you may want to replay.",
			parameters: {
				name: { type: "string", required: true, description: "kebab-case skill name (2-64 chars: a-z0-9-)." },
				description: { type: "string", required: true, description: "One line: when to use this skill." },
				steps: {
					type: "array",
					required: true,
					description: "Ordered steps, e.g. [{tool: \"open_app\", args: {name: \"系统设置\"}}, …].",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							tool: { type: "string", required: true },
							args: { type: "object", additionalProperties: true },
							// 0.76.0：步骤级校验（0.75 已在执行器实现，这里补上工具参数）
							verify: { type: "object", additionalProperties: true, description: "Extra verify_state predicate run after this step, e.g. {kind:'frontmost_app', contains:'系统设置'}." },
							expect: { type: "object", additionalProperties: true, description: "Assertions on this step's result text: {contains: string|string[], absent: string|string[]}." }
						}
					}
				},
				tags: { type: "array", items: { type: "string" } },
				overwrite: { type: "boolean", description: "Pass true to replace an existing skill with the same name." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						ok: { type: "boolean", required: true },
						name: { type: "string" },
						path: { type: "string" },
						bytes: { type: "integer" },
						overwritten: { type: "boolean" },
						error: { type: "string" }
					}
				},
				render: (_args, value) =>
					[{
						type: "text",
						text: value.ok === true
							? `Saved skill ${String(value.name)} (${String(value.bytes)} bytes${value.overwritten === true ? ", overwritten" : ""})`
							: `Skill save failed: ${String(value.error ?? "unknown error")}`
					}]
			},
			isConcurrencySafe: () => false,
			presentCall: (args) => presentCall("Save skill", args),
			async execute(args, exec) {
				exec.signal.throwIfAborted();
				try {
					const saved = saveSkill(
						{
							name: String(args.name ?? ""),
							description: String(args.description ?? ""),
							steps: Array.isArray(args.steps) ? args.steps : [],
							// 0.66.0：把 {{变量}} 记下来，skill_list / skill_run 才能提示要传什么
							variables: collectVariables(Array.isArray(args.steps) ? args.steps : []),
							...(args.tags === undefined ? {} : { tags: args.tags })
						},
						{ overwrite: args.overwrite === true }
					);
					audit("skill_save", { name: saved.name, bytes: saved.bytes, overwritten: saved.overwritten });
					return { schemaVersion: SCHEMA_VERSION, ok: true, ...saved };
				} catch (error) {
					audit("skill_save_failed", { error: error instanceof Error ? error.message : String(error) });
					return { schemaVersion: SCHEMA_VERSION, ok: false, error: error instanceof Error ? error.message : String(error) };
				}
			}
		})
	);

	register(
		defineTool({
			name: "skill_list",
			description: "List saved skills with usage stats (runs / success count / health). Sorted by name by default; pass sort:\"usage\" to put the most-used first, or sort:\"updated\". Health marks skills that never succeeded (stale) or fail more than half the time (flaky).",
			parameters: {
				sort: { type: "string", description: "name (default) | usage | updated" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						total: { type: "integer", required: true },
						dir: { type: "string", required: true },
						skills: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									name: { type: "string", required: true },
									description: { type: "string", required: true },
									steps: { type: "integer", required: true },
									tags: { type: "array", items: { type: "string" } },
									updatedAt: { type: "string", required: true },
									// 0.81.0：使用频次与健康度
									runs: { type: "integer" },
									okRuns: { type: "integer" },
									firstSteps: { type: "integer" },
									lastSteps: { type: "integer" },
									health: { type: "string" }
								}
							}
						}
					}
				},
				render: (_args, value) =>
					[{
						type: "text",
						text: value.total === 0
							? `No saved skills yet (dir: ${String(value.dir)})`
							: `Saved skills: ${value.skills.map((skill) => `${skill.name}(${skill.steps} steps${skill.runs === undefined || skill.runs === 0 ? "" : `，用 ${String(skill.runs)} 次`}${skill.health === "stale" ? "，⚠️ 未成功过" : skill.health === "flaky" ? "，⚠️ 常失败" : ""})`).join(", ")}`
					}]
			},
			isConcurrencySafe: () => true,
			presentCall: (args) => presentCall("List skills", args),
			async execute(args, exec) {
				exec.signal.throwIfAborted();
				const stats = readStats();
				const skills = listSkills().map((skill) => {
					const stat = stats[String(skill.name)];
					const runs = Number(stat?.runs ?? 0);
					return {
						name: String(skill.name),
						description: String(skill.description ?? ""),
						steps: Array.isArray(skill.steps) ? skill.steps.length : 0,
						...(Array.isArray(skill.tags) ? { tags: skill.tags } : {}),
						updatedAt: String(skill.updatedAt ?? ""),
						runs,
						okRuns: Number(stat?.ok ?? 0),
						...(runs === 0 ? {} : {
							...(Number(stat?.first ?? 0) > 0 ? { firstSteps: Number(stat.first) } : {}),
							...(Number(stat?.last ?? 0) > 0 ? { lastSteps: Number(stat.last) } : {})
						}),
						health: judgeSkillHealth(stat)
					};
				});
				const sort = String(args?.sort ?? "name");
				const sorted = sort === "usage"
					? [...skills].sort((a, b) => (b.runs - a.runs) || a.name.localeCompare(b.name))
					: sort === "updated"
						? [...skills].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
						: [...skills].sort((a, b) => a.name.localeCompare(b.name));
				audit("skill_list", { total: sorted.length, sort });
				return { schemaVersion: SCHEMA_VERSION, total: sorted.length, dir: skillDir(), skills: sorted };
			}
		})
	);

	register(
		defineTool({
			name: "skill_show",
			description: "Show one saved skill as JSON text (tool + args per step). Use it before replaying a sequence manually.",
			parameters: {
				name: { type: "string", required: true, description: "kebab-case skill name." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						ok: { type: "boolean", required: true },
						name: { type: "string" },
						json: { type: "string" },
						error: { type: "string" }
					}
				},
				render: (_args, value) =>
					[{
						type: "text",
						text: value.ok === true ? String(value.json ?? "") : `Skill read failed: ${String(value.error ?? "unknown error")}`
					}]
			},
			isConcurrencySafe: () => true,
			presentCall: (args) => presentCall("Show skill", args),
			async execute(args, exec) {
				exec.signal.throwIfAborted();
				try {
					const skill = readSkill(String(args.name ?? ""));
					return { schemaVersion: SCHEMA_VERSION, ok: true, name: String(skill.name), json: JSON.stringify(skill, null, 2) };
				} catch (error) {
					return { schemaVersion: SCHEMA_VERSION, ok: false, name: String(args.name ?? ""), error: error instanceof Error ? error.message : String(error) };
				}
			}
		})
	);

	register(
		defineTool({
			name: "skill_suggest",
			description:
				"Turn the recent successful GUI actions into a ready-to-save skill draft (memory only, never persisted by this call). Returns a skill JSON you can pass to skill_save. Sensitive-arg actions and non-GUI tools are skipped. Use after finishing a repeatable sequence.",
			parameters: {
				name: { type: "string", description: "Optional kebab-case skill name; defaults to captured-<date>-<n>steps." },
				description: { type: "string", description: "Optional one-line description." },
				consume: { type: "boolean", description: "Clear the candidate buffer after returning the draft (default false)." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						ok: { type: "boolean", required: true },
						text: { type: "string", required: true },
						steps: { type: "integer" },
						error: { type: "string" }
					}
				},
				render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
			},
			isConcurrencySafe: () => true,
			presentCall: () => presentCall("Suggest skill", {}),
			async execute(args, exec) {
				const key = sessionKeyOf(exec);
				const before = candidateCount(key);
				const built = buildCandidateSkill({ name: args?.name, description: args?.description, key });
				if (built.ok !== true) {
					audit("skill_suggest", { ok: false, candidates: before });
					return { schemaVersion: SCHEMA_VERSION, ok: false, steps: before, text: `skill_suggest: ${String(built.reason ?? (built.errors ?? []).join("; "))}`, error: built.reason ?? "invalid" };
				}
				if (args?.consume === true) resetCandidates();
				audit("skill_suggest", { ok: true, steps: built.skill.steps.length, consumed: args?.consume === true });
				return {
					schemaVersion: SCHEMA_VERSION,
					ok: true,
					steps: built.skill.steps.length,
					text: `候选技能 ${built.skill.name}：${String(built.skill.steps.length)} 步（${built.skill.steps.map((step) => step.tool).join(" → ")}）。存下来用 skill_save，或先 skill_run 试跑。\n${JSON.stringify({ version: 1, skills: [built.skill] })}`
				};
			}
		})
	);

	register(
		defineTool({
			name: "skill_export",
			description:
				"Export skills to a portable JSON bundle (local skill library at ~/.dsh/dsh-operator/skills). Omit name to export all. Pass path to also write the bundle to disk; otherwise the JSON is returned in text. Safe: skills store only tool names + args.",
			parameters: {
				name: { type: "string", description: "Single skill name; omit to export all." },
				path: { type: "string", description: "Optional file path to also write the bundle to." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						ok: { type: "boolean", required: true },
						text: { type: "string", required: true },
						count: { type: "integer" },
						path: { type: "string" },
						error: { type: "string" }
					}
				},
				render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
			},
			isConcurrencySafe: () => true,
			presentCall: (args) => presentCall("Export skills", args),
			async execute(args) {
				try {
					const bundle = exportSkills(args?.name === undefined ? undefined : [String(args.name)]);
					const payload = `${JSON.stringify(bundle, null, 2)}\n`;
					const bytes = Buffer.byteLength(payload);
					let written;
					if (typeof args?.path === "string" && args.path.trim() !== "") {
						written = resolveTransferPath(args.path, { create: true });
						await writeFile(written, payload, "utf8");
					}
					audit("skill_export", { count: bundle.skills.length, bytes, wroteFile: written !== undefined });
					const head = `导出 ${String(bundle.skills.length)} 条技能（bundle v${String(bundle.version)}，${String(bytes)} bytes）${written === undefined ? "" : ` → ${written}`}`;
					// 0.82.0：包太大时不再把整份 JSON 塞进回包（会撑爆上下文）
					const inline = written === undefined && bytes <= EXPORT_INLINE_MAX_BYTES ? `\n${JSON.stringify(bundle)}` : written === undefined ? "\n（包较大，正文已省略；请传 path 落盘后再导入）" : "";
					return { schemaVersion: SCHEMA_VERSION, ok: true, count: bundle.skills.length, ...(written === undefined ? {} : { path: written }), text: `${head}${inline}` };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					audit("skill_export_failed", { error: message });
					return { schemaVersion: SCHEMA_VERSION, ok: false, text: `skill_export failed: ${message}`, error: message };
				}
			}
		})
	);

	register(
		defineTool({
			name: "skill_import",
			description:
				"Import skills from a JSON bundle produced by skill_export (or inline JSON in content). Every entry is validated first: invalid or secret-bearing steps are skipped with a reason, never half-written. Existing names need overwrite:true.",
			parameters: {
				path: { type: "string", description: "File path of the bundle to read." },
				content: { type: "string", description: "Inline bundle JSON (use instead of path)." },
				overwrite: { type: "boolean", description: "Replace existing skills with the same name." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						ok: { type: "boolean", required: true },
						text: { type: "string", required: true },
						imported: { type: "integer" },
						skipped: { type: "integer" },
						error: { type: "string" }
					}
				},
				render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
			},
			isConcurrencySafe: () => false,
			presentCall: (args) => presentCall("Import skills", args),
			async execute(args) {
				try {
					let raw;
					if (typeof args?.content === "string" && args.content.trim() !== "") raw = args.content;
					else if (typeof args?.path === "string" && args.path.trim() !== "") {
						const resolved = resolveTransferPath(args.path);
						const info = statSync(resolved, { throwIfNoEntry: false });
						// 0.82.0：/dev/zero 这类不是普通文件，先拦下再读
						if (info === undefined || info.isFile() === false) throw new Error(`不是普通文件：${resolved}`);
						if (info.size > TRANSFER_MAX_BYTES) throw new Error(`文件过大（${String(info.size)} bytes > ${String(TRANSFER_MAX_BYTES)}）`);
						raw = await readFile(resolved, "utf8");
					}
					else throw new Error("需要 path 或 content 之一");
					const result = importSkills(JSON.parse(raw), { overwrite: args?.overwrite === true });
					audit("skill_import", { imported: result.imported.length, skipped: result.skipped.length });
					return {
						schemaVersion: SCHEMA_VERSION,
						ok: result.skipped.length === 0,
						imported: result.imported.length,
						skipped: result.skipped.length,
						text: describeImport(result)
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					audit("skill_import_failed", { error: message });
					return { schemaVersion: SCHEMA_VERSION, ok: false, text: `skill_import failed: ${message}`, error: message };
				}
			}
		})
	);

	register(
		defineTool({
			name: "skill_delete",
			description: "Delete a saved skill by name (irreversible; the file is removed from ~/.dsh/dsh-operator/skills).",
			parameters: {
				name: { type: "string", required: true, description: "kebab-case skill name." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						ok: { type: "boolean", required: true },
						name: { type: "string", required: true },
						deleted: { type: "boolean", required: true },
						error: { type: "string" }
					}
				},
				render: (_args, value) =>
					[{
						type: "text",
						text: value.ok === true
							? value.deleted === true ? `Deleted skill ${String(value.name)}` : `No such skill: ${String(value.name)}`
							: `Skill delete failed: ${String(value.error ?? "unknown error")}`
					}]
			},
			isConcurrencySafe: () => false,
			presentCall: (args) => presentCall("Delete skill", args),
			async execute(args, exec) {
				exec.signal.throwIfAborted();
				try {
					const name = String(args.name ?? "");
					const deleted = deleteSkill(name);
					audit("skill_delete", { name, deleted });
					return { schemaVersion: SCHEMA_VERSION, ok: true, name, deleted };
				} catch (error) {
					return { schemaVersion: SCHEMA_VERSION, ok: false, name: String(args.name ?? ""), deleted: false, error: error instanceof Error ? error.message : String(error) };
				}
			}
		})
	);


	/** 技能迁移文件的字节上限（0.82.0）。 */
	const TRANSFER_MAX_BYTES = 1000000;
	/** 回包内联 JSON 的阈值：超过就只给摘要，强制走 path（0.82.0）。 */
	const EXPORT_INLINE_MAX_BYTES = 262144;

	/**
	 * 迁移文件路径守卫：只允许技能目录或其同级 exports 目录内。
	 * 0.82.0：之前可以写任意绝对路径（包括 ~/.zshrc），或把包塞回技能库被当成技能加载。
	 * @param {string} raw
	 * @param {{ create?: boolean }} [options]
	 * @returns {string} 绝对路径
	 */
	function resolveTransferPath(raw, options = {}) {
		const text = String(raw ?? "").trim();
		if (text === "") throw new Error("path 不能为空");
		const exportsDir = join(dirname(skillDir()), "exports");
		const target = text.startsWith("/") ? text : join(exportsDir, text);
		const resolved = resolve(target);
		const roots = [resolve(skillDir()), resolve(exportsDir)];
		const inside = roots.some((root) => resolved === root || resolved.startsWith(`${root}${sep}`));
		if (inside === false) throw new Error(`路径必须位于 ${roots.join(" 或 ")} 之内（收到 ${resolved}）`);
		if (options.create === true) mkdirSync(exportsDir, { recursive: true });
		return resolved;
	}

	function browserRunner() {
		return internals.osascript ? { runner: internals.osascript } : {};
	}

	register(
		defineTool({
			name: "browser_dom_snapshot",
			description:
				"Read the frontmost tab of a running browser as structured DOM (title/url/text/links/interactive controls) through the AppleScript JavaScript channel. Read-only: does not read input values, cookies or passwords. If the channel is disabled it returns {available:false} with the exact Chrome/Safari menu switch to enable; fall back to screenshot tools in that case.",
			parameters: {
				browser: { type: "string", description: "Browser app name: Google Chrome (default) or Safari." },
				maxText: { type: "integer", description: "Max characters of page text (default 4000)." },
				maxLinks: { type: "integer", description: "Max links to list (default 80, capped 200)." },
				maxInteractive: { type: "integer", description: "Max interactive controls (default 60, capped 120)." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						ok: { type: "boolean", required: true },
						available: { type: "boolean", required: true },
						backend: { type: "string" },
						reason: { type: "string" },
						hint: { type: "string" },
						url: { type: "string" },
						title: { type: "string" },
						text: { type: "string" },
						links: { type: "array", items: { type: "string" } },
						interactive: { type: "array", items: { type: "string" } },
						error: { type: "string" }
					}
				},
				render: (_args, value) =>
					[{
						type: "text",
						text: value.available === true
							? `DOM snapshot: ${String(value.title ?? "")} (${String(value.url ?? "")}) — ${value.links?.length ?? 0} links, ${value.interactive?.length ?? 0} controls`
							: `DOM channel unavailable (${String(value.reason ?? "unknown")}): ${String(value.hint ?? value.error ?? "")}`
					}]
			},
			isConcurrencySafe: () => true,
			presentCall: (args) => presentCall("Read browser DOM", args),
			async execute(args, exec) {
				exec.signal.throwIfAborted();
				const browser = String(args.browser ?? "Google Chrome");
				try {
					const limits = {
						maxText: Math.min(20000, Math.max(200, Number(args.maxText ?? 4000))),
						maxLinks: Math.min(200, Math.max(1, Number(args.maxLinks ?? 80))),
						maxInteractive: Math.min(120, Math.max(1, Number(args.maxInteractive ?? 60)))
					};
					const snapshot = await readDomSnapshot({ browser, ...browserRunner(), ...limits });
					const links = (snapshot.links ?? []).map((link) => `${link.text || "(no text)"} -> ${link.href}`);
					const interactive = (snapshot.interactive ?? []).map(
						(el) => `${el.tag}${el.role ? `[${el.role}]` : ""}${el.type ? `(${el.type})` : ""}${el.disabled ? " [disabled]" : ""}: ${el.label || "(no label)"}`
					);
					audit("browser_dom_snapshot", { browser, links: links.length, interactive: interactive.length });
					return {
						schemaVersion: SCHEMA_VERSION,
						ok: true,
						available: true,
						backend: "applescript",
						url: String(snapshot.url ?? ""),
						title: String(snapshot.title ?? ""),
						text: String(snapshot.text ?? ""),
						links,
						interactive
					};
				} catch (error) {
					const code = /** @type {{code?: string, hint?: string}} */ (error).code;
					const port = Number(config?.browserCdpPort ?? 0);
					if (port > 0) {
						try {
							const snapshot = await internals.cdpSnapshot({ port, maxText: Math.min(20000, Math.max(200, Number(args.maxText ?? 4000))), maxLinks: Math.min(200, Math.max(1, Number(args.maxLinks ?? 80))), maxInteractive: Math.min(120, Math.max(1, Number(args.maxInteractive ?? 60))) });
							const links = (snapshot.links ?? []).map((link) => `${link.text || "(no text)"} -> ${link.href}`);
							const interactive = (snapshot.interactive ?? []).map((el) => `${el.tag}${el.role ? `[${el.role}]` : ""}${el.type ? `(${el.type})` : ""}${el.disabled ? " [disabled]" : ""}: ${el.label || "(no label)"}`);
							audit("browser_dom_snapshot", { browser: "cdp", port, links: links.length, interactive: interactive.length });
							return { schemaVersion: SCHEMA_VERSION, ok: true, available: true, backend: "cdp", url: String(snapshot.url ?? ""), title: String(snapshot.title ?? ""), text: String(snapshot.text ?? ""), links, interactive };
						} catch (cdpError) {
							audit("browser_dom_snapshot_failed", { browser, code: "cdp-error", port });
							return { schemaVersion: SCHEMA_VERSION, ok: false, available: false, backend: "cdp", reason: "cdp-error", error: `${error instanceof Error ? error.message : String(error)}; CDP fallback failed: ${cdpError instanceof Error ? cdpError.message : String(cdpError)}` };
						}
					}
					audit("browser_dom_snapshot_failed", { browser, code: code ?? "error" });
					return {
						schemaVersion: SCHEMA_VERSION,
						ok: false,
						available: false,
						reason: code === "disabled" ? "disabled" : "error",
						...(code === "disabled" && typeof /** @type {{hint?: string}} */ (error).hint === "string" ? { hint: /** @type {{hint?: string}} */ (error).hint } : {}),
						error: error instanceof Error ? error.message : String(error)
					};
				}
			}
		})
	);

	register(
		defineTool({
			name: "browser_dom_click",
			description:
				"Click one element in the frontmost browser tab by CSS selector or by visible text (button/link). Destructive-looking targets (删除/删除账号/pay/send…) require confirm:true. Uses the same AppleScript JS channel as browser_dom_snapshot.",
			parameters: {
				browser: { type: "string", description: "Browser app name: Google Chrome (default) or Safari." },
				selector: { type: "string", description: "CSS selector (preferred when known)." },
				text: { type: "string", description: "Visible text of a button/link (fallback)." },
				confirm: { type: "boolean", description: "Pass true to allow a guarded destructive target." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						ok: { type: "boolean", required: true },
						backend: { type: "string" },
						how: { type: "string" },
						matched: { type: "string" },
						error: { type: "string" },
						reason: { type: "string" }
					}
				},
				render: (_args, value) =>
					[{
						type: "text",
						text: value.ok === true ? `Clicked DOM element (${String(value.how)})` : `DOM click failed: ${String(value.error ?? value.reason ?? "unknown error")}`
					}]
			},
			isConcurrencySafe: () => false,
			presentCall: (args) => presentCall("Click DOM element", args),
			async execute(args, exec) {
				exec.signal.throwIfAborted();
				// 0.86.0：selector 和 text 都要过守卫（之前只看 text，selector 可绕过；实际点击又优先 selector）
				const guards = [String(args.text ?? ""), String(args.selector ?? "")].filter((item) => item.trim() !== "");
				if (guards.length === 0) return { schemaVersion: SCHEMA_VERSION, ok: false, error: "selector or text is required" };
				for (const candidate of guards) {
					if (config?.guard === false) break;
					const verdict = guardTitlePress({ title: candidate, confirm: args.confirm === true, enabled: true });
					if (verdict.allowed !== true) {
						audit("browser_dom_click_guarded", { matched: matchDangerousTitle(candidate) ?? "", field: candidate === String(args.text ?? "") ? "text" : "selector" });
						return { schemaVersion: SCHEMA_VERSION, ok: false, error: verdict.reason };
					}
				}
				try {
					const result = await clickDom({
						browser: String(args.browser ?? "Google Chrome"),
						...(args.selector === undefined ? {} : { selector: String(args.selector) }),
						...(args.text === undefined ? {} : { text: String(args.text) }),
						...browserRunner()
					});
					audit("browser_dom_click", { ok: result.ok === true, how: String(result.how ?? "") });
					return { schemaVersion: SCHEMA_VERSION, ok: result.ok === true, backend: "applescript", ...(result.how ? { how: String(result.how) } : {}), ...(result.matched ? { matched: String(result.matched) } : {}), ...(result.reason && result.ok !== true ? { reason: String(result.reason) } : {}) };
				} catch (error) {
					const port = Number(config?.browserCdpPort ?? 0);
					if (port > 0) {
						try {
							const result = await internals.cdpClick({ port, ...(args.selector === undefined ? {} : { selector: String(args.selector) }), ...(args.text === undefined ? {} : { text: String(args.text) }) });
							audit("browser_dom_click", { ok: result.ok === true, how: "cdp" });
							return { schemaVersion: SCHEMA_VERSION, ok: result.ok === true, backend: "cdp", ...(result.how ? { how: `cdp:${String(result.how)}` } : {}), ...(result.reason && result.ok !== true ? { reason: String(result.reason) } : {}) };
						} catch (cdpError) {
							return { schemaVersion: SCHEMA_VERSION, ok: false, backend: "cdp", error: `${error instanceof Error ? error.message : String(error)}; CDP fallback failed: ${cdpError instanceof Error ? cdpError.message : String(cdpError)}` };
						}
					}
					return { schemaVersion: SCHEMA_VERSION, ok: false, error: error instanceof Error ? error.message : String(error) };
				}
			}
		})
	);

	register(
		defineTool({
			name: "browser_dom_fill",
			description:
				"Fill one form field in the frontmost browser tab (native setter + input/change events, works with React/Vue). Password fields (type=password) are refused; values are never logged or echoed back.",
			parameters: {
				browser: { type: "string", description: "Browser app name: Google Chrome (default) or Safari." },
				selector: { type: "string", required: true, description: "CSS selector of the input/textarea/select." },
				value: { type: "string", required: true, description: "Text to type into the field." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						ok: { type: "boolean", required: true },
						backend: { type: "string" },
						valueLength: { type: "integer" },
						reason: { type: "string" },
						error: { type: "string" }
					}
				},
				render: (_args, value) =>
					[{
						type: "text",
						text: value.ok === true ? `Filled field (${String(value.valueLength)} chars)` : `DOM fill failed: ${String(value.error ?? value.reason ?? "unknown error")}`
					}]
			},
			isConcurrencySafe: () => false,
			presentCall: () => ({ title: "Fill DOM field", detail: "browser form field" }),
			async execute(args, exec) {
				exec.signal.throwIfAborted();
				try {
					const result = await fillDom({
						browser: String(args.browser ?? "Google Chrome"),
						selector: String(args.selector ?? ""),
						value: String(args.value ?? ""),
						...browserRunner()
					});
					audit("browser_dom_fill", { ok: result.ok === true, valueLength: Number(result.valueLength ?? 0) });
					return {
						schemaVersion: SCHEMA_VERSION,
						ok: result.ok === true,
						backend: "applescript",
						...(Number.isInteger(result.valueLength) ? { valueLength: result.valueLength } : {}),
						...(result.reason && result.ok !== true ? { reason: String(result.reason) } : {})
					};
				} catch (error) {
					const port = Number(config?.browserCdpPort ?? 0);
					if (port > 0) {
						try {
							const result = await internals.cdpFill({ port, selector: String(args.selector ?? ""), value: String(args.value ?? "") });
							audit("browser_dom_fill", { ok: result.ok === true, valueLength: Number(result.valueLength ?? 0), backend: "cdp" });
							return { schemaVersion: SCHEMA_VERSION, ok: result.ok === true, backend: "cdp", ...(Number.isInteger(result.valueLength) ? { valueLength: result.valueLength } : {}), ...(result.reason && result.ok !== true ? { reason: String(result.reason) } : {}) };
						} catch (cdpError) {
							return { schemaVersion: SCHEMA_VERSION, ok: false, backend: "cdp", error: `${error instanceof Error ? error.message : String(error)}; CDP fallback failed: ${cdpError instanceof Error ? cdpError.message : String(cdpError)}` };
						}
					}
					return { schemaVersion: SCHEMA_VERSION, ok: false, error: error instanceof Error ? error.message : String(error) };
				}
			}
		})
	);


	register(
		defineTool({
			name: "browser_dom_probe",
			description:
				"Check the browser automation channels before relying on them: AppleScript JavaScript channel state (Chrome/Safari) and the CDP debugging endpoint (requires browserCdpPort set in plugin config and Chrome started with --remote-debugging-port). Read-only.",
			parameters: {
				browser: { type: "string", description: "Browser app name for the AppleScript probe (default Google Chrome)." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						ok: { type: "boolean", required: true },
						browserCdpPort: { type: "integer", required: true },
						applescript: {
							type: "object",
							required: true,
							additionalProperties: false,
							properties: {
								available: { type: "boolean", required: true },
								reason: { type: "string" },
								hint: { type: "string" },
								error: { type: "string" }
							}
						},
						cdp: {
							type: "object",
							required: true,
							additionalProperties: false,
							properties: {
								available: { type: "boolean", required: true },
								reason: { type: "string", required: true },
								browser: { type: "string" },
								hint: { type: "string" }
							}
						}
					}
				},
				render: (_args, value) =>
					[{
						type: "text",
						text: `Browser channels — AppleScript: ${value.applescript.available ? "ready" : `unavailable (${String(value.applescript.reason ?? "unknown")})`}; CDP: ${value.cdp.available ? `ready (${String(value.cdp.browser ?? "CDP")})` : `unavailable (${String(value.cdp.reason)})`}${value.browserCdpPort > 0 ? "" : " [browserCdpPort=0, CDP disabled]"}; config browserCdpPort=${value.browserCdpPort}`
					}]
			},
			isConcurrencySafe: () => true,
			presentCall: (args) => presentCall("Probe browser channels", args),
			async execute(args, exec) {
				exec.signal.throwIfAborted();
				const browser = String(args.browser ?? "Google Chrome");
				let applescript = { available: false, reason: "unknown" };
				try {
					const probe = await probeAppleScriptDom({ browser, ...browserRunner() });
					applescript = { available: probe.available === true, ...(probe.reason ? { reason: String(probe.reason) } : {}), ...(probe.hint ? { hint: String(probe.hint) } : {}) };
				} catch (error) {
					applescript = { available: false, reason: "error", error: error instanceof Error ? error.message : String(error) };
				}
				const port = Number(config?.browserCdpPort ?? 0);
				let cdp = { available: false, reason: "no-port" };
				if (port > 0) {
					try {
						const probe = await internals.cdpProbe({ port });
						cdp = { available: probe.available === true, reason: String(probe.reason ?? "unknown"), ...(probe.browser ? { browser: String(probe.browser) } : {}), ...(probe.hint ? { hint: String(probe.hint) } : {}) };
					} catch (error) {
						cdp = { available: false, reason: "error", hint: error instanceof Error ? error.message : String(error) };
					}
				}
				return { schemaVersion: SCHEMA_VERSION, ok: applescript.available === true || cdp.available === true, browserCdpPort: port, applescript, cdp };
			}
		})
	);


	register(
		defineTool({
			name: "task_profile",
			description:
				"Classify a desktop-automation goal into simple / standard / complex and return the recommended operating profile (step budget, plan-first, per-step verification, batching). Read-only; call it before long multi-app tasks to decide whether to write a plan.",
			parameters: {
				goal: { type: "string", required: true, description: "The user task in one sentence." },
				hint: { type: "string", description: "Force a tier: simple | standard | complex." },
				estSteps: { type: "integer", description: "Optional estimate of GUI steps." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						text: { type: "string", required: true },
						tier: { type: "string", required: true },
						maxSteps: { type: "integer" },
						requirePlan: { type: "boolean" },
						verifyAfterEach: { type: "boolean" },
						allowBatch: { type: "boolean" },
						matched: { type: "array", items: { type: "string" } },
						// 0.70.0：建议的计划模板，可直接传给 plan_create { template }
						suggestedTemplate: { type: "string" }
					}
				},
				render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
			},
			isConcurrencySafe: () => true,
			presentCall: (args) => presentCall("Classify task", args),
			async execute(args) {
				const result = classifyTask(String(args.goal ?? ""), { hint: args.hint, estSteps: args.estSteps });
				const profile = result.profile;
				const templateHint = typeof result.suggestedTemplate === "string" ? ` 建议模板：plan_create { template: "${result.suggestedTemplate}" }。` : "";
				const text = `task_profile: ${result.tier} (${result.reason}) → maxSteps ${profile.maxSteps}, plan-first ${profile.requirePlan === true ? "yes" : "no"}, per-step verify ${profile.verifyAfterEach === true ? "yes" : "no"}, batch ${profile.allowBatch === true ? "yes" : "no"}. ${profile.note}${templateHint}`;
				return {
					schemaVersion: SCHEMA_VERSION,
					text,
					tier: result.tier,
					maxSteps: profile.maxSteps,
					requirePlan: profile.requirePlan,
					verifyAfterEach: profile.verifyAfterEach,
					allowBatch: profile.allowBatch,
					matched: result.matched,
					...(typeof result.suggestedTemplate === "string" ? { suggestedTemplate: result.suggestedTemplate } : {})
				};
			}
		})
	);

	register(
		defineTool({
			name: "plan_create",
			description:
				"Create a task plan (goal + ordered tool steps) in ~/.dsh/dsh-operator/plans/<id>.json so a long multi-app task can be resumed across turns/sessions. Args are stored as plain JSON; sensitive-looking keys are rejected. Use plan_update to advance step status.",
			parameters: {
				goal: { type: "string", required: true, description: "Plan goal (>=4 chars)." },
				steps: {
					type: "array",
					required: true,
					description: "Ordered steps (1-60). Each step is {id, tool, args?, verify?, expect?}. Example: {id:\"open-finder\", tool:\"open_in_finder\", args:{path:\"~/Desktop\"}, verify:{kind:\"frontmost_app\", contains:\"Finder\"}}.",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: { type: "string", required: true, description: "kebab-case step id, unique." },
							tool: { type: "string", required: true },
							args: { type: "object", additionalProperties: true },
							verify: { type: "object", additionalProperties: true, description: "Extra verify_state predicate run after this step." },
							expect: { type: "object", additionalProperties: true, description: "Assertions on this step's result text: {contains, absent}." }
						}
					}
				},
				template: { type: "string", description: "Optional guard template: observe-only / verify-around / cross-app. Wraps your steps with observe/verify steps." },
				tier: { type: "string", description: "Optional tier from task_profile." },
				note: { type: "string" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						ok: { type: "boolean", required: true },
						id: { type: "string" },
						stepCount: { type: "integer" },
						text: { type: "string" },
						error: { type: "string" }
					}
				},
				render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
			},
			isConcurrencySafe: () => false,
			presentCall: (args) => presentCall("Create plan", args),
			async execute(args, exec) {
				exec.signal.throwIfAborted();
				try {
					const baseSteps = Array.isArray(args.steps) ? args.steps : [];
					// 0.70.0：按模板加「先观察、后校验」护栏（模板不替你想业务动作）
					const templated = applyTemplate(String(args.template ?? ""), baseSteps);
					const created = createPlan({
						goal: String(args.goal ?? ""),
						steps: templated.steps,
						...(args.tier === undefined ? {} : { tier: args.tier }),
						...(args.note === undefined ? {} : { note: args.note })
					});
					audit("plan_create", { id: created.id, steps: created.plan.steps.length });
					const templateNote = templated.applied.length === 0 ? "" : ` (template ${templated.applied.join("+")})`;
					// 0.114.0：模板只加观察步、不带断言——别让「有 auto-verify 步骤」被误读成「验过了」
					const assertedCount = created.plan.steps.filter((step) => step.expect !== undefined || step.verify !== undefined).length;
					const assertNote = templated.applied.length === 0 || assertedCount > 0
						? ""
						: `\n⚠️ 模板只加了观察步（${templated.applied.join("+")}），它们不带断言——关键步骤请补 expect/verify，否则 done 只代表动作执行完`;
					// 0.84.1：别再建议手工标 running——执行器不写 running，标了反而会被当成待办重跑
					const text = `plan ${created.id}: ${created.plan.steps.length} steps${templateNote}, tier ${String(created.plan.tier ?? "unset")}, asserted ${String(assertedCount)}/${String(created.plan.steps.length)}. Next: plan_run {id:"${created.id}"}（它会按顺序执行 pending 步骤并推进状态）；要跳过/改某一步用 plan_update。${assertNote}`;
					return { schemaVersion: SCHEMA_VERSION, ok: true, id: created.id, stepCount: created.plan.steps.length, text };
				} catch (error) {
					audit("plan_create_failed", { error: error instanceof Error ? error.message : String(error) });
					return { schemaVersion: SCHEMA_VERSION, ok: false, text: `plan_create failed: ${error instanceof Error ? error.message : String(error)}`, error: error instanceof Error ? error.message : String(error) };
				}
			}
		})
	);

	register(
		defineTool({
			name: "plan_update",
			description:
				"Advance one step of a saved plan (status: pending|running|done|failed|skipped) and return the plan summary (counts + next pending step). Failed steps make the whole plan failed; use it to keep long tasks auditable. Example: plan_update {id:\"plan-20261106-1200\", stepId:\"open-finder\", status:\"done\", note:\"window opened\"}.",
			parameters: {
				id: { type: "string", required: true, description: "Plan id from plan_create or listPlans." },
				stepId: { type: "string", required: true, description: "Step id inside the plan." },
				status: { type: "string", required: true, description: "pending | running | done | failed | skipped." },
				note: { type: "string" }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						ok: { type: "boolean", required: true },
						text: { type: "string" },
						planStatus: { type: "string" },
						counts: {
							type: "object",
							additionalProperties: false,
							properties: {
								pending: { type: "integer" },
								running: { type: "integer" },
								done: { type: "integer" },
								failed: { type: "integer" },
								skipped: { type: "integer" }
							}
						},
						nextStep: { type: "string" },
						error: { type: "string" }
					}
				},
				render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
			},
			isConcurrencySafe: () => false,
			presentCall: (args) => presentCall("Update plan step", args),
			async execute(args, exec) {
				exec.signal.throwIfAborted();
				try {
					const updated = updatePlan(String(args.id ?? ""), { stepId: String(args.stepId ?? ""), status: String(args.status ?? ""), ...(args.note === undefined ? {} : { note: args.note }) });
					const summary = updated.summary;
					audit("plan_update", { id: summary.id, status: String(args.status), planStatus: summary.status });
					const text = `plan ${summary.id}: ${summary.status} — done ${summary.counts.done}/${Object.values(summary.counts).reduce((a, b) => a + b, 0)}${summary.nextStep ? `, next ${summary.nextStep}` : ", no pending steps"}`;
					return { schemaVersion: SCHEMA_VERSION, ok: true, text, planStatus: summary.status, counts: summary.counts, ...(summary.nextStep === null ? {} : { nextStep: summary.nextStep }) };
				} catch (error) {
					audit("plan_update_failed", { error: error instanceof Error ? error.message : String(error) });
					return { schemaVersion: SCHEMA_VERSION, ok: false, text: `plan_update failed: ${error instanceof Error ? error.message : String(error)}`, error: error instanceof Error ? error.message : String(error) };
				}
			}
		})
	);


	register(
		defineTool({
			name: "skill_run",
			description:
				"Replay a saved skill (ordered tool calls from the local skill library). Besides this plugin's extended tools it can replay host GUI actions (click / input_text / hotkey / scroll / drag / wait …) which is usually what a recorded sequence contains; stops on first failure unless stopOnError:false. Use dryRun to validate a skill without side effects.",
			parameters: {
				name: { type: "string", required: true, description: "kebab-case skill name." },
				args: { type: "object", additionalProperties: true, description: "Values for the skill's {{placeholders}}; a missing one aborts before any step runs." },
				dryRun: { type: "boolean", description: "Validate only; do not execute." },
				stopOnError: { type: "boolean", description: "Stop at first failure (default true)." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						ok: { type: "boolean", required: true },
						text: { type: "string", required: true },
						executed: { type: "integer" },
						failed: { type: "integer" },
						skipped: { type: "integer" },
						steps: { type: "integer", description: "Steps actually run in this attempt." },
						baseline: { type: "integer", description: "First successful run's step count." },
						deltaPercent: { type: "integer", description: "Change vs the baseline, in percent." },
						targetMet: { type: "boolean", description: "True when this run used at most half the baseline steps." },
						results: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									id: { type: "string" },
									tool: { type: "string" },
									status: { type: "string" },
									error: { type: "string" },
									summary: { type: "string" }
								}
							}
						},
						error: { type: "string" }
					}
				},
				render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
			},
			isConcurrencySafe: () => false,
			presentCall: (args) => presentCall("Run skill steps", args),
			async execute(args, exec) {
				try {
					const skill = readSkill(String(args.name ?? ""));
					// 0.66.0：先填 {{变量}}；缺参数就在执行任何一步之前报清楚
					const declared = Array.isArray(skill.variables) && skill.variables.length > 0 ? skill.variables : collectVariables(skill.steps ?? []);
					const prepared = applySkillArgs(skill.steps ?? [], args.args ?? {});
					if (prepared.missing.length > 0) {
						const declaredText = declared.length > 0 ? declared.join(", ") : "(none)";
						audit("skill_run_failed", { name: skill.name, error: "missing_args", missing: prepared.missing });
						return {
							schemaVersion: SCHEMA_VERSION,
							ok: false,
							text: `skill ${skill.name} 缺少参数：${prepared.missing.join(", ")}（该技能参数：${declaredText}）；用 skill_run { name, args: { … } } 传入`,
							executed: 0,
							failed: 0,
							skipped: 0,
							results: [],
							error: `missing_args: ${prepared.missing.join(",")}`
						};
					}
					const fork = forkSteps();
					const allowed = new Set([...handlers.keys(), ...fork.keys()].filter((name) => name !== "skill_run" && name !== "plan_run"));
					// 0.67.0：工具名漂移时，在动第一步之前就报清楚，别等第 3 步才炸
					const pre = preflightSkill(prepared.steps, allowed);
					if (pre.ok === false) {
						audit("skill_run_failed", { name: skill.name, error: "unsupported_tool", problems: pre.problems.length });
						return {
							schemaVersion: SCHEMA_VERSION,
							ok: false,
							text: describePreflight(pre.problems),
							executed: 0,
							failed: 0,
							skipped: 0,
							results: [],
							error: "unsupported_tool"
						};
					}
					// 0.75.0：步骤级校验——expect 断言回包文本，verify 额外跑一次 verify_state
					const afterStep = async ({ step, summary, text }) => {
						// 0.78.0：优先断言渲染文案（用户看到的那句话），没有再退回字段摘要
						const expectVerdict = evaluateExpect(step?.expect, text ?? summary);
						if (expectVerdict.ok === false) return expectVerdict;
						if (step?.verify !== undefined) {
							const checker = handlers.get("verify_state");
							if (checker === undefined) return { ok: false, reason: "verify 需要 verify_state 工具（当前环境未注册）" };
							const value = await checker.execute(step.verify, { signal: exec.signal });
							if (value?.satisfied !== true) {
								return { ok: false, reason: `verify 未通过（${String(step.verify.kind)}）：${String(value?.observed ?? "")}`.slice(0, 260) };
							}
						}
						return { ok: true };
					};
					const run = await executeSteps(prepared.steps, {
						handlers,
						fallback: fork,
						allowedTools: allowed,
						signal: exec.signal,
						stopOnError: args.stopOnError !== false,
						dryRun: args.dryRun === true,
						afterStep,
						// 0.76.0：GUI 步骤需要调用者 agent 才能解析模型路由
						// 0.82.0：replay 标记——回放不再把自己喂进技能候选
						stepContext: { ...(exec?.agent === undefined ? {} : { agent: exec.agent }), replay: true }
					});
					audit("skill_run", { name: skill.name, executed: run.executed, failed: run.failed, dryRun: args.dryRun === true });
					// 0.67.0：非 dryRun 才记步数基线（dryRun 没有真实执行）
					let comparison = "";
					let stats = null;
					if (args.dryRun !== true) {
						// 0.82.0：统计写失败（盘满/权限）不该把已完成的回放判成失败
						try {
							stats = recordSkillRun(skill.name, { steps: run.executed, ok: run.ok });
							comparison = ` · ${describeRun(stats)}`;
						} catch (statsError) {
							comparison = ` · 统计未记录：${statsError instanceof Error ? statsError.message : String(statsError)}`;
						}
					}
					return {
						schemaVersion: SCHEMA_VERSION,
						ok: run.ok,
						text: `skill ${skill.name}: ${summarizeResults(run)}${comparison}`,
						executed: run.executed,
						failed: run.failed,
						skipped: run.skipped,
						...(stats === null ? {} : { steps: stats.last, baseline: stats.first, deltaPercent: stats.deltaPercent, targetMet: stats.targetMet }),
						results: run.results
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					audit("skill_run_failed", { error: message });
					return { schemaVersion: SCHEMA_VERSION, ok: false, text: `skill_run failed: ${message}`, executed: 0, failed: 0, skipped: 0, results: [], error: message };
				}
			}
		})
	);

	register(
		defineTool({
			name: "plan_run",
			description:
				"Execute a saved plan's pending steps through the shared tool table (extended tools plus the base GUI/browser tools such as click, hotkey, browser_open), advancing statuses pending→running→done/failed in ~/.dsh/dsh-operator/plans. Stops on first failure; steps after the failure stay pending so a later run can continue. A plan-level lock blocks concurrent runs of the same plan, and a status write-back failure makes the call fail. Only `pending` steps are executed (a `running` status means claimed elsewhere, not execute-me) — except that a `running` step left behind by a crashed run (lock is free) is rolled back to pending and re-run, named in `resumedFrom`; an aborted step is rolled back to pending too. Use dryRun to preview.",
			parameters: {
				id: { type: "string", required: true, description: "Plan id." },
				dryRun: { type: "boolean", description: "Preview only; do not execute or write statuses." },
				stopOnError: { type: "boolean", description: "Stop at first failure (default true)." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						ok: { type: "boolean", required: true },
						text: { type: "string", required: true },
						executed: { type: "integer" },
						failed: { type: "integer" },
						skipped: { type: "integer" },
						planStatus: { type: "string" },
						totalSteps: { type: "integer" },
						doneSteps: { type: "integer" },
						// 0.114.0：有 expect/verify 的步数（0 表示「只是执行完，没验过」）
						assertedSteps: { type: "integer" },
						nextStep: { type: "string" },
						// 0.113.0：续跑时点名上次中断在哪一步（`` 表示没有中断残留）
						resumedFrom: { type: "string" },
						results: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									id: { type: "string" },
									tool: { type: "string" },
									status: { type: "string" },
									error: { type: "string" },
									summary: { type: "string" }
								}
							}
						},
						error: { type: "string" }
					}
				},
				render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
			},
			isConcurrencySafe: () => false,
			presentCall: (args) => presentCall("Run plan steps", args),
			async execute(args, exec) {
				try {
					const id = String(args.id ?? "");
					const plan = readPlan(id);
					const dryRun = args.dryRun === true;
					// 0.84.0：口径与 planProgress 一致（缺 status 的旧计划也当待办）
					// 0.113.0：running 是上次执行中断的残留（锁空闲时会重置成 pending），本次要一起跑，
					// 否则中断在最后一步的计划会被当成「没有待执行步骤」直接跳过。
					const pending = (plan.steps ?? []).filter((step) => {
						const status = step.status ?? "pending";
						return status === "pending" || status === "running";
					});
					if (pending.length === 0) {
						// 0.84.0：计划已经是 failed 却没有待办步时，不能报 ok
						if (plan.status === "failed") {
							const summary = planSummary(plan);
							audit("plan_run", { id, executed: 0, failed: summary.counts.failed, dryRun, blocked: "failed-plan" });
							return { schemaVersion: SCHEMA_VERSION, ok: false, text: `plan ${id}: 没有待执行步骤，但计划状态是 failed（${String(summary.counts.done)}/${String(plan.steps.length)} done）——先 plan_update 或重建计划，别直接重跑`, executed: 0, failed: summary.counts.failed, skipped: 0, planStatus: plan.status, totalSteps: plan.steps.length, doneSteps: summary.counts.done, results: [], error: "plan is failed with no pending steps" };
						}
						const summary = planSummary(plan);
						audit("plan_run", { id, executed: 0, failed: 0, dryRun, skipped: true });
						return { schemaVersion: SCHEMA_VERSION, ok: true, text: `plan ${id}: no pending steps (${String(summary.counts.done)}/${String(plan.steps.length)} done, status ${plan.status})`, executed: 0, failed: 0, skipped: 0, planStatus: plan.status, totalSteps: plan.steps.length, doneSteps: summary.counts.done, results: [] };
					}
					const fork = forkSteps();
					// 0.84.0：preflight——未知工具在动手前就报出来，别执行一半才发现
					const resolvable = (name) => handlers.has(name) || fork.has(name);
					const unknown = pending.map((step) => String(step.tool ?? "")).filter((name) => name === "" || resolvable(name) === false || name === "skill_run" || name === "plan_run");
					if (unknown.length > 0) {
						throw new Error(`计划的待执行步骤里有不可用工具：${[...new Set(unknown)].join("、")}（先 plan_update 修正，别执行到一半才发现）`);
					}
					// 0.84.0：计划级锁——同一计划并发 plan_run 会重复执行同一步
					const lockPath = join(planDir(), `${id}.run.lock`);
					let lockFd = null;
					try {
						lockFd = openSync(lockPath, "wx");
					} catch (lockError) {
						if (lockError?.code === "EEXIST") {
							const stale = (() => { try { return Date.now() - statSync(lockPath).mtimeMs > 10 * 60 * 1000; } catch { return false; } })();
							if (stale === false) {
								audit("plan_run", { id, blocked: "locked" });
								return { schemaVersion: SCHEMA_VERSION, ok: false, text: `plan ${id}: 已有 plan_run 在执行中（锁文件 ${lockPath}）——等它结束再跑，避免重复执行`, executed: 0, failed: 0, skipped: 0, planStatus: plan.status, totalSteps: plan.steps.length, doneSteps: 0, results: [], error: "plan is locked by another run" };
							}
							rmSync(lockPath, { force: true });
							lockFd = openSync(lockPath, "wx");
						} else {
							throw lockError;
						}
					}
					const statusWriteErrors = [];
					// 0.113.0：中断续跑——上次进程死在半路时，计划里会留下 running 步。
					// 锁已拿到说明没有别的 plan_run 在跑，这个 running 一定是残留 → 退回 pending 重跑该步。
					const resumedFrom = [];
					try {
						const stale = readPlan(id).steps.filter((step) => step.status === "running");
						for (const step of stale) {
							updatePlan(id, { stepId: step.id, status: "pending", note: "上次执行中断（running 残留），本次重跑" });
							resumedFrom.push(`${step.id}(${step.tool})`);
						}
					} catch (resumeError) {
						// 读不回来就按原样跑，别让续跑逻辑本身把 plan_run 弄挂
						statusWriteErrors.push(`resume: ${resumeError instanceof Error ? resumeError.message : String(resumeError)}`);
					}
					if (resumedFrom.length > 0) audit("plan_run_resume", { id, from: resumedFrom });
					// 0.77.0：计划步骤同样支持 expect / verify（与技能共用一套口径）
					const planAfterStep = async ({ step, summary, text }) => {
						const verdict = evaluateExpect(step?.expect, text ?? summary);
						if (verdict.ok === false) return verdict;
						if (step?.verify !== undefined) {
							const checker = handlers.get("verify_state");
							if (checker === undefined) return { ok: false, reason: "verify 需要 verify_state 工具（当前环境未注册）" };
							const value = await checker.execute(step.verify, { signal: exec.signal });
							if (value?.satisfied !== true) {
								return { ok: false, reason: `verify 未通过（${String(step.verify.kind)}）：${String(value?.observed ?? "")}`.slice(0, 260) };
							}
						}
						return { ok: true };
					};
					const run = await executeSteps(pending, {
						handlers,
						fallback: fork,
						stepContext: { ...(exec?.agent === undefined ? {} : { agent: exec.agent }), replay: true },
						afterStep: planAfterStep,
						allowedTools: new Set([...handlers.keys(), ...fork.keys()].filter((name) => name !== "skill_run" && name !== "plan_run")),
						signal: exec.signal,
						stopOnError: args.stopOnError !== false,
						dryRun,
						onStep: ({ id: stepId, status, error }) => {
							if (dryRun) return;
							// 0.84.0：失败后剩余步保持 pending（之前落成 skipped 就永久消耗，无法续跑）
							if (status === "skipped") return;
							// 0.113.0：开始执行就落 running，中断后计划里能看出停在哪一步
							if (status === "running") {
								try {
									updatePlan(id, { stepId, status: "running" });
								} catch (planError) {
									statusWriteErrors.push(`${stepId}: ${planError instanceof Error ? planError.message : String(planError)}`);
								}
								return;
							}
							// 0.113.0：中断回退——把刚落的 running 退回 pending，别让计划卡死
							if (status === "pending") {
								try {
									updatePlan(id, { stepId, status: "pending", note: "执行被中断，已退回待执行" });
								} catch (planError) {
									statusWriteErrors.push(`${stepId}: ${planError instanceof Error ? planError.message : String(planError)}`);
								}
								return;
							}
							const mapped = status === "ok" ? "done" : "failed";
							try {
								updatePlan(id, { stepId, status: mapped, ...(error === undefined ? {} : { note: error }) });
							} catch (planError) {
								// 0.82.0：状态没推进会让下次 plan_run 重放已执行的步，必须让它可见
								statusWriteErrors.push(`${stepId}: ${planError instanceof Error ? planError.message : String(planError)}`);
							}
						}
					});
					closeSync(lockFd);
					rmSync(lockPath, { force: true });
					lockFd = null;
					// 0.113.0：兜底——正常路径每步都有终态；万一哪条异常分支漏了回调，
					// 也别把计划卡在「永远正在跑」，下次 plan_run 会被挡在门外。
					try {
						const leftover = readPlan(id).steps.filter((step) => step.status === "running");
						for (const step of leftover) {
							updatePlan(id, { stepId: step.id, status: "pending", note: "执行结束仍有 running 残留，已退回待执行" });
						}
						if (leftover.length > 0) audit("plan_run_leftover_running", { id, steps: leftover.map((step) => step.id) });
					} catch {
						// 收尾清理失败不影响本次回包
					}
					const finalPlan = readPlan(id);
					const progress = planSummary(finalPlan);
					audit("plan_run", { id, executed: run.executed, failed: run.failed, dryRun, statusWriteErrors: statusWriteErrors.length });
					return {
						schemaVersion: SCHEMA_VERSION,
						// 0.84.0：状态没写回就等于没跑完，不能报 ok
						ok: run.ok && statusWriteErrors.length === 0,
						text: `plan ${id}: ${summarizeResults(run)} — ${String(progress.counts.done)}/${String(finalPlan.steps.length)} done, status ${finalPlan.status}, asserted ${String(progress.asserted)}/${String(finalPlan.steps.length)}${progress.nextStep === null ? "" : `, next ${progress.nextStep}${progress.nextTool === null ? "" : ` (${progress.nextTool})`}`}${resumedFrom.length === 0 ? "" : `\n⚠️ 上次执行中断在 ${resumedFrom.join("、")}，本次已重跑`}${statusWriteErrors.length === 0 ? "" : `\n⚠️ 计划状态有 ${String(statusWriteErrors.length)} 处未写回（${statusWriteErrors.slice(0, 2).join("；")}）——重跑前先确认，避免重复执行`}${finalPlan.status === "done" && progress.asserted === 0 ? "\n⚠️ 本计划没有任何 expect/verify 断言——done 只代表动作执行完，不代表结果已验证" : ""}${run.ok === true && candidateCount(sessionKeyOf(exec)) >= 3 ? `\n提示：本次执行可沉淀为技能——skill_suggest 看看草案` : ""}`,
						executed: run.executed,
						failed: run.failed,
						skipped: run.skipped,
						planStatus: finalPlan.status,
						totalSteps: finalPlan.steps.length,
						doneSteps: progress.counts.done,
						// 0.114.0：断言覆盖——doneSteps 包含没有断言的步，别把两者混谈
						assertedSteps: progress.asserted,
						...(progress.nextStep === null ? {} : { nextStep: progress.nextStep }),
						resumedFrom: resumedFrom.join(", "),
						results: run.results
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					audit("plan_run_failed", { error: message });
					return { schemaVersion: SCHEMA_VERSION, ok: false, text: `plan_run failed: ${message}`, executed: 0, failed: 0, skipped: 0, results: [], error: message };
				} finally {
					// 0.84.0：任何路径都要释放计划锁
					try {
						rmSync(join(planDir(), `${String(args?.id ?? "")}.run.lock`), { force: true });
					} catch {
						// 锁已不在
					}
				}
			}
		})
	);


	register(
		defineTool({
			name: "plan_delete",
			description:
				"Delete a saved plan by id from ~/.dsh/dsh-operator/plans. Irreversible; use plan_list to find the id first.",
			parameters: {
				id: { type: "string", required: true, description: "Plan id from plan_list." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						text: { type: "string", required: true },
						ok: { type: "boolean" },
						id: { type: "string" },
						error: { type: "string" }
					}
				},
				render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
			},
			isConcurrencySafe: () => false,
			presentCall: (args) => presentCall("Delete plan", args),
			async execute(args) {
				const id = String(args.id ?? "");
				try {
					// 0.84.0：不存在时不能谎报删除成功（拼错 id 也要报）
					const removed = deletePlan(id);
					audit("plan_delete", { id, removed });
					return removed
						? { schemaVersion: SCHEMA_VERSION, ok: true, id, text: `plan ${id} deleted` }
						: { schemaVersion: SCHEMA_VERSION, ok: false, id, text: `plan ${id} not found（没有删除任何文件）`, error: "plan not found" };
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					audit("plan_delete_failed", { id, error: message });
					return { schemaVersion: SCHEMA_VERSION, ok: false, id, text: `plan_delete failed: ${message}`, error: message };
				}
			}
		})
	);


	register(
		defineTool({
			name: "plan_list",
			description:
				"List saved task plans (id, goal, plan status, done/total steps, updatedAt) from ~/.dsh/dsh-operator/plans. Read-only; use it to resume a long task or find a plan id for plan_run.",
			parameters: {
				limit: { type: "integer", description: "Max plans to list (default 20)." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						text: { type: "string", required: true },
						count: { type: "integer" },
						plans: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									id: { type: "string" },
									goal: { type: "string" },
									status: { type: "string" },
									done: { type: "integer" },
									total: { type: "integer" },
									// 0.113.0：中断后停在哪一步（没有 running 步时为空串）
									runningStep: { type: "string" },
									updatedAt: { type: "string" }
								}
							}
						}
					}
				},
				render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
			},
			isConcurrencySafe: () => true,
			presentCall: (args) => presentCall("List plans", args),
			async execute(args) {
				// 0.85.0：坏计划文件不再无声消失；goal 回包也截断，避免超长文本进上下文
				const { plans, corrupt } = readPlans({ limit: Number(args.limit ?? 20) });
				const rows = plans.map((plan) => {
					const summary = planSummary(plan);
					const total = Object.values(summary.counts).reduce((a, b) => a + b, 0);
					return { id: String(plan.id ?? summary.id), goal: String(plan.goal ?? "").slice(0, 200), status: String(summary.status ?? "pending"), done: summary.counts.done, total, runningStep: summary.runningStep === null ? "" : String(summary.runningStep), updatedAt: String(summary.updatedAt ?? "") };
				});
				const base = rows.length === 0
					? "plans: none (use plan_create)"
					: ["plans:", ...rows.map((row) => `${row.id}\t${row.status}${row.runningStep === "" ? "" : `@${row.runningStep}`}\t${row.done}/${row.total}\t${row.goal.slice(0, 60)}`)].join("\n");
				const text = corrupt === 0 ? base : `${base}\n⚠️ 有 ${String(corrupt)} 个计划文件解析失败（已跳过）——检查 ~/.dsh/dsh-operator/plans 下的 .json`;
				return { schemaVersion: SCHEMA_VERSION, text, count: rows.length, plans: rows };
			}
		})
	);

	register(
		defineTool({
			name: "operator_status",
			description:
				"Show this plugin's runtime status: version, platform, configured limits (axMaxNodes/failureSamples/browserCdpPort), and counts of skills/plans/failure records/audit lines. Read-only; use it for self-diagnosis before reporting a bug.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						text: { type: "string", required: true },
						version: { type: "string" },
						platform: { type: "string" },
						platformVerified: { type: "boolean" },
						extendedToolsSupported: { type: "boolean" },
						seamProvider: { type: "string" },
						dataDir: { type: "string" },
						skills: { type: "integer" },
						plans: { type: "integer" },
						// 0.68.0：活跃计划数（带下一步的那一行也依赖它）
						activePlans: { type: "integer" },
						// 0.80.0：可提炼成技能的候选步数
						candidates: { type: "integer" },
						// 0.102.0：执行单元状态（queued/working/waiting-person/idle/ended）
						execution: { type: "string" },
						failureFiles: { type: "integer" },
						failureRecords: { type: "integer" },
						auditLines: { type: "integer" },
						auditBytes: { type: "integer" },
						axMaxNodes: { type: "integer" },
						failureSamples: { type: "boolean" },
						browserCdpPort: { type: "integer" }
					}
				},
				render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
			},
			isConcurrencySafe: () => true,
			presentCall: () => presentCall("Plugin status", {}),
			async execute(_args, exec) {
				const status = collectStatus({ config: config ?? {}, version: deps?.version ?? "unknown", installedVersion: installedPluginVersion(), browserTools: browserToolsStatus(), seamProvider: deps?.seamProvider });
				// 0.68.0：活跃计划那一行由 collectStatus 统一输出（用 planProgress 的口径）。
				// 这里只保留审计计数，避免出现两行 active plans（旧实现还会打出 undefined）。
				const activePlans = listPlans({ limit: 100 }).filter((plan) => plan.status !== "done" && plan.status !== "failed");
				const candidates = candidateCount(sessionKeyOf(exec));
				audit("operator_status", { skills: status.skills, plans: status.plans, failures: status.failureRecords, activePlans: activePlans.length, candidates });
				// 0.80.0：候选不主动提示就等于没人用——顺手把它摆出来
				const hint = candidates >= 2 ? `\ncandidates: ${String(candidates)} 步可提技能（skill_suggest）` : "";
				// 0.102.0（P2）：执行单元状态一行——「现在卡在谁身上」不用翻日志
				const execution = executionLineOf(ctx, exec);
				return { schemaVersion: SCHEMA_VERSION, ...status, candidates, execution, text: `${String(status.text)}${hint}\n${execution}` };
			}
		})
	);

	register(
		defineTool({
			name: "failure_list",
			description:
				"List sanitized failure samples from ~/.dsh/dsh-operator/failures (JSONL). Read-only: returns totals, grouped by kind/tool, recent records (tool, kind, message, timestamp) and a short hint per kind. No user text/screenshots are stored — args only keep lengths. Use it after repeated action failures to decide the next approach.",
			parameters: {
				limit: { type: "integer", description: "Max recent records to return (1-50, default 10)." },
				digest: { type: "boolean", default: true, description: "Include grouped by-kind/by-tool counts." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						text: { type: "string", required: true },
						total: { type: "integer" },
						dir: { type: "string" },
						byKind: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: { key: { type: "string" }, count: { type: "integer" } }
							}
						},
						byApp: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: { key: { type: "string" }, count: { type: "integer" } }
							}
						},
						byTool: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: { key: { type: "string" }, count: { type: "integer" } }
							}
						},
						hot: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: { key: { type: "string" }, count: { type: "integer" } }
							}
						},
						recent: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									t: { type: "string" },
									tool: { type: "string" },
									kind: { type: "string" },
									message: { type: "string" }
								}
							}
						}
					}
				},
				render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
			},
			isConcurrencySafe: () => true,
			presentCall: (args) => presentCall("List failures", args),
			async execute(args) {
				const dir = failureDir();
				const limit = Math.min(50, Math.max(1, Number(args.limit ?? 10) || 10));
				const digest = args.digest === false ? null : digestFailures({ dir, top: 5, recent: limit });
				const recent = digest === null ? digestFailures({ dir, recent: limit }).recent : digest.recent;
				const total = digest === null ? digestFailures({ dir, recent: 0 }).total : digest.total;
				const pairRows = (pairs) => pairs.map(([key, count]) => ({ key, count }));
				const byKind = digest === null ? [] : pairRows(digest.byKind);
				const byTool = digest === null ? [] : pairRows(digest.byTool);
				const hot = digest === null || Array.isArray(digest.byPair) === false ? [] : pairRows(digest.byPair);
				const byApp = digest === null || Array.isArray(digest.byApp) === false ? [] : pairRows(digest.byApp);
				const hints = {
					guard_rejected: "guard 拦下是预期行为；确需执行时显式传 confirm:true",
					timeout: "状态没到位：改用 verify_state 轮询或增大 settle/timeout",
					unavailable: "能力不可用：检查屏幕录制/辅助功能授权、浏览器通道开关",
					not_found: "目标找不到：坐标或 AX index 可能过期，重新观察后再操作",
					cancelled: "操作被取消，确认是否误触 Esc/中断",
					error: "看 message 与 operator_status/doctor 输出定位"
				};
				const seen = new Set();
				const lines = [`failures: ${total} (${dir})`];
				if (total === 0) lines.push("（空——这是好事）");
				if (digest !== null && total > 0) {
					if (byKind.length > 0) lines.push(`by kind: ${byKind.map((row) => `${row.key}(${row.count})`).join(", ")}`);
					if (byTool.length > 0) lines.push(`by tool: ${byTool.map((row) => `${row.key}(${row.count})`).join(", ")}`);
					if (byApp.length > 0) lines.push(`by app: ${byApp.map((row) => `${row.key}(${row.count})`).join(", ")}`);
					if (hot.length > 0) lines.push(`hot: ${hot.map((row) => `${row.key}(${row.count})`).join(", ")}`);
					const repeats = hot.filter((row) => row.count >= 3);
					for (const row of repeats) {
						const kind = String(row.key).includes("·") ? String(row.key).split("·").pop() : "error";
						lines.push(`repeat: ${row.key} ×${String(row.count)} —— 别再用同样的参数重试；${hints[kind] ?? hints.error}`);
					}
				}
				if (recent.length > 0) {
					lines.push("recent:");
					for (const row of recent) {
						const kind = String(row.kind ?? "error");
						const tool = String(row.tool ?? "(unknown)");
						const time = String(row.t ?? "").replace("T", " ").slice(0, 19);
						const message = String(row.message ?? "").slice(0, 120);
						const appName = typeof row.app === "string" && row.app !== "" ? `  ${row.app}` : "";
						lines.push(`  ${time}  ${tool}  [${kind}]${appName}  ${message}`);
						if (hints[kind] !== undefined && seen.has(kind) === false) {
							seen.add(kind);
							lines.push(`    hint: ${hints[kind]}`);
						}
					}
				}
				const rows = recent.map((row) => ({
					t: String(row.t ?? ""),
					tool: String(row.tool ?? ""),
					kind: String(row.kind ?? "error"),
					message: String(row.message ?? "").slice(0, 180)
				}));
				audit("failure_list", { total, limit });
				return { schemaVersion: SCHEMA_VERSION, text: lines.join("\n"), total, dir, byKind, byTool, byApp, hot, recent: rows };
			}
		})
	);

	register(
		defineTool({
			name: "ax_batch",
			description:
				"Run 1-12 GUI actions in one tool call and stop at the first failure. Supported actions: AX (ax_press / ax_set_value / ax_menu / ax_scroll), fork (click / scroll / input / hotkey), and browser (browser_open / browser_click / browser_type, requires an active browser binding). Intermediate screenshots are discarded to save tokens; call it after one observation (cu_observe / AX snapshot) to replay a known sequence and reuse that observation instead of re-observing after each step.",
			parameters: {
				steps: {
					type: "array",
					description: "Ordered steps (1-12). Each step needs action plus that action's fields.",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							action: { type: "string", required: true, enum: ["ax_press", "ax_set_value", "ax_menu", "ax_scroll", "click", "double_click", "drag", "long_press", "scroll", "input", "hotkey", "wait", "browser_open", "browser_click", "browser_type"] },
							index: { type: "integer", description: "AX node index (ax_press / ax_set_value / optional container for ax_scroll)." },
							expect_role: { type: "string", description: "Expected AX role guard (ax_press)." },
							expect_title: { type: "string", description: "Expected AX title guard (ax_press)." },
							pid: { type: "integer", description: "Target process id for ax_* steps." },
							value: { type: "string", description: "New field value (ax_set_value)." },
							path: { type: "string", description: "Menu path like the ones ax_menu accepts." },
							direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction (ax_scroll / scroll)." },
							page: { type: "boolean", description: "Scroll a full page (ax_scroll / scroll)." },
							x: { type: "integer", description: "Click/scroll/input x fraction 0-1000 (click needs x+y)." },
							y: { type: "integer", description: "Click/scroll/input y fraction 0-1000 (click needs x+y)." },
							screen_index: { type: "integer", description: "Screen index for fork actions (default 0)." },
							text: { type: "string", description: "Text to type (input)." },
							keys: { type: "string", description: "Comma-separated key names for hotkey, e.g. \"cmd,shift,4\"." },
							submit: { type: "boolean", description: "Press Enter after typing (input)." },
							replace: { type: "boolean", description: "Select all before typing (input)." },
							scroll_level: { type: "integer", description: "Scroll magnitude 1-10 (scroll)." },
							to_x: { type: "integer", description: "Drag end x fraction 0-1000." },
							to_y: { type: "integer", description: "Drag end y fraction 0-1000." },
							duration_seconds: { type: "integer", description: "Hold duration 1-10 (long_press)." },
							seconds: { type: "integer", description: "How many 1-second waits (wait, 1-10)." },
							url: { type: "string", description: "URL for browser_open (http(s)/about)." },
							ref: { type: "string", description: "Browser element ref from browser_state (browser_click / browser_type)." },
							role: { type: "string", description: "Role filter when matching browser_click text." },
							match_index: { type: "integer", description: "0-based index among browser_click text matches." },
							button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button for browser_click (default left)." },
							confirm: { type: "boolean", description: "Pass true only after the user confirmed a destructive browser target." },
							mode: { type: "string", description: "browser_type mode: insert_text (default) or keystrokes." },
						}
					}
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						text: { type: "string", required: true },
						steps: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									index: { type: "integer" },
									action: { type: "string" },
									ok: { type: "boolean" },
									note: { type: "string" }
								}
							}
						},
						failedAt: { type: "integer" }
					}
				},
				render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
			},
			isConcurrencySafe: () => true,
			presentCall: (args) => presentCall("AX batch", args),
			async execute(args, exec) {
				const steps = Array.isArray(args?.steps) ? args.steps : [];
				// 0.121.7：单步也允许——模型经常只想复用「观察 + 一步」的批式路径，
				// 以前强制 2 步会浪费一次试错。
				if (steps.length < 1) throw new Error("ax_batch: steps 至少 1 步（空数组）；单步也可直接调 ax_press/ax_set_value/ax_menu/ax_scroll");
				if (steps.length > 12) throw new Error("ax_batch: steps 最多 12 步");
				const positionOf = (step) => (step.x === undefined || step.y === undefined ? undefined : [step.x, step.y]);
				const stripBatchFields = (step) => {
					const out = { ...step };
					for (const key of ["action", "x", "y", "text", "keys", "submit", "replace", "scroll_level", "to_x", "to_y", "duration_seconds", "seconds", "url", "ref", "role", "match_index", "button", "confirm", "mode"]) delete out[key];
					return out;
				};
				const specs = {
					ax_press: { tool: "ax_press", required: ["index"], build: stripBatchFields },
					ax_set_value: { tool: "ax_set_value", required: ["index", "value"], build: stripBatchFields },
					ax_menu: { tool: "ax_menu", required: ["path"], build: stripBatchFields },
					ax_scroll: { tool: "ax_scroll", required: [], build: stripBatchFields },
					click: {
						tool: "click",
						required: ["x", "y"],
						build: (step) => ({ screen_index: step.screen_index ?? 0, position: [step.x, step.y] })
					},
					scroll: {
						tool: "scroll",
						required: [],
						build: (step) => ({
							screen_index: step.screen_index ?? 0,
							...(positionOf(step) === undefined ? {} : { position: positionOf(step) }),
							direction: step.direction,
							...(step.scroll_level === undefined ? {} : { scroll_level: step.scroll_level }),
							...(step.page === undefined ? {} : { page: step.page })
						})
					},
					input: {
						tool: "input_text",
						required: ["text"],
						build: (step) => ({
							screen_index: step.screen_index ?? 0,
							...(positionOf(step) === undefined ? {} : { position: positionOf(step) }),
							text: step.text,
							...(step.submit === undefined ? {} : { submit: step.submit }),
							...(step.replace === undefined ? {} : { replace: step.replace })
						})
					},
					hotkey: {
						tool: "hotkey",
						required: ["keys"],
						build: (step) => ({ keys: String(step.keys).split(",").map((key) => key.trim()).filter((key) => key !== "") })
					},
					double_click: {
						tool: "click",
						required: ["x", "y"],
						build: (step) => ({ screen_index: step.screen_index ?? 0, position: [step.x, step.y], count: 2 })
					},
					drag: {
						tool: "drag",
						required: ["x", "y", "to_x", "to_y"],
						build: (step) => ({
							start_screen_index: step.screen_index ?? 0,
							start_position: [step.x, step.y],
							end_screen_index: step.screen_index ?? 0,
							end_position: [step.to_x, step.to_y]
						})
					},
					long_press: {
						tool: "long_press",
						required: ["x", "y"],
						build: (step) => ({
							screen_index: step.screen_index ?? 0,
							position: [step.x, step.y],
							...(step.duration_seconds === undefined ? {} : { duration_seconds: step.duration_seconds })
						})
					},
					wait: {
						tool: "wait",
						required: [],
						build: () => ({})
					},
					browser_open: {
						tool: "browser_open",
						required: ["url"],
						build: (step) => ({
							url: step.url,
							...(step.wait === undefined ? {} : { wait: step.wait })
						})
					},
					browser_click: {
						tool: "browser_click",
						required: [],
						build: (step) => ({
							...(step.ref === undefined ? {} : { ref: step.ref }),
							...(step.text === undefined ? {} : { text: step.text }),
							...(step.role === undefined ? {} : { role: step.role }),
							...(Number.isInteger(step.match_index) ? { index: step.match_index } : {}),
							...(step.button === undefined ? {} : { button: step.button }),
							...(step.confirm === undefined ? {} : { confirm: step.confirm })
						})
					},
					browser_type: {
						tool: "browser_type",
						required: ["ref", "text"],
						build: (step) => ({
							ref: step.ref,
							text: step.text,
							...(step.replace === undefined ? {} : { replace: step.replace }),
							...(step.mode === undefined ? {} : { mode: step.mode })
						})
					}
				};
				const defs = deps?.computerUseToolDefs;
				// 0.21.9：扩展 AX 工具注册在 handlers 里，fork 动作在 computerUseToolDefs 里；
				// 先查 handlers 再回退 fork 定义（0.21.8 只查后者，运行时 ax_* 会误报 not registered）。
				const resolveRun = (toolName) => {
					const entry = handlers.get(toolName) ?? defs?.get?.(toolName);
					if (entry === undefined) return undefined;
					if (typeof entry.execute === "function") return entry.execute;
					const definition = entry.definition;
					return typeof definition?.execute === "function" ? definition.execute : undefined;
				};
				const noteOf = (out) => {
					if (out === null || out === undefined) return "done";
					// 浏览器工具回的是 {schemaVersion, ok, text}；把 text 当步骤摘要，避免只显示 "ok"。
					if (typeof out.text === "string" && out.text.trim() !== "") {
						return out.text.trim().replace(/\s*\n\s*/g, " ").slice(0, 120);
					}
					if (typeof out.pressed === "boolean") {
						if (out.pressed === false) return "not pressed";
						return ["pressed", String(out.role ?? "").trim(), String(out.title ?? "").trim()].filter((part) => part !== "").join(" ");
					}
					if (typeof out.set === "boolean") return out.set ? "set" : "not set";
					if (typeof out.ok === "boolean") return out.ok ? "ok" : `error: ${String(out.error ?? "unknown")}`;
					if (typeof out.note === "string" && out.note !== "") return out.note.slice(0, 120);
					return "done";
				};
				const results = [];
				let failedAt;
				for (let i = 0; i < steps.length; i += 1) {
					const step = steps[i] ?? {};
					const action = String(step.action ?? "");
					const spec = specs[action];
					if (spec === undefined) {
						results.push({ index: i, action, ok: false, note: "unknown action" });
						failedAt = i;
						break;
					}
					const missing = spec.required.filter((key) => step[key] === undefined);
					if (missing.length > 0) {
						results.push({ index: i, action, ok: false, note: `missing ${missing.join(", ")}` });
						failedAt = i;
						break;
					}
					const run = resolveRun(spec.tool);
					if (typeof run !== "function") {
						results.push({ index: i, action, ok: false, note: `${spec.tool} not registered` });
						failedAt = i;
						break;
					}
					const stepArgs = spec.build === undefined ? stripBatchFields(step) : spec.build(step);
					const repeats = action === "wait" ? Math.max(1, Math.min(10, Number(step.seconds) || 1)) : 1;
					try {
						let out;
						for (let turn = 0; turn < repeats; turn += 1) out = await run(stepArgs, exec);
						const ok = out === null || out === undefined || (out.pressed !== false && out.ok !== false);
						results.push({ index: i, action, ok, note: noteOf(out) });
						if (!ok) {
							failedAt = i;
							break;
						}
					} catch (error) {
						results.push({ index: i, action, ok: false, note: String(error?.message ?? error).slice(0, 160) });
						failedAt = i;
						break;
					}
				}
				const okCount = results.filter((row) => row.ok).length;
				const lines = [`ax_batch: ${okCount}/${steps.length} ok${failedAt === undefined ? "" : ` (failed at step ${failedAt + 1})`}`];
				const failures = results.filter((row) => row.ok !== true);
				if (failures.length === 0) {
					lines.push(`  ok: 1-${results.length}`);
				} else {
					const failureIndexes = new Set(failures.map((row) => row.index + 1));
					const okIndexes = results.map((row) => row.index + 1).filter((index) => !failureIndexes.has(index));
					if (okIndexes.length > 0) lines.push(`  ok: ${okIndexes.join(", ")}`);
					for (const row of failures) {
						lines.push(`  ${row.index + 1}. ${row.action} FAILED${row.note === "" ? "" : ` — ${row.note}`}`);
					}
				}
				audit("ax_batch", { steps: steps.length, ok: okCount, failedAt: failedAt ?? null });
				const output = { schemaVersion: SCHEMA_VERSION, text: lines.join("\n"), steps: results };
				if (failedAt !== undefined) output.failedAt = failedAt;
				return output;
			}
		})
	);

	// 动作之后窗口信息可能变化：不缓存太久，交给下一次调用重新取。
	invalidateWindowCache();
	void backend;
	// 0.17：注册表统一。fork 侧工具在 applyComputerUse 里才注册，
	// 所以这里返回惰性构建器，等两侧都注册完再合成（见 registerV2Tools）。
	return {
		handlers,
		registerExtra: register,
		buildRegistry: () => mergeToolRegistries(handlers, deps?.computerUseToolDefs)
	};
}

/** v2 强工具 cu_observe 的 action → 旧工具名。 */
export const CU_OBSERVE_ACTIONS = {
	screenshot: "screenshot",
	windows: "list_windows",
	window_screenshot: "screenshot_window",
	zoom: "zoom_region",
	verify: "verify_state"
};

/** v2 强工具 cu_act 的 action → 旧工具名。 */
export const CU_ACT_ACTIONS = {
	click: "click",
	drag: "drag",
	scroll: "scroll",
	input: "input_text",
	hotkey: "hotkey",
	ax_press: "ax_press",
	ax_set_value: "ax_set_value",
	ax_menu: "ax_menu",
	ax_scroll: "ax_scroll"
};

/** 被 v2 强工具覆盖的旧工具名；`legacyToolNames: false` 时不再直接暴露（registry 内仍保留给分派器）。 */
export const V2_LEGACY_TOOL_NAMES = new Set([...Object.values(CU_OBSERVE_ACTIONS), ...Object.values(CU_ACT_ACTIONS)]);

/**
 * 0.17：注册 v2 强工具（首批 cu_observe）。
 * 必须在 applyComputerUse 之后调用（fork 侧工具那时才进 registry）。
 */
export function registerV2Tools({ handle, defineTool }) {
	if (handle === void 0 || typeof handle.buildRegistry !== "function") return void 0;
	const registry = handle.buildRegistry();
	const cuObserve = buildDispatcher({
		name: "cu_observe",
		description:
			"v2 observe: one tool for looking before acting. action = screenshot (frontmost window capture) | windows (window list + displays + frontmost app) | window_screenshot (one window by id) | zoom (native-resolution crop of a screen region) | verify (poll a state predicate). 旧工具名仍可用，新会话优先用本工具。",
		registry,
		actions: CU_OBSERVE_ACTIONS,
		// 输入 schema 取并集但全部可选；必填由 requiredByAction 按 action 校验
		// （合并成员自带的 required:true 不能带进来，否则 windows/screenshot 也会强制要 window_id/kind）。
		parameters: {
			screen_index: { type: "integer", description: "0 for the attached frontmost-window screenshot." },
			window_id: { type: "integer", description: "CGWindowID from list_windows (window_screenshot)." },
			pid: { type: "integer", description: "Only list windows of this process id (windows)." },
			title_contains: { type: "string", description: "Only windows whose title contains this text (windows)." },
			app_contains: { type: "string", description: "Only windows whose app name contains this text (windows)." },
			limit: { type: "integer", description: "Max windows to return (default 20, max 200)." },
			attach: { type: "boolean", default: true, description: "Attach the image to the tool result (window_screenshot)." },
			x: { type: "number", default: 500, description: "Region center x, 0–1000 fraction of the frontmost window (zoom)." },
			y: { type: "number", default: 500, description: "Region center y, 0–1000 fraction (zoom)." },
			width: { type: "number", default: 300, description: "Region width 0–1000 (zoom)." },
			height: { type: "number", default: 300, description: "Region height 0–1000 (zoom)." },
			kind: { type: "string", enum: ["window_title", "frontmost_app", "app_running", "ax_text", "ax_element"], description: "Predicate kind (verify)." },
			contains: { type: "string", description: "Substring to match (verify)." },
			role: { type: "string", description: "ax_element: expected AX role substring (verify)." },
			title: { type: "string", description: "ax_element: expected AX title substring (verify)." },
			value: { type: "string", description: "ax_element: expected AX value substring (verify)." },
			max_nodes: { type: "integer", default: 200, description: "AX node cap for verify." },
			timeout_ms: { type: "integer", default: 5000, description: "Poll deadline in ms (verify)." },
			interval_ms: { type: "integer", default: 400, description: "Poll interval in ms (verify)." },
			case_sensitive: { type: "boolean", default: false, description: "Case-sensitive match (verify)." }
		},
		requiredByAction: {
			screenshot: [],
			windows: [],
			window_screenshot: ["window_id"],
			zoom: [],
			verify: ["kind"]
		},
		defineTool
	});
	handle.registerExtra(cuObserve);

	const cuAct = buildDispatcher({
		name: "cu_act",
		description:
			"v2 act: one tool for desktop actions. action = click | drag | scroll | input (type into a focused field) | hotkey | ax_press | ax_set_value | ax_menu | ax_scroll. 参数沿用旧工具命名（position/[x,y]、keys、index、path 等）；拿不准的 action 先用 cu_observe 观察。旧工具名仍可用，新会话优先用本工具。",
		registry,
		actions: CU_ACT_ACTIONS,
		// 与 cu_observe 同理：输入 schema 取并集，但不能把各工具自己的 required 带进来
		// （否则 click 的 position 会变成 hotkey 的必填项），改为按 action 运行时校验。
		parameters: {
			screen_index: { type: "integer", description: "0 for the attached frontmost-window screenshot." },
			position: { type: "array", items: { type: "number" }, description: "[x, y] as 0–1000 fractions of the screenshot, not pixels." },
			start_screen_index: { type: "integer", description: "0 for the attached frontmost-window screenshot." },
			start_position: { type: "array", items: { type: "number" }, description: "[x, y] start as 0–1000 fractions." },
			end_screen_index: { type: "integer", description: "0 for the attached frontmost-window screenshot." },
			end_position: { type: "array", items: { type: "number" }, description: "[x, y] end as 0–1000 fractions." },
			button: { type: "string", enum: ["left", "right"], default: "left", description: "Mouse button. Default: left." },
			count: { type: "integer", enum: [1, 2], default: 1, description: "1 single click, 2 double-click." },
			modifiers: { type: "array", items: { type: "string" }, description: "Modifier keys held only for this click, e.g. [\"shift\"]." },
			text: { type: "string", description: "Characters to type (input) or the new field value (ax_set_value)." },
			replace: { type: "boolean", default: false, description: "Select all in the focused field before typing." },
			submit: { type: "boolean", default: false, description: "Press Enter after typing." },
			keys: { type: "array", items: { type: "string" }, description: "Key names in order, e.g. [\"cmd\", \"c\"]." },
			direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction." },
			scroll_level: { type: "integer", description: "Scroll magnitude 1–10 (scroll action)." },
			page: { type: "boolean", description: "Scroll a full page (ax_scroll)." },
			index: { type: "integer", description: "AX node index from the latest <ax_snapshot>." },
			value: { type: "string", description: "Value to write (ax_set_value)." },
			expect_role: { type: "string", description: "Expected AX role (exact) for ax_* actions." },
			expect_title: { type: "string", description: "Expected AX title substring for ax_* actions." },
			path: { type: "string", description: "Menu path for ax_menu, e.g. 文件/关闭." },
			pid: { type: "integer", description: "Target process id (defaults to the frontmost app)." },
			confirm: { type: "boolean", description: "Allow guarded controls/shortcuts (delete/remove/pay/send…)." }
		},
		requiredByAction: {
			click: ["screen_index", "position"],
			drag: ["start_screen_index", "start_position", "end_screen_index", "end_position"],
			scroll: ["screen_index", "position", "direction", "scroll_level"],
			input: ["screen_index", "position", "text"],
			hotkey: ["keys"],
			ax_press: ["index"],
			ax_set_value: ["index", "value"],
			ax_menu: ["path"],
			ax_scroll: ["direction"]
		},
		defineTool
	});
	handle.registerExtra(cuAct);
	audit("v2_tool_registered", { tools: ["cu_observe", "cu_act"], covered: 14 });
	return { cuObserve, cuAct };
}
