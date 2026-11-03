// 浏览器 DOM 通道（0.11.1 spike，默认不对外暴露工具）
//
// 两条后端路线，都遵守同一原则：**只读优先、可回退截图、不伪造指纹、不绕风控**。
//
// A) AppleScript JS（Chrome / Safari）
//    零重启、保留登录态；但需要用户手动开启：
//    Chrome：查看 → 开发者 → 允许 Apple 事件中的 JavaScript（菜单路径会随版本略有不同）
//    Safari：开发 → 允许 JavaScript（从 Apple 事件中）
//    开启后 osascript 可以 `execute ... javascript` 直接拿 DOM/点击/填表。
//
// B) CDP（Chrome 远程调试）
//    需要以 `--remote-debugging-port=<port>` 启动 Chrome（可用独立 user-data-dir 保留一套自动化登录态）。
//    本模块提供连接/求值工具；0.11.1 只用它做无侵入验证（临时 profile + headless），不动用户正在用的 Chrome。
//
// 安全边界：本模块只执行调用方给的 JS；不读取 Cookie/密码，不做指纹伪装；检测到风控挑战时由上层停止并请人工接管。

import { execFile } from "node:child_process";

/** AppleScript 通道被关闭时 Chrome 返回的错误特征。 */
const APPLESCRIPT_DISABLED_RE = /JavaScript 的功能已关闭|JavaScript from Apple Events|执行 JavaScript 的功能/;

export const APPLESCRIPT_DISABLED_HINT =
	"浏览器 DOM 通道未开启：Chrome 菜单「查看 → 开发者 → 允许 Apple 事件中的 JavaScript」（Safari：开发 → 允许 JavaScript（从 Apple 事件中））开启后重试；或在启动 Chrome 时加 --remote-debugging-port 走 CDP。";

/** AppleScript 字符串转义（仅处理 \ 和 "，并压成单行）。 */
export function escapeAppleScriptString(value) {
	return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replace(/\r?\n/g, " ");
}

/**
 * 构造「在 Chrome 前台标签页执行 JS」的 AppleScript。
 * @param {string} js 单行 JS（包含换行会被压成空格）
 */
export function buildAppleScriptEval(js, browser = "Google Chrome") {
	const target = browser === "Safari" ? "Safari" : "Google Chrome";
	return `tell application "${target}" to execute front window's active tab javascript "${escapeAppleScriptString(js)}"`;
}

/** 用于探测通道是否可用的最小脚本。 */
export function buildProbeScript() {
	return "JSON.stringify({title:document.title,url:location.href,ready:document.readyState})";
}

/**
 * 页面快照脚本：返回 JSON 字符串（由 AppleScript/CDP 传回后解析）。
 * 只读 DOM，不点击、不提交、不读 input 的值（避免把密码/敏感内容带回上下文）。
 */
export function buildSnapshotScript({ maxText = 4000, maxLinks = 80, maxInteractive = 60 } = {}) {
	return `JSON.stringify((() => {
  const limit = (s, n) => String(s || "").replace(/\\s+/g, " ").trim().slice(0, n);
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const links = Array.from(document.querySelectorAll("a[href]")).slice(0, ${Number(maxLinks)}).map((a) => ({ text: limit(a.innerText, 120), href: a.href, rect: rect(a) }));
  const interactive = Array.from(document.querySelectorAll("button, [role=button], input, select, textarea, [role=textbox], [role=link]")).slice(0, ${Number(maxInteractive)}).map((el) => ({
    tag: el.tagName.toLowerCase(), role: el.getAttribute("role") || "", type: el.getAttribute("type") || "",
    label: limit(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.innerText, 120),
    disabled: Boolean(el.disabled), rect: rect(el)
  }));
  return { url: location.href, title: document.title, ready: document.readyState, text: limit(document.body ? document.body.innerText : "", ${Number(maxText)}), links, interactive };
})())`;
}

/** 点击脚本：优先按 selector，其次按可见文本匹配 buttons/links。返回 JSON 字符串。 */
export function buildClickScript({ selector, text } = {}) {
	const sel = selector ? `document.querySelector(${JSON.stringify(String(selector))})` : "null";
	const txt = text ? JSON.stringify(String(text)) : "null";
	return `JSON.stringify((() => {
  const usable = (el) => {
    if (!el) return "not-found";
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    if (rect.width === 0 || rect.height === 0) return "not-visible";
    if (style.visibility === "hidden" || style.display === "none") return "hidden";
    if (el.disabled === true) return "disabled";
    if (el.getAttribute("aria-disabled") === "true") return "aria-disabled";
    return "ok";
  };
  const bySel = ${sel};
  if (bySel) {
    const state = usable(bySel);
    if (state !== "ok") return { ok: false, reason: "selector target " + state };
    bySel.scrollIntoView({ block: "center" });
    bySel.click();
    return { ok: true, how: "selector", matched: (bySel.innerText || bySel.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 80) };
  }
  const want = ${txt};
  if (want) {
    const nodes = Array.from(document.querySelectorAll("a,button,[role=button]"));
    const hit = nodes.find((el) => (el.innerText || "").replace(/\\s+/g, " ").trim().includes(want));
    if (hit) { hit.scrollIntoView({ block: "center" }); hit.click(); return { ok: true, how: "text", matched: (hit.innerText || "").trim().slice(0, 80) }; }
    return { ok: false, reason: "text not found" };
  }
  return { ok: false, reason: "no selector or text" };
})())`;
}

