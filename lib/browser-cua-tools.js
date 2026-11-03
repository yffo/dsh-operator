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

import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

import { audit } from "./audit-log.js";
import { dedupeByKey } from "./ax-dedupe.js";
import {
	CDP_UNAVAILABLE_HINT,
	collectConsole,
	consoleEntryLevel,
	collectNetwork,
	openPage,
	readInteractiveText,
	readPageText,
	redactUrl,
	summarizeConsoleEntry,
	summarizeNetworkEntry,
	waitForNetworkIdle,
	waitForSelector,
	waitForText
} from "./browser-cdp.js";
import { cuaCall, cuaSocketPath, ensureCuaDaemon, resolveCuaDriverBinary } from "./cua-driver.js";
import { closeBrowser, launchBrowser } from "./browser-launch.js";
import { guardHotkey, guardTitlePress } from "./guard.js";
import { classifyFailure, recordFailure } from "./failure-store.js";

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
	"browser_set_input_files",
	"browser_read",
	"browser_launch",
	"browser_close"
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
export function dedupeStateText(text, result, sessionKey = "") {
	if (typeof text !== "string" || text === "") return text;
	const refs = Array.isArray(result?.refs) ? result.refs : [];
	if (refs.length === 0) return text;
	const marker = `refs (${refs.length}):`;
	const index = text.indexOf(marker);
	if (index < 0) return text;
	const refsPart = text.slice(index);
	// 小快照折叠后可能反而更长：只有 refs 段明显大于说明行时才折叠。
	if (refsPart.length < REFS_UNCHANGED_NOTE.length + 80) return text;
	// 0.115.2（审计 M3）：key 带上会话标识。之前只有 target/tab，两个会话共用同一个浏览器窗口时，
	// B 的第一份快照会被折叠成「Same refs as the previous snapshot」——而 B 从没见过这些 refs。
	const key = `refs:${String(sessionKey)}:${String(result?.target_id ?? "")}:${String(result?.tab_id ?? "")}`;
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
function formatBytes(bytes) {
	if (!Number.isFinite(bytes) || bytes < 0) return "?";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 目录快照：只记文件名与大小/修改时间，便于下载后判断新增了哪些文件（不读内容）。 */
function snapshotDirectory(root) {
	const files = new Map();
	let names = [];
	try {
		names = readdirSync(root).slice(0, 500);
	} catch {
		return files;
	}
	for (const name of names) {
		try {
			const info = statSync(join(root, name));
			if (info.isFile()) files.set(name, { size: info.size, mtimeMs: info.mtimeMs });
		} catch {
			// 忽略读取失败的条目
		}
	}
	return files;
}

function diffDirectory(before, after) {
	const fresh = [];
	for (const [name, info] of after.entries()) {
		const previous = before.get(name);
		if (previous === undefined || previous.size !== info.size || previous.mtimeMs !== info.mtimeMs) {
			fresh.push({ name, size: info.size });
		}
	}
	return fresh.sort((left, right) => right.size - left.size);
}

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
const INTERACTIVE_ROLES = new Set(["a", "link", "button", "textbox", "input", "textarea", "checkbox", "radio", "combobox", "select", "menuitem", "tab", "option", "searchbox"]);

/**
 * 这个 ref 是否是可交互控件（给 interactive_only 过滤用）。
 * @param {{ node?: string, role?: string }} item cua-driver 的 ref 项。
 * @returns {boolean}
 */
export function isInteractiveRef(item) {
	const role = String(item?.role ?? item?.node ?? "").toLowerCase();
	return INTERACTIVE_ROLES.has(role);
}

/** ref → 元素标签缓存（0.86.0）：点击前用它判断目标是不是删除/支付类控件。 */
const REF_LABELS = new Map();

/**
 * 0.117.1（审计未证实 #1 的防御性修复）：缓存 key 带上 target/tab。
 * 驱动的 ref（如 p1:12）是否跨 tab 唯一在仓库里没有保证；带目标维度后，
 * 即使两个标签页复用同一个 ref 前缀，也不会把旧标签套到新元素上。
 */
function refLabelKey(ref, source) {
	return `${String(source?.target_id ?? "")}:${String(source?.tab_id ?? "")}:${String(ref)}`;
}

// 0.116.1（审计 L4）：凭据目录黑名单——上传（0.91.0）与下载落点共用同一份。
const SENSITIVE_PATH_PATTERNS = [/\.ssh(\/|$)/i, /\.gnupg(\/|$)/i, /Keychains(\/|$)/i, /\.aws\/credentials/i, /\.config\/gh\/hosts\.yml/i];

/**
 * 记住本次快照的 ref → label，供点击守卫使用（0.86.0）。
 * @param {object} result 驱动返回的状态
 */
export function rememberRefLabels(result) {
	const refs = Array.isArray(result?.refs) ? result.refs : [];
	for (const item of refs) {
		const ref = String(item?.ref ?? "");
		if (ref === "") continue;
		const label = String(item?.label ?? item?.name ?? "").trim();
		if (label !== "") REF_LABELS.set(refLabelKey(ref, result), label.slice(0, 120));
	}
	if (REF_LABELS.size > 2000) {
		// 只留最近的一批，避免无限增长
		const keep = [...REF_LABELS.entries()].slice(-1000);
		REF_LABELS.clear();
		for (const [key, value] of keep) REF_LABELS.set(key, value);
	}
}

export function summarizeState(result, { maxRefs = 40, maxTextChars = 1200, maxOutlineLines = 30, interactiveOnly = false } = {}) {
	if (result === null || typeof result !== "object") return String(result ?? "");
	const tabs = Array.isArray(result.tabs) ? result.tabs : Array.isArray(result.targets) ? result.targets : [];
	const parts = [];
	if (typeof result.target_id === "string") parts.push(`target_id=${result.target_id}`);
	if (typeof result.tab_id === "string") parts.push(`tab_id=${result.tab_id}`);
	if (tabs.length > 0) {
		const rows = tabs.slice(0, 12).map((tab) => {
			const id = String(tab.tab_id ?? tab.id ?? "?");
			const title = String(tab.title ?? "").slice(0, 60);
			// 0.116.0（审计 L3）：tab 列表也会带 token 的 URL，走同一套脱敏
			const url = redactUrl(String(tab.url ?? "")).slice(0, 80);
			return `- ${id}${tab.active === true ? " (active)" : ""}: ${title}${url.length > 0 ? ` — ${url}` : ""}`;
		});
		parts.push(`tabs:\n${rows.join("\n")}`);
	}
	if (typeof result.text === "string" && result.text.trim() !== "") {
		const text = result.text.trim();
		parts.push(text.length > maxTextChars ? `${text.slice(0, maxTextChars)}\n…（正文已截断，共 ${String(text.length)} 字符；需要更多用 browser_read）` : text);
	}
	const refs = Array.isArray(result.refs) ? result.refs : [];
	const targetRefs = interactiveOnly === true ? refs.filter((item) => isInteractiveRef(item)) : refs;
	if (targetRefs.length > 0) {
		const limit = Math.max(1, Math.min(200, maxRefs));
		const rows = targetRefs.slice(0, limit).map((item) => {
			const label = String(item.label ?? item.name ?? "").slice(0, 70);
			return `- ${item.ref} ${String(item.node ?? item.role ?? "?")}${label.length > 0 ? ` ${label}` : ""}`;
		});
		const hidden = targetRefs.length - limit;
		const tail = hidden > 0 ? `\n… 还有 ${String(hidden)} 个没列出（用 query/role 过滤，或调大 max_refs）` : "";
		parts.push(`refs (${targetRefs.length}):\n${rows.join("\n")}${tail}`);
	}
	if (typeof result.outline === "string" && result.outline.trim() !== "") {
		const lines = result.outline.trim().split("\n");
		const kept = lines.slice(0, maxOutlineLines).join("\n");
		parts.push(lines.length > maxOutlineLines ? `${kept}\n…（结构树还有 ${String(lines.length - maxOutlineLines)} 行，需要细节用 browser_read selector 或 query 过滤）` : kept);
	}
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
let lastBrowserToolsState = { registered: false, reason: "not registered yet", names: [] };

/** 最近一次注册结果，供 operator_status 显示浏览器通道状态。 */
export function browserToolsStatus() {
	return lastBrowserToolsState;
}

export function registerBrowserTools(ctx, config, deps) {
	const { defineTool } = deps;
	if (process.env.DSH_OPERATOR_BROWSER === "0") {
		console.warn("[dsh-operator] DSH_OPERATOR_BROWSER=0，跳过 browser_* 工具");
		lastBrowserToolsState = { registered: false, names: [], reason: "DSH_OPERATOR_BROWSER=0" };
		return { registered: false, names: [], reason: "disabled" };
	}
	const bin = resolveCuaDriverBinary();
	if (bin === void 0) {
		console.warn("[dsh-operator] 未找到 cua-driver，跳过 browser_* 工具（browser_dom_* 仍可用）");
		lastBrowserToolsState = { registered: false, names: [], reason: "cua-driver not installed" };
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
	const bound = { targetId: undefined, tabId: undefined, pid: undefined, sessionKey: "" };
	/** 绑定类工具：换绑/准备不受「跨会话」拦截。 */
	const REBIND_TOOLS = new Set(["browser_state", "browser_prepare"]);

	/** 从工具执行上下文取会话标识（与技能候选共用同一套推导）。 */
	function sessionKeyOf(exec) {
		const agent = exec?.agent;
		const raw = agent?.id ?? agent?.sessionId ?? exec?.sessionId ?? exec?.session?.id ?? "";
		return typeof raw === "string" ? raw : "";
	}

	/** 把 target_id/tab_id 补成 cua-driver 需要的精确坐标。 */
	function bindings(args) {
		const explicitTarget = typeof args.target_id === "string" && args.target_id.length > 0 ? args.target_id : undefined;
		const explicitTab = typeof args.tab_id === "string" && args.tab_id.length > 0 ? args.tab_id : undefined;
		const targetId = explicitTarget ?? bound.targetId;
		// 0.92.0：显式指定了 target 却没给 tab 时，绝不回退到另一个 target 的 bound tab，
		// 否则会「操作 B 目标却用 A 的 tab」。
		const tabId = explicitTab ?? (explicitTarget !== undefined && explicitTarget !== bound.targetId ? undefined : bound.tabId);
		return { targetId, tabId };
	}

	/**
	 * 调一个 cua-driver 浏览器工具。
	 * @returns {Promise<{ok:true, result:any} | {ok:false, error:string, hint?:string}>}
	 */
	function normalizeRefusal(outcome) {
		const result = outcome?.result;
		// 0.117.1（审计未证实 #2 的防御性修复）：不只认 `status:"refused"`。
		// 驱动若在成功 RPC 里返回 error/failed/denied，之前会被当成成功（ok:true）并静默输出。
		const failureStatus = String(result?.status ?? "");
		if (outcome?.ok === true && result !== null && typeof result === "object" && ["refused", "error", "failed", "denied", "rejected"].includes(failureStatus)) {
			const refusal = result.refusal ?? {};
			const code = String(refusal.code ?? result.code ?? failureStatus);
			const message = String(refusal.message ?? result.message ?? result.error ?? result.hint ?? "cua-driver 拒绝了该操作");
			const approval = /approval|confirmation flow|confirm/i.test(message);
			const hint = approval
				? "该动作需要宿主确认（destructive-tool confirmation）；没有确认通道（CLI/独立进程）时会被直接拒绝——请在有确认弹窗的宿主里重试，或改用非破坏性路径。"
				: hintForBrowserError(code) ?? message;
			return { ok: false, error: message, hint, refusal: code };
		}
		return outcome;
	}

	async function call(tool, args, { timeoutMs = 60000 } = {}) {
		if (typeof deps.call === "function") return normalizeRefusal(await deps.call(tool, args));
		await ensureReady();
		const payload = { session, ...args };
		const invoke = (extra) => cuaCall(bin, tool, { ...payload, ...extra }, { socket, timeoutMs });
		try {
			const result = await invoke({});
			return normalizeRefusal({ ok: true, result });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// cua-driver 在空闲/守护重启后会回收会话；这里自动重建一次再重试。
			if (/session has ended/i.test(message)) {
				try {
					await cuaCall(bin, "start_session", { session }, { socket, timeoutMs });
					const result = await invoke({});
					// 0.87.0：重试结果同样要归一化——驱动回 status:"refused" 不能当成功
					return normalizeRefusal({ ok: true, result });
				} catch (retryError) {
					const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
					return { ok: false, error: retryMessage, hint: hintForBrowserError(retryMessage) };
				}
			}
			return { ok: false, error: message, hint: hintForBrowserError(message) };
		}
	}

	/**
	 * 导航后自动拿一份快照（cua-driver 没有「等 load」接口，靠重试快照兜底）。
	 * @returns {Promise<string>} 快照文本；拿不到返回空串。
	 */
	async function stateWithRetry({ attempts = 3, delayMs = 300, targetId, tabId } = {}) {
		// 0.115.0（审计 G1）：允许显式指定这次要读的 target/tab——导航用的是哪个就快照哪个。
		// 之前固定读全局 bound：显式导航到 B 页，回包却是 A 页的 refs，模型会把两页搞混。
		const wantedTarget = typeof targetId === "string" ? targetId : bound.targetId;
		const wantedTab = typeof tabId === "string"
			? tabId
			: (typeof targetId === "string" && targetId !== bound.targetId ? undefined : bound.tabId);
		if (typeof wantedTarget !== "string") return "";
		for (let index = 0; index < attempts; index += 1) {
			const outcome = await call("get_browser_state", {
				target_id: wantedTarget,
				...(typeof wantedTab === "string" ? { tab_id: wantedTab } : {})
			});
			if (outcome.ok === true) {
				const result = outcome.result;
				if (typeof result.target_id === "string") bound.targetId = result.target_id;
				if (typeof result.tab_id === "string") bound.tabId = result.tab_id;
				rememberRefLabels(result);
				const text = dedupeStateText(summarizeState(result), result, bound.sessionKey);
				if (text.trim() !== "") return text;
			}
			if (index < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
		return "";
	}

	/** 统一失败输出。 */
	function failed(name, outcome) {
		audit(`browser_${name}_failed`, { error: outcome.error.slice(0, 300) });
		if (config?.failureSamples !== false) {
			recordFailure({ tool: `browser_${name}`, error: new Error(outcome.error), kind: classifyFailure(outcome.error), version: deps?.version });
		}
		return {
			schemaVersion: SCHEMA_VERSION,
			ok: false,
			text: `browser_${name} 失败：${outcome.error}${outcome.hint === void 0 ? "" : `\n下一步：${outcome.hint}`}`
		};
	}

	/** 取一份最新快照文本（失败返回空串），供 ref 过期时自动补发。 */
	async function freshStateText({ maxRefs = 40 } = {}) {
		if (typeof bound.targetId !== "string") return "";
		const params = { target_id: bound.targetId, tab_id: bound.tabId, snapshot_format: "semantic_v2" };
		let outcome = await call("get_browser_state", params);
		if (outcome.ok !== true && /snapshot_format|semantic/i.test(String(outcome.error ?? ""))) {
			delete params.snapshot_format;
			outcome = await call("get_browser_state", params);
		}
		if (outcome.ok !== true) return "";
		const result = outcome.result;
		if (typeof result.target_id === "string") bound.targetId = result.target_id;
		if (typeof result.tab_id === "string") bound.tabId = result.tab_id;
		// 0.115.0（审计 G2 触发③）：这里补发的 refs 也要进 REF_LABELS，否则紧接着用这些 ref
		// 点击时守卫拿不到标签（空串=放行），stale 恢复路径就成了破坏性点击的后门。
		rememberRefLabels(result);
		return dedupeStateText(summarizeState(result, { maxRefs }), result, bound.sessionKey);
	}

	/**
	 * 等绑定标签页的 URL 变成包含 expected 的地址（导航后用，不依赖 CDP 端口）。
	 * @param {string} expected - URL 里应包含的片段。
	 * @param {number} timeoutMs - 最长等待时间。
	 */
	async function waitForUrlContains(expected, timeoutMs) {
		const startedAt = Date.now();
		const wanted = expected.toLowerCase();
		let current = "";
		// 0.116.0（审计 L6）：记住起始地址。「地址里包含目标片段」不等于「发生了导航」——
		// 之前调用前就已包含时会立刻返回「地址已变化」，让模型误以为点击生效了。
		let initial;
		while (Date.now() - startedAt <= timeoutMs) {
			if (typeof bound.targetId === "string") {
				const outcome = await call("get_browser_state", { target_id: bound.targetId, tab_id: bound.tabId });
				if (outcome.ok === true) {
					const result = outcome.result ?? {};
					if (typeof result.target_id === "string") bound.targetId = result.target_id;
					if (typeof result.tab_id === "string") bound.tabId = result.tab_id;
					const tabs = Array.isArray(result.tabs) ? result.tabs : [];
					const active = tabs.find((tab) => String(tab.tab_id ?? tab.id ?? "") === String(bound.tabId)) ?? tabs.find((tab) => tab.active === true);
					current = String(active?.url ?? result.url ?? current);
					if (initial === undefined && current !== "") initial = current;
					if (current.toLowerCase().includes(wanted)) {
						const changed = initial !== undefined && current !== initial;
						return {
							schemaVersion: SCHEMA_VERSION,
							ok: true,
							text: changed
								? `地址已变化：${current}（用时 ${String(Date.now() - startedAt)}ms）`
								: `地址已包含「${expected}」，但调用前后地址没变（不能证明发生了导航）：${current}`
						};
					}
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
		return { schemaVersion: SCHEMA_VERSION, ok: false, text: `等 URL 超时（${String(timeoutMs)}ms）：当前 ${current.length > 0 ? current : "（取不到地址，先 browser_state 绑定）"}` };
	}

	/**
	 * 按可见文案找 ref：先取一份快照，再在 refs 里做包含匹配。
	 * 多个匹配时拒绝并列出候选（避免点错），配合 role/index 可以精确到某一个。
	 * @returns {Promise<{ok:true, ref:string, label:string} | {ok:false, message:string}>}
	 */
	async function resolveRefByText(text, { role, index } = {}) {
		if (typeof bound.targetId !== "string" || typeof bound.tabId !== "string") {
			return { ok: false, message: "还没有绑定 tab：先 browser_state(pid, window_id)" };
		}
		// dom_refs_v1 的 label 只给 href/aria，拿不到可见文案；按文案点必须用 semantic_v2（含 name/role）。
		let outcome = await call("get_browser_state", { target_id: bound.targetId, tab_id: bound.tabId, snapshot_format: "semantic_v2" });
		if (outcome.ok !== true) {
			outcome = await call("get_browser_state", { target_id: bound.targetId, tab_id: bound.tabId });
		}
		if (outcome.ok !== true) return { ok: false, message: `按文案点击前取快照失败：${outcome.error}` };
		const result = outcome.result;
		if (typeof result.target_id === "string") bound.targetId = result.target_id;
		if (typeof result.tab_id === "string") bound.tabId = result.tab_id;
		// 0.115.0（审计 G2）：按文案匹配后的 refs 也要进标签缓存，否则紧接着用 ref 点击时守卫拿不到标签。
		rememberRefLabels(result);
		const refs = Array.isArray(result.refs) ? result.refs : [];
		const needle = text.toLowerCase();
		const roleFilter = typeof role === "string" && role.trim() !== "" ? role.trim().toLowerCase() : undefined;
		const matches = refs.filter((item) => {
			const label = String(item.name ?? item.label ?? "").toLowerCase();
			const node = String(item.role ?? item.node ?? "").toLowerCase();
			if (!label.includes(needle)) return false;
			return roleFilter === undefined || node.includes(roleFilter);
		});
		if (matches.length === 0) return { ok: false, message: `没有找到文案包含「${text}」的元素；先 browser_state 看一遍 refs，或换一段更精确的文案` };
		if (matches.length === 1) return { ok: true, ref: String(matches[0].ref), label: String(matches[0].name ?? matches[0].label ?? "") };
		if (Number.isInteger(index) && index >= 0 && index < matches.length) {
			return { ok: true, ref: String(matches[index].ref), label: String(matches[index].label ?? matches[index].name ?? "") };
		}
		const listed = matches
			.slice(0, 8)
			.map((item, order) => `${order}. ${item.ref} ${String(item.role ?? item.node ?? "?")} ${String(item.name ?? item.label ?? "")}`)
			.join("\n");
		return { ok: false, message: `「${text}」匹配到 ${matches.length} 个元素，先选一个再点（传 index 或更精确的 text）：\n${listed}` };
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

	// deps.toolDefs（可选）：把定义同时放进宿主共享的工具定义表，ax_batch 才能在一次
	// 调用里混跑桌面动作和浏览器动作（0.39.0）。
	const register = (definition) => {
		// 0.90.0：绑定属于「谁绑的谁用」——A 会话绑定的 tab，B 会话不能直接操作/读快照。
		// 换绑类工具（browser_state / browser_prepare）不拦，它们本来就会重建绑定。
		const execute = definition.execute;
		if (typeof execute === "function" && REBIND_TOOLS.has(definition.name) === false) {
			definition = {
				...definition,
				async execute(args, exec) {
					const current = sessionKeyOf(exec);
					if (bound.sessionKey !== "" && current !== "" && current !== bound.sessionKey) {
						audit("browser_cross_session_refused", { tool: definition.name });
						return {
							schemaVersion: SCHEMA_VERSION,
							ok: false,
							text: `浏览器绑定属于另一个会话（${bound.sessionKey.slice(0, 8)}…）。为避免操作到别人的标签页，本工具已拒绝。\n处理方式：在当前会话重新 browser_state {pid, window_id} 绑定你要的标签页，再继续。`
						};
					}
					return execute(args, exec);
				}
			};
		}
		if (deps?.toolDefs instanceof Map) deps.toolDefs.set(definition.name, definition);
		return ctx.tools.register(defineTool(definition));
	};

	register({
		name: "browser_state",
		description:
			"Bind or snapshot a real browser through cua-driver. Bind: pass pid + window_id (from cua_windows) to get target_id/tab_id and a semantic snapshot with element refs (p<snapshot>:<index>). Snapshot: pass target_id + tab_id. Refs become stale after navigation or a newer snapshot, so re-read before clicking. Read-only; never opens a page or moves the pointer. Text only: there is no screenshot parameter (use cua_observe with include_screenshot for images).",
		parameters: {
			pid: { type: "integer", description: "Browser process id (bind mode). Get it from cua_windows." },
			window_id: { type: "integer", description: "Browser window id (bind mode)." },
			target_id: { type: "string", description: "Target id from an earlier bind (snapshot mode)." },
			tab_id: { type: "string", description: "Tab id from an earlier snapshot (optional; defaults to the bound tab)." },
			snapshot_format: { type: "string", description: "semantic_v2 (default; refs carry visible names) or dom_refs_v1 (raw href labels)." },
			query: { type: "string", description: "Only keep elements whose role/name/text matches this query." },
			max_refs: { type: "integer", description: "Cap the refs printed (default 40, max 200); the overflow line tells you how many are hidden." },
			interactive_only: { type: "boolean", default: false, description: "Only list interactive refs (link/button/input/checkbox…), skipping headings and static text." }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "number", required: true }, ok: { type: "boolean", required: true }, text: { type: "string", required: true } } }, render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }] },
		// 0.115.2（审计 M7）：这个工具会写共享 bound（target/tab/所有权），不能和别的调用并发跑——
		// 否则后返回的长请求会把 bound 覆盖成另一个 target，紧接着的 click 就点错页。
		isConcurrencySafe: () => false,
		presentCall: (args) => presentCall("Read browser state", args),
		async execute(args, exec) {
			const params = {};
			// 0.115.0（审计 M2）：绑定失败不该抢走所有权——先记局部，成功后再提交
			let pendingPid;
			let pendingSession = "";
			if (Number.isInteger(args.pid) && Number.isInteger(args.window_id)) {
				params.pid = args.pid;
				params.window_id = args.window_id;
				pendingPid = args.pid;
				// 0.90.0：记住是谁绑的
				pendingSession = sessionKeyOf(exec);
				// cua-driver 要求显式策略：不传会以 browser_consent_required 拒绝。
				params.strategy = { kind: "existing_profile" };
			} else if (typeof args.target_id === "string" && args.target_id.length > 0) {
				params.target_id = args.target_id;
				// 0.115.0（审计 M1）：与 bindings() 同一条规则——显式 target 不是 bound 那个时，
				// 绝不能把 bound 的 tab 拼上去（否则成了「B 的 target + A 的 tab」混合态）。
				const explicitTab = typeof args.tab_id === "string" && args.tab_id.length > 0 ? args.tab_id : undefined;
				const tab = explicitTab ?? (args.target_id === bound.targetId ? bound.tabId : undefined);
				if (typeof tab === "string") params.tab_id = tab;
			}
			const explicitFormat = args.snapshot_format === "semantic_v2" || args.snapshot_format === "dom_refs_v1";
			params.snapshot_format = explicitFormat ? args.snapshot_format : "semantic_v2";
			if (typeof args.query === "string" && args.query.length > 0) params.query = args.query;
			if (params.target_id === undefined && params.pid === undefined) {
				return { schemaVersion: SCHEMA_VERSION, ok: false, text: "browser_state 需要 pid+window_id（首次绑定）或 target_id（快照）" };
			}
			let outcome = await call("get_browser_state", params);
			if (outcome.ok !== true && explicitFormat === false && /snapshot_format|semantic/i.test(String(outcome.error ?? ""))) {
				// 驱动太老不认识 semantic_v2 时退回默认格式，别让读快照整个失败。
				delete params.snapshot_format;
				outcome = await call("get_browser_state", params);
			}
			if (outcome.ok !== true) return failed("state", outcome);
			// 0.115.0（审计 M2）：只有绑定真的成功了才提交所有权——失败的重绑不能把原会话踹出去
			if (Number.isInteger(pendingPid)) {
				bound.pid = pendingPid;
				bound.sessionKey = pendingSession;
			}
			const result = outcome.result;
			if (typeof result.target_id === "string") bound.targetId = result.target_id;
			if (typeof result.tab_id === "string") bound.tabId = result.tab_id;
			const maxRefs = Number.isInteger(args.max_refs) ? args.max_refs : 40;
			const interactiveOnly = args.interactive_only === true;
			rememberRefLabels(result);
			return succeeded("state", dedupeStateText(summarizeState(result, { maxRefs, interactiveOnly }), result, bound.sessionKey));
		}
	});

	register({
		name: "browser_prepare",
		description:
			"Attach the browser tools to a running Chrome/Edge/Brave window (existing user profile, real logins). Call this when browser_state refuses with browser_consent_required or browser_requires_setup. Give pid + window_id from cua_windows, or just app (e.g. \"Chrome\") to resolve the window automatically. On macOS Chrome this may briefly show Chrome's own remote-debugging prompt; delivery_mode:\"foreground\" accepts that.",
		parameters: {
			pid: { type: "integer", description: "Browser process id from cua_windows (optional when app is given)." },
			window_id: { type: "integer", description: "Browser window id from cua_windows (optional when app is given)." },
			app: { type: "string", description: "Resolve window by app name substring (e.g. Chrome) instead of pid/window_id." },
			window_title: { type: "string", description: "With app: pick the window whose title contains this text." },
			delivery_mode: { type: "string", description: "background (default) or foreground." }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "number", required: true }, ok: { type: "boolean", required: true }, text: { type: "string", required: true } } }, render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }] },
		isConcurrencySafe: () => false,
		presentCall: (args) => presentCall("Attach browser", args),
		async execute(args, exec) {
			let pid = Number(args.pid);
			let windowId = Number(args.window_id);
			if (!Number.isInteger(pid) || !Number.isInteger(windowId)) {
				if (typeof args.app !== "string" || args.app.trim() === "") {
					return { schemaVersion: SCHEMA_VERSION, ok: false, text: "browser_prepare 需要 pid + window_id（来自 cua_windows），或给 app 名自动找窗口" };
				}
				const listed = await call("list_windows", {});
				if (listed.ok !== true) return failed("prepare", listed);
				const windows = Array.isArray(listed.result?.windows) ? listed.result.windows : [];
				const wantedApp = args.app.trim().toLowerCase();
				const wantedTitle = typeof args.window_title === "string" ? args.window_title.trim().toLowerCase() : "";
				const appOf = (entry) => String(entry.app ?? entry.app_name ?? "");
				const titleOf = (entry) => String(entry.title ?? "");
				let matches = windows.filter((entry) => appOf(entry).toLowerCase().includes(wantedApp) && (wantedTitle === "" || titleOf(entry).toLowerCase().includes(wantedTitle)));
				if (wantedTitle === "" && matches.length > 1) {
					// Chrome 会额外暴露几个无标题的辅助窗口，优先带标题的真实窗口。
					const titled = matches.filter((entry) => titleOf(entry).trim() !== "");
					if (titled.length > 0) matches = titled;
				}
				if (matches.length === 0) {
					const names = [...new Set(windows.map((entry) => appOf(entry) || "?"))].slice(0, 12).join("、");
					return { schemaVersion: SCHEMA_VERSION, ok: false, text: `没有找到 app 含「${args.app}」的窗口；当前窗口来自：${names === "" ? "（空）" : names}` };
				}
				if (matches.length > 1) {
					const candidates = matches.slice(0, 6).map((entry, index) => `${index}. pid=${String(entry.pid)} window=${String(entry.window_id)} ${String(entry.app ?? "")} · ${String(entry.title ?? "")}`).join("\n");
					return { schemaVersion: SCHEMA_VERSION, ok: false, text: `匹配到 ${matches.length} 个窗口，请传 pid + window_id 指定一个：\n${candidates}` };
				}
				pid = Number(matches[0].pid);
				windowId = Number(matches[0].window_id);
			}
			const params = { pid, window_id: windowId };
			// 显式声明「接用户正在用的 profile」：cua-driver 对已有端点只做探测，
			// 不带 strategy 时 browser_prepare 只回 already_prepared，后续 get_browser_state 仍会被拒。
			params.strategy = { kind: "existing_profile" };
			if (typeof args.delivery_mode === "string" && args.delivery_mode.length > 0) params.delivery_mode = args.delivery_mode;
			const outcome = await call("browser_prepare", params);
			if (outcome.ok !== true) return failed("prepare", outcome);
			// 0.115.2（审计 M10）：prepare 成功后要认领所有权——之前不写 sessionKey，结果是
			// 「我 prepare 了却不能用」（被原会话的所有权拦住），而原会话在驱动已切到新窗口时仍被授权。
			bound.pid = params.pid;
			bound.sessionKey = sessionKeyOf(exec);
			// 新窗口的 target/tab 还没快照过：清掉旧的，等下一次 browser_state 填。
			const hadOldTarget = typeof bound.targetId === "string";
			bound.targetId = undefined;
			bound.tabId = undefined;
			return succeeded("prepare", `已绑定 pid=${params.pid} window=${params.window_id}\n${compactJson(outcome.result, 2000)}${hadOldTarget ? "\n（旧 target/tab 已清空——下一步 browser_state 取新窗口快照）" : ""}`);
		}
	});

	register({
		name: "browser_open",
		description:
			"Navigate the bound tab (or a given tab_id) to an http(s)/about URL through the attached real browser. Navigation invalidates all element refs for that tab; by default the tool also returns a fresh snapshot so you can act immediately (pass wait:false to skip).",
		parameters: {
			url: { type: "string", required: true, description: "Absolute http:// or https:// URL (or about:blank)." },
			tab_id: { type: "string", description: "Tab id; defaults to the bound tab." },
			target_id: { type: "string", description: "Target id; defaults to the bound target." },
			wait: { type: "boolean", default: true, description: "After navigating, fetch a fresh snapshot (up to 3 tries) so you can act immediately; pass false to skip." }
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
			if (args.wait === false) return succeeded("open", `已打开 ${url}（tab ${tabId}）；ref 已失效，重新 browser_state`);
			const stateText = await stateWithRetry({ targetId, tabId });
			if (stateText === "") return succeeded("open", `已打开 ${url}（tab ${tabId}）；快照暂时取不到，稍后 browser_state 重试`);
			return succeeded("open", `已打开 ${url}（tab ${tabId}）；下面是最新快照，直接用这些 ref 继续：\n${stateText}`);
		}
	});

	register({
		name: "browser_click",
		description:
			"Click one element in the bound tab by semantic ref from browser_state. Default route is trusted input (CDP Input.dispatchMouseEvent, hardware-like); pass input_route:\"dom_event\" only when a synthetic DOM click is explicitly acceptable. Never click destructive targets (删除/支付/发送/退出) without the user's confirmation.",
		parameters: {
			ref: { type: "string", description: "Element ref from browser_state, e.g. p1:12. Omit when using text." },
			text: { type: "string", description: "Click by visible label instead of ref: snapshots the tab, matches refs whose label contains this text (case-insensitive), and refuses when ambiguous." },
			role: { type: "string", description: "With text: only consider refs whose role/node matches (e.g. button, link)." },
			index: { type: "integer", description: "With text: pick the nth match (0-based) when you already know which one you want." },
			target_id: { type: "string", description: "Target id; defaults to the bound target." },
			tab_id: { type: "string", description: "Tab id; defaults to the bound tab." },
			input_route: { type: "string", description: "trusted (default) or dom_event." },
			button: { type: "string", description: "left (default), right, middle." },
			count: { type: "integer", description: "Click count (default 1)." },
			refresh: { type: "boolean", default: false, description: "After a successful click, fetch a fresh snapshot and append its refs (saves a follow-up browser_state round trip)." },
			confirm: { type: "boolean", description: "Pass true when the user has confirmed a destructive target." }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "number", required: true }, ok: { type: "boolean", required: true }, text: { type: "string", required: true } } }, render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }] },
		isConcurrencySafe: () => false,
		presentCall: (args) => presentCall("Click element", args),
		async execute(args) {
			let ref = String(args.ref ?? "");
			let resolvedLabel = "";
			if (ref.length === 0) {
				const text = String(args.text ?? "").trim();
				if (text === "") return { schemaVersion: SCHEMA_VERSION, ok: false, text: "browser_click 需要 ref（来自 browser_state）或 text（按可见文案匹配）" };
				const resolved = await resolveRefByText(text, { role: args.role, index: args.index });
				if (resolved.ok !== true) return { schemaVersion: SCHEMA_VERSION, ok: false, text: resolved.message };
				ref = resolved.ref;
				resolvedLabel = String(resolved.label ?? "");
			}
			// 0.86.0：destructive 目标必须真的有门——之前 confirm 既不检查目标也不透传
			// 0.115.0（审计 G2）：判定必须用「实际要点的元素标签」。之前只看调用方传的 text——
			// 同时给 ref（指向删除按钮）+ 一句无害 text 就能绕过；按文案匹配时命中的真实 label 也被丢弃。
			// 现在三处来源都查（缓存标签 / 文案解析命中的标签 / 调用方 text），任一命中危险词就拦。
			const resolvedBindings = bindings(args);
			const labels = [REF_LABELS.get(refLabelKey(ref, { target_id: resolvedBindings.targetId, tab_id: resolvedBindings.tabId })), resolvedLabel, String(args.text ?? "").trim()]
				.filter((value) => typeof value === "string" && value !== "");
			const targetLabel = labels[0] ?? "";
			// 0.116.1（审计 L5）：逃生门统一走配置——之前这里硬编码 enabled:true，
			// 用户明确关掉守卫（guard:false）后浏览器工具仍然被拦，语义不一致。
			const guarded = guardTitlePress({ title: labels.join(" "), confirm: args.confirm === true, enabled: config?.guard !== false });
			if (guarded.allowed !== true) {
				audit("browser_click_guarded", { ref, label: targetLabel.slice(0, 60) });
				return { schemaVersion: SCHEMA_VERSION, ok: false, text: String(guarded.reason) };
			}
			const { targetId, tabId } = resolvedBindings;
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
			const note = args.refresh === true ? await freshStateText({ maxRefs: 20 }) : "";
			return succeeded("click", `已点击 ${ref}${args.confirm === true ? "（用户已确认）" : ""}${note === "" ? "" : `\n点击后的快照（直接用这些 ref 继续）：\n${note}`}`);
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
			mode: { type: "string", description: "insert_text (default) or keystrokes." },
			refresh: { type: "boolean", default: false, description: "After a successful type, fetch a fresh snapshot and append its refs." }
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
			const typeNote = args.refresh === true ? await freshStateText({ maxRefs: 20 }) : "";
			return succeeded("type", `已输入 ${params.text.length} 个字符${typeNote === "" ? "" : `\n输入后的快照（直接用这些 ref 继续）：\n${typeNote}`}`);
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
			if (outcome.ok !== true) return failedWithRecovery("dialog", outcome);
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
			// 0.116.1（审计 L4）：落点先验——之前只要求「绝对路径」，不存在/不是目录也照样触发，
			// 而且不该允许往凭据目录里写文件。
			let rootInfo;
			try {
				rootInfo = statSync(root);
			} catch {
				rootInfo = undefined;
			}
			if (rootInfo === undefined || rootInfo.isDirectory() === false) return { schemaVersion: SCHEMA_VERSION, ok: false, text: `destination_root 必须是已存在的目录：${root}` };
			if (SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(root))) return { schemaVersion: SCHEMA_VERSION, ok: false, text: `拒绝把下载写进疑似凭据目录：${root}` };
			const { targetId, tabId } = bindings(args);
			if (targetId === undefined || tabId === undefined) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "还没有绑定 tab：先 browser_state(pid, window_id)" };
			const before = snapshotDirectory(root);
			const outcome = await call("browser_download", { session, ref, destination_root: root, target_id: targetId, tab_id: tabId }, { timeoutMs: 120000 });
			if (outcome.ok !== true) return failedWithRecovery("download", outcome);
			let fresh = diffDirectory(before, snapshotDirectory(root));
			for (let attempt = 0; fresh.length === 0 && attempt < 6; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 300));
				fresh = diffDirectory(before, snapshotDirectory(root));
			}
			audit("browser_download", { files: fresh.length, bytes: fresh.reduce((sum, entry) => sum + entry.size, 0) });
			// 0.116.1（审计 L4）：「触发了下载」不等于「下载成功」——目录里没有新文件就不能报 ok。
			if (fresh.length === 0) {
				audit("browser_download_unverified", { root: root.slice(0, 120) });
				return { schemaVersion: SCHEMA_VERSION, ok: false, text: `已触发下载到 ${root}，但等了好几轮目录里仍然没有新文件——可能下载失败、或写到了别处。先用 ls 复核再判断，别当成成功。` };
			}
			return succeeded("download", `已下载 ${fresh.length} 个文件到 ${root}：\n${fresh.slice(0, 6).map((entry) => `${entry.name}（${formatBytes(entry.size)}）`).join("\n")}${fresh.length > 6 ? `\n…还有 ${fresh.length - 6} 个` : ""}`);
		}
	});

	register({
		name: "browser_set_input_files",
		description: "Assign absolute local file paths to a live <input type=file> ref (bypasses the native picker). Regular files only; 1–32 paths.",
		parameters: {
			ref: { type: "string", required: true, description: "The file input's ref from browser_state." },
			files: { type: "array", items: { type: "string" }, required: true, description: "Absolute paths of 1–32 local regular files." },
			// 0.91.0：上传 = 把本地文件交给网页，必须显式确认（防止页面提示注入把 ~/.ssh 之类塞进表单）
			confirm: { type: "boolean", description: "Pass true only after the user approved uploading these exact files to this page." },
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
			if (args.confirm !== true) {
				audit("browser_set_input_files_guarded", { count: files.length });
				return {
					schemaVersion: SCHEMA_VERSION,
					ok: false,
					text: `上传文件会把本地文件交给当前网页（${files.slice(0, 3).join("、")}${files.length > 3 ? " …" : ""}），需要你确认。\n确认后带 confirm:true 重调；如果这些路径不是你指定的，先停下——页面内容可能诱导上传敏感文件。`
				};
			}
			if (files.length > 32) return { schemaVersion: SCHEMA_VERSION, ok: false, text: `一次最多 32 个文件（收到 ${String(files.length)}）` };
			// 0.91.0：只接受普通文件（目录/符号链接/设备文件一律拒绝），并拒绝明显的凭据目录
			const SENSITIVE_PATHS = SENSITIVE_PATH_PATTERNS;
			for (const entry of files) {
				if (entry.startsWith("/") === false) return { schemaVersion: SCHEMA_VERSION, ok: false, text: `文件必须是绝对路径：${entry}` };
				// 先看路径意图，再看文件存在性——不存在的 .ssh 路径也更该报「凭据」而不是「不是普通文件」
				if (SENSITIVE_PATHS.some((pattern) => pattern.test(entry))) {
					audit("browser_set_input_files_sensitive", { path: entry.slice(0, 120) });
					return { schemaVersion: SCHEMA_VERSION, ok: false, text: `拒绝上传疑似凭据文件：${entry}（如确实需要，请用户自己拖拽上传）` };
				}
				// 0.115.1（审计 M8）：statSync 会跟随符号链接——注释说「拒绝符号链接」其实从没拒绝过。
				const linkInfo = lstatSync(entry, { throwIfNoEntry: false });
				if (linkInfo === undefined) return { schemaVersion: SCHEMA_VERSION, ok: false, text: `文件不存在：${entry}` };
				if (linkInfo.isSymbolicLink()) return { schemaVersion: SCHEMA_VERSION, ok: false, text: `符号链接一律拒绝（请传真实路径）：${entry}` };
				const info = statSync(entry, { throwIfNoEntry: false });
				if (info === undefined || info.isFile() === false) return { schemaVersion: SCHEMA_VERSION, ok: false, text: `不是普通文件（目录/设备文件都不行）：${entry}` };
				// 真实路径再跑一遍凭据正则：防止 /tmp/x -> ~/.ssh/id_rsa 这类借道
				let real = entry;
				try {
					real = realpathSync(entry);
				} catch {
					real = entry;
				}
				if (real !== entry && SENSITIVE_PATHS.some((pattern) => pattern.test(real))) {
					audit("browser_set_input_files_sensitive", { path: real.slice(0, 120) });
					return { schemaVersion: SCHEMA_VERSION, ok: false, text: `拒绝上传疑似凭据文件（真实路径指向凭据目录）：${entry} → ${real}（如确实需要，请用户自己拖拽上传）` };
				}
			}
			const { targetId, tabId } = bindings(args);
			if (targetId === undefined || tabId === undefined) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "还没有绑定 tab：先 browser_state(pid, window_id)" };
			const outcome = await call("browser_set_input_files", { session, ref, files, target_id: targetId, tab_id: tabId });
			if (outcome.ok !== true) return failedWithRecovery("set_input_files", outcome);
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
			"Wait through the CDP backend (requires browserCdpPort and a Chrome started with --remote-debugging-port). With `selector`: wait until that element exists (add `visible: true` to require it be rendered); with `text`: wait until that visible text appears; without either: wait for readyState=complete and network idle. Optionally pick the tab by url_contains/title_contains/index. Read-only; use after navigation before clicking.",
		parameters: {
			port: { type: "integer", description: "CDP port; defaults to browserCdpPort from config." },
			url_contains: { type: "string", description: "Pick the tab whose URL contains this text." },
			title_contains: { type: "string", description: "Pick the tab whose title contains this text." },
			index: { type: "integer", description: "Pick the nth matching page target (0-based)." },
			timeout_ms: { type: "integer", description: "Overall wait budget in ms (default 15000)." },
			idle_ms: { type: "integer", description: "How long the network must stay idle (default 500)." },
			selector: { type: "string", description: "Wait until this CSS selector exists instead of waiting for network idle." },
			text: { type: "string", description: "Wait until this visible text appears in the page (no selector needed)." },
			visible: { type: "boolean", default: false, description: "With selector: require the element to be rendered (non-zero box, not display:none/visibility:hidden)." },
			expect_url: { type: "string", description: "Wait until the bound tab's URL contains this text (no CDP port needed; polls browser_state)." }
		},
		output: cdpOutput,
		// 0.115.2（审计 M7）：expect_url 分支会写共享 bound（同 stateWithRetry），并发同样会串页。
		isConcurrencySafe: () => false,
		presentCall: (args) => presentCall("Wait for page", args),
		async execute(args) {
			// 0.86.0：无上界时 browser_wait {timeout_ms: 86400000} 能挂一天
			const timeoutMs = Math.min(120000, Math.max(0, Number.isInteger(args.timeout_ms) ? args.timeout_ms : 15000));
			if (typeof args.expect_url === "string" && args.expect_url.trim() !== "") {
				return waitForUrlContains(args.expect_url.trim(), timeoutMs);
			}
			const port = cdpPort(args);
			if (port === 0) return cdpDisabled(port);
			const opened = await openPage(port, {
				urlContains: typeof args.url_contains === "string" ? args.url_contains : undefined,
				titleContains: typeof args.title_contains === "string" ? args.title_contains : undefined,
				index: Number.isInteger(args.index) ? args.index : undefined
			});
			if (opened.ok !== true) return { schemaVersion: SCHEMA_VERSION, ok: false, text: `browser_wait 失败：${opened.error}\n${CDP_UNAVAILABLE_HINT}` };
			try {
				if (typeof args.selector === "string" && args.selector.trim() !== "") {
					const found = await waitForSelector(opened.client, args.selector, { timeoutMs, visible: args.visible === true });
					if (found.ok !== true) return { schemaVersion: SCHEMA_VERSION, ok: false, text: `browser_wait 失败：${String(found.error ?? "未知错误")}` };
					audit("browser_wait", { ok: true, selector: true });
					return { schemaVersion: SCHEMA_VERSION, ok: true, text: `元素已出现：${args.selector}${found.visible === true ? "（可见）" : ""}，用时 ${String(found.elapsedMs)}ms` };
				}
				if (typeof args.text === "string" && args.text.trim() !== "") {
					const seen = await waitForText(opened.client, args.text, { timeoutMs });
					if (seen.ok !== true) return { schemaVersion: SCHEMA_VERSION, ok: false, text: `browser_wait 失败：${String(seen.error ?? "未知错误")}` };
					audit("browser_wait", { ok: true, text: true });
					return { schemaVersion: SCHEMA_VERSION, ok: true, text: `文本已出现：${args.text}，用时 ${String(seen.elapsedMs)}ms` };
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
			reload: { type: "boolean", default: false, description: "Reload the page first so load-time errors are captured (changes page state; off by default)." },
			query: { type: "string", description: "Only keep entries whose text contains this (case-insensitive); use it to drop third-party noise." },
			level: { type: "string", enum: ["error", "warning", "all"], description: "Only keep this level (default all)." }
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
				const durationMs = Math.min(120000, Math.max(0, Number.isInteger(args.duration_ms) ? args.duration_ms : 3000));
				const limit = Number.isInteger(args.limit) ? args.limit : 20;
				const collected = await collectConsole(opened.client, { durationMs, limit, reload: args.reload === true });
				const wanted = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
				const level = args.level === "error" || args.level === "warning" ? args.level : "all";
				const lines = collected.entries
					.filter((entry) => level === "all" || consoleEntryLevel(entry) === level)
					.map((entry) => summarizeConsoleEntry(entry))
					.filter((line) => wanted === "" || String(line).toLowerCase().includes(wanted));
				audit("browser_console", { ok: true, count: lines.length });
				// 0.115.1（审计 M4）：reload 失败时不能报「干净」——那等于把失败当成通过
				const consoleReloadNote = collected.reloadError === undefined ? "" : `\n⚠️ 页面 reload 失败（${String(collected.reloadError)}）——这次结论只能覆盖 reload 之前的页面`;
				return { schemaVersion: SCHEMA_VERSION, ok: collected.reloadError === undefined, text: `${lines.length === 0 ? `控制台干净（${String(durationMs)}ms 内没有 error/warning）` : `控制台 ${String(lines.length)} 条：\n${lines.join("\n")}`}${consoleReloadNote}` };
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
			limit: { type: "integer", description: "Max entries (default 20)." },
			reload: { type: "boolean", default: false, description: "Reload the page first so load-time failures are captured (changes page state; off by default)." },
			query: { type: "string", description: "Only keep entries whose URL/status text contains this (case-insensitive)." }
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
				const durationMs = Math.min(120000, Math.max(0, Number.isInteger(args.duration_ms) ? args.duration_ms : 3000));
				const limit = Number.isInteger(args.limit) ? args.limit : 20;
				const collected = await collectNetwork(opened.client, { durationMs, limit, reload: args.reload === true });
				const wanted = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
				const lines = collected.entries.map((entry) => summarizeNetworkEntry(entry)).filter((line) => wanted === "" || String(line).toLowerCase().includes(wanted));
				audit("browser_network", { ok: true, count: lines.length });
				const networkReloadNote = collected.reloadError === undefined ? "" : `\n⚠️ 页面 reload 失败（${String(collected.reloadError)}）——这次结论只能覆盖 reload 之前的页面`;
				return { schemaVersion: SCHEMA_VERSION, ok: collected.reloadError === undefined, text: `${lines.length === 0 ? `网络正常（${String(durationMs)}ms 内没有失败请求）` : `失败请求 ${String(lines.length)} 条：\n${lines.join("\n")}`}${networkReloadNote}` };
			} finally {
				opened.client.close();
			}
		}
	});

	register({
		name: "browser_read",
		description:
			"Read the visible text of a page through the CDP backend (requires browserCdpPort and a Chrome started with --remote-debugging-port). Runs one fixed expression — never arbitrary page JS. Pass interactive_only to list only clickable labels (links/buttons/inputs) instead of the whole page. Much cheaper than a screenshot when you only need the text. Read-only; max_chars defaults to 4000 and selector reads one element only.",
		parameters: {
			port: { type: "integer", description: "CDP port; defaults to browserCdpPort from config." },
			url_contains: { type: "string", description: "Pick the tab whose URL contains this text." },
			title_contains: { type: "string", description: "Pick the tab whose title contains this text." },
			index: { type: "integer", description: "Pick the nth matching page target (0-based)." },
			max_chars: { type: "integer", description: "Maximum characters to return (default 4000, hard cap 20000)." },
			selector: { type: "string", description: "Optional CSS selector: read only that element's visible text." },
			interactive_only: { type: "boolean", default: false, description: "Only return labels of interactive elements (links/buttons/inputs), not the whole page text." }
		},
		output: cdpOutput,
		isConcurrencySafe: () => true,
		presentCall: (args) => presentCall("Read page text", args),
		async execute(args) {
			const port = cdpPort(args);
			if (port === 0) return cdpDisabled(port);
			const opened = await openPage(port, {
				urlContains: typeof args.url_contains === "string" ? args.url_contains : undefined,
				titleContains: typeof args.title_contains === "string" ? args.title_contains : undefined,
				index: Number.isInteger(args.index) ? args.index : undefined
			});
			if (opened.ok !== true) return { schemaVersion: SCHEMA_VERSION, ok: false, text: `browser_read 失败：${opened.error}\n${CDP_UNAVAILABLE_HINT}` };
			try {
				const readOptions = {
					maxChars: Number.isInteger(args.max_chars) ? args.max_chars : 4000,
					selector: typeof args.selector === "string" ? args.selector : undefined
				};
				const interactiveOnly = args.interactive_only === true;
				const read = interactiveOnly
					? await readInteractiveText(opened.client, readOptions)
					: await readPageText(opened.client, readOptions);
				if (read.ok !== true) return { schemaVersion: SCHEMA_VERSION, ok: false, text: `browser_read 失败：${String(read.error ?? "未知错误")}` };
				audit("browser_read", { ok: true, chars: read.text.length });
				// 0.116.0（审计 L3）：标题里的 URL 同样脱敏（页面 URL 常带 access_token）
				const url = redactUrl(String(opened.target?.url ?? ""));
				const head = `${interactiveOnly ? "可交互元素" : "页面文本"}${url === "" ? "" : `（${url}）`}${read.truncated === true ? "（已截断）" : ""}：`;
				return succeeded("read", read.text === "" ? "页面没有可见文本（可能是空页面或全在 iframe 里）" : `${head}\n${read.text}`);
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
			delivery_mode: { type: "string", description: "background (default, no focus steal) or foreground." },
			refresh: { type: "boolean", default: false, description: "After a successful key press, fetch a fresh snapshot and append its refs (handy after Enter submits a form)." },
			confirm: { type: "boolean", description: "Pass true only after the user confirmed a quit/force-quit/logout shortcut." }
		},
		output: { schema: { type: "object", additionalProperties: false, properties: { schemaVersion: { type: "number", required: true }, ok: { type: "boolean", required: true }, text: { type: "string", required: true } } }, render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }] },
		isConcurrencySafe: () => false,
		presentCall: (args) => presentCall("Press key", args),
		async execute(args) {
			const key = String(args.key ?? "").toLowerCase();
			if (key.length === 0) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "browser_key 需要 key（如 return / tab / escape）" };
			// 0.86.0：browser_key 之前是任意 App 的无守卫键盘通道（cmd+q 可直接退出）
			const wantedKeys = [...(Array.isArray(args.modifiers) ? args.modifiers.filter((m) => typeof m === "string" && m.length > 0) : []), key];
			const keyGuard = guardHotkey(wantedKeys, args.confirm === true, config?.guard !== false);
			if (keyGuard.allowed !== true) {
				audit("browser_key_guarded", { key, modifiers: wantedKeys.length - 1 });
				return { schemaVersion: SCHEMA_VERSION, ok: false, text: String(keyGuard.reason) };
			}
			const explicitPid = Number.isInteger(args.pid) ? args.pid : undefined;
			// 0.116.0（审计 L7）：显式 pid 必须与当前浏览器绑定一致——否则 browser_key 实际是
			// 「对任意进程发键盘」的通道（名字却叫 browser_*，和 cua_act 边界混在一起）。
			if (explicitPid !== undefined && Number.isInteger(bound.pid) && explicitPid !== bound.pid) {
				return {
					schemaVersion: SCHEMA_VERSION,
					ok: false,
					text: `browser_key 的 pid 必须与已绑定的浏览器一致（bound pid=${String(bound.pid)}，收到 ${String(explicitPid)}）——先 browser_state 绑定目标窗口，或省略 pid 用绑定值。`
				};
			}
			const pid = explicitPid ?? bound.pid;
			if (!Number.isInteger(pid)) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "还没有绑定浏览器 pid：先 browser_state(pid, window_id)，或显式传 pid" };
			const delivery = args.delivery_mode === "foreground" ? "foreground" : "background";
			const modifiers = Array.isArray(args.modifiers) ? args.modifiers.filter((m) => typeof m === "string" && m.length > 0) : [];
			const outcome =
				modifiers.length === 0
					? await call("press_key", { pid, key, delivery_mode: delivery }, { timeoutMs: 30000 })
					: await call("hotkey", { pid, keys: [...modifiers, key], delivery_mode: delivery }, { timeoutMs: 30000 });
			if (outcome.ok !== true) return failedWithRecovery("key", outcome);
			const effect = typeof outcome.result?.effect === "string" ? outcome.result.effect : "sent";
			audit("browser_key", { ok: true, key, modifiers: modifiers.length });
			const keyNote = args.refresh === true ? await freshStateText({ maxRefs: 20 }) : "";
			return {
				schemaVersion: SCHEMA_VERSION,
				ok: true,
				text: `已发送 ${[...modifiers, key].join("+")}（${delivery}，effect=${effect}）；按键不可回读${keyNote === "" ? "，必要时用 browser_state 复核。" : `，下面是按键后的快照：\n${keyNote}`}`
			};
		}
	});

	register({
		name: "browser_launch",
		description:
			"Launch a separate browser instance with its own profile and debugging port — isolated cookies, no interference with the user's own browser, and it closes on demand. Returns pid/port/profileDir; pass that `port` to the other browser_* tools. Use it when the task needs a clean login environment (a different account) or should run in the background; bind the user's real browser (browser_prepare) instead when the task should reuse their existing session.",
		parameters: {
			browser: { type: "string", enum: ["auto", "chrome", "edge", "brave", "chromium"], description: "Which browser to launch; default auto (first installed)." },
			headless: { type: "boolean", description: "Run without a visible window (default false)." },
			url: { type: "string", description: "Start page (default about:blank)." },
			user_data_dir: { type: "string", description: "Profile directory to keep cookies across runs; omit for a temporary dir that browser_close deletes." },
			port: { type: "integer", description: "CDP port; omit to pick a free one." }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					schemaVersion: { type: "number", required: true },
					ok: { type: "boolean", required: true },
					text: { type: "string", required: true },
					pid: { type: "integer" },
					port: { type: "integer" },
					profileDir: { type: "string" },
					browser: { type: "string" },
					headless: { type: "boolean" }
				}
			},
			render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
		},
		isConcurrencySafe: () => false,
		async execute(args) {
			try {
				const launched = await launchBrowser({
					browser: typeof args.browser === "string" ? args.browser : "auto",
					headless: args.headless === true,
					userDataDir: typeof args.user_data_dir === "string" && args.user_data_dir !== "" ? args.user_data_dir : undefined,
					url: typeof args.url === "string" && args.url !== "" ? args.url : undefined,
					port: Number.isInteger(args.port) ? args.port : undefined
				});
				audit("browser_launch", { browser: launched.browser, port: launched.port, headless: launched.headless });
				return {
					schemaVersion: SCHEMA_VERSION,
					ok: true,
					text: `已启动 ${launched.browser}（${launched.headless ? "无头" : "可见"}），CDP 端口 ${String(launched.port)}，pid ${String(launched.pid)}，profile: ${launched.profileDir}${launched.temporaryProfile ? "（临时目录，关闭时删除）" : ""}。后续 browser_* 调用带 port: ${String(launched.port)}；用完 browser_close。`,
					pid: launched.pid,
					port: launched.port,
					profileDir: launched.profileDir,
					browser: launched.browser,
					headless: launched.headless
				};
			} catch (error) {
				audit("browser_launch_failed", { error: String(error?.message ?? error).slice(0, 200) });
				return { schemaVersion: SCHEMA_VERSION, ok: false, text: `browser_launch 失败：${String(error?.message ?? error)}` };
			}
		}
	});

	register({
		name: "browser_close",
		description:
			"Close a browser instance started by browser_launch. Pass the same `port` (plus pid / profile_dir from the launch result when you have them). A temporary profile created by browser_launch is deleted; a user_data_dir you supplied is left alone.",
		parameters: {
			port: { type: "integer", required: true, description: "CDP port returned by browser_launch." },
			pid: { type: "integer", description: "Process id returned by browser_launch (fallback kill)." },
			profile_dir: { type: "string", description: "profileDir returned by browser_launch; only dsh-operator temp dirs are deleted." }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					schemaVersion: { type: "number", required: true },
					ok: { type: "boolean", required: true },
					text: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			const port = Number.isInteger(args.port) ? args.port : 0;
			if (port <= 0) return { schemaVersion: SCHEMA_VERSION, ok: false, text: "browser_close 需要 browser_launch 返回的 port" };
			const outcome = await closeBrowser({
				port,
				pid: Number.isInteger(args.pid) ? args.pid : undefined,
				profileDir: typeof args.profile_dir === "string" ? args.profile_dir : undefined,
				removeProfile: true
			});
			audit("browser_close", { port, note: outcome.note.slice(0, 120) });
			return { schemaVersion: SCHEMA_VERSION, ok: true, text: `已关闭端口 ${String(port)} 上的浏览器：${outcome.note}` };
		}
	});

	audit("browser_tools_registered", { names: BROWSER_TOOL_NAMES.length, session });
	lastBrowserToolsState = { registered: true, names: [...BROWSER_TOOL_NAMES] };
	return { registered: true, names: [...BROWSER_TOOL_NAMES] };
}
