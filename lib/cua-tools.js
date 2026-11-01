// cua-driver 工具面（0.22.0）：cua_windows / cua_observe / cua_act
//
// 与既有 computer-use 工具的分工：
// - 既有 click/input_text 等走「屏幕坐标 + CGEvent」，会移动真实指针、抢用户焦点；
// - cua_* 走 cua-driver 的 window 级后台投递（X/Y 是窗口局部像素，或 element_token），
//   不移动真实指针、不抢焦点 —— 适合「用户同时在用这台 Mac」的场景。
//
// 三件套：
// - cua_windows：列窗口 + 前台窗口 + 显示器，拿 window_id/pid/bounds；
// - cua_observe：读指定窗口的 AX 树（附带可选截图），拿 element_token（形如 s00000004:31）；
// - cua_act：对指定窗口执行单个动作（click/type_text/press_key/hotkey/scroll/drag/set_value），
//   默认 background，返回动作结果 + observe diff（若有变化）。
//
// 边界（写进工具描述，避免模型误用）：
// - 原生 App 的后台菜单快捷键不可用（需 delivery_mode:"foreground" 或 fallback_foreground）；
// - macOS 原生 drag&drop（拖文件/列表重排）不支持后台 drop，会报 background_unavailable；
// - 截图需要屏幕录制授权（TCC）；AX 树与后台操作不需要。

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit } from "./audit-log.js";
import { jpegDimensions } from "./capture-downscale.js";
import { CAPTURE_CONSENT_MARKER, SCREEN_RECORDING_HINT, cuaListWindows, cuaRunSteps, cuaScreenSize, cuaWindowState, ensureCuaDaemon, isCaptureConsentError, resolveCuaDriverBinary, cuaSocketPath } from "./cua-driver.js";

const SCHEMA_VERSION = 1;
/** 提供给模型的 AX 树文本上限（行），超出提示用 query/max_elements 收窄。 */
const TREE_TEXT_MAX_LINES = 140;
/** cua_act 支持的动作。 */
const ACTIONS = ["click", "type_text", "press_key", "hotkey", "scroll", "drag", "set_value"];

function presentCall(title, rawInput) {
	return { card: "generic", title, kind: "execute", rawInput };
}

function positiveInt(value, label) {
	const number = Number(value);
	if (Number.isInteger(number) === false || number <= 0) throw new Error(`${label} must be a positive integer`);
	return number;
}

function findWindow(windows, windowId) {
	const window = windows.find((entry) => entry.window_id === windowId);
	if (window === void 0) throw new Error(`找不到 window_id=${String(windowId)} 的窗口；先调用 cua_windows 查看当前窗口列表`);
	return window;
}

/** 前台窗口 = 当前 Space 上 layer 0 的最大 z_index。 */
function frontmostWindow(windows) {
	let best;
	for (const window of windows) {
		if (window.layer !== 0 || window.on_current_space === false) continue;
		if (best === void 0 || window.z_index > best.z_index) best = window;
	}
	return best;
}

function windowLine(window, { frontmost = false } = {}) {
	const bounds = window.bounds ?? {};
	const app = String(window.app_name ?? "?");
	const title = String(window.title ?? "");
	const parts = [
		`window_id=${String(window.window_id)}`,
		`pid=${String(window.pid)}`,
		`app="${app}"`,
		`title="${title}"`,
		`bounds=${String(bounds.x)},${String(bounds.y)} ${String(bounds.width)}x${String(bounds.height)}`,
		`layer=${String(window.layer)}`,
		`z=${String(window.z_index)}`
	];
	if (window.on_current_space === false) parts.push("other_space=true");
	if (window.is_on_screen === false) parts.push("off_screen=true");
	if (frontmost === true) parts.push("frontmost=true");
	return `<window ${parts.join(" ")}/>`;
}