/** 填表脚本：设置 value 并派发 input/change（React 等受控组件也能感知）。 */
export function buildFillScript({ selector, value } = {}) {
	const want = JSON.stringify(String(value ?? ""));
	return `JSON.stringify((() => {
  const el = document.querySelector(${JSON.stringify(String(selector ?? ""))});
  if (!el) return { ok: false, reason: "selector not found" };
  if (el.type === "password") return { ok: false, reason: "password field refused" };
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc && desc.set) desc.set.call(el, ${want}); else el.value = ${want};
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, valueLength: String(el.value || "").length };
})())`;
}

function defaultRunner(command, args) {
	return new Promise((resolve) => {
		execFile(command, args, { timeout: 8000 }, (error, stdout, stderr) => {
			resolve({ ok: error === null, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), error: error?.message ?? "" });
		});
	});
}

/**
 * 探测 AppleScript DOM 通道是否可用（不发请求、不读页面内容）。
 * @returns {Promise<{available:boolean, reason:string, hint?:string}>}
 */
export async function probeAppleScriptDom({ browser = "Google Chrome", runner = defaultRunner } = {}) {
	const script = buildAppleScriptEval(buildProbeScript(), browser);
	const result = await runner("/usr/bin/osascript", ["-e", script]);
	if (result.ok) return { available: true, reason: "ok" };
	const text = `${result.stderr} ${result.error}`;
	if (APPLESCRIPT_DISABLED_RE.test(text)) return { available: false, reason: "disabled", hint: APPLESCRIPT_DISABLED_HINT };
	return { available: false, reason: "error", hint: text.slice(0, 200) };
}

/**
 * 在浏览器前台标签页执行 JS。
 * @returns {Promise<{ok:boolean, value?:string, code?:string, error?:string, hint?:string}>}
 */
export async function evalAppleScriptDom({ js, browser = "Google Chrome", runner = defaultRunner } = {}) {
	const result = await runner("/usr/bin/osascript", ["-e", buildAppleScriptEval(js, browser)]);
	if (result.ok) return { ok: true, value: result.stdout };
	const text = `${result.stderr} ${result.error}`;
	if (APPLESCRIPT_DISABLED_RE.test(text)) return { ok: false, code: "disabled", error: "DOM channel disabled", hint: APPLESCRIPT_DISABLED_HINT };
	return { ok: false, code: "error", error: text.slice(0, 300) };
}

/** 页面快照（AppleScript 通道）。返回解析后的对象；通道不可用/解析失败时抛错由上层降级。 */
export async function readDomSnapshot({ browser = "Google Chrome", runner = defaultRunner, ...limits } = {}) {
	const result = await evalAppleScriptDom({ js: buildSnapshotScript(limits), browser, runner });
	if (!result.ok) throw Object.assign(new Error(result.error), result);
	try {
		return JSON.parse(result.value);
	} catch {
		throw new Error("DOM snapshot: browser returned non-JSON result");
	}
}

/** 按 selector/text 点击（AppleScript 通道）。 */
export async function clickDom({ browser = "Google Chrome", runner = defaultRunner, selector, text } = {}) {
	const result = await evalAppleScriptDom({ js: buildClickScript({ selector, text }), browser, runner });
	if (!result.ok) throw Object.assign(new Error(result.error), result);
	return JSON.parse(result.value);
}

/** 填表（AppleScript 通道）。 */
export async function fillDom({ browser = "Google Chrome", runner = defaultRunner, selector, value } = {}) {
	const result = await evalAppleScriptDom({ js: buildFillScript({ selector, value }), browser, runner });
	if (!result.ok) throw Object.assign(new Error(result.error), result);
	return JSON.parse(result.value);
}

// ---------------------------------------------------------------------------
// CDP（Chrome 远程调试）最小客户端：spike 用，Node ≥22 自带全局 WebSocket。
// ---------------------------------------------------------------------------

/** 解析 user-data-dir 下的 DevToolsActivePort 文件（两行：端口 / ws 路径）。 */
export function parseDevToolsActivePort(content) {
	const lines = String(content ?? "").trim().split("\n");
	const port = Number(lines[0]);
	if (!Number.isInteger(port) || port <= 0) return null;
	return { port, wsPath: lines[1] || "/devtools/browser" };
}

