// CDP 后端（P2）：给 operator 补上「导航后等网络空闲、控制台错误、失败请求」这类
// 只能从 Chrome DevTools Protocol 拿到的事实。
//
// 边界（很重要）：
// - cua-driver 的 browser_* 通道把 CDP 封装在它自己的环回代理后面，只暴露语义快照与
//   输入动作，拿不到 Runtime/Network 事件；所以本模块**只连用户显式开启的调试端口**。
// - 需要 Chrome 以 `--remote-debugging-port=<port>` 启动（建议配独立 user-data-dir，
//   避开浏览器对默认 profile 的安全限制），并在插件配置里设置 `browserCdpPort`。
// - 只读：启用 Runtime/Log/Network 并收集事件，不执行页面 JS、不改 DOM、不导 Cookie。

/** 连接与等待失败时，给人看的下一步。 */
export const CDP_UNAVAILABLE_HINT =
	"CDP 不可用：用 `--remote-debugging-port=9222 --user-data-dir=<独立目录>` 启动 Chrome（或 Edge/Brave），再在插件配置里设置 `browserCdpPort`；当前实现只连显式开启的调试端口，不复用 cua-driver 的环回代理。";

/** 视为「失败」的 HTTP 状态。 */
export function isFailureStatus(status) {
	return Number.isInteger(status) && status >= 400;
}

/** 从 /json/list 里挑一个页面 target。 */
export function pickTarget(targets, { urlContains, titleContains, index } = {}) {
	const pages = (Array.isArray(targets) ? targets : []).filter((t) => t && t.type === "page" && typeof t.webSocketDebuggerUrl === "string");
	const filtered = pages.filter((t) => {
		if (typeof urlContains === "string" && urlContains.length > 0 && !String(t.url ?? "").includes(urlContains)) return false;
		if (typeof titleContains === "string" && titleContains.length > 0 && !String(t.title ?? "").includes(titleContains)) return false;
		return true;
	});
	if (Number.isInteger(index) && index >= 0) return filtered[index];
	return filtered[0];
}

/** 控制台条目 → 一行摘要（只保留有用的字段，避免把整页对象塞回上下文）。 */
export function summarizeConsoleEntry(entry) {
	if (entry === null || typeof entry !== "object") return String(entry ?? "");
	if (entry.kind === "exception") return `异常: ${String(entry.text ?? "").slice(0, 300)}`;
	if (entry.kind === "log") return `${String(entry.level ?? "log")}: ${String(entry.text ?? "").slice(0, 300)}`;
	const args = Array.isArray(entry.args) ? entry.args.map((a) => String(a?.value ?? a?.description ?? a?.type ?? "?")).join(" ") : "";
	return `${String(entry.type ?? "log")}: ${args.slice(0, 300)}`;
}

/** 控制台条目 → "error" / "warning"（异常一律算 error）；无法判断时返回 "error"。 */
export function consoleEntryLevel(entry) {
	if (entry === null || typeof entry !== "object") return "error";
	if (entry.kind === "exception") return "error";
	if (entry.kind === "log") return String(entry.level ?? "error") === "warning" ? "warning" : "error";
	const type = String(entry.type ?? "error");
	return type === "warning" ? "warning" : "error";
}

/** 网络条目 → 一行摘要。 */
export function summarizeNetworkEntry(entry) {
	if (entry === null || typeof entry !== "object") return String(entry ?? "");
	const status = entry.status === undefined ? "" : ` ${String(entry.status)}`;
	const reason = entry.errorText ? ` (${String(entry.errorText)})` : "";
	return `${String(entry.method ?? "GET")} ${String(entry.url ?? "").slice(0, 160)}${status}${reason}`;
}

async function fetchJson(url, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), Math.max(500, timeoutMs));
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}