function errorHint(message) {
	if (message.includes(CAPTURE_CONSENT_MARKER)) return SCREEN_RECORDING_HINT;
	if (message.includes("select_menu_would_raise_window"))
		return '后台点击 <select> 会抢窗口焦点被拒：改用 action="set_value"（element_token + value）选择选项。';
	if (message.includes("background_unavailable"))
		return "该动作在后台不可用（例如原生菜单快捷键/拖拽会话）：传 fallback_foreground=true 让 cua-driver 短暂前台执行并自动恢复，或改用原生工具。";
	if (message.includes("target_focus_unconfirmed"))
		return "目标元素无法确认获得焦点（未发送按键）：先对窗口做一次 cua_observe，再用 element_token 精确指定，或接受前台模式。";
	if (message.includes("element_token") || message.includes("stale"))
		return "element_token 已过期：重新 cua_observe 取最新 snapshot_id 后再试。";
	return void 0;
}

function wrapError(error) {
	const hint = errorHint(String(error?.message ?? ""));
	const suffix = hint === void 0 ? "" : `\n提示：${hint}`;
	return new Error(`${String(error?.message ?? error)}${suffix}`);
}

function treeText(state) {
	const markdown = typeof state.tree_markdown === "string" ? state.tree_markdown : "";
	const lines = markdown.split("\n").filter((line) => line.trim().length > 0);
	const kept = lines.slice(0, TREE_TEXT_MAX_LINES);
	const omitted = lines.length - kept.length;
	const notes = [];
	if (omitted > 0) notes.push(`<tree_truncated omitted_lines="${String(omitted)}"/>`);
	if (state.truncated === true) {
		const hint = typeof state.truncation_hint === "string" ? state.truncation_hint : "";
		notes.push(`<tree_partial reason="${String(state.truncation_reason ?? "max_elements")}"${hint.length > 0 ? ` hint="${hint.replaceAll("\"", "'")}"` : ""}/>`);
	}
	return [kept.join("\n"), ...notes].filter((part) => part.length > 0).join("\n");
}

/**
 * 注册 cua_* 工具；找不到 cua-driver 时什么都不注册（静默降级为原有工具面）。
 * @param {object} ctx 插件上下文（需 ctx.tools.register / ctx.attachments.saveImage）
 * @param {object} config 本包配置（当前不额外使用；DSH_OPERATOR_CUA=0 可关）
 * @param {{ defineTool: Function, AttachmentId: Function, version?: string }} deps
 * @returns {{ registered: boolean, reason?: string }}
 */
