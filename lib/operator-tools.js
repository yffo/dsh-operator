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
import { jpegDimensions } from "./capture-downscale.js";
import { invalidateWindowCache, listWindows } from "./macos-query.js";
import { pressAx, snapshotAx } from "./ax-observer.js";

const SCHEMA_VERSION = 1;
const execFileAsync = promisify(execFile);
const SCREENSHOT_BIN = "/usr/sbin/screencapture";
const DELAY_MAX_MS = 30000;

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
	const value = await listWindows({});
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
			const value = await listWindows({ titleContains: needle });
			const count = Array.isArray(value?.windows) ? value.windows.length : 0;
			return { ok: count > 0, observed: count > 0 ? `${count} window(s) matched title` : "no window title matched" };
		}
		case "frontmost_app": {
			const value = await listWindows({});
			const app = normalize(value?.frontmostApp);
			const ok = wanted !== "" && app.includes(wanted);
			return { ok, observed: ok ? `frontmost app is ${String(value?.frontmostApp)}` : `frontmost app is ${String(value?.frontmostApp ?? "unknown")}` };
		}
		case "app_running": {
			if (wanted === "") return { ok: false, observed: "contains is required for app_running" };
			const value = await listWindows({ appContains: needle });
			const count = Array.isArray(value?.windows) ? value.windows.length : 0;
			return { ok: count > 0, observed: count > 0 ? `${count} window(s) of the app` : "app not visible" };
		}
		case "ax_text": {
			const pid = await frontmostPid(args);
			const snapshot = pid === undefined ? undefined : await snapshotAx(pid, args.max_nodes ?? 200);
			if (snapshot === undefined) return { ok: false, observed: "no AX snapshot" };
			const text = normalize(axTextOf(snapshot));
			const ok = wanted !== "" && text.includes(wanted);
			return { ok, observed: ok ? "AX text matched" : "AX text not matched" };
		}
		case "ax_element": {
			const pid = await frontmostPid(args);
			const snapshot = pid === undefined ? undefined : await snapshotAx(pid, args.max_nodes ?? 200);
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
export function registerOperatorTools(ctx, config, deps) {
	if (process.platform !== "darwin") return;
	const backend = deps?.backend;
	const defineTool = deps?.defineTool;
	const AttachmentId = deps?.AttachmentId;
	if (backend === undefined || typeof defineTool !== "function") return;
	const axMaxNodes = Number.isInteger(config?.axMaxNodes) ? config.axMaxNodes : 120;

	ctx.tools.register(
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
				const value = await listWindows({
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

	ctx.tools.register(
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
					await execFileAsync(SCREENSHOT_BIN, ["-x", "-t", "jpg", "-l", String(windowId), path], {
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

	ctx.tools.register(
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
					const listed = await listWindows({});
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
					await execFileAsync(SCREENSHOT_BIN, ["-x", "-C", "-R", region, "-t", "jpg", path], {
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

	ctx.tools.register(
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

	ctx.tools.register(
		defineTool({
			name: "ax_press",
			description:
				"Press one native accessibility element by its index from the latest <ax_snapshot> (for example [32]), through AXPress. This is a background delivery: the pointer and focus do not move, and no screenshot timing is involved. Provide expect_role / expect_title to refuse a stale or mismatched node. Use this for native AppKit controls (System Settings, Notes, Calendar); for web/Electron content keep using click/input_text. Facts only in the result.",
			parameters: {
				index: { type: "integer", required: true, description: "Node index from the latest <ax_snapshot>, e.g. 32." },
				expect_role: { type: "string", description: "Expected AX role (exact, e.g. AXButton); refuses on mismatch." },
				expect_title: { type: "string", description: "Expected title/description substring; refuses on mismatch." },
				pid: { type: "integer", description: "Target process id (defaults to the frontmost app)." }
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
					const listed = await listWindows({});
					pid = Number(listed?.frontmostPid);
				}
				if (Number.isInteger(pid) === false || pid <= 0) {
					return { schemaVersion: SCHEMA_VERSION, pressed: false, index: Number(args.index ?? -1), error: "no target pid" };
				}
				const result = await pressAx({
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

	// 动作之后窗口信息可能变化：不缓存太久，交给下一次调用重新取。
	invalidateWindowCache();
	void backend;
}