/** 读出容器目标的浏览器信息；连不上返回 {ok:false, error}。 */
export async function cdpVersion(port, { host = "127.0.0.1", timeoutMs = 3000 } = {}) {
	const base = `http://${host}:${Number(port)}`;
	try {
		const version = await fetchJson(`${base}/json/version`, timeoutMs);
		return { ok: true, version };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** 列出可调试 target。 */
export async function cdpTargets(port, { host = "127.0.0.1", timeoutMs = 3000 } = {}) {
	try {
		return { ok: true, targets: await fetchJson(`http://${host}:${Number(port)}/json/list`, timeoutMs) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * 连接一个页面 target 的 CDP WebSocket。
 * @returns {Promise<{ok:true, client:object, target:object} | {ok:false, error:string}>}
 */
export async function openPage(port, options = {}) {
	const { host = "127.0.0.1", timeoutMs = 5000 } = options;
	const listed = await cdpTargets(port, { host, timeoutMs });
	if (listed.ok !== true) return { ok: false, error: listed.error };
	const target = pickTarget(listed.targets, options);
	if (target === undefined) return { ok: false, error: "没有匹配的页面 target（用 url_contains/title_contains/index 指定）" };
	if (typeof WebSocket !== "function") return { ok: false, error: "CDP 需要 Node ≥22（全局 WebSocket）" };

	const ws = new WebSocket(target.webSocketDebuggerUrl);
	let nextId = 1;
	const pending = new Map();
	const listeners = new Set();
	const cleanup = () => {
		for (const [, entry] of pending) entry.reject(new Error("CDP closed"));
		pending.clear();
	};
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("CDP connect timeout")), Math.max(1000, timeoutMs));
		ws.addEventListener(
			"open",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true }
		);
		ws.addEventListener(
			"error",
			() => {
				clearTimeout(timer);
				reject(new Error("CDP connect failed"));
			},
			{ once: true }
		);
	}).catch(() => null);
	if (ws.readyState !== 1) {
		ws.close();
		return { ok: false, error: "CDP WebSocket 连不上（检查端口/Origin 限制）" };
	}
	ws.addEventListener("message", (event) => {
		let message;
		try {
			message = JSON.parse(String(event.data));
		} catch {
			return;
		}
		if (message.id && pending.has(message.id)) {
			const entry = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) entry.reject(new Error(`${message.error.code}: ${message.error.message}`));
			else entry.resolve(message.result);
			return;
		}
		for (const listener of listeners) listener(message);
	});
	ws.addEventListener("close", cleanup);
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params }));
			setTimeout(() => {
				if (!pending.has(id)) return;
				pending.delete(id);
				reject(new Error(`CDP ${method} timeout`));
			}, 10000);
		});
	const client = {
		send,
		on(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		close() {
			cleanup();
			try {
				ws.close();
			} catch {
				/* ignore */
			}
		}
	};
	return { ok: true, client, target };
}

/**
 * 读页面可见文本（只跑固定表达式 `document.body.innerText`，不执行任意 JS）。
 * @param {object} client CDP 客户端。
 * @param {{maxChars?:number}} options
 * @returns {Promise<{ok:boolean, text?:string, truncated?:boolean, title?:string, url?:string, error?:string}>}
 */
