// cua-driver 客户端（0.22.0）：把 cua-driver 的后台投递能力接成 dsh-operator 的可选工具面。
//
// 为什么走 cua-driver：它的 click/type_text/press_key/hotkey/scroll/drag 默认以
// `delivery_mode:"background"` 投递到「指定 pid/window_id」，不移动真实指针、
// 不抢用户焦点，因此 AI 在操作窗口时用户还能用同一台 Mac 做别的事。
//
// 本文件只负责「进程与 JSON」：
// - 定位二进制（env DSH_OPERATOR_CUA_BIN 优先，其次 PATH、~/.local/bin、Homebrew 常见目录）
// - 保证 daemon 在跑（`cua-driver serve`，socket 默认交给 CLI，可用 env DSH_OPERATOR_CUA_SOCKET 覆盖）
// - `cua-driver call <tool> '<json>'` 并解析 JSON 输出
// 语义细节（element_token、后台投递、fallback）在 lib/cua-tools.js。

import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { audit } from "./audit-log.js";

const execFileAsync = promisify(execFile);

/** 调用超时（毫秒）：run_steps 整批上限 60s，这里留出余量。 */
const DEFAULT_CALL_TIMEOUT_MS = 65000;
/** 等待 daemon 就绪的上限。 */
const DAEMON_WAIT_MS = 8000;

/** 截图被 TCC 挡住时 cua-driver 返回的固定标记。 */
export const CAPTURE_CONSENT_MARKER = "direct_capture_consent_required";

/** 给模型看的截图授权提示（TCC 由用户点一次 Allow 即可）。 */
export const SCREEN_RECORDING_HINT =
	"cua-driver 截屏需要屏幕录制授权：请在终端运行 `cua-driver permissions grant` 并在系统弹窗点 Allow（或到「系统设置 → 隐私与安全性 → 屏幕录制」勾选 CuaDriver），之后重试即可。AX 树与后台操作不受影响。";

function isExecutable(path) {
	if (typeof path !== "string" || path.length === 0) return false;
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * 定位 cua-driver 可执行文件。
 * @returns {string | undefined} 找不到时 undefined（调用方据此跳过 cua_* 工具）
 */
export function resolveCuaDriverBinary() {
	const explicit = process.env.DSH_OPERATOR_CUA_BIN;
	if (isExecutable(explicit)) return explicit;
	const dirs = [];
	for (const dir of (process.env.PATH ?? "").split(":")) if (dir.length > 0) dirs.push(dir);
	dirs.push(join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin");
	for (const dir of dirs) {
		const candidate = join(dir, "cua-driver");
		if (isExecutable(candidate)) return candidate;
	}
	return undefined;
}

/** @returns {string | undefined} 显式配置的 socket 路径 */
export function cuaSocketPath() {
	const explicit = process.env.DSH_OPERATOR_CUA_SOCKET;
	return typeof explicit === "string" && explicit.length > 0 ? explicit : void 0;
}

async function runRaw(bin, args, { socket, timeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) {
	const full = socket === void 0 ? args : ["--socket", socket, ...args];
	try {
		const { stdout } = await execFileAsync(bin, full, {
			timeout: timeoutMs,
			maxBuffer: 64 * 1024 * 1024,
			encoding: "utf8"
		});
		return stdout;
	} catch (error) {
		const stdout = typeof error.stdout === "string" ? error.stdout : "";
		const stderr = typeof error.stderr === "string" ? error.stderr : "";
		const message = (stderr.length > 0 ? stderr : stdout.length > 0 ? stdout : String(error.message ?? "")).trim();
		const tail = message.split("\n").slice(-8).join("\n");
		const failure = new Error(`cua-driver ${args.slice(0, 2).join(" ")} 失败：${tail.length > 0 ? tail : "未知错误"}`);
		failure.stdout = stdout;
		failure.stderr = stderr;
		throw failure;
	}
}

function parseJsonOutput(stdout, tool) {
	const start = stdout.indexOf("{");
	const end = stdout.lastIndexOf("}");
	if (start < 0 || end < start) throw new Error(`cua-driver ${tool} 返回了非 JSON 输出：${stdout.trim().slice(0, 200)}`);
	const parsed = JSON.parse(stdout.slice(start, end + 1));
	if (parsed === null || typeof parsed !== "object") throw new Error(`cua-driver ${tool} 返回了非对象 JSON`);
	return parsed;
}

/** 解析 `cua-driver status` 文本。 */
export function parseDaemonStatus(stdout) {
	const lines = String(stdout ?? "").split("\n");
	const field = (label) => {
		const line = lines.find((entry) => entry.trim().toLowerCase().startsWith(label));
		return line === void 0 ? void 0 : line.split(":").slice(1).join(":").trim();
	};
	const running = lines.some((line) => /daemon is running/i.test(line));
	const pidText = field("pid:");
	return {
		running,
		socket: field("socket:") ?? field("socket path:"),
		pid: pidText !== void 0 && /^\d+$/.test(pidText) ? Number(pidText) : void 0,
		permissionMode: field("permission mode:")
	};
}

/** 查询 daemon 状态；未运行时 never throw。 */
export async function cuaDaemonStatus(bin, { socket, timeoutMs = 5000 } = {}) {
	try {
		const stdout = await runRaw(bin, ["status"], { socket, timeoutMs });
		return parseDaemonStatus(stdout);
	} catch {
		return { running: false };
	}
}

/** 每个二进制只保留一个「确保 daemon 就绪」的 promise，避免并发重复 spawn。 */
const daemonPromises = new Map();

/**
 * 确保 daemon 在跑；不在跑就 detached 起一个 `cua-driver serve` 并轮询 status。
 * @param {string} bin
 * @param {{ socket?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ running: boolean, socket?: string, pid?: number, permissionMode?: string }>}
 */
export function ensureCuaDaemon(bin, { socket, timeoutMs = DAEMON_WAIT_MS } = {}) {
	const key = `${bin}\u0000${socket ?? ""}`;
	const existing = daemonPromises.get(key);
	if (existing !== void 0) return existing;
	const promise = startDaemon(bin, { socket, timeoutMs }).finally(() => daemonPromises.delete(key));
	daemonPromises.set(key, promise);
	return promise;
}

async function startDaemon(bin, { socket, timeoutMs }) {
	const initial = await cuaDaemonStatus(bin, { socket, timeoutMs: 3000 });
	if (initial.running === true) return initial;
	const args = socket === void 0 ? ["serve"] : ["--socket", socket, "serve"];
	const child = spawn(bin, args, { detached: true, stdio: "ignore" });
	child.unref();
	audit("cua_daemon_spawn", { pid: child.pid ?? 0 });
	const deadline = Date.now() + Math.max(1000, timeoutMs);
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 150));
		const status = await cuaDaemonStatus(bin, { socket, timeoutMs: 2000 });
		if (status.running === true) return status;
	}
	throw new Error(
		`cua-driver daemon 没有起来（超时 ${Math.round(timeoutMs / 1000)}s）。可手动运行 \`cua-driver serve\` 查看报错；不需要时用 DSH_OPERATOR_CUA=0 关闭 cua_* 工具。`
	);
}

