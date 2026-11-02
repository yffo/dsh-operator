// 浏览器自动化工具面（0.24.0）：把 cua-driver 的 browser_* 接成 operator 的原生能力。
//
// 为什么走 cua-driver 的 browser_*，而不是自己写 CDP：
// - cua-driver 已经实现了「绑定当前 Chrome 窗口 → 列出 tab → semantic 快照 → 按 ref 操作」
//   的完整链路，ref 会随快照失效，输入默认走 Input.dispatchMouseEvent（受信任事件，
//   不是 element.click() 那种合成点击）；
// - 它操作的是**用户自己的浏览器进程**，登录态/扩展/指纹都是真的；
// - 它把「需要授权的 attaching」做成显式状态（browser_consent_required /
//   browser_requires_setup / background_unavailable），我们只负责翻译成人话。
//
// 与既有 browser_dom_* 的分工：
// - browser_dom_*：AppleScript JS 通道，零重启、Safari 也能用，但事件是合成的（isTrusted=false）；
// - browser_*（本文件）：cua-driver 通道，refs + 受信任输入 + 导航/滚动/选择，适合高风控站点。
//
// 边界：
// - 需要 cua-driver ≥ 0.38；没装就静默不注册（DSH_OPERATOR_BROWSER=0 也可关）；
// - 绑定用户正在用的浏览器需要用户同意（cua-driver 会报 browser_consent_required /
//   browser_requires_setup，detail.next_call 指明下一步）；
// - 不读 Cookie/密码；不伪造指纹；不绕过验证码——遇到挑战就停下交给用户。

import { existsSync } from "node:fs";

import { audit } from "./audit-log.js";
import { dedupeByKey } from "./ax-dedupe.js";
import {
	CDP_UNAVAILABLE_HINT,
	collectConsole,
	collectNetwork,
	openPage,
	summarizeConsoleEntry,
	summarizeNetworkEntry,
	waitForNetworkIdle,
	waitForSelector
} from "./browser-cdp.js";
import { cuaCall, cuaSocketPath, ensureCuaDaemon, resolveCuaDriverBinary } from "./cua-driver.js";

const SCHEMA_VERSION = 1;

/** 注册的工具名（测试与 README 共用）。 */
export const BROWSER_TOOL_NAMES = Object.freeze([
	"browser_state",
	"browser_prepare",
	"browser_open",
	"browser_click",
	"browser_type",
	"browser_pointer",
	"browser_select",
	"browser_wait",
	"browser_console",
	"browser_network",
	"browser_key",
	"browser_dialog",
	"browser_download",
	"browser_set_input_files"
]);

/**
 * 同一页面连续快照的 refs 折叠说明：refs 通常 1–2KB，重复回传纯烧 token。
 * 页面变了（refs 文本变了）就自动回全文。
 */
export const REFS_UNCHANGED_NOTE =
	'<refs_unchanged>Same refs (same page state) as the previous snapshot; call browser_state again with query/snapshot_format if you need the full list.</refs_unchanged>';

/**
 * 把状态文本里的 refs 段做连续去重（纯函数，便于测试）。
 * @param {string} text summarizeState 的输出。
 * @param {object|undefined} result cua-driver 返回的状态对象。
 * @returns {string}
 */
export function dedupeStateText(text, result) {
	if (typeof text !== "string" || text === "") return text;
	const refs = Array.isArray(result?.refs) ? result.refs : [];
	if (refs.length === 0) return text;
	const marker = `refs (${refs.length}):`;
	const index = text.indexOf(marker);
	if (index < 0) return text;
	const refsPart = text.slice(index);
	// 小快照折叠后可能反而更长：只有 refs 段明显大于说明行时才折叠。
	if (refsPart.length < REFS_UNCHANGED_NOTE.length + 80) return text;
	const key = `refs:${String(result?.target_id ?? "")}:${String(result?.tab_id ?? "")}`;
	return text.slice(0, index) + dedupeByKey(key, refsPart, REFS_UNCHANGED_NOTE);
}

/** cua-driver 拒绝码 → 给模型下一步怎么做。 */
const HINTS = [
	["browser_consent_required", "浏览器还没绑定：先 browser_state(pid, window_id) 或 browser_prepare(pid, window_id) 取得授权。"],
	["browser_requires_setup", "这个浏览器还没接上：调用 browser_prepare(pid, window_id, delivery_mode:\"foreground\")（macOS 下的 Chrome 会弹一次自己的调试授权）。"],
	["background_unavailable", "后台姿态不可用：改用 browser_prepare(..., delivery_mode:\"foreground\")，或先把浏览器窗口切到当前 Space。"],
	["stale", "ref/快照已过期：重新 browser_state 拿最新 refs 再操作。"],
	["not_attached", "当前没有绑定的 tab：先 browser_state 绑定目标窗口。"],
	["no such tab", "tab_id 不存在：重新 browser_state 取最新 tab_id。"],
	["refused", "cua-driver 拒绝了该操作，按返回的 refusal.message 调整参数。"]
];

/**
 * 把 cua-driver 的错误文本映射成一句可执行提示。
 * @param {string} message
 * @returns {string | undefined}
 */
export function hintForBrowserError(message) {
	const text = String(message ?? "").toLowerCase();
	for (const [code, hint] of HINTS) if (text.includes(code)) return hint;
	return undefined;
}