/**
 * 连接 CDP。返回 { send(method, params), close() }；调用方负责重试与超时。
 * @param {string} webSocketDebuggerUrl 形如 ws://127.0.0.1:9222/devtools/browser/xxx
 */
export async function cdpConnect(webSocketDebuggerUrl) {
	if (typeof WebSocket !== "function") throw new Error("CDP 需要 Node ≥22（全局 WebSocket）");
	const ws = new WebSocket(webSocketDebuggerUrl);
	let nextId = 1;
	const pending = new Map();
	await new Promise((resolve, reject) => {
		ws.addEventListener("open", resolve, { once: true });
		ws.addEventListener("error", (event) => reject(new Error(`CDP connect failed: ${event?.message ?? "error"}`)), { once: true });
	});
	ws.addEventListener("message", (event) => {
		let message;
		try {
			message = JSON.parse(String(event.data));
		} catch {
			return;
		}
		if (message.id && pending.has(message.id)) {
			const { resolve, reject } = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) reject(new Error(`${message.error.code}: ${message.error.message}`));
			else resolve(message.result);
		}
	});
	const send = (method, params = {}, sessionId) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			const message = { id, method, params };
			if (sessionId) message.sessionId = sessionId;
			ws.send(JSON.stringify(message));
			setTimeout(() => {
				if (pending.has(id)) {
					pending.delete(id);
					reject(new Error(`CDP timeout: ${method}`));
				}
			}, 8000).unref?.();
		});
	return { send, close: () => ws.close() };
}

// ---------------------------------------------------------------------------
// CDP 后端（0.11.4）：连到用户自己启动的 Chrome 调试端口，作为 AppleScript 通道的备选。
// 不接管浏览器生命周期，也不动用户 profile；只需 Chrome 以 --remote-debugging-port=N 启动。
// ---------------------------------------------------------------------------

async function fetchJson(url, timeoutMs = 3000) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (response.ok !== true) throw new Error(`HTTP ${response.status} for ${url}`);
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 用 CDP 在「指定的 page target」执行 JS。CDP 端口需由调用方确保 Chrome 已以调试端口启动。
 * 0.116.1（审计 L11）：CDP 的 `/json/list` 并不暴露「哪个标签在前台」，之前注释写「当前活动页面」
 * 其实是第一个 page target——多标签时可能读/点/填到后台页。现在支持显式 `targetId`；
 * 不传时优先带 attached 的 target，再退回第一个，调用方需要确定性时应显式指定。
 * @returns {Promise<string>} Runtime.evaluate 的字符串结果
 */
export async function cdpEvalScript({ port, js, targetId, timeoutMs = 8000 } = {}) {
	if (Number.isInteger(port) === false || port <= 0) throw new Error("CDP port is required");
	if (typeof WebSocket !== "function") throw new Error("CDP 需要 Node ≥22（全局 WebSocket）");
	const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
	const pages = Array.isArray(targets) ? targets.filter((target) => target.type === "page" && typeof target.webSocketDebuggerUrl === "string") : [];
	const page = typeof targetId === "string" && targetId !== ""
		? pages.find((target) => target.id === targetId)
		: pages.find((target) => target.attached === true) ?? pages[0];
	if (!page) throw new Error(`CDP: no page target on port ${port}${typeof targetId === "string" && targetId !== "" ? ` (targetId=${targetId})` : ""}`);
	const client = await cdpConnect(page.webSocketDebuggerUrl);
	try {
		const result = await client.send("Runtime.evaluate", { expression: js, returnByValue: true, awaitPromise: true });
		if (result?.exceptionDetails) throw new Error(`CDP page exception: ${result.exceptionDetails.text}`);
		return String(result?.result?.value ?? "");
	} finally {
		client.close();
	}
}

/** 页面快照（CDP 通道）。 */
export async function readCdpSnapshot({ port, ...limits } = {}) {
	const text = await cdpEvalScript({ port, js: buildSnapshotScript(limits) });
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("CDP snapshot: browser returned non-JSON result");
	}
}

/** 点击（CDP 通道）。 */
export async function clickCdpDom({ port, selector, text } = {}) {
	const value = JSON.parse(await cdpEvalScript({ port, js: buildClickScript({ selector, text }) }));
	return value;
}

/** 填表（CDP 通道）。 */
export async function fillCdpDom({ port, selector, value } = {}) {
	return JSON.parse(await cdpEvalScript({ port, js: buildFillScript({ selector, value }) }));
}

/** 探测 CDP 端口是否可用（不执行页面 JS）。 */
export async function probeCdp({ port } = {}) {
	if (Number.isInteger(port) === false || port <= 0) return { available: false, reason: "no-port" };
	try {
		const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
		return { available: true, reason: "ok", browser: String(version?.Browser ?? "") };
	} catch (error) {
		return { available: false, reason: "unreachable", hint: error instanceof Error ? error.message : String(error) };
	}
}