/** 调用一个 cua-driver 工具（JSON 参数）。 */
export async function cuaCall(bin, tool, args = {}, { socket, timeoutMs } = {}) {
	const stdout = await runRaw(bin, ["call", tool, JSON.stringify(args)], { socket, timeoutMs });
	return parseJsonOutput(stdout, tool);
}

/** 列出窗口（含显示器前台窗口信息）。 */
export async function cuaListWindows(bin, { socket, onScreenOnly = true } = {}) {
	await ensureCuaDaemon(bin, { socket });
	return cuaCall(bin, "list_windows", onScreenOnly === true ? { on_screen_only: true } : {}, { socket });
}

/** 屏幕尺寸（逻辑点 + backing scale）。 */
export async function cuaScreenSize(bin, { socket } = {}) {
	await ensureCuaDaemon(bin, { socket });
	return cuaCall(bin, "get_screen_size", {}, { socket });
}

/** 列表运行中的 App。 */
export async function cuaListApps(bin, { socket } = {}) {
	await ensureCuaDaemon(bin, { socket });
	return cuaCall(bin, "list_apps", {}, { socket });
}

/**
 * 读窗口 AX 树（可附带截图）。
 * @param {string} bin
 * @param {{ pid: number, windowId: number, includeScreenshot?: boolean, screenshotPath?: string, treeFormat?: string, maxElements?: number, maxDepth?: number, maxImageDimension?: number, since?: string, socket?: string, timeoutMs?: number, query?: string }} options
 */
export async function cuaWindowState(bin, { pid, windowId, includeScreenshot = false, screenshotPath, treeFormat = "elements", maxElements = 200, maxDepth, maxImageDimension, since, socket, timeoutMs, query }) {
	await ensureCuaDaemon(bin, { socket });
	const args = {
		pid,
		window_id: windowId,
		include_screenshot: includeScreenshot === true,
		include_accessibility_tree: true,
		tree_format: treeFormat,
		max_elements: maxElements
	};
	if (typeof maxDepth === "number") args.max_depth = maxDepth;
	if (typeof maxImageDimension === "number" && maxImageDimension > 0) args.max_image_dimension = maxImageDimension;
	if (typeof screenshotPath === "string" && screenshotPath.length > 0) args.screenshot_out_file = screenshotPath;
	if (typeof since === "string" && since.length > 0) args.since = since;
	if (typeof query === "string" && query.length > 0) args.query = query;
	return cuaCall(bin, "get_window_state", args, { socket, timeoutMs });
}

/**
 * 批量执行步骤（cua-driver 的 run_steps：默认后台投递、首错即停、可选 observe diff）。
 * @param {string} bin
 * @param {{ pid: number, windowId: number, steps: unknown[], observe?: object, delayMs?: number, deliveryMode?: string, socket?: string, timeoutMs?: number }} options
 */
export async function cuaRunSteps(bin, { pid, windowId, steps, observe, delayMs, deliveryMode, socket, timeoutMs }) {
	await ensureCuaDaemon(bin, { socket });
	const args = { pid, window_id: windowId, steps };
	if (observe !== void 0) args.observe = observe;
	if (typeof delayMs === "number") args.delay_ms = delayMs;
	if (typeof deliveryMode === "string" && deliveryMode.length > 0) args.delivery_mode = deliveryMode;
	return cuaCall(bin, "run_steps", args, { socket, timeoutMs });
}

/** 判断错误是不是「截图被 TCC 挡住」。 */
export function isCaptureConsentError(error) {
	const message = String(error?.message ?? "");
	return message.includes(CAPTURE_CONSENT_MARKER);
}