/**
 * 哪类浏览器错误值得「自动重取快照」：ref 过期/快照被取代/元素找不到时，
 * 再附一份最新 refs 比让模型自己再调一次 browser_state 省一个来回。
 */
export function shouldRecoverWithSnapshot(message) {
	return /ref_stale|ref is stale|superseded|not found|找不到|stale/i.test(String(message ?? ""));
}

/** 紧凑 JSON：给模型看的兜底文本（保留结构，限制长度）。 */
export function compactJson(value, max = 6000) {
	let text;
	try {
		text = JSON.stringify(value);
	} catch {
		text = String(value);
	}
	return text.length > max ? `${text.slice(0, max)}…（已截断，可用更小的 limit 再取）` : text;
}

/** 从 browser_state 结果里挑出模型最需要的一行摘要。 */
export function summarizeState(result) {
	if (result === null || typeof result !== "object") return String(result ?? "");
	const tabs = Array.isArray(result.tabs) ? result.tabs : Array.isArray(result.targets) ? result.targets : [];
	const parts = [];
	if (typeof result.target_id === "string") parts.push(`target_id=${result.target_id}`);
	if (typeof result.tab_id === "string") parts.push(`tab_id=${result.tab_id}`);
	if (tabs.length > 0) {
		const rows = tabs.slice(0, 12).map((tab) => {
			const id = String(tab.tab_id ?? tab.id ?? "?");
			const title = String(tab.title ?? "").slice(0, 60);
			const url = String(tab.url ?? "").slice(0, 80);
			return `- ${id}${tab.active === true ? " (active)" : ""}: ${title}${url.length > 0 ? ` — ${url}` : ""}`;
		});
		parts.push(`tabs:\n${rows.join("\n")}`);
	}
	if (typeof result.text === "string" && result.text.trim() !== "") parts.push(result.text.trim());
	const refs = Array.isArray(result.refs) ? result.refs : [];
	if (refs.length > 0) {
		const rows = refs.slice(0, 40).map((item) => {
			const label = String(item.label ?? item.name ?? "").slice(0, 70);
			return `- ${item.ref} ${String(item.node ?? item.role ?? "?")}${label.length > 0 ? ` ${label}` : ""}`;
		});
		parts.push(`refs (${refs.length}):\n${rows.join("\n")}`);
	}
	if (typeof result.outline === "string" && result.outline.trim() !== "") parts.push(result.outline.trim());
	return parts.length > 0 ? parts.join("\n") : compactJson(result);
}

function presentCall(title, rawInput) {
	return { card: "generic", title, kind: "execute", rawInput };
}

/**
 * 注册浏览器工具；cua-driver 缺失时静默跳过。
 * @param {object} ctx 插件上下文（需 ctx.tools.register）
 * @param {object} config 本包配置（browserSession 可选）
 * @param {{ defineTool: Function, version?: string }} deps
 * @returns {{ registered: boolean, names: string[], reason?: string }}
 */
