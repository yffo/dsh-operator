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
import { classifyFailure, recordFailure } from "./failure-store.js";
import { jpegDimensions } from "./capture-downscale.js";
import { invalidateWindowCache, listWindows } from "./macos-query.js";
import { pressAx, pressAxMenu, scrollAx, setAxValue, snapshotAx } from "./ax-observer.js";
import { guardTitlePress, matchDangerousTitle } from "./guard.js";
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
			return { ok: count > 0, observed: count > 0 ? `${count} window(s) matched title` : "no window title matched" };
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
			return { ok: count > 0, observed: count > 0 ? `${count} window(s) of the app` : "app not visible" };
		}
		case "ax_text": {
			const pid = await frontmostPid(args);
			const snapshot = pid === undefined ? undefined : await internals.snapshotAx(pid, args.max_nodes ?? 200);
			if (snapshot === undefined) return { ok: false, observed: "no AX snapshot" };
			const text = normalize(axTextOf(snapshot));
			const ok = wanted !== "" && text.includes(wanted);
			return { ok, observed: ok ? "AX text matched" : "AX text not matched" };
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
			return { ok: hits.length > 0, observed: hits.length > 0 ? `${hits.length} AX element(s) matched` : "no AX element matched" };
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
	if (process.platform !== "darwin") {
		// Windows/Linux 守卫：扩展工具（含 AX 系列）只在 macOS 注册，这里明确提示而不是静默消失。
		console.warn(`[dsh-operator] extended tools are macOS-only; skipped on ${process.platform} (untested platform)`);
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
	const register = (definition) => ctx.tools.register(captureFailures(definition));

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

	// 动作之后窗口信息可能变化：不缓存太久，交给下一次调用重新取。
	invalidateWindowCache();
	void backend;
}
