// cua-driver 工具面（0.22.0）：cua_windows / cua_observe / cua_act
//
// 与既有 computer-use 工具的分工：
// - 既有 click/input_text 等走「屏幕坐标 + CGEvent」，会移动真实指针、抢用户焦点；
// - cua_* 走 cua-driver 的 window 级后台投递（X/Y 是窗口局部像素，或 element_token），
//   不移动真实指针、不抢焦点 —— 适合「用户同时在用这台 Mac」的场景。
//
// 四件套：
// - cua_windows：列窗口 + 前台窗口 + 显示器，拿 window_id/pid/bounds；
// - cua_launch：后台启动/打开 App（不置顶、不打扰正在使用的用户）；
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
import { guardHotkey, guardPointTarget } from "./guard.js";
import { dedupeAxText } from "./ax-dedupe.js";
import { hitTestPoint } from "./ax-observer.js";
import { jpegDimensions } from "./capture-downscale.js";
import { CAPTURE_CONSENT_MARKER, SCREEN_RECORDING_HINT, cuaCall, cuaLaunchApp, cuaListWindows, cuaRunSteps, cuaScreenSize, cuaWindowState, ensureCuaDaemon, isCaptureConsentError, resolveCuaDriverBinary, cuaSocketPath } from "./cua-driver.js";

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
	let lines = markdown.split("\n").filter((line) => line.trim().length > 0);
	if (lines.length === 0 && Array.isArray(state.elements)) {
		// tree_format=elements 时驱动返回结构数组，渲染成与 markdown 一致的 [N] 行。
		lines = state.elements.map((element) => {
			const label = typeof element.label === "string" && element.label.length > 0 ? ` (${element.label})` : "";
			return `- [${String(element.element_index ?? "")}] ${String(element.role ?? "")}${label}`;
		});
	}
	const kept = lines.slice(0, TREE_TEXT_MAX_LINES);
	const omitted = lines.length - kept.length;
	const notes = [];
	if (omitted > 0) notes.push(`<tree_truncated omitted_lines="${String(omitted)}"/>`);
	if (state.truncated === true) {
		const hint = typeof state.truncation_hint === "string" ? state.truncation_hint : "";
		notes.push(`<tree_partial reason="${String(state.truncation_reason ?? "max_elements")}"${hint.length > 0 ? ` hint="${hint.replaceAll("\"", "'")}"` : ""}/>`);
	} else if (state.elements_complete === false) {
		notes.push(`<tree_partial reason="max_elements" returned="${String(state.returned_element_count ?? kept.length)}" total="${String(state.total_element_count ?? state.element_count ?? "?")}"/>`);
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
			name: "cua_launch",
			description:
				"Launch or open an app in the BACKGROUND without bringing it to the foreground (does not steal focus; use this instead of open_app when the user is working and must not be interrupted). Give bundle_id (preferred) or name (display name or absolute .app path). Optional urls opens files/folders in that app (e.g. a Finder folder path). Optional creates_new_application_instance forces a separate instance so concurrent sessions do not fight over one window. Returns pid, bundle_id, name, launch_state, windows and whether focus was suppressed.",
			parameters: {
				bundle_id: { type: "string", description: "App bundle identifier, e.g. com.apple.Safari (preferred)." },
				name: { type: "string", description: "App display name or absolute .app path (used when bundle_id is absent)." },
				urls: { type: "array", items: { type: "string" }, description: "Optional file paths or URLs to open with the app." },
				creates_new_application_instance: { type: "boolean", default: false, description: "Force a new app instance (open -n) for concurrent sessions." },
				webkit_inspector_port: { type: "integer", description: "Optional WebKit inspector port (Tauri/WebKit apps)." },
				observe: { type: "boolean", default: false, description: "Accepted for symmetry; launch results already include windows." }
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
			presentCall: (args) => presentCall("Launch app in background", args),
			async execute(args) {
				const bundleId = typeof args.bundle_id === "string" && args.bundle_id.length > 0 ? args.bundle_id : void 0;
				const name = typeof args.name === "string" && args.name.length > 0 ? args.name : void 0;
				if (bundleId === void 0 && name === void 0) throw new Error("cua_launch 需要 bundle_id 或 name 之一");
				const urls = Array.isArray(args.urls) ? args.urls.filter((url) => typeof url === "string" && url.length > 0) : void 0;
				try {
					await ensureReady();
					const result = await cuaLaunchApp(bin, {
						bundleId,
						name,
						urls,
						createsNewApplicationInstance: args.creates_new_application_instance === true,
						socket,
						webkitInspectorPort: Number.isInteger(args.webkit_inspector_port) ? args.webkit_inspector_port : void 0
					});
					const windows = Array.isArray(result.windows) ? result.windows : [];
					const state = result.launch_state ?? {};
					const launchState = state.window_ready === true && state.process_running === true ? "ready" : state.process_running === true ? "running" : "requested";
					const lines = [
						`<cua_launch pid="${String(result.pid ?? "")}" bundle_id="${String(result.bundle_id ?? "")}" name="${String(result.name ?? "")}" launch_state="${launchState}" process_running="${String(state.process_running ?? "")}" window_ready="${String(state.window_ready ?? "")}" self_activation_suppressed="${String(result.self_activation_suppressed ?? "")}" windows="${String(windows.length)}"/>`,
						...windows.slice(0, 5).map((window) => `  <window window_id="${String(window.window_id ?? "")}" pid="${String(window.pid ?? "")}" app="${String(window.app_name ?? "")}" title="${String(window.title ?? "")}" bounds="${String(window.bounds?.x ?? "")},${String(window.bounds?.y ?? "")} ${String(window.bounds?.width ?? "")}x${String(window.bounds?.height ?? "")}"/>`)
					];
					audit("cua_launch", { bundleId, name, urls: urls?.length ?? 0, pid: result.pid, suppressed: result.self_activation_suppressed });
					return { schemaVersion: SCHEMA_VERSION, text: lines.join("\n") };
				} catch (error) {
					throw wrapError(error);
				}
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
						// 0.118.0（视觉解析接入）：把驱动的 capture_id 透给模型，
						// 后续 cua_parse_visual / 视觉坐标点击都靠它对齐「这张截图」。
						captureId: { type: "string" },
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
					if (includeScreenshot === false || isCaptureConsentError(error) === false) {
						// 0.87.0：失败路径也要清掉临时截图（之前只在成功路径 rm，会残留窗口截图）
						await rm(dir, { recursive: true, force: true }).catch(() => void 0);
						throw wrapError(error);
					}
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
						// 0.116.0（审计 L10）：二次失败同样要清临时目录（首次失败路径 0.87.0 已修）
						await rm(dir, { recursive: true, force: true }).catch(() => void 0);
						throw wrapError(retryError);
					}
				}
				if (includeScreenshot === true && state.screenshot_error !== void 0) {
					const reason = state.screenshot_error.reason;
					note = typeof reason === "string" && reason.length > 0 ? `${SCREEN_RECORDING_HINT}\n${reason}` : SCREEN_RECORDING_HINT;
				}
				const summary = `<cua_window driver="cua-driver" window_id="${String(windowId)}" pid="${String(window.pid)}" app="${String(window.app_name ?? "")}" title="${String(window.title ?? "")}" snapshot_id="${String(state.snapshot_id ?? "")}" elements="${String(state.returned_element_count ?? state.element_count ?? 0)}/${String(state.total_element_count ?? state.element_count ?? 0)}" format="${String(state.tree_format ?? "markdown")}"/>`;
				let image;
				if (includeScreenshot === true && note === void 0) {
					try {
						const data = await readFile(screenshotPath);
						const info = imageInfo(data);
						const saved = await ctx.attachments.saveImage({ data, mediaType: info.mediaType, name: `cua-window-${String(windowId)}` });
						image = {
							attachmentId: String(saved.attachmentId),
							mediaType: info.mediaType,
							bytes: data.length,
							width: info.width,
							height: info.height
						};
					} catch (error) {
						note = `截图读取失败：${String(error?.message ?? error)}`;
					}
				}
				await rm(dir, { recursive: true, force: true }).catch(() => void 0);
				audit("cua_observe", { window_id: windowId, screenshot: image !== void 0, elements: Number(state.returned_element_count ?? 0) });
				// 同一窗口的树经常一字不差：连续两次相同就折叠成一行，省掉重复的 2–4KB。
				// 0.115.2（审计 M3）：key 必须带会话——两个会话看同一个窗口时，B 的第一份观察
				// 会被折叠成「跟上次一样」，而 B 从没见过那棵树。
				const sessionTag = String(exec?.agent?.id ?? exec?.agent?.sessionId ?? exec?.sessionId ?? exec?.session?.id ?? "");
				const tree = dedupeAxText(`cua:${sessionTag}:${String(windowId)}`, treeText(state));
				const text = [summary, tree].filter((part) => part.length > 0).join("\n");
				const result = { schemaVersion: SCHEMA_VERSION, windowId, text };
				// DSH 要求工具返回值是 lossless JSON：可选字段必须在有值时才出现，不能带 undefined。
				if (note !== void 0) result.note = note;
				if (image !== void 0) result.image = image;
				// 0.118.0：透传 capture_id 并提示低 AX 场景的下一步
				if (typeof state?.capture_id === "string" && state.capture_id !== "") result.captureId = state.capture_id;
				const emptyTree = Number(state?.returned_element_count ?? state?.element_count ?? 0) === 0 || typeof state?.degraded_reason === "string";
				if (emptyTree) {
					const hint = "AX 树为空/不可信（画布、游戏、远程桌面或自绘界面常见）——先用 ocr 读这张截图里的文字与坐标（零依赖、立即可用），再按坐标 click；需要图标级区域时用 cua_parse_visual（需可选的 cua-perception 扩展）";
					result.note = result.note === void 0 ? hint : `${String(result.note)}\n${hint}`;
				}
				return result;
			}
		})
	);

	ctx.tools.register(
		defineTool({
			name: "cua_parse_visual",
			description:
				"Parse one window screenshot into text/icon regions (local CPU, no network; needs the optional cua-perception extension). Use it when the AX tree is empty or untrustworthy — canvas, games, remote desktop, custom-drawn UI. Pass the capture_id from a recent cua_observe; the driver refuses captures older than 60s or already used for an action, so observe again if it is rejected. Click the returned x/y with cua_act (window-local screenshot pixels); the usual guards still apply.",
			parameters: {
				capture_id: { type: "string", description: "capture_id from cua_observe (preferred). Omit to take a fresh snapshot first (needs window_id)." },
				window_id: { type: "integer", description: "Window id used to take a fresh snapshot when capture_id is omitted." },
				kinds: { type: "array", items: { type: "string" }, description: "Region kinds to return: text / icon. Omit for all." },
				max_regions: { type: "integer", description: "Return at most this many regions." },
				min_confidence: { type: "number", description: "Drop regions below this confidence (0-1)." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						ok: { type: "boolean", required: true },
						text: { type: "string", required: true },
						captureId: { type: "string" },
						regions: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									kind: { type: "string" },
									text: { type: "string" },
									x: { type: "number" },
									y: { type: "number" },
									width: { type: "number" },
									height: { type: "number" },
									confidence: { type: "number" }
								}
							}
						}
					}
				},
				render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
			},
			isConcurrencySafe: () => false,
			presentCall: (args) => presentCall("Parse visual regions (cua)", args),
			async execute(args) {
				try {
					await ensureReady();
				} catch (error) {
					throw wrapError(error);
				}
				let captureId = typeof args.capture_id === "string" ? args.capture_id : "";
				if (captureId === "") {
					const windowId = positiveInt(args.window_id, "cua_parse_visual: window_id（未给 capture_id 时必填）");
					let windowsResult;
					try {
						windowsResult = await cuaListWindows(bin, { socket, onScreenOnly: false });
					} catch (error) {
						throw wrapError(error);
					}
					const window = findWindow(Array.isArray(windowsResult.windows) ? windowsResult.windows : [], windowId);
					let state;
					try {
						state = await cuaWindowState(bin, { pid: window.pid, windowId, includeScreenshot: true, maxElements: 1, socket });
					} catch (error) {
						throw wrapError(error);
					}
					captureId = typeof state?.capture_id === "string" ? state.capture_id : "";
					if (captureId === "") {
						return { schemaVersion: SCHEMA_VERSION, ok: false, text: "cua_parse_visual 失败：这次窗口快照没有返回 capture_id（驱动版本过旧？0.38 起才有）", regions: [] };
					}
				}
				const payload = { capture_id: captureId };
				const options = {};
				if (Array.isArray(args.kinds)) {
					const kinds = args.kinds.map(String).filter((kind) => kind === "text" || kind === "icon");
					if (kinds.length > 0) options.kinds = kinds;
				}
				if (Number.isInteger(args.max_regions) && args.max_regions > 0) options.max_regions = args.max_regions;
				if (Number.isFinite(args.min_confidence)) options.min_confidence = Math.min(1, Math.max(0, Number(args.min_confidence)));
				if (Object.keys(options).length > 0) payload.options = options;
				let raw;
				try {
					raw = await cuaCall(bin, "parse_visual_regions", payload, { socket, timeoutMs: 120000 });
				} catch (error) {
					const message = String(error?.message ?? error);
					audit("cua_parse_visual_failed", { error: message.slice(0, 200) });
					return { schemaVersion: SCHEMA_VERSION, ok: false, text: perceptionHint(message), captureId, regions: [] };
				}
				const regions = normalizeVisualRegions(raw);
				audit("cua_parse_visual", { regions: regions.length, capture: String(captureId).slice(0, 40) });
				if (regions.length === 0) {
					return { schemaVersion: SCHEMA_VERSION, ok: true, text: `视觉解析完成：没有识别出区域（${String(captureId)}）——换个更清晰的截图，或调低 min_confidence`, captureId, regions: [] };
				}
				const lines = regions.slice(0, 40).map((region, index) => {
					const box = region;
					const label = region.text === "" ? "" : ` "${region.text}"`;
					const conf = region.confidence > 0 ? ` conf=${region.confidence.toFixed(2)}` : "";
					return `[${String(index + 1)}] ${region.kind}${label} @ x=${String(box.x)} y=${String(box.y)} w=${String(box.width)} h=${String(box.height)}${conf}`;
				});
				const more = regions.length > 40 ? `\n…还有 ${String(regions.length - 40)} 个区域（用 max_regions 限制或调高 min_confidence）` : "";
				const text = `视觉区域 ${String(regions.length)} 个（capture ${String(captureId)}）：\n${lines.join("\n")}${more}\n坐标是窗口本地像素，直接用 cua_act {action:"click", x, y} 点击；危险控件与安全输入框仍会过守卫。`;
				return { schemaVersion: SCHEMA_VERSION, ok: true, text, captureId, regions };
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
				observe: { type: "boolean", default: true, description: "Attach an observe diff of the window after the action. Default: true." },
				// 0.116.0（审计 L8）：之前只在 output schema 里写了 confirm 的用途，参数表没有——
				// 模型看 schema 不知道能传，被守卫拒了还得猜参数名。
				confirm: { type: "boolean", default: false, description: "Guarded confirmation: pass true only after the user approved a quit/force-quit/logout shortcut or a destructive element click." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						schemaVersion: { type: "number", required: true },
						ok: { type: "boolean", required: true },
						confirm: {
							type: "boolean",
							description: "Guarded confirmation: pass true only after the user approved a quit/force-quit/logout shortcut or a destructive element click."
						},
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
				// 0.86.0：cua_act 也不能绕过快捷键守卫（meta/win 别名统一在 guard 里归一）
				if (action === "press_key" || action === "hotkey") {
					const keys = action === "hotkey"
						? (Array.isArray(args.keys) ? args.keys.map(String) : [])
						: [...(Array.isArray(args.modifiers) ? args.modifiers.map(String) : []), String(args.key ?? "")];
					// 0.116.1（审计 L5）：同上，尊重 config.guard 逃生门
					const verdict = guardHotkey(keys, args.confirm === true, config?.guard !== false);
					if (verdict.allowed !== true) {
						audit("cua_act_guarded", { action, keys: keys.join("+") });
						return { schemaVersion: SCHEMA_VERSION, ok: false, action, text: String(verdict.reason) };
					}
				}
				// 0.86.0：按元素名点击删除/支付类控件时也要确认
				// 0.115.0（审计 G3）：守卫要覆盖所有定位方式——element_token 去元素树里查标签，
				// x/y 走 AX hit-test；解析不到标签时 fail-closed（宁可要 confirm，也不盲点删除按钮）。
				if (action === "click" && args.confirm !== true) {
					const guardedClick = await resolveClickGuard(window, target, args, { bin, socket });
					const pointVerdict = guardPointTarget({
						role: guardedClick.role,
						title: guardedClick.labels[0] ?? "",
						description: guardedClick.labels.slice(1).join(" "),
						confirm: false,
						enabled: config?.guard !== false
					});
					if (pointVerdict.allowed !== true) {
						audit("cua_act_guarded", { action, label: guardedClick.labels.join(" ").slice(0, 60), secure: pointVerdict.secure === true });
						return { schemaVersion: SCHEMA_VERSION, ok: false, action, text: String(pointVerdict.reason) };
					}
					if (guardedClick.unresolved === true) {
						audit("cua_act_guarded", { action, unresolved: true });
						return {
							schemaVersion: SCHEMA_VERSION,
							ok: false,
							action,
							text: `这个 element_token 定位不到控件标签（${String(target.element_token ?? "")}），无法判断是否删除/支付类按钮——先 cua_observe 复核目标，或用户确认后传 confirm:true`
						};
					}
				}
				const step = buildStep(action, args, target);
				const deliveryMode = typeof args.delivery_mode === "string" && args.delivery_mode.length > 0 ? args.delivery_mode : "background";
				const observe = args.observe === false ? void 0 : { include_screenshot: false, include_accessibility_tree: true, max_elements: 60, since: "latest" };
				const runSteps = async (currentStep) => {
					try {
						return {
							result: await cuaRunSteps(bin, {
								pid: window.pid,
								windowId,
								steps: [currentStep],
								observe,
								deliveryMode,
								foregroundFallback: args.fallback_foreground === true,
								socket
							})
						};
					} catch (error) {
						return { error };
					}
				};
				let attempt = await runSteps(step);
				let retried = false;
				const token = typeof target.element_token === "string" ? target.element_token : void 0;
				if (token !== void 0 && isStaleTokenMessage(failureText(attempt.result, attempt.error))) {
					const index = staleTokenIndex(token);
					if (index !== void 0) {
						try {
							const freshToken = await reobserveElementToken(bin, {
								pid: window.pid,
								windowId,
								index,
								socket,
								expected: {
									...(typeof target.role === "string" ? { role: target.role } : {}),
									...(typeof target.name === "string" ? { name: target.name } : {})
								}
							});
							if (freshToken !== void 0) {
								retried = true;
								audit("cua_act_token_retry", { window_id: windowId, action });
								attempt = await runSteps({ tool: step.tool, args: { ...step.args, element_token: freshToken } });
							}
						} catch {
							// 保留首次失败结果
						}
					}
				}
				if (attempt.error !== void 0) throw wrapError(attempt.error);
				const result = attempt.result;
				const steps = Array.isArray(result.steps) ? result.steps : [];
				const failed = steps.find((entry) => entry?.ok === false);
				const ok = failed === void 0 && result.ok !== false;
				const observation = formatObservation(result.observe ?? result.observation);
				const header = `<cua_act window_id="${String(windowId)}" app="${String(window.app_name ?? "")}" action="${action}" delivery="${deliveryMode}" ok="${String(ok)}"${retried ? ' retried="true"' : ""}${result.foreground_fallback === true ? ' fallback="foreground"' : ""}/>`;
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

/** 解析 element_token 里的元素序号（`<snapshot_id>:N` 的 N）。 */
function staleTokenIndex(token) {
	const match = /^[A-Za-z0-9]+:(\d+)$/.exec(token);
	return match === null ? void 0 : Number(match[1]);
}

/** 是否是「快照/元素 token 过期」类错误。 */
function isStaleTokenMessage(message) {
	return /element_token is stale|no current snapshot|call get_window_state again/i.test(message);
}

/** 重新 observe 一次窗口并取回同序号元素的新 token。 */
async function reobserveElementToken(bin, { pid, windowId, index, socket, expected }) {
	const state = await cuaWindowState(bin, {
		pid,
		windowId,
		includeScreenshot: false,
		treeFormat: "elements",
		maxElements: 400,
		socket
	});
	const elements = Array.isArray(state.elements) ? state.elements : [];
	const match = elements.find((element) => Number(element?.element_index) === index);
	if (typeof match?.element_token !== "string" || match.element_token.length === 0) return void 0;
	// 0.92.0：AX 树变了以后同号元素可能已经换成另一个控件——role/name 不一致就别重试，宁可报过期。
	if (expected !== undefined && expected !== null) {
		const sameRole = expected.role === undefined || String(match.role ?? "") === String(expected.role);
		const sameName = expected.name === undefined || String(match.name ?? match.label ?? "") === String(expected.name);
		if (sameRole === false || sameName === false) return void 0;
	}
	return match.element_token;
}

/** 从 run_steps 失败结果或异常里取错误文本（异常含被截断前的完整 stdout/stderr）。 */
function failureText(result, error) {
	const parts = [];
	if (error instanceof Error) {
		parts.push(error.message);
		if (typeof error.stdout === "string") parts.push(error.stdout);
		if (typeof error.stderr === "string") parts.push(error.stderr);
	}
	const steps = Array.isArray(result?.steps) ? result.steps : [];
	for (const entry of steps) {
		if (typeof entry?.error === "string") parts.push(entry.error);
		else if (typeof entry?.message === "string") parts.push(entry.message);
	}
	return parts.join("\n");
}

/**
 * 把驱动返回的视觉区域规范化成统一结构（0.118.0）。
 * 字段名以装扩展后实测为准，这里兼容 regions/items/elements 与 frame/bbox/box 三种写法。
 */
function normalizeVisualRegions(raw) {
	const out = [];
	const push = (region) => {
		if (region === null || typeof region !== "object") return;
		const frame = region.frame ?? region.bbox ?? region.box ?? region;
		const x = Number(frame?.x);
		const y = Number(frame?.y);
		const width = Number(frame?.width ?? frame?.w);
		const height = Number(frame?.height ?? frame?.h);
		if ([x, y, width, height].some((value) => Number.isFinite(value) === false)) return;
		const confidence = Number(region.confidence ?? region.score ?? 0);
		out.push({
			kind: String(region.kind ?? region.type ?? "region").slice(0, 24),
			text: String(region.text ?? region.label ?? region.content ?? "").slice(0, 200),
			x, y, width, height,
			confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0
		});
	};
	let used = false;
	for (const key of ["regions", "items", "elements"]) {
		if (Array.isArray(raw?.[key])) { raw[key].forEach(push); used = true; break; }
	}
	if (used === false && raw?.regions !== null && typeof raw?.regions === "object") {
		for (const list of Object.values(raw.regions)) if (Array.isArray(list)) list.forEach(push);
	}
	if (out.length === 0 && Array.isArray(raw)) raw.forEach(push);
	return out;
}

/** 视觉解析失败时给模型/用户可执行的下一步（0.118.0）。 */
function perceptionHint(message) {
	const text = String(message ?? "").slice(0, 300);
	if (/capture_not_found|not installed|not_installed|perception|extension/i.test(text)) {
		return `perception 不可用：${text}
可能的三个原因（按可能性排）：
1) 通道不对 —— 官方文档明确：**一次性 \`cua-driver call\` 进程解析不了另一个进程的 capture_id**，
   需要持久的 MCP 连接或 SDK runtime 完成「观察 → 解析 → 点击」这一圈。本插件当前仍走一次性 call，
   因此在接入长连接之前，这个工具对真实 capture 会一直报 not found；
2) 扩展没装 / catalog 未发布 —— \`cua-driver extension install cua-perception --catalog <signed-catalog.json>\`；
   截至目前上游仍是 developer preview，官方 catalog 尚未发布，所以暂时装不上；
3) capture 过期或已被消费 —— 驱动拒绝复用超过 60s 或已用于动作的截图，重新 cua_observe 再试。`;
	}
	return `cua_parse_visual 失败：${text}`;
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

/**
 * 0.115.0（审计 G3）：click 前把「实际要点的控件标签」解析出来。
 * 之前只看 `target.name`——element_token（文档主推）和 x/y 两条路完全不经过守卫，
 * 删除/支付控件可以无 confirm 点下去。
 * @param {object} window cua-driver 的窗口条目（含 pid / window_id / bounds）
 * @param {object} target resolveTarget 的结果
 * @param {object} args cua_act 的原始参数
 * @param {object} io `{ bin, socket }`
 * @returns {Promise<{labels:string[], role?:string, secure?:boolean, unresolved?:boolean}>}
 */
async function resolveClickGuard(window, target, args, io) {
	const labels = [];
	let role;
	if (typeof target.name === "string" && target.name !== "") labels.push(target.name);
	if (typeof target.element_token === "string" && target.element_token.length > 0) {
		const index = staleTokenIndex(target.element_token);
		if (index === void 0) return { labels, role, unresolved: true };
		try {
			const state = await cuaWindowState(io.bin, {
				pid: window.pid,
				windowId: window.window_id,
				includeScreenshot: false,
				treeFormat: "elements",
				maxElements: 400,
				socket: io.socket
			});
			const elements = Array.isArray(state.elements) ? state.elements : [];
			const match = elements.find((element) => Number(element?.element_index) === index);
			if (match === void 0) return { labels, role, unresolved: true };
			const name = String(match.name ?? match.label ?? "");
			if (name !== "") labels.push(name);
			if (typeof match.role === "string") role = match.role;
		} catch {
			return { labels, role, unresolved: true };
		}
	}
	if (Number.isFinite(args.x) && Number.isFinite(args.y)) {
		const bounds = window.bounds ?? {};
		if (Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
			try {
				const hit = await hitTestPoint(bounds.x + Number(args.x), bounds.y + Number(args.y));
				if (hit !== void 0) {
					if (typeof hit.title === "string" && hit.title !== "") labels.push(hit.title);
					if (typeof hit.description === "string" && hit.description !== "") labels.push(hit.description);
					if (typeof hit.role === "string") role = hit.role;
					if (hit.secure === true) return { labels, role, secure: true };
				}
			} catch {
				// hit-test 拿不到就按「无标签」处理：坐标点击是低层兜底，不能因此全部拦死
			}
		}
	}
	return { labels, role };
}

/** 把 cua_act 的单个动作映射成 run_steps 的一步。 */
function buildStep(action, args, target) {
	const modifiers = Array.isArray(args.modifiers) ? args.modifiers.map(String) : void 0;
	if (action === "click") {
		const button = typeof args.button === "string" ? args.button : "left";
		const count = Number.isInteger(args.count) ? args.count : 1;
		const tool = button === "right" ? "right_click" : count >= 2 ? "double_click" : "click";
		const stepArgs = { ...target };
		// 0.116.0（审计 L9）：modifiers 对所有 click 派生工具都转发——之前只有普通 click 带，
		// 「cmd+双击」会静默变成普通双击，结果回给调用方还看不出来。
		if (modifiers !== void 0) stepArgs.modifier = modifiers;
		if (button !== "left" && button !== "right") stepArgs.button = button;
		if (count > 1) stepArgs.count = count;
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
function imageInfo(data) {
	// cua-driver 的 screenshot_out_file 实际写 PNG（文件名后缀不可信），按 magic bytes 判定。
	if (data.length > 24 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
		return { mediaType: "image/png", width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
	}
	const size = jpegDimensions(data) ?? { width: 0, height: 0 };
	return { mediaType: "image/jpeg", width: size.width, height: size.height };
}

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