export function registerCuaTools(ctx, config, deps) {
	const { defineTool, AttachmentId, version } = deps;
	if (process.env.DSH_OPERATOR_CUA === "0") {
		console.warn("[dsh-operator] DSH_OPERATOR_CUA=0，跳过 cua_* 工具");
		return { registered: false, reason: "disabled" };
	}
	const bin = resolveCuaDriverBinary();
	if (bin === void 0) {
		console.warn(
			"[dsh-operator] 未找到 cua-driver，跳过 cua_* 工具。安装：/bin/bash -c \"$(curl -fsSL https://cua.ai/driver/install.sh)\"；忽略即可继续用原有工具。"
		);
		return { registered: false, reason: "cua-driver not installed" };
	}
	const socket = cuaSocketPath();
	// daemon 只在第一次工具调用时才拉起，避免插件启动拖慢桌面。
	let daemonReady = false;
	const ensureReady = async () => {
		if (daemonReady === true) return;
		await ensureCuaDaemon(bin, { socket });
		daemonReady = true;
	};

	ctx.tools.register(
		defineTool({
			name: "cua_windows",
			description:
				"List windows for background control via cua-driver (does not touch the user's mouse or focus). Returns display size, the frontmost window (frontmost=true) and window rows with window_id/pid/app/title/bounds/layer/z. cua_act only needs window_id. Filter with app_contains/title_contains when many windows are open.",
			parameters: {
				app_contains: { type: "string", description: "Only windows whose app name contains this text (case-insensitive)." },
				title_contains: { type: "string", description: "Only windows whose title contains this text (case-insensitive)." },
				on_screen_only: { type: "boolean", default: true, description: "Only list on-screen windows. Default: true." },
				limit: { type: "integer", description: "Max windows to return (default 20, max 50)." }
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
			presentCall: (args) => presentCall("List cua windows", args),
			async execute(args) {
				try {
					await ensureReady();
				} catch (error) {
					throw wrapError(error);
				}
				const limit = Number.isInteger(args.limit) ? Math.max(1, Math.min(50, args.limit)) : 20;
				const appFilter = typeof args.app_contains === "string" ? args.app_contains.toLowerCase() : void 0;
				const titleFilter = typeof args.title_contains === "string" ? args.title_contains.toLowerCase() : void 0;
				let windowsResult;
				let size;
				try {
					[windowsResult, size] = await Promise.all([
						cuaListWindows(bin, { socket, onScreenOnly: args.on_screen_only !== false }),
						cuaScreenSize(bin, { socket })
					]);
				} catch (error) {
					throw wrapError(error);
				}
				const all = Array.isArray(windowsResult.windows) ? windowsResult.windows : [];
				const filtered = all.filter((window) => {
					if (appFilter !== void 0 && String(window.app_name ?? "").toLowerCase().includes(appFilter) === false) return false;
					if (titleFilter !== void 0 && String(window.title ?? "").toLowerCase().includes(titleFilter) === false) return false;
					return true;
				});
				const front = frontmostWindow(all);
				const shown = filtered.slice(0, limit);
				const lines = [
					`<cua_windows driver="cua-driver" displays="1" windows="${String(filtered.length)}"${filtered.length > shown.length ? ' truncated="true"' : ""}>`,
					`<frontmost window_id="${String(front?.window_id ?? "")}" pid="${String(front?.pid ?? "")}" app="${String(front?.app_name ?? "")}" title="${String(front?.title ?? "")}"/>`,
					`<display index="0" primary="true" scale="${String(size.scale_factor ?? 1)}">${String(size.width)}x${String(size.height)}</display>`,
					...shown.map((window) => windowLine(window, { frontmost: front !== void 0 && window.window_id === front.window_id })),
					"</cua_windows>"
				];
				audit("cua_windows", { windows: all.length, shown: shown.length, filtered: filtered.length });
				return { schemaVersion: SCHEMA_VERSION, text: lines.join("\n") };
			}
		})
	);

	ctx.tools.register(
		defineTool({
			name: "cua_observe",
			description:
				"Read the AX tree of one window through cua-driver (background; does not move the cursor). Returns element_token values shaped like <snapshot_id>:<N> for cua_act's element_token, plus background info (app/window/display). Pass query or lower max_elements when the tree is large. The optional screenshot needs Screen Recording permission (macOS TCC); without it the AX tree is still returned with a hint.",
			parameters: {
				window_id: { type: "integer", required: true, description: "Target window_id from cua_windows." },
				include_screenshot: { type: "boolean", default: true, description: "Attach a window screenshot. Default: true (falls back to AX-only if TCC blocks it)." },
				max_elements: { type: "integer", description: "AX element budget (default 200)." },
				max_image_dimension: { type: "integer", description: "Screenshot long-edge cap in px (default 1600)." },
				max_depth: { type: "integer", description: "AX tree depth limit." },
				query: { type: "string", description: "Only keep AX nodes matching this text/role (when supported by the driver)." },
				since: { type: "string", description: "Diff against an earlier snapshot_id (e.g. 'latest')." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						windowId: { type: "integer", required: true },
						text: { type: "string", required: true },
						note: { type: "string" },
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
					const blocks = [{ type: "text", text: [value.text, value.note ?? ""].filter((part) => part.length > 0).join("\n") }];
					if (value.image !== void 0) {
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
			presentCall: (args) => presentCall("Observe window (cua)", args),
			async execute(args, exec) {
				try {
					await ensureReady();
				} catch (error) {
					throw wrapError(error);
				}
				const windowId = positiveInt(args.window_id, "cua_observe: window_id");
				let windowsResult;
				try {
					windowsResult = await cuaListWindows(bin, { socket, onScreenOnly: false });
				} catch (error) {
					throw wrapError(error);
				}
				const window = findWindow(Array.isArray(windowsResult.windows) ? windowsResult.windows : [], windowId);
				const includeScreenshot = args.include_screenshot !== false;
				const maxElements = Number.isInteger(args.max_elements) ? Math.max(1, args.max_elements) : 200;
				const maxImageDimension = Number.isInteger(args.max_image_dimension) ? Math.max(0, args.max_image_dimension) : 1600;
				const dir = await mkdtemp(join(tmpdir(), "dsh-operator-cua-"));
				const screenshotPath = join(dir, `window-${String(windowId)}.jpg`);
				let note;
				let state;
				try {
					state = await cuaWindowState(bin, {
						pid: window.pid,
						windowId,
						includeScreenshot,
						screenshotPath,
						maxElements,
						maxImageDimension,
						maxDepth: args.max_depth,
						query: args.query,
						since: args.since,
						socket
					});
				} catch (error) {
					if (includeScreenshot === false || isCaptureConsentError(error) === false) throw wrapError(error);
					note = SCREEN_RECORDING_HINT;
					try {
						state = await cuaWindowState(bin, {
							pid: window.pid,
							windowId,
							includeScreenshot: false,
							maxElements,
							maxDepth: args.max_depth,
							query: args.query,
							since: args.since,
							socket
						});
					} catch (retryError) {
						throw wrapError(retryError);
					}
				}
				const summary = `<cua_window driver="cua-driver" window_id="${String(windowId)}" pid="${String(window.pid)}" app="${String(window.app_name ?? "")}" title="${String(window.title ?? "")}" snapshot_id="${String(state.snapshot_id ?? "")}" elements="${String(state.returned_element_count ?? state.element_count ?? 0)}/${String(state.total_element_count ?? state.element_count ?? 0)}" format="${String(state.tree_format ?? "markdown")}"/>`;
				let image;
				if (includeScreenshot === true && note === void 0) {
					try {
						const data = await readFile(screenshotPath);
						const size = jpegDimensions(data) ?? { width: 0, height: 0 };
						const saved = await ctx.attachments.saveImage({ data, mediaType: "image/jpeg", name: `cua-window-${String(windowId)}` });
						image = {
							attachmentId: String(saved.attachmentId),
							mediaType: "image/jpeg",
							bytes: data.length,
							width: size.width,
							height: size.height
						};
					} catch (error) {
						note = `截图读取失败：${String(error?.message ?? error)}`;
					}
				}
				await rm(dir, { recursive: true, force: true }).catch(() => void 0);
				audit("cua_observe", { window_id: windowId, screenshot: image !== void 0, elements: Number(state.returned_element_count ?? 0) });
				const text = [summary, treeText(state)].filter((part) => part.length > 0).join("\n");
				return { schemaVersion: SCHEMA_VERSION, windowId, text, note, image };
			}
		})
	);

	ctx.tools.register(
		defineTool({
			name: "cua_act",
			description:
				`Run ONE background action on one window via cua-driver (does not move the real pointer or steal focus). action is one of ${ACTIONS.join("/")}. Target one of: element_token (from cua_observe, most reliable), role/name (optionally nth), or x/y (window-local pixels of the cua_observe screenshot; use only for canvas/WebGL/custom-drawn UI). Default delivery_mode=background. If a background action is unavailable (native menu key equivalents, native drag sessions), pass fallback_foreground=true to run it briefly in the foreground and restore the previous app. Returns per-step ok/error plus an observe diff.`,
			parameters: {
				window_id: { type: "integer", required: true, description: "Target window_id from cua_windows." },
				action: { type: "string", required: true, enum: ACTIONS, description: `One of ${ACTIONS.join("/")}.` },
				element_token: { type: "string", description: "AX element token from cua_observe (best targeting)." },
				role: { type: "string", description: "AX role when using name-based targeting." },
				name: { type: "string", description: "AX name/title when using name-based targeting." },
				nth: { type: "integer", description: "0-based index among name matches." },
				x: { type: "number", description: "Window-local X pixel (only when no AX target exists)." },
				y: { type: "number", description: "Window-local Y pixel." },
				text: { type: "string", description: "Text for type_text." },
				key: { type: "string", description: "Single key for press_key." },
				keys: { type: "array", items: { type: "string" }, description: "Chord for hotkey, e.g. [\"cmd\",\"c\"]." },
				value: { type: "string", description: "Value for set_value." },
				direction: { type: "string", description: "Scroll direction: up/down/left/right." },
				amount: { type: "integer", description: "Scroll amount (wheel notches or key repeats)." },
				by: { type: "string", description: "Scroll unit: line/page." },
				button: { type: "string", description: "Mouse button for click: left/right/middle." },
				count: { type: "integer", description: "Click count (2 = double click)." },
				modifiers: { type: "array", items: { type: "string" }, description: "Held modifiers: cmd/shift/option/ctrl." },
				from_x: { type: "number", description: "Drag start window-local X." },
				from_y: { type: "number", description: "Drag start window-local Y." },
				to_x: { type: "number", description: "Drag end window-local X." },
				to_y: { type: "number", description: "Drag end window-local Y." },
				duration_ms: { type: "integer", description: "Drag duration (default 500)." },
				delivery_mode: { type: "string", description: "background (default) or foreground." },
				fallback_foreground: { type: "boolean", default: false, description: "Allow a foreground retry when background delivery is unavailable." },
				observe: { type: "boolean", default: true, description: "Attach an observe diff of the window after the action. Default: true." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						ok: { type: "boolean", required: true },
						action: { type: "string", required: true },
						text: { type: "string", required: true },
						hint: { type: "string" }
					}
				},
				render: (_args, value) => [{ type: "text", text: [value.text, value.hint ?? ""].filter((part) => part.length > 0).join("\n") }]
			},
			isConcurrencySafe: () => false,
			presentCall: (args) => presentCall(`cua_act ${String(args.action)}`, args),
			async execute(args, exec) {
				try {
					await ensureReady();
				} catch (error) {
					throw wrapError(error);
				}
				const windowId = positiveInt(args.window_id, "cua_act: window_id");
				const action = String(args.action);
				if (ACTIONS.includes(action) === false) throw new Error(`cua_act: action 只能是 ${ACTIONS.join("/")}，收到 ${action}`);
				let windowsResult;
				try {
					windowsResult = await cuaListWindows(bin, { socket, onScreenOnly: false });
				} catch (error) {
					throw wrapError(error);
				}
				const window = findWindow(Array.isArray(windowsResult.windows) ? windowsResult.windows : [], windowId);
				const target = resolveTarget(args);
				if (action !== "drag" && action !== "hotkey" && Object.keys(target).length === 0) {
					throw new Error("cua_act: 需要 element_token、role/name（可带 nth）或 x/y 之一作为动作目标");
				}
				const step = buildStep(action, args, target);
				const deliveryMode = typeof args.delivery_mode === "string" && args.delivery_mode.length > 0 ? args.delivery_mode : "background";
				const observe = args.observe === false ? void 0 : { include_screenshot: false, include_accessibility_tree: true, max_elements: 60, since: "latest" };
				let result;
				try {
					result = await cuaRunSteps(bin, {
						pid: window.pid,
						windowId,
						steps: [step],
						observe,
						deliveryMode,
						foregroundFallback: args.fallback_foreground === true,
						socket
					});
				} catch (error) {
					throw wrapError(error);
				}
				const steps = Array.isArray(result.steps) ? result.steps : [];
				const failed = steps.find((entry) => entry?.ok === false);
				const ok = failed === void 0 && result.ok !== false;
				const observation = formatObservation(result.observe ?? result.observation);
				const header = `<cua_act window_id="${String(windowId)}" app="${String(window.app_name ?? "")}" action="${action}" delivery="${deliveryMode}" ok="${String(ok)}"${result.foreground_fallback === true ? ' fallback="foreground"' : ""}/>`;
				const text = [header, observation ?? ""].filter((part) => part.length > 0).join("\n");
				audit("cua_act", { window_id: windowId, action, ok });
				if (ok === false) {
					const message = typeof failed?.error === "string" ? failed.error : JSON.stringify(failed ?? result).slice(0, 500);
					return { schemaVersion: SCHEMA_VERSION, ok: false, action, text: `${text}\n<step_failed>${message}</step_failed>`, hint: errorHint(message) };
				}
				return { schemaVersion: SCHEMA_VERSION, ok: true, action, text };
			}
		})
	);

	audit("cua_tools_registered", { tools: 3, version: String(version ?? "unknown") });
	return { registered: true };
}

/** 解析动作目标：element_token > role/name/nth > x/y。 */
function resolveTarget(args) {
	if (typeof args.element_token === "string" && args.element_token.length > 0) return { element_token: args.element_token };
	if (typeof args.role === "string" || typeof args.name === "string") {
		const target = {};
		if (typeof args.role === "string") target.role = args.role;
		if (typeof args.name === "string") target.name = args.name;
		if (Number.isInteger(args.nth)) target.nth = args.nth;
		return target;
	}
	if (typeof args.x === "number" && typeof args.y === "number") return { x: args.x, y: args.y };
	return {};
}

/** 把 cua_act 的单个动作映射成 run_steps 的一步。 */
function buildStep(action, args, target) {
	const modifiers = Array.isArray(args.modifiers) ? args.modifiers.map(String) : void 0;
	if (action === "click") {
		const button = typeof args.button === "string" ? args.button : "left";
		const count = Number.isInteger(args.count) ? args.count : 1;
		const tool = button === "right" ? "right_click" : count >= 2 ? "double_click" : "click";
		const stepArgs = { ...target };
		if (tool === "click" && modifiers !== void 0) stepArgs.modifier = modifiers;
		if (tool === "click" && button !== "left" && button !== "right") stepArgs.button = button;
		if (tool === "click" && count > 1) stepArgs.count = count;
		return Object.keys(stepArgs).length === 0 ? { tool } : { tool, args: stepArgs };
	}
	if (action === "type_text") {
		if (typeof args.text !== "string" || args.text.length === 0) throw new Error("cua_act: type_text 需要 text");
		return { tool: "type_text", args: { ...target, text: args.text } };
	}
	if (action === "press_key") {
		if (typeof args.key !== "string" || args.key.length === 0) throw new Error("cua_act: press_key 需要 key");
		const stepArgs = { key: args.key, ...target };
		if (modifiers !== void 0) stepArgs.modifiers = modifiers;
		return { tool: "press_key", args: stepArgs };
	}
	if (action === "hotkey") {
		if (Array.isArray(args.keys) === false || args.keys.length === 0) throw new Error('cua_act: hotkey 需要 keys（如 ["cmd","c"]）');
		return { tool: "hotkey", args: { keys: args.keys.map(String) } };
	}
	if (action === "scroll") {
		if (typeof args.direction !== "string" || args.direction.length === 0) throw new Error("cua_act: scroll 需要 direction（up/down/left/right）");
		const stepArgs = { direction: args.direction, ...target };
		if (Number.isInteger(args.amount)) stepArgs.amount = args.amount;
		if (typeof args.by === "string" && args.by.length > 0) stepArgs.by = args.by;
		return { tool: "scroll", args: stepArgs };
	}
	if (action === "drag") {
		const numbers = [args.from_x, args.from_y, args.to_x, args.to_y];
		if (numbers.every((value) => typeof value === "number") === false)
			throw new Error("cua_act: drag 需要 from_x/from_y/to_x/to_y（窗口局部截图坐标）");
		const stepArgs = { from_x: args.from_x, from_y: args.from_y, to_x: args.to_x, to_y: args.to_y };
		if (Number.isInteger(args.duration_ms)) stepArgs.duration_ms = args.duration_ms;
		if (modifiers !== void 0) stepArgs.modifier = modifiers;
		return { tool: "drag", args: stepArgs };
	}
	if (action === "set_value") {
		if (typeof args.value !== "string") throw new Error("cua_act: set_value 需要 value（字符串）");
		return { tool: "set_value", args: { ...target, value: args.value } };
	}
	throw new Error(`cua_act: 未知 action ${action}`);
}

/** 把 run_steps 的 observe 结果整理成简短文本。 */
function formatObservation(observed) {
	if (observed === void 0 || observed === null) return void 0;
	const state = observed.state ?? observed;
	const lines = [];
	if (typeof observed.summary === "string" && observed.summary.length > 0) lines.push(observed.summary);
	if (typeof state.tree_markdown === "string" && state.tree_markdown.length > 0) {
		const treeLines = state.tree_markdown.split("\n").filter((line) => line.trim().length > 0).slice(0, 40);
		lines.push(`<observe snapshot_id="${String(state.snapshot_id ?? "")}">`, treeLines.join("\n"), "</observe>");
	}
	if (lines.length === 0) return void 0;
	return lines.join("\n");
}