export function registerBrowserTools(ctx, config, deps) {
	const { defineTool } = deps;
	if (process.env.DSH_OPERATOR_BROWSER === "0") {
		console.warn("[dsh-operator] DSH_OPERATOR_BROWSER=0，跳过 browser_* 工具");
		return { registered: false, names: [], reason: "disabled" };
	}
	const bin = resolveCuaDriverBinary();
	if (bin === void 0) {
		console.warn("[dsh-operator] 未找到 cua-driver，跳过 browser_* 工具（browser_dom_* 仍可用）");
		return { registered: false, names: [], reason: "cua-driver not installed" };
	}
	const socket = cuaSocketPath();
	const session = typeof config?.browserSession === "string" && config.browserSession.length > 0 ? config.browserSession : "dsh-operator";
	let daemonReady = false;
	const ensureReady = async () => {
		if (daemonReady === true) return;
		await ensureCuaDaemon(bin, { socket });
		daemonReady = true;
	};

	/** 最近一次绑定的 target/tab，让后续 click/type 可以只传 ref。 */
	const bound = { targetId: undefined, tabId: undefined, pid: undefined };

	/** 把 target_id/tab_id 补成 cua-driver 需要的精确坐标。 */
	function bindings(args) {
		const targetId = typeof args.target_id === "string" && args.target_id.length > 0 ? args.target_id : bound.targetId;
		const tabId = typeof args.tab_id === "string" && args.tab_id.length > 0 ? args.tab_id : bound.tabId;
		return { targetId, tabId };
	}

	/**
	 * 调一个 cua-driver 浏览器工具。
	 * @returns {Promise<{ok:true, result:any} | {ok:false, error:string, hint?:string}>}
	 */
	async function call(tool, args, { timeoutMs = 60000 } = {}) {
		await ensureReady();
		const payload = { session, ...args };
		const invoke = (extra) => cuaCall(bin, tool, { ...payload, ...extra }, { socket, timeoutMs });
		try {
			const result = await invoke({});
			return { ok: true, result };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// cua-driver 在空闲/守护重启后会回收会话；这里自动重建一次再重试。
			if (/session has ended/i.test(message)) {
				try {
					await cuaCall(bin, "start_session", { session }, { socket, timeoutMs });
					const result = await invoke({});
					return { ok: true, result };
				} catch (retryError) {
					const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
					return { ok: false, error: retryMessage, hint: hintForBrowserError(retryMessage) };
				}
			}
			return { ok: false, error: message, hint: hintForBrowserError(message) };
		}
	}

	/** 统一失败输出。 */
	function failed(name, outcome) {
		audit(`browser_${name}_failed`, { error: outcome.error.slice(0, 300) });
		return {
			schemaVersion: SCHEMA_VERSION,
			ok: false,
			text: `browser_${name} 失败：${outcome.error}${outcome.hint === void 0 ? "" : `\n下一步：${outcome.hint}`}`
		};
	}

	/** 取一份最新快照文本（失败返回空串），供 ref 过期时自动补发。 */
	async function freshStateText() {
		if (typeof bound.targetId !== "string") return "";
		const outcome = await call("get_browser_state", { target_id: bound.targetId, tab_id: bound.tabId });
		if (outcome.ok !== true) return "";
		const result = outcome.result;
		if (typeof result.target_id === "string") bound.targetId = result.target_id;
		if (typeof result.tab_id === "string") bound.tabId = result.tab_id;
		return dedupeStateText(summarizeState(result), result);
	}

	/**
	 * 失败输出；ref 过期类错误额外附一份最新快照，模型可以直接用新 ref 继续。
	 */
	async function failedWithRecovery(name, outcome) {
		const base = failed(name, outcome);
		if (!shouldRecoverWithSnapshot(outcome.error)) return base;
		const text = await freshStateText();
		if (text === "") return base;
		return {
			schemaVersion: SCHEMA_VERSION,
			ok: false,
			text: `${base.text}\n已自动重新取快照（直接用下面的 ref 继续，不必再调 browser_state）：\n${text}`
		};
	}

	function succeeded(name, text, extra = {}) {
		audit(`browser_${name}`, { ok: true });
		return { schemaVersion: SCHEMA_VERSION, ok: true, text, ...extra };
	}

	const register = (definition) => ctx.tools.register(defineTool(definition));

	register({
		name: "browser_state",
		description:
			"Bind or snapshot a real browser through cua-driver. Bind: pass pid + window_id (from cua_windows) to get target_id/tab_id and a semantic snapshot with element refs (p<snapshot>:<index>). Snapshot: pass target_id + tab_id. Refs become stale after navigation or a newer snapshot, so re-read before clicking. Read-only; never opens a page or moves the pointer.",
		parameters: {
			pid: { type: "integer", description: "Browser process id (bind mode). Get it from cua_windows." },
			window_id: { type: "integer", description: "Browser window id (bind mode)." },
			target_id: { type: "string", description: "Target id from an earlier bind (snapshot mode)." },
			tab_id: { type: "string", description: "Tab id from an earlier snapshot (optional; defaults to the bound tab)." },
			include_screenshot: { type: "boolean", default: false, description: "Capture the exact tab viewport as PNG (extra tokens; off by default)." },
			snapshot_format: { type: "string", description: "dom_refs_v1 (default) or semantic_v2." },
			query: { type: "string", description: "Only keep elements whose role/name/text matches this query." }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "number", required: true }, ok: { type: "boolean", required: true }, text: { type: "string", required: true } } }, render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }] },
		isConcurrencySafe: () => true,
		presentCall: (args) => presentCall("Read browser state", args),
		async execute(args) {
			const params = {};
			if (Number.isInteger(args.pid) && Number.isInteger(args.window_id)) {
				params.pid = args.pid;
				params.window_id = args.window_id;
				bound.pid = args.pid;
				// cua-driver 要求显式策略：不传会以 browser_consent_required 拒绝。
				params.strategy = { kind: "existing_profile" };
			} else if (typeof args.target_id === "string" && args.target_id.length > 0) {
				params.target_id = args.target_id;
				params.tab_id = typeof args.tab_id === "string" && args.tab_id.length > 0 ? args.tab_id : bound.tabId;
			}
			if (args.include_screenshot === true) params.include_screenshot = true;
			if (args.snapshot_format === "semantic_v2" || args.snapshot_format === "dom_refs_v1") params.snapshot_format = args.snapshot_format;
			if (typeof args.query === "string" && args.query.length > 0) params.query = args.query;
			if (params.target_id === undefined && params.pid === undefined) {
				return { schemaVersion: SCHEMA_VERSION, ok: false, text: "browser_state 需要 pid+window_id（首次绑定）或 target_id（快照）" };
			}
			const outcome = await call("get_browser_state", params);
			if (outcome.ok !== true) return failed("state", outcome);
			const result = outcome.result;
			if (typeof result.target_id === "string") bound.targetId = result.target_id;
			if (typeof result.tab_id === "string") bound.tabId = result.tab_id;
			return succeeded("state", dedupeStateText(summarizeState(result), result));
		}
	});

	register({
		name: "browser_prepare",
		description:
			"Attach the browser tools to a running Chrome/Edge/Brave window (existing user profile, real logins). Call this when browser_state refuses with browser_consent_required or browser_requires_setup. On macOS Chrome this may briefly show Chrome's own remote-debugging prompt; delivery_mode:\"foreground\" accepts that.",
		parameters: {
			pid: { type: "integer", required: true, description: "Browser process id from cua_windows." },
			window_id: { type: "integer", required: true, description: "Browser window id from cua_windows." },
			delivery_mode: { type: "string", description: "background (default) or foreground." }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "number", required: true }, ok: { type: "boolean", required: true }, text: { type: "string", required: true } } }, render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }] },
		isConcurrencySafe: () => false,
		presentCall: (args) => presentCall("Attach browser", args),
		async execute(args) {
			const params = { pid: Number(args.pid), window_id: Number(args.window_id) };
			// 显式声明「接用户正在用的 profile」：cua-driver 对已有端点只做探测，
			// 不带 strategy 时 browser_prepare 只回 already_prepared，后续 get_browser_state 仍会被拒。
			params.strategy = { kind: "existing_profile" };
			if (typeof args.delivery_mode === "string" && args.delivery_mode.length > 0) params.delivery_mode = args.delivery_mode;
			const outcome = await call("browser_prepare", params);
			if (outcome.ok !== true) return failed("prepare", outcome);
			return succeeded("prepare", `已绑定 pid=${params.pid} window=${params.window_id}\n${compactJson(outcome.result, 2000)}`);
		}
	});

	register({
		name: "browser_open",
		description:
			"Navigate the bound tab (or a given tab_id) to an http(s)/about URL through the attached real browser. Navigation invalidates all element refs for that tab; call browser_state afterwards.",
		parameters: {
			url: { type: "string", required: true, description: "Absolute http:// or https:// URL (or about:blank)." },
			tab_id: { type: "string", description: "Tab id; defaults to the bound tab." },
			target_id: { type: "string", description: "Target id; defaults to the bound target." }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "number", required: true }, ok: { type: "boolean", required: true }, text: { type: "string", required: true } } }, render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }] },
		isConcurrencySafe: () => false,
		presentCall: (args) => presentCall("Open URL", args),
		async execute(args) {
			const url = String(args.url ?? "");
			if (!/^(https?:|about:)/i.test(url)) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "browser_open 只接受 http(s):// 或 about: 开头的 URL" };
			const { targetId, tabId } = bindings(args);
			if (targetId === undefined || tabId === undefined) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "还没有绑定 tab：先 browser_state(pid, window_id) 或 browser_prepare" };
			const outcome = await call("browser_navigate", { target_id: targetId, tab_id: tabId, url });
			if (outcome.ok !== true) return failed("open", outcome);
			return succeeded("open", `已打开 ${url}（tab ${tabId}）；ref 已失效，重新 browser_state`);
		}
	});

	register({
		name: "browser_click",
		description:
			"Click one element in the bound tab by semantic ref from browser_state. Default route is trusted input (CDP Input.dispatchMouseEvent, hardware-like); pass input_route:\"dom_event\" only when a synthetic DOM click is explicitly acceptable. Never click destructive targets (删除/支付/发送/退出) without the user's confirmation.",
		parameters: {
			ref: { type: "string", required: true, description: "Element ref from browser_state, e.g. p1:12." },
			target_id: { type: "string", description: "Target id; defaults to the bound target." },
			tab_id: { type: "string", description: "Tab id; defaults to the bound tab." },
			input_route: { type: "string", description: "trusted (default) or dom_event." },
			button: { type: "string", description: "left (default), right, middle." },
			count: { type: "integer", description: "Click count (default 1)." },
			confirm: { type: "boolean", description: "Pass true when the user has confirmed a destructive target." }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "number", required: true }, ok: { type: "boolean", required: true }, text: { type: "string", required: true } } }, render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }] },
		isConcurrencySafe: () => false,
		presentCall: (args) => presentCall("Click element", args),
		async execute(args) {
			const ref = String(args.ref ?? "");
			if (ref.length === 0) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "browser_click 需要 ref（来自 browser_state）" };
			const { targetId, tabId } = bindings(args);
			if (targetId === undefined || tabId === undefined) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "还没有绑定 tab：先 browser_state(pid, window_id)" };
			const params = { ref, target_id: targetId, tab_id: tabId };
			const route = String(args.input_route ?? "");
			if (route === "trusted" || route === "dom_event") params.input_route = route;
			if (typeof args.button === "string") params.button = args.button;
			if (Number.isInteger(args.count) && args.count > 1) params.count = args.count;
			const outcome = await call("browser_click", params);
			if (outcome.ok !== true) {
				if (args.confirm !== true) {
					return failedWithRecovery("click", { ...outcome, hint: `${outcome.hint ?? "检查 ref 是否过期"}；若是删除/支付/发送类按钮，先向用户确认再传 confirm:true` });
				}
				return failedWithRecovery("click", outcome);
			}
			return succeeded("click", `已点击 ${ref}${args.confirm === true ? "（用户已确认）" : ""}`);
		}
	});

	register({
		name: "browser_type",
		description:
			"Type into an editable element in the bound tab by ref. mode=insert_text (default) is a bulk Input.insertText; mode=keystrokes sends per-character key events (slower, closer to human). Pass replace:true to clear the field first.",
		parameters: {
			ref: { type: "string", required: true, description: "Editable element ref from browser_state." },
			target_id: { type: "string", description: "Target id; defaults to the bound target." },
			tab_id: { type: "string", description: "Tab id; defaults to the bound tab." },
			text: { type: "string", required: true, description: "Text to type (empty string with replace:true clears the field)." },
			replace: { type: "boolean", default: false, description: "Replace the field content instead of appending." },
			mode: { type: "string", description: "insert_text (default) or keystrokes." }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "number", required: true }, ok: { type: "boolean", required: true }, text: { type: "string", required: true } } }, render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }] },
		isConcurrencySafe: () => false,
		presentCall: (args) => presentCall("Type into element", args),
		async execute(args) {
			const ref = String(args.ref ?? "");
			if (ref.length === 0) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "browser_type 需要 ref（来自 browser_state）" };
			const { targetId, tabId } = bindings(args);
			if (targetId === undefined || tabId === undefined) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "还没有绑定 tab：先 browser_state(pid, window_id)" };
			const params = { ref, target_id: targetId, tab_id: tabId, text: String(args.text ?? "") };
			if (args.replace === true) params.replace = true;
			if (args.mode === "keystrokes" || args.mode === "insert_text") params.mode = args.mode;
			const outcome = await call("browser_type", params);
			if (outcome.ok !== true) return failedWithRecovery("type", outcome);
			return succeeded("type", `已输入 ${params.text.length} 个字符`);
		}
	});

	register({
		name: "browser_pointer",
		description:
			"Hover, right-click, double-click, scroll or drag inside the bound tab. Scroll needs delta_y (negative scrolls down like a mouse wheel). Never brings the tab to the foreground.",
		parameters: {
			action: { type: "string", required: true, description: "hover | right_click | double_click | scroll | drag" },
			ref: { type: "string", description: "Target element ref (required for hover/right_click/double_click/drag)." },
			target_id: { type: "string", description: "Target id; defaults to the bound target." },
			tab_id: { type: "string", description: "Tab id; defaults to the bound tab." },
			delta_x: { type: "integer", description: "Scroll delta X (optional)." },
			delta_y: { type: "integer", description: "Scroll delta Y (negative scrolls down)." },
			to_ref: { type: "string", description: "Drag destination ref." },
			to_x: { type: "integer", description: "Drag destination viewport X." },
			to_y: { type: "integer", description: "Drag destination viewport Y." }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "number", required: true }, ok: { type: "boolean", required: true }, text: { type: "string", required: true } } }, render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }] },
		isConcurrencySafe: () => false,
		presentCall: (args) => presentCall("Pointer gesture", args),
		async execute(args) {
			const action = String(args.action ?? "");
			const { targetId, tabId } = bindings(args);
			if (targetId === undefined || tabId === undefined) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "还没有绑定 tab：先 browser_state(pid, window_id)" };
			const params = { action, target_id: targetId, tab_id: tabId };
			if (typeof args.ref === "string" && args.ref.length > 0) params.ref = args.ref;
			if (Number.isInteger(args.delta_x)) params.delta_x = args.delta_x;
			if (Number.isInteger(args.delta_y)) params.delta_y = args.delta_y;
			if (typeof args.to_ref === "string" && args.to_ref.length > 0) params.to_ref = args.to_ref;
			if (Number.isInteger(args.to_x)) params.to_x = args.to_x;
			if (Number.isInteger(args.to_y)) params.to_y = args.to_y;
			if (params.ref === undefined && action !== "scroll") return { schemaVersion: SCHEMA_VERSION, ok: false, text: `browser_pointer:${action} 需要 ref` };
			if (action === "scroll" && params.delta_x === undefined && params.delta_y === undefined) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "browser_pointer:scroll 需要 delta_x 或 delta_y" };
			const outcome = await call("browser_pointer", params);
			if (outcome.ok !== true) return failedWithRecovery("pointer", outcome);
			return succeeded("pointer", `已执行 ${action}${outcome.result === undefined ? "" : `\n${compactJson(outcome.result, 1200)}`}`);
		}
	});

	register({
		name: "browser_select",
		description: "Select one option of a native <select> by ref in the bound tab, matching exactly one option by label or value. Dispatches synthetic input/change events; verify the page reacted.",
		parameters: {
			ref: { type: "string", required: true, description: "Select element ref from browser_state." },
			target_id: { type: "string", description: "Target id; defaults to the bound target." },
			tab_id: { type: "string", description: "Tab id; defaults to the bound tab." },
			label: { type: "string", description: "Exact visible option label." },
			value: { type: "string", description: "Exact option value." }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "number", required: true }, ok: { type: "boolean", required: true }, text: { type: "string", required: true } } }, render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }] },
		isConcurrencySafe: () => false,
		presentCall: (args) => presentCall("Select option", args),
		async execute(args) {
			const ref = String(args.ref ?? "");
			const hasLabel = typeof args.label === "string" && args.label.length > 0;
			const hasValue = typeof args.value === "string" && args.value.length > 0;
			if (ref.length === 0 || hasLabel === hasValue) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "browser_select 需要 ref，并且 label/value 二选一" };
			const { targetId, tabId } = bindings(args);
			if (targetId === undefined || tabId === undefined) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "还没有绑定 tab：先 browser_state(pid, window_id)" };
			const params = { ref, target_id: targetId, tab_id: tabId };
			if (hasLabel) params.label = String(args.label);
			if (hasValue) params.value = String(args.value);
			const outcome = await call("browser_select", params);
			if (outcome.ok !== true) return failedWithRecovery("select", outcome);
			return succeeded("select", `已选择 ${hasLabel ? `label=${params.label}` : `value=${params.value}`}`);
		}
	});

	register({
		name: "browser_dialog",
		description: "Inspect or resolve a page JavaScript dialog (alert/confirm/prompt/beforeunload) in the bound tab. action=inspect returns a dialog_id; accept/dismiss need that exact id. Use this instead of guessing what an alert says.",
		parameters: {
			action: { type: "string", required: true, description: "inspect | accept | dismiss" },
			dialog_id: { type: "string", description: "Opaque dialog id from action=inspect; required for accept/dismiss." },
			prompt_text: { type: "string", description: "Text for a prompt dialog (accept only)." },
			target_id: { type: "string", description: "Target id; defaults to the bound target." },
			tab_id: { type: "string", description: "Tab id; defaults to the bound tab." }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "number", required: true }, ok: { type: "boolean", required: true }, text: { type: "string", required: true } } }, render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }] },
		isConcurrencySafe: () => false,
		presentCall: (args) => presentCall("Browser dialog", args),
		async execute(args) {
			const action = String(args.action ?? "");
			if (["inspect", "accept", "dismiss"].includes(action) === false) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "browser_dialog: action 必须是 inspect/accept/dismiss" };
			const { targetId, tabId } = bindings(args);
			if (targetId === undefined || tabId === undefined) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "还没有绑定 tab：先 browser_state(pid, window_id)" };
			const params = { action, target_id: targetId, tab_id: tabId };
			if (typeof args.dialog_id === "string" && args.dialog_id.length > 0) params.dialog_id = args.dialog_id;
			if (action !== "inspect" && params.dialog_id === undefined) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "browser_dialog: accept/dismiss 需要先 inspect 拿 dialog_id" };
			if (typeof args.prompt_text === "string" && args.prompt_text.length > 0) params.prompt_text = args.prompt_text;
			const outcome = await call("browser_dialog", params);
			if (outcome.ok !== true) return failed("dialog", outcome);
			return succeeded("dialog", `dialog ${action}: ${compactJson(outcome.result, 600)}`);
		}
	});

	register({
		name: "browser_download",
		description: "Trigger one download by activating a live page ref and save it inside an absolute, existing directory. Needs confirm:true (writes a file). Refuses stale refs; never returns the source URL or saved filename.",
		parameters: {
			ref: { type: "string", required: true, description: "Live page ref that starts the download (e.g. a link's ref)." },
			destination_root: { type: "string", required: true, description: "Absolute existing directory to save into." },
			confirm: { type: "boolean", description: "Must be true to actually download." },
			target_id: { type: "string", description: "Target id; defaults to the bound target." },
			tab_id: { type: "string", description: "Tab id; defaults to the bound tab." }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "number", required: true }, ok: { type: "boolean", required: true }, text: { type: "string", required: true } } }, render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }] },
		isConcurrencySafe: () => false,
		presentCall: (args) => presentCall("Download", args),
		async execute(args) {
			if (args.confirm !== true) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "browser_download 会写文件：确认后带 confirm:true 再调" };
			const ref = String(args.ref ?? "");
			const root = String(args.destination_root ?? "");
			if (ref.length === 0 || root.startsWith("/") === false) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "browser_download 需要 ref 和绝对路径 destination_root" };
			const { targetId, tabId } = bindings(args);
			if (targetId === undefined || tabId === undefined) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "还没有绑定 tab：先 browser_state(pid, window_id)" };
			const outcome = await call("browser_download", { session, ref, destination_root: root, target_id: targetId, tab_id: tabId }, { timeoutMs: 120000 });
			if (outcome.ok !== true) return failed("download", outcome);
			return succeeded("download", `已下载到 ${root}（${compactJson(outcome.result, 400)}）`);
		}
	});

	register({
		name: "browser_set_input_files",
		description: "Assign absolute local file paths to a live <input type=file> ref (bypasses the native picker). Regular files only; 1–32 paths.",
		parameters: {
			ref: { type: "string", required: true, description: "The file input's ref from browser_state." },
			files: { type: "array", items: { type: "string" }, required: true, description: "Absolute paths of 1–32 local regular files." },
			target_id: { type: "string", description: "Target id; defaults to the bound target." },
			tab_id: { type: "string", description: "Tab id; defaults to the bound tab." }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "number", required: true }, ok: { type: "boolean", required: true }, text: { type: "string", required: true } } }, render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }] },
		isConcurrencySafe: () => false,
		presentCall: (args) => presentCall("Set input files", args),
		async execute(args) {
			const ref = String(args.ref ?? "");
			const files = Array.isArray(args.files) ? args.files.map((entry) => String(entry)) : [];
			if (ref.length === 0 || files.length === 0) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "browser_set_input_files 需要 ref 和 files" };
			const bad = files.find((entry) => entry.startsWith("/") === false || existsSync(entry) === false);
			if (bad !== undefined) return { schemaVersion: SCHEMA_VERSION, ok: false, text: `文件必须是存在的绝对路径：${bad}` };
			const { targetId, tabId } = bindings(args);
			if (targetId === undefined || tabId === undefined) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "还没有绑定 tab：先 browser_state(pid, window_id)" };
			const outcome = await call("browser_set_input_files", { session, ref, files, target_id: targetId, tab_id: tabId });
			if (outcome.ok !== true) return failed("set_input_files", outcome);
			return succeeded("set_input_files", `已设置 ${String(files.length)} 个文件到 ${ref}`);
		}
	});

	/**
	 * CDP 端口：参数优先，其次插件配置；0 表示未开启。
	 * @param {object} args
	 * @returns {number}
	 */
	function cdpPort(args) {
		if (Number.isInteger(args.port) && args.port > 0) return args.port;
		const configured = Number(config?.browserCdpPort ?? 0);
		return Number.isInteger(configured) && configured > 0 ? configured : 0;
	}

	/** CDP 不可用时的统一说明。 */
	function cdpDisabled(port) {
		const detail = port === 0 ? "当前 browserCdpPort=0（未开启）。" : `当前 browserCdpPort=${String(port)}。`;
		return { schemaVersion: SCHEMA_VERSION, ok: false, text: `CDP 后端不可用：${CDP_UNAVAILABLE_HINT}\n${detail}` };
	}

	const cdpOutput = {
		schema: { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "number", required: true }, ok: { type: "boolean", required: true }, text: { type: "string", required: true } } },
		render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
	};

	register({
		name: "browser_wait",
		description:
			"Wait through the CDP backend (requires browserCdpPort and a Chrome started with --remote-debugging-port). With `selector`: wait until that element exists (add `visible: true` to require it be rendered); without it: wait for readyState=complete and network idle. Optionally pick the tab by url_contains/title_contains/index. Read-only; use after navigation before clicking.",
		parameters: {
			port: { type: "integer", description: "CDP port; defaults to browserCdpPort from config." },
			url_contains: { type: "string", description: "Pick the tab whose URL contains this text." },
			title_contains: { type: "string", description: "Pick the tab whose title contains this text." },
			index: { type: "integer", description: "Pick the nth matching page target (0-based)." },
			timeout_ms: { type: "integer", description: "Overall wait budget in ms (default 15000)." },
			idle_ms: { type: "integer", description: "How long the network must stay idle (default 500)." },
			selector: { type: "string", description: "Wait until this CSS selector exists instead of waiting for network idle." },
			visible: { type: "boolean", default: false, description: "With selector: require the element to be rendered (non-zero box, not display:none/visibility:hidden)." }
		},
		output: cdpOutput,
		isConcurrencySafe: () => true,
		presentCall: (args) => presentCall("Wait for page", args),
		async execute(args) {
			const port = cdpPort(args);
			if (port === 0) return cdpDisabled(port);
			const opened = await openPage(port, {
				urlContains: typeof args.url_contains === "string" ? args.url_contains : undefined,
				titleContains: typeof args.title_contains === "string" ? args.title_contains : undefined,
				index: Number.isInteger(args.index) ? args.index : undefined
			});
			if (opened.ok !== true) return { schemaVersion: SCHEMA_VERSION, ok: false, text: `browser_wait 失败：${opened.error}\n${CDP_UNAVAILABLE_HINT}` };
			try {
				const timeoutMs = Number.isInteger(args.timeout_ms) ? args.timeout_ms : 15000;
				if (typeof args.selector === "string" && args.selector.trim() !== "") {
					const found = await waitForSelector(opened.client, args.selector, { timeoutMs, visible: args.visible === true });
					if (found.ok !== true) return { schemaVersion: SCHEMA_VERSION, ok: false, text: `browser_wait 失败：${String(found.error ?? "未知错误")}` };
					audit("browser_wait", { ok: true, selector: true });
					return { schemaVersion: SCHEMA_VERSION, ok: true, text: `元素已出现：${args.selector}${found.visible === true ? "（可见）" : ""}，用时 ${String(found.elapsedMs)}ms` };
				}
				const idleMs = Number.isInteger(args.idle_ms) ? args.idle_ms : 500;
				const waited = await waitForNetworkIdle(opened.client, { timeoutMs, idleMs });
				if (waited.ok !== true) return { schemaVersion: SCHEMA_VERSION, ok: false, text: `browser_wait 失败：${String(waited.error ?? "未知错误")}` };
				audit("browser_wait", { ok: true });
				return { schemaVersion: SCHEMA_VERSION, ok: true, text: `页面就绪：${String(waited.url ?? opened.target?.url ?? "")}（readyState=${String(waited.readyState ?? "complete")}，空闲 ${String(waited.idleMs ?? 0)}ms）` };
			} finally {
				opened.client.close();
			}
		}
	});

	register({
		name: "browser_console",
		description:
			"Collect console errors/warnings and uncaught exceptions for a short window through the CDP backend (requires browserCdpPort + --remote-debugging-port). Read-only; returns at most a few recent entries.",
		parameters: {
			port: { type: "integer", description: "CDP port; defaults to browserCdpPort from config." },
			url_contains: { type: "string", description: "Pick the tab whose URL contains this text." },
			index: { type: "integer", description: "Pick the nth matching page target (0-based)." },
			duration_ms: { type: "integer", description: "Collection window in ms (default 3000)." },
			limit: { type: "integer", description: "Max entries (default 20)." },
			reload: { type: "boolean", default: false, description: "Reload the page first so load-time errors are captured (changes page state; off by default)." }
		},
		output: cdpOutput,
		isConcurrencySafe: () => true,
		presentCall: (args) => presentCall("Read console", args),
		async execute(args) {
			const port = cdpPort(args);
			if (port === 0) return cdpDisabled(port);
			const opened = await openPage(port, {
				urlContains: typeof args.url_contains === "string" ? args.url_contains : undefined,
				index: Number.isInteger(args.index) ? args.index : undefined
			});
			if (opened.ok !== true) return { schemaVersion: SCHEMA_VERSION, ok: false, text: `browser_console 失败：${opened.error}\n${CDP_UNAVAILABLE_HINT}` };
			try {
				const durationMs = Number.isInteger(args.duration_ms) ? args.duration_ms : 3000;
				const limit = Number.isInteger(args.limit) ? args.limit : 20;
				const collected = await collectConsole(opened.client, { durationMs, limit, reload: args.reload === true });
				const lines = collected.entries.map((entry) => summarizeConsoleEntry(entry));
				audit("browser_console", { ok: true, count: lines.length });
				return { schemaVersion: SCHEMA_VERSION, ok: true, text: lines.length === 0 ? `控制台干净（${String(durationMs)}ms 内没有 error/warning）` : `控制台 ${String(lines.length)} 条：\n${lines.join("\n")}` };
			} finally {
				opened.client.close();
			}
		}
	});

	register({
		name: "browser_network",
		description:
			"Collect failed requests and 4xx/5xx responses for a short window through the CDP backend (requires browserCdpPort + --remote-debugging-port). Read-only.",
		parameters: {
			port: { type: "integer", description: "CDP port; defaults to browserCdpPort from config." },
			url_contains: { type: "string", description: "Pick the tab whose URL contains this text." },
			index: { type: "integer", description: "Pick the nth matching page target (0-based)." },
			duration_ms: { type: "integer", description: "Collection window in ms (default 3000)." },
			limit: { type: "integer", description: "Max entries (default 20)." }
		},
		output: cdpOutput,
		isConcurrencySafe: () => true,
		presentCall: (args) => presentCall("Read network", args),
		async execute(args) {
			const port = cdpPort(args);
			if (port === 0) return cdpDisabled(port);
			const opened = await openPage(port, {
				urlContains: typeof args.url_contains === "string" ? args.url_contains : undefined,
				index: Number.isInteger(args.index) ? args.index : undefined
			});
			if (opened.ok !== true) return { schemaVersion: SCHEMA_VERSION, ok: false, text: `browser_network 失败：${opened.error}\n${CDP_UNAVAILABLE_HINT}` };
			try {
				const durationMs = Number.isInteger(args.duration_ms) ? args.duration_ms : 3000;
				const limit = Number.isInteger(args.limit) ? args.limit : 20;
				const collected = await collectNetwork(opened.client, { durationMs, limit, reload: args.reload === true });
				const lines = collected.entries.map((entry) => summarizeNetworkEntry(entry));
				audit("browser_network", { ok: true, count: lines.length });
				return { schemaVersion: SCHEMA_VERSION, ok: true, text: lines.length === 0 ? `网络正常（${String(durationMs)}ms 内没有失败请求）` : `失败请求 ${String(lines.length)} 条：\n${lines.join("\n")}` };
			} finally {
				opened.client.close();
			}
		}
	});

	register({
		name: "browser_key",
		description:
			"Press one key (or a modifier combo) at the browser process through cua-driver: Enter to submit a search, Tab to move focus, Escape to dismiss. Needs the browser pid — remembered from browser_state(pid, window_id) or passed explicitly. Sends real key events; focus must be in the page (click the field first).",
		parameters: {
			key: { type: "string", required: true, description: "Key name: return, tab, escape, up/down/left/right, space, delete, home, end, pageup, pagedown, f1-f12, a letter or digit." },
			modifiers: { type: "array", items: { type: "string" }, description: "Optional modifiers: cmd, shift, option/alt, ctrl, fn. Order matters only for readability." },
			pid: { type: "integer", description: "Browser pid; defaults to the pid remembered from browser_state." },
			delivery_mode: { type: "string", description: "background (default, no focus steal) or foreground." }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "number", required: true }, ok: { type: "boolean", required: true }, text: { type: "string", required: true } } }, render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }] },
		isConcurrencySafe: () => false,
		presentCall: (args) => presentCall("Press key", args),
		async execute(args) {
			const key = String(args.key ?? "").toLowerCase();
			if (key.length === 0) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "browser_key 需要 key（如 return / tab / escape）" };
			const pid = Number.isInteger(args.pid) ? args.pid : bound.pid;
			if (!Number.isInteger(pid)) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "还没有绑定浏览器 pid：先 browser_state(pid, window_id)，或显式传 pid" };
			const delivery = args.delivery_mode === "foreground" ? "foreground" : "background";
			const modifiers = Array.isArray(args.modifiers) ? args.modifiers.filter((m) => typeof m === "string" && m.length > 0) : [];
			const outcome =
				modifiers.length === 0
					? await call("press_key", { pid, key, delivery_mode: delivery }, { timeoutMs: 30000 })
					: await call("hotkey", { pid, keys: [...modifiers, key], delivery_mode: delivery }, { timeoutMs: 30000 });
			if (outcome.ok !== true) return failed("key", outcome);
			const effect = typeof outcome.result?.effect === "string" ? outcome.result.effect : "sent";
			audit("browser_key", { ok: true, key, modifiers: modifiers.length });
			return { schemaVersion: SCHEMA_VERSION, ok: true, text: `已发送 ${[...modifiers, key].join("+")}（${delivery}，effect=${effect}）；按键不可回读，必要时用 browser_state 复核。` };
		}
	});

	audit("browser_tools_registered", { names: BROWSER_TOOL_NAMES.length, session });
	return { registered: true, names: [...BROWSER_TOOL_NAMES] };
}