export async function readPageText(client, { maxChars = 4000, selector } = {}) {
	const limit = Number.isFinite(maxChars) ? Math.max(200, Math.min(20000, Math.trunc(maxChars))) : 4000;
	// selector 只用来定位元素，表达式仍是固定骨架；选择器本身走 JSON.stringify，不拼任意代码。
	const expression = typeof selector === "string" && selector !== ""
		? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.innerText : ""; })()`
		: "document.body ? document.body.innerText : ''";
	const evaluated = await client
		.send("Runtime.evaluate", { expression, returnByValue: true })
		.catch((error) => ({ error }));
	if (evaluated === undefined || evaluated === null || evaluated.error !== undefined) {
		return { ok: false, error: `读取页面文本失败：${evaluated?.error?.message ?? "未知错误"}` };
	}
	const raw = String(evaluated.result?.value ?? "");
	const text = raw.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
	if (text === "") return { ok: true, text: "", truncated: false };
	const truncated = text.length > limit;
	return { ok: true, text: truncated ? text.slice(0, limit) : text, truncated };
}

/**
 * 只读「可交互元素的文案」：链接/按钮/输入框等，适合先知道页面上能点什么。
 * 表达式是固定骨架，选择器只做 JSON 转义插入，不执行任意页面 JS。
 * @param {object} client CDP 客户端。
 * @param {{ maxChars?: number, selector?: string }} [options]
 * @returns {Promise<{ok: boolean, text?: string, truncated?: boolean, error?: string}>}
 */
export async function readInteractiveText(client, { maxChars = 4000, selector } = {}) {
	const limit = Number.isFinite(maxChars) ? Math.max(200, Math.min(20000, Math.trunc(maxChars))) : 4000;
	const scope = typeof selector === "string" && selector !== "" ? `document.querySelector(${JSON.stringify(selector)})` : "document.body";
	const expression =
		`(() => {
			const root = ${scope};
			if (!root) return "";
			const nodes = root.querySelectorAll('a,button,input,select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[role="menuitem"],[role="option"]');
			const lines = [];
			for (const el of nodes) {
				const tag = el.tagName.toLowerCase();
				const role = (el.getAttribute("role") || tag).trim();
				const label = String(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim();
				if (label === "") continue;
				lines.push(role + " · " + label.slice(0, 80));
				if (lines.length >= 120) break;
			}
			return lines.join("\n");
		})()`;
	const evaluated = await client
		.send("Runtime.evaluate", { expression, returnByValue: true })
		.catch((error) => ({ error }));
	if (evaluated === undefined || evaluated === null || evaluated.error !== undefined) {
		return { ok: false, error: `读取可交互元素失败：${evaluated?.error?.message ?? "未知错误"}` };
	}
	const raw = String(evaluated.result?.value ?? "");
	const text = raw.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
	if (text === "") return { ok: true, text: "", truncated: false };
	const truncated = text.length > limit;
	return { ok: true, text: truncated ? text.slice(0, limit) : text, truncated };
}

/**
 * 等页面进入「网络空闲 + 就绪」状态。
 * @returns {Promise<{ok:boolean, url?:string, readyState?:string, idleMs?:number, error?:string}>}
 */
export async function waitForNetworkIdle(client, { timeoutMs = 15000, idleMs = 500 } = {}) {
	await client.send("Network.enable");
	await client.send("Runtime.enable");
	let inflight = 0;
	let lastActivity = Date.now();
	const onEvent = (message) => {
		const method = String(message.method ?? "");
		if (method === "Network.requestWillBeSent") {
			inflight += 1;
			lastActivity = Date.now();
		} else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
			inflight = Math.max(0, inflight - 1);
			lastActivity = Date.now();
		}
	};
	const off = client.on(onEvent);
	const deadline = Date.now() + Math.max(1000, timeoutMs);
	try {
		while (Date.now() < deadline) {
			const evaluated = await client.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }).catch(() => null);
			const readyState = evaluated?.result?.value;
			const idle = inflight === 0 && Date.now() - lastActivity >= Math.max(100, idleMs);
			if (readyState === "complete" && idle) {
				const url = await client.send("Runtime.evaluate", { expression: "location.href", returnByValue: true }).catch(() => null);
				return { ok: true, url: url?.result?.value, readyState, idleMs: Date.now() - lastActivity };
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return { ok: false, error: `等待网络空闲超时（${Math.round(timeoutMs / 1000)}s，仍在途 ${inflight} 个请求）` };
	} finally {
		off();
	}
}

/**
 * 等某个 CSS 选择器出现（可选：等到可见）。
 * 表达式是固定模板，选择器走 JSON 转义，不拼接任意 JS。
 * @param {object} client CDP 客户端（需有 send）。
 * @param {string} selector CSS 选择器。
 * @param {{timeoutMs?:number, visible?:boolean, intervalMs?:number}} options
 * @returns {Promise<{ok:boolean, found:boolean, visible?:boolean, elapsedMs:number, error?:string}>}
 */
/**
 * 等页面可见文本出现（固定骨架表达式，文本用 JSON 字符串嵌入，不执行任意 JS）。
 * 适合「提交后等结果文案」「等加载提示消失」这类没有稳定选择器的场景。
 * @param {{send:Function}} client openPage 返回的客户端。
 * @param {string} text 要等的可见文本片段。
 * @param {{timeoutMs?:number, intervalMs?:number}} [options]
 * @returns {Promise<{ok:boolean, found:boolean, elapsedMs:number, error?:string}>}
 */
export async function waitForText(client, text, { timeoutMs = 10000, intervalMs = 200 } = {}) {
	const needle = String(text ?? "").trim();
	if (needle === "") return { ok: false, found: false, elapsedMs: 0, error: "text 不能为空" };
	const expression = `(() => {
		const body = document.body;
		if (!body) return { found: false };
		const value = typeof body.innerText === "string" ? body.innerText : "";
		return { found: value.includes(${JSON.stringify(needle)}) };
	})()`;
	const started = Date.now();
	const deadline = started + Math.max(1000, timeoutMs);
	const step = Math.max(100, Math.min(1000, intervalMs));
	while (Date.now() < deadline) {
		const evaluated = await client.send("Runtime.evaluate", { expression, returnByValue: true }).catch(() => null);
		const elapsedMs = Date.now() - started;
		if (evaluated?.result?.value?.found === true) return { ok: true, found: true, elapsedMs };
		await new Promise((resolve) => setTimeout(resolve, step));
	}
	const elapsedMs = Date.now() - started;
	return { ok: false, found: false, elapsedMs, error: `等文本超时（${Math.round(elapsedMs / 1000)}s）：${needle}` };
}

export async function waitForSelector(client, selector, { timeoutMs = 10000, visible = false, intervalMs = 200 } = {}) {
	const target = String(selector ?? "").trim();
	if (target === "") return { ok: false, found: false, elapsedMs: 0, error: "selector 不能为空" };
	const expression = `(() => {
		const el = document.querySelector(${JSON.stringify(target)});
		if (!el) return { found: false };
		const rect = el.getBoundingClientRect();
		const style = getComputedStyle(el);
		const shown = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
		return { found: true, visible: shown };
	})()`;
	const started = Date.now();
	const deadline = started + Math.max(1000, timeoutMs);
	const step = Math.max(100, Math.min(1000, intervalMs));
	while (Date.now() < deadline) {
		const evaluated = await client.send("Runtime.evaluate", { expression, returnByValue: true }).catch(() => null);
		const value = evaluated?.result?.value;
		const elapsedMs = Date.now() - started;
		if (value && value.found === true) {
			if (!visible || value.visible === true) return { ok: true, found: true, visible: value.visible === true, elapsedMs };
		}
		await new Promise((resolve) => setTimeout(resolve, step));
	}
	const elapsedMs = Date.now() - started;
	return {
		ok: false,
		found: false,
		elapsedMs,
		error: `等待选择器超时（${Math.round(elapsedMs / 1000)}s）：${target}${visible ? "（要求可见）" : ""}`
	};
}

/**
 * 收集一段时间内的控制台错误/异常。
 * @returns {Promise<{entries:Array<object>}>}
 */
export async function collectConsole(client, { durationMs = 3000, limit = 20, reload = false } = {}) {
	const entries = [];
	await client.send("Runtime.enable");
	await client.send("Log.enable");
	if (reload === true) {
		await client.send("Page.enable").catch(() => null);
		await client.send("Page.reload", { ignoreCache: false }).catch(() => null);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	const off = client.on((message) => {
		const method = String(message.method ?? "");
		if (method === "Runtime.consoleAPICalled") {
			const type = String(message.params?.type ?? "log");
			if (type !== "error" && type !== "warning" && type !== "assert") return;
			entries.push({ kind: "console", type, args: message.params?.args ?? [] });
		} else if (method === "Runtime.exceptionThrown") {
			const detail = message.params?.exceptionDetails ?? {};
			entries.push({ kind: "exception", text: detail.exception?.description ?? detail.text ?? "未知异常" });
		} else if (method === "Log.entryAdded") {
			const level = String(message.params?.entry?.level ?? "info");
			if (level !== "error" && level !== "warning") return;
			entries.push({ kind: "log", level, text: message.params?.entry?.text ?? "" });
		}
	});
	try {
		await new Promise((resolve) => setTimeout(resolve, Math.max(200, durationMs)));
		return { entries: entries.slice(-Math.max(1, limit)) };
	} finally {
		off();
	}
}

/** 收集一段时间内的失败请求与 4xx/5xx 响应。 */
export async function collectNetwork(client, { durationMs = 3000, limit = 20, reload = false } = {}) {
	const entries = [];
	const pending = new Map();
	await client.send("Network.enable");
	if (reload === true) {
		await client.send("Page.enable").catch(() => null);
		await client.send("Page.reload", { ignoreCache: false }).catch(() => null);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	const off = client.on((message) => {
		const method = String(message.method ?? "");
		const params = message.params ?? {};
		if (method === "Network.requestWillBeSent") {
			pending.set(params.requestId, { url: params.request?.url, method: params.request?.method });
		} else if (method === "Network.responseReceived") {
			const status = params.response?.status;
			if (isFailureStatus(status)) {
				entries.push({ url: params.response?.url, method: pending.get(params.requestId)?.method ?? "GET", status });
			}
		} else if (method === "Network.loadingFailed") {
			entries.push({ url: pending.get(params.requestId)?.url ?? "", method: pending.get(params.requestId)?.method ?? "GET", errorText: params.errorText ?? "失败" });
		}
	});
	try {
		await new Promise((resolve) => setTimeout(resolve, Math.max(200, durationMs)));
		return { entries: entries.slice(-Math.max(1, limit)) };
	} finally {
		off();
	}
}
