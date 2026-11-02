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

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { audit } from "./audit-log.js";
import { deleteSkill, listSkills, readSkill, saveSkill, skillDir } from "./skill-store.js";
import { classifyTask } from "./task-profile.js";
import { createPlan, deletePlan, listPlans, planSummary, readPlan, updatePlan } from "./planner.js";
import { collectStatus } from "./status.js";
import { executeSteps, summarizeResults } from "./executor.js";
import { classifyFailure, digestFailures, failureDir, recordFailure } from "./failure-store.js";
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
							version: failureVersion
						});
					}
					return value;
				} catch (error) {
					recordFailure({ tool: definition.name, args, error, version: failureVersion });
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
				try {
					await internals.execFileAsync(internals.screenshotBin, ["-x", "-t", "jpg", "-l", String(windowId), path], {
						timeout: 5000,
						maxBuffer: 1024 * 1024
					});
					const data = await readFile(path);
					const size = jpegDimensions(data) ?? { width: 0, height: 0 };
					const result = {
						schemaVersion: SCHEMA_VERSION,
						windowId,
						width: size.width,
						height: size.height
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
			name: "ax_press",
			description:
				"Press one native accessibility element by its index from the latest <ax_snapshot> (for example [32]), through AXPress. This is a background delivery: the pointer and focus do not move, and no screenshot timing is involved. Provide expect_role / expect_title to refuse a stale or mismatched node. Use this for native AppKit controls (System Settings, Notes, Calendar); for web/Electron content keep using click/input_text. Facts only in the result.",
			parameters: {
				index: { type: "integer", required: true, description: "Node index from the latest <ax_snapshot>, e.g. 32." },
				expect_role: { type: "string", description: "Expected AX role (exact, e.g. AXButton); refuses on mismatch." },
				expect_title: { type: "string", description: "Expected title/description substring; refuses on mismatch." },
				pid: { type: "integer", description: "Target process id (defaults to the frontmost app)." },
				confirm: { type: "boolean", description: "Pass true to allow pressing a guarded control (delete/remove/pay/send…)." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						pressed: { type: "boolean", required: true },
						index: { type: "integer", required: true },
						role: { type: "string" },
						title: { type: "string" },
						error: { type: "string" }
					}
				},
				render: (_args, value) =>
					[
						{
							type: "text",
							text: value.pressed === true
								? `Pressed AX node [${String(value.index)}] ${String(value.role)} "${String(value.title ?? "")}" via AXPress (background)`
								: `AXPress failed for node [${String(value.index)}]: ${String(value.error ?? "unknown error")}`
						}
					]
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
				const result = await internals.pressAx({
					pid,
					index: Number(args.index ?? -1),
					expectRole: typeof args.expect_role === "string" ? args.expect_role : undefined,
					expectTitle: typeof args.expect_title === "string" ? args.expect_title : undefined
				});
				audit("ax_press", {
					index: Number(args.index ?? -1),
					pressed: result.pressed === true,
					expect_role: typeof args.expect_role === "string",
					expect_title: typeof args.expect_title === "string"
				});
				return {
					schemaVersion: SCHEMA_VERSION,
					pressed: result.pressed === true,
					index: Number(result.index ?? args.index ?? -1),
					...(typeof result.role === "string" && result.role !== "" ? { role: result.role } : {}),
					...(typeof result.title === "string" && result.title !== "" ? { title: result.title } : {}),
					...(typeof result.error === "string" && result.error !== "" ? { error: result.error } : {})
				};
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
						error: { type: "string" }
					}
				},
				render: (_args, value) =>
					[
						{
							type: "text",
							text: value.ok === true
								? `Set value on AX node [${String(value.index)}] ${String(value.role)} "${String(value.title ?? "")}" (background)`
								: `AX set-value failed for node [${String(value.index)}]: ${String(value.error ?? "unknown error")}`
						}
					]
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
				const result = await internals.setAxValue({
					pid,
					index,
					value: String(args.value ?? ""),
					expectRole: typeof args.expect_role === "string" ? args.expect_role : undefined
				});
				audit("ax_set_value", { index, ok: result.ok === true, expect_role: typeof args.expect_role === "string" });
				return {
					schemaVersion: SCHEMA_VERSION,
					ok: result.ok === true,
					index: Number(result.index ?? index),
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
						error: { type: "string" }
					}
				},
				render: (_args, value) =>
					[
						{
							type: "text",
							text: value.ok === true
								? `Scrolled ${String(value.role ?? "AXScrollArea")} [${String(value.index)}] ${String(value.direction)}${value.page === true ? " (page)" : ""}${typeof value.resolved === "string" ? ` (${value.resolved})` : ""}`
								: `AX scroll failed for node [${String(value.index)}]: ${String(value.error ?? "unknown error")}`
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
				return {
					schemaVersion: SCHEMA_VERSION,
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
						error: { type: "string" }
					}
				},
				render: (_args, value) =>
					[
						{
							type: "text",
							text: value.ok === true
								? `Invoked menu ${String(value.path)} via AXPress (background)`
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
				const pid = await frontmostPid(args);
				if (Number.isInteger(pid) === false) {
					return { schemaVersion: SCHEMA_VERSION, ok: false, path: label, error: "no target pid" };
				}
				if (config?.guard !== false) {
					const verdict = guardTitlePress({ title: label, confirm: args.confirm === true, enabled: true });
					if (verdict.allowed !== true) {
						audit("ax_menu_guarded", { path: label });
						return { schemaVersion: SCHEMA_VERSION, ok: false, path: label, error: verdict.reason };
					}
				}
				const result = await internals.pressAxMenu({ pid, path: segments });
				audit("ax_menu", { path: label, ok: result.ok === true });
				return {
					schemaVersion: SCHEMA_VERSION,
					ok: result.ok === true,
					path: label,
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
							args: { type: "object", additionalProperties: true }
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
						{ name: String(args.name ?? ""), description: String(args.description ?? ""), steps: Array.isArray(args.steps) ? args.steps : [], ...(args.tags === undefined ? {} : { tags: args.tags }) },
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
			description: "List saved skills (name, description, step count, tags, updatedAt). Skills are local, plain JSON files under ~/.dsh/dsh-operator/skills.",
			parameters: {},
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
									updatedAt: { type: "string", required: true }
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
							: `Saved skills: ${value.skills.map((skill) => `${skill.name}(${skill.steps} steps)`).join(", ")}`
					}]
			},
			isConcurrencySafe: () => true,
			presentCall: (args) => presentCall("List skills", args),
			async execute(_args, exec) {
				exec.signal.throwIfAborted();
				const skills = listSkills().map((skill) => ({
					name: String(skill.name),
					description: String(skill.description ?? ""),
					steps: Array.isArray(skill.steps) ? skill.steps.length : 0,
					...(Array.isArray(skill.tags) ? { tags: skill.tags } : {}),
					updatedAt: String(skill.updatedAt ?? "")
				}));
				return { schemaVersion: SCHEMA_VERSION, total: skills.length, dir: skillDir(), skills };
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
				const target = String(args.text ?? args.selector ?? "");
				if (target.trim() === "") return { schemaVersion: SCHEMA_VERSION, ok: false, error: "selector or text is required" };
				if (config?.guard !== false) {
					const verdict = guardTitlePress({ title: target, confirm: args.confirm === true, enabled: true });
					if (verdict.allowed !== true) {
						audit("browser_dom_click_guarded", { matched: matchDangerousTitle(target) ?? "" });
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
						matched: { type: "array", items: { type: "string" } }
					}
				},
				render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
			},
			isConcurrencySafe: () => true,
			presentCall: (args) => presentCall("Classify task", args),
			async execute(args) {
				const result = classifyTask(String(args.goal ?? ""), { hint: args.hint, estSteps: args.estSteps });
				const profile = result.profile;
				const text = `task_profile: ${result.tier} (${result.reason}) → maxSteps ${profile.maxSteps}, plan-first ${profile.requirePlan === true ? "yes" : "no"}, per-step verify ${profile.verifyAfterEach === true ? "yes" : "no"}, batch ${profile.allowBatch === true ? "yes" : "no"}. ${profile.note}`;
				return { schemaVersion: SCHEMA_VERSION, text, tier: result.tier, maxSteps: profile.maxSteps, requirePlan: profile.requirePlan, verifyAfterEach: profile.verifyAfterEach, allowBatch: profile.allowBatch, matched: result.matched };
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
					description: "Ordered steps: [{id, tool, args?, verify?}] (1-60).",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							id: { type: "string", required: true, description: "kebab-case step id, unique." },
							tool: { type: "string", required: true },
							args: { type: "object", additionalProperties: true },
							verify: { type: "object", additionalProperties: true }
						}
					}
				},
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
					const created = createPlan({
						goal: String(args.goal ?? ""),
						steps: Array.isArray(args.steps) ? args.steps : [],
						...(args.tier === undefined ? {} : { tier: args.tier }),
						...(args.note === undefined ? {} : { note: args.note })
					});
					audit("plan_create", { id: created.id, steps: created.plan.steps.length });
					const text = `plan ${created.id}: ${created.plan.steps.length} steps, tier ${String(created.plan.tier ?? "unset")}. Next: plan_update {id:"${created.id}", stepId:"${created.plan.steps[0].id}", status:"running"}`;
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
				"Advance one step of a saved plan (status: pending|running|done|failed|skipped) and return the plan summary (counts + next pending step). Failed steps make the whole plan failed; use it to keep long tasks auditable.",
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
					const fork = forkSteps();
					const run = await executeSteps(skill.steps ?? [], {
						handlers,
						fallback: fork,
						allowedTools: new Set([...handlers.keys(), ...fork.keys()].filter((name) => name !== "skill_run" && name !== "plan_run")),
						signal: exec.signal,
						stopOnError: args.stopOnError !== false,
						dryRun: args.dryRun === true
					});
					audit("skill_run", { name: skill.name, executed: run.executed, failed: run.failed, dryRun: args.dryRun === true });
					return { schemaVersion: SCHEMA_VERSION, ok: run.ok, text: `skill ${skill.name}: ${summarizeResults(run)}`, executed: run.executed, failed: run.failed, skipped: run.skipped, results: run.results };
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
				"Execute a saved plan's pending steps with this plugin's extended tools, advancing step statuses (pending→running→done/failed) in ~/.dsh/dsh-operator/plans. Stops on first failure. Unsafe for steps needing base GUI tools (click/input_text): mark those failed manually. Use dryRun to preview.",
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
						nextStep: { type: "string" },
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
					const pending = (plan.steps ?? []).filter((step) => step.status === "pending" || step.status === "running");
					if (pending.length === 0) {
						const summary = planSummary(plan);
						audit("plan_run", { id, executed: 0, failed: 0, dryRun, skipped: true });
						return { schemaVersion: SCHEMA_VERSION, ok: true, text: `plan ${id}: no pending steps (${String(summary.counts.done)}/${String(plan.steps.length)} done, status ${plan.status})`, executed: 0, failed: 0, skipped: 0, planStatus: plan.status, totalSteps: plan.steps.length, doneSteps: summary.counts.done, results: [] };
					}
					const fork = forkSteps();
					const run = await executeSteps(pending, {
						handlers,
						fallback: fork,
						allowedTools: new Set([...handlers.keys(), ...fork.keys()].filter((name) => name !== "skill_run" && name !== "plan_run")),
						signal: exec.signal,
						stopOnError: args.stopOnError !== false,
						dryRun,
						onStep: ({ id: stepId, status, error }) => {
							if (dryRun) return;
							const mapped = status === "ok" ? "done" : status === "skipped" ? "skipped" : "failed";
							try {
								updatePlan(id, { stepId, status: mapped, ...(error === undefined ? {} : { note: error }) });
							} catch {
								/* 状态更新失败不影响执行结果 */
							}
						}
					});
					const finalPlan = readPlan(id);
					const progress = planSummary(finalPlan);
					audit("plan_run", { id, executed: run.executed, failed: run.failed, dryRun });
					return {
						schemaVersion: SCHEMA_VERSION,
						ok: run.ok,
						text: `plan ${id}: ${summarizeResults(run)} — ${String(progress.counts.done)}/${String(finalPlan.steps.length)} done, status ${finalPlan.status}${progress.nextStep === null ? "" : `, next ${progress.nextStep}`}`,
						executed: run.executed,
						failed: run.failed,
						skipped: run.skipped,
						planStatus: finalPlan.status,
						totalSteps: finalPlan.steps.length,
						doneSteps: progress.counts.done,
						...(progress.nextStep === null ? {} : { nextStep: progress.nextStep }),
						results: run.results
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					audit("plan_run_failed", { error: message });
					return { schemaVersion: SCHEMA_VERSION, ok: false, text: `plan_run failed: ${message}`, executed: 0, failed: 0, skipped: 0, results: [], error: message };
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
					deletePlan(id);
					audit("plan_delete", { id });
					return { schemaVersion: SCHEMA_VERSION, ok: true, id, text: `plan ${id} deleted` };
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
				const plans = listPlans({ limit: Number(args.limit ?? 20) });
				const rows = plans.map((plan) => {
					const summary = planSummary(plan);
					const total = Object.values(summary.counts).reduce((a, b) => a + b, 0);
					return { id: String(plan.id ?? summary.id), goal: String(plan.goal ?? ""), status: String(summary.status ?? "pending"), done: summary.counts.done, total, updatedAt: String(summary.updatedAt ?? "") };
				});
				const text = rows.length === 0
					? "plans: none (use plan_create)"
					: ["plans:", ...rows.map((row) => `${row.id}\t${row.status}\t${row.done}/${row.total}\t${row.goal.slice(0, 60)}`)].join("\n");
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
			async execute() {
				const status = collectStatus({ config: config ?? {}, version: deps?.version ?? "unknown", seamProvider: deps?.seamProvider });
				const activePlans = listPlans({ limit: 100 }).filter((plan) => plan.status !== "done" && plan.status !== "failed");
				const hint = activePlans.length === 0
					? ""
					: `\nactive plans: ${String(activePlans.length)} (next ${activePlans[0].id}${activePlans[0].nextStep === null ? "" : ` → ${activePlans[0].nextStep}`})`;
				audit("operator_status", { skills: status.skills, plans: status.plans, failures: status.failureRecords, activePlans: activePlans.length });
				return { schemaVersion: SCHEMA_VERSION, ...status, text: `${status.text}${hint}` };
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
						byTool: {
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
				}
				if (recent.length > 0) {
					lines.push("recent:");
					for (const row of recent) {
						const kind = String(row.kind ?? "error");
						const tool = String(row.tool ?? "(unknown)");
						const time = String(row.t ?? "").replace("T", " ").slice(0, 19);
						const message = String(row.message ?? "").slice(0, 120);
						lines.push(`  ${time}  ${tool}  [${kind}]  ${message}`);
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
				return { schemaVersion: SCHEMA_VERSION, text: lines.join("\n"), total, dir, byKind, byTool, recent: rows };
			}
		})
	);

	register(
		defineTool({
			name: "ax_batch",
			description:
				"Run 2-12 GUI actions in one tool call and stop at the first failure. Supported actions: AX (ax_press / ax_set_value / ax_menu / ax_scroll), fork (click / scroll / input / hotkey), and browser (browser_open / browser_click / browser_type, requires an active browser binding). Intermediate screenshots are discarded to save tokens; call it after one observation (cu_observe / AX snapshot) to replay a known sequence and reuse that observation instead of re-observing after each step.",
			parameters: {
				steps: {
					type: "array",
					description: "Ordered steps (2-12). Each step needs action plus that action's fields.",
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
				if (steps.length < 2) throw new Error("ax_batch: steps 至少 2 步（单步请直接用 ax_press/ax_set_value/ax_menu/ax_scroll）");
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
				for (const row of results) {
					lines.push(`  ${row.index + 1}. ${row.action} ${row.ok ? "ok" : "FAILED"}${row.note === "" ? "" : ` — ${row.note}`}`);
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
