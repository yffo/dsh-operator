// dsh-operator AX 快照观察（P1-6）
//
// 原生 AppKit 应用的 Accessibility 树比截图更“干净”：一次快照就能拿到角色、
// 标题、值与位置。这里只做最小取证：有 frame 的节点、节点/深度受限、值截断，
// 并把窗口内的位置换算成 0–1000 的截图坐标，模型可以直接用现有 click(x,y)。
//
// 设计约束：
// - 纯补充：AX 失败/未授权/树太浅时返回 undefined，视觉快照照常工作。
// - 观察只读；AXPress 只在 ax_press 工具显式调用时发生（后台投递，不动光标）。
// - 体积可控：节点上限 + 文本字节上限，避免 AX 树把 token 打爆。

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELPER_PATH = join(dirname(fileURLToPath(import.meta.url)), "bin", "ax-snapshot");
const DEFAULT_MAX_NODES = 120;
const MAX_TEXT_BYTES = 32 * 1024;
/** 单次快照正文的字符预算（超出后截断并标 truncated）。 */
export const MAX_TEXT_CHARS = 24000;
// 无身份容器节点（有 frame、role 在 IDENTITY_ROLES 里但没有 title/value）超过这个数就裁剪，
// 避免 AX 树里的装饰性容器把 token 打爆；保留的节点仍沿用 helper 的原始 index。
export const MAX_ANONYMOUS_NODES = 40;
const HELPER_TIMEOUT_MS = 2500;

const DEFAULT_MIN_NODES = 16;

let settings = { enabled: true, maxNodes: DEFAULT_MAX_NODES, minNodes: DEFAULT_MIN_NODES };

/** 配置 AX 观察；apply() 时调用一次。 */
export function configureAxObservation(options = {}) {
	settings = {
		enabled: options.enabled !== false,
		maxNodes: clampMaxNodes(options.maxNodes),
		minNodes: clampMinNodes(options.minNodes)
	};
}

function clampMinNodes(value) {
	if (typeof value !== "number" || Number.isFinite(value) === false) return DEFAULT_MIN_NODES;
	return Math.min(400, Math.max(0, Math.floor(value)));
}

function clampMaxNodes(value) {
	if (typeof value !== "number" || Number.isFinite(value) === false) return DEFAULT_MAX_NODES;
	return Math.min(400, Math.max(20, Math.floor(value)));
}

/** AX 观察是否开启且辅助程序可用。 */
export function axObservationAvailable() {
	return settings.enabled && existsSync(HELPER_PATH);
}

/**
 * 抓一份原始 AX 快照（不做文本格式化）。verify_state 等工具用。
 * @param {number} pid 进程号。
 * @param {number} [maxNodes] 节点上限。
 * @returns {Promise<object|undefined>} helper JSON；失败/未授权返回 undefined。
 */
export async function snapshotAx(pid, maxNodes = settings.maxNodes) {
	if (existsSync(HELPER_PATH) === false) return undefined;
	const id = Number(pid);
	if (Number.isInteger(id) === false || id <= 0) return undefined;
	return runHelper(id, maxNodes);
}

/**
 * 按全局屏幕坐标（左上原点、逻辑点）做 AX hit-test，供坐标点击前的语义核对。
 * @param {number} x
 * @param {number} y
 * @returns {Promise<{ok:boolean, role?:string, title?:string, description?:string, secure?:boolean, pid?:number, bounds?:object, error?:string}|undefined>}
 */
export async function hitTestPoint(x, y) {
	if (existsSync(HELPER_PATH) === false) return undefined;
	const px = Number(x);
	const py = Number(y);
	if (Number.isFinite(px) === false || Number.isFinite(py) === false) return undefined;
	return new Promise((resolve) => {
		execFile(HELPER_PATH, ["--hit-test", String(Math.round(px)), String(Math.round(py))], { timeout: 1500, maxBuffer: 16384, encoding: "utf8" }, (error, stdout) => {
			if (error !== null) {
				resolve(undefined);
				return;
			}
			try {
				resolve(JSON.parse(String(stdout)));
			} catch {
				resolve(undefined);
			}
		});
	});
}

/**
 * 按快照节点 index 对原生控件触发 AXPress（后台投递：不动光标、不抢焦点）。
 * 先校验 role/title 期望，再对命中元素发 AXPress。
 * @param {object} options
 * @param {number} options.pid 目标进程号。
 * @param {number} options.index 快照里 `[N]` 的节点 index。
 * @param {string} [options.expectRole] 期望 AX role（完全匹配）。
 * @param {string} [options.expectTitle] 期望标题/描述包含的子串。
 * @returns {Promise<object>} `{pressed, index, role, title, error?}`。
 */
export async function pressAx({ pid, index, expectRole, expectTitle } = {}) {
	if (existsSync(HELPER_PATH) === false) return { pressed: false, index: Number(index), error: "AX helper unavailable" };
	if (Number.isInteger(Number(pid)) === false || Number(pid) <= 0) return { pressed: false, index: Number(index), error: "invalid pid" };
	if (Number.isInteger(Number(index)) === false || Number(index) < 0) return { pressed: false, index: Number(index), error: "invalid index" };
	const args = ["--pid", String(Number(pid)), "--press", String(Number(index))];
	if (typeof expectRole === "string" && expectRole !== "") args.push("--expect-role", expectRole);
	if (typeof expectTitle === "string" && expectTitle !== "") args.push("--expect-title", expectTitle);
	return new Promise((resolve) => {
		execFile(HELPER_PATH, args, { timeout: 4000, maxBuffer: 65536, encoding: "utf8" }, (error, stdout) => {
			if (error !== null) {
				resolve({ pressed: false, index: Number(index), error: error.message });
				return;
			}
			try {
				resolve(JSON.parse(String(stdout)));
			} catch {
				resolve({ pressed: false, index: Number(index), error: "invalid helper output" });
			}
		});
	});
}

/**
 * 给原生文本控件直接赋值（AXUIElementSetAttributeValue），后台投递。
 * 仅允许文本类 role；secure 字段会被 helper 拒绝。
 * @param {object} options
 * @param {number} options.pid 目标进程号。
 * @param {number} options.index 快照节点 index。
 * @param {string} options.value 要写入的文本。
 * @param {string} [options.expectRole] 期望 AX role（完全匹配）。
 * @returns {Promise<object>} `{ok,index,role,title,error?}`。
 */
export async function setAxValue({ pid, index, value, expectRole } = {}) {
	if (existsSync(HELPER_PATH) === false) return { ok: false, index: Number(index), error: "AX helper unavailable" };
	if (Number.isInteger(Number(pid)) === false || Number(pid) <= 0) return { ok: false, index: Number(index), error: "invalid pid" };
	if (Number.isInteger(Number(index)) === false || Number(index) < 0) return { ok: false, index: Number(index), error: "invalid index" };
	if (typeof value !== "string") return { ok: false, index: Number(index), error: "value must be a string" };
	const args = ["--pid", String(Number(pid)), "--set-value", String(Number(index)), "--value", value];
	if (typeof expectRole === "string" && expectRole !== "") args.push("--expect-role", expectRole);
	return runHelperArgs(args, 4000, { ok: false, index: Number(index) });
}

/**
 * 按菜单路径触发原生 App 菜单命令（后台 AXPress，逐段）。
 * @param {object} options
 * @param {number} options.pid 目标进程号。
 * @param {string[]} options.path 菜单路径，例如 ["文件","关闭"]。
 * @returns {Promise<object>} `{ok,path:[...],error?}`。
 */
const SCROLL_DIRECTIONS = new Set(["up", "down", "left", "right"]);

export async function scrollAx({ pid, index, direction, page = false, expectRole, expectTitle } = {}) {
	if (existsSync(HELPER_PATH) === false) return { ok: false, index: Number(index), error: "AX helper unavailable" };
	if (Number.isInteger(Number(pid)) === false || Number(pid) <= 0) return { ok: false, index: Number(index), error: "invalid pid" };
	if (typeof direction !== "string" || SCROLL_DIRECTIONS.has(direction) === false) return { ok: false, index: Number(index), error: "direction must be up/down/left/right" };
	const requested = Number(index);
	const hasIndex = Number.isInteger(requested) && requested >= 0;
	const hasIdentity = (typeof expectRole === "string" && expectRole !== "") || (typeof expectTitle === "string" && expectTitle !== "");
	// index 可选：没有 index 时按 expect_role/expect_title 在新鲜树里自动选面积最大的滚动容器。
	if (hasIndex === false && hasIdentity === false) return { ok: false, index: Number.isFinite(requested) ? requested : -1, error: "index or expect_role/expect_title required" };
	const args = ["--pid", String(Number(pid)), "--direction", direction];
	if (hasIndex === true) args.push("--scroll", String(requested));
	if (page === true) args.push("--page");
	if (typeof expectRole === "string" && expectRole !== "") args.push("--expect-role", expectRole);
	if (typeof expectTitle === "string" && expectTitle !== "") args.push("--expect-title", expectTitle);
	return runHelperArgs(args, 5000, { ok: false, index: hasIndex === true ? requested : -1, error: "scroll failed" });
}

export async function pressAxMenu({ pid, path } = {}) {
	const segments = Array.isArray(path) ? path.map((part) => String(part)).filter((part) => part !== "") : [];
	if (existsSync(HELPER_PATH) === false) return { ok: false, path: segments, error: "AX helper unavailable" };
	if (Number.isInteger(Number(pid)) === false || Number(pid) <= 0) return { ok: false, path: segments, error: "invalid pid" };
	if (segments.length === 0) return { ok: false, path: segments, error: "empty menu path" };
	const args = ["--pid", String(Number(pid)), "--menu", segments.join("/")];
	return runHelperArgs(args, 5000, { ok: false, path: segments });
}

/**
 * 移动/缩放原生窗口（AXPosition/AXSize，不抢前台、不动光标）。
 * 目标窗口按 `windowTitle` 子串匹配，缺省取该 App 的第一个窗口。
 * @param {object} options
 * @param {number} options.pid 目标进程号。
 * @param {{x:number,y:number,width:number,height:number}} options.frame 目标 frame（屏幕坐标点）。
 * @param {string} [options.windowTitle] 窗口标题子串。
 * @returns {Promise<object>} `{ok, windowTitle?, frame?, error?}`。
 */
export async function setWindowFrame({ pid, frame, windowTitle } = {}) {
	if (existsSync(HELPER_PATH) === false) return { ok: false, error: "AX helper unavailable" };
	if (Number.isInteger(Number(pid)) === false || Number(pid) <= 0) return { ok: false, error: "invalid pid" };
	const x = Number(frame?.x);
	const y = Number(frame?.y);
	const width = Number(frame?.width);
	const height = Number(frame?.height);
	if ([x, y, width, height].every((value) => Number.isFinite(value)) === false) {
		return { ok: false, error: "frame must contain finite x, y, width and height" };
	}
	if (width <= 0 || height <= 0) return { ok: false, error: "frame width and height must be positive" };
	const args = ["--pid", String(Number(pid)), "--set-frame", `${x},${y},${width},${height}`];
	if (typeof windowTitle === "string" && windowTitle !== "") args.push("--set-frame-title", windowTitle);
	return runHelperArgs(args, 5000, { ok: false, error: "window frame failed" });
}

function runHelperArgs(args, timeout, fallback) {
	return new Promise((resolve) => {
		execFile(HELPER_PATH, args, { timeout, maxBuffer: 65536, encoding: "utf8" }, (error, stdout) => {
			if (error !== null) {
				resolve({ ...fallback, error: error.message });
				return;
			}
			try {
				resolve(JSON.parse(String(stdout)));
			} catch {
				resolve({ ...fallback, error: "invalid helper output" });
			}
		});
	});
}

function runHelper(pid, maxNodes) {
	return new Promise((resolve) => {
		execFile(
			HELPER_PATH,
			["--pid", String(pid), "--max-nodes", String(maxNodes), "--max-depth", "12"],
			{ timeout: HELPER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
			(error, stdout) => {
				if (error !== null) {
					resolve(undefined);
					return;
				}
				try {
					resolve(JSON.parse(String(stdout)));
				} catch {
					resolve(undefined);
				}
			}
		);
	});
}

function fraction(value, origin, size) {
	if (!(Number.isFinite(value) && Number.isFinite(origin) && Number.isFinite(size)) || size <= 0) return 0;
	const ratio = (value - origin) / size;
	return Math.round(Math.min(1, Math.max(0, ratio)) * 1000);
}

function escapeText(value) {
	return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function normalizeFrame(frame) {
	if (frame === null || typeof frame !== "object") return undefined;
	const values = ["x", "y", "width", "height"].map((key) => Number(frame[key]));
	if (values.some((value) => Number.isFinite(value) === false)) return undefined;
	if (values[2] <= 0 || values[3] <= 0) return undefined;
	return { x: values[0], y: values[1], width: values[2], height: values[3] };
}

function intersects(a, b) {
	return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

const SKIPPED_ROLES = new Set(["AXMenuBar", "AXMenu", "AXMenuBarItem"]);

// 只保留“有身份”的节点（有标题/值）或少数容器角色，避免整棵树把 token 打爆。
const IDENTITY_ROLES = new Set([
	"AXWindow",
	"AXButton",
	"AXTextField",
	"AXCheckBox",
	"AXRadioButton",
	"AXPopUpButton",
	"AXSlider",
	"AXImage",
	"AXMenuItem",
	"AXLink",
	"AXTabGroup",
	"AXTab"
]);

/**
 * 把 helper 的 JSON 输出格式化成模型可读的文本快照。
 * @param snapshot helper 输出（含 windowFrame 与 nodes）。
 * @param foreground inspectForeground 结果（appName/windowTitle 用于标题兜底）。
 * @param region 本次观察截图的逻辑坐标区域（screen.bounds）；缺省时退回前台窗口 frame。
 *   截图可能合并同一 App 的多个窗口，此时窗口 frame 与截图区域不一致，必须用截图区域归一化。
 * @returns `<ax_snapshot>` 文本，或 undefined（无可信内容）。
 */
export function formatAxSnapshot(snapshot, foreground = {}, region, minimumNodes = 0) {
	if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot.nodes) === false) return undefined;
	const windowFrame = normalizeFrame(snapshot.windowFrame);
	const capture = normalizeFrame(region) ?? windowFrame;
	const rawNodes = snapshot.nodes
		.map((node) => ({ node, frame: normalizeFrame(node?.frame) }))
		.filter((entry) => entry.frame !== undefined)
		.filter((entry) => SKIPPED_ROLES.has(String(entry.node.role)) === false)
		.filter((entry) => capture === undefined || intersects(entry.frame, capture));
	let anonymousKept = 0;
	let anonymousTrimmed = false;
	const nodes = rawNodes.filter((entry) => {
		const title = typeof entry.node.title === "string" ? entry.node.title : "";
		const value = typeof entry.node.value === "string" ? entry.node.value : "";
		if (title !== "" || value !== "") return true;
		if (IDENTITY_ROLES.has(String(entry.node.role)) === false) return false;
		anonymousKept += 1;
		if (anonymousKept > MAX_ANONYMOUS_NODES) {
			anonymousTrimmed = true;
			return false;
		}
		return true;
	});
	if (nodes.length < Math.max(4, minimumNodes)) return undefined;
	const appName = typeof snapshot.appName === "string" && snapshot.appName !== "" ? snapshot.appName : foreground.appName ?? "unknown";
	const windowTitle = typeof snapshot.windowTitle === "string" && snapshot.windowTitle !== "" ? snapshot.windowTitle : foreground.windowTitle;
	const lines = [];
	const origin = capture ?? { x: 0, y: 0, width: 1, height: 1 };
	let usedChars = 0;
	let budgetTrimmed = false;
	for (const { node, frame } of nodes) {
		const position = `@(${String(fraction(frame.x + frame.width / 2, origin.x, origin.width))},${String(fraction(frame.y + frame.height / 2, origin.y, origin.height))})`;
		const role = escapeText(String(node.role));
		const titleText = typeof node.title === "string" && node.title !== "" ? ` "${escapeText(node.title)}"` : "";
		const value = typeof node.value === "string" && node.value !== "" ? ` value="${escapeText(node.value)}"` : "";
		const line = `[${String(node.index)}] ${role}${titleText}${value} ${position}`;
		usedChars += line.length + 1;
		if (usedChars > MAX_TEXT_CHARS) {
			budgetTrimmed = true;
			break;
		}
		lines.push(line);
	}
	const header = [
		`<ax_snapshot app="${escapeText(String(appName))}"`,
		windowTitle === undefined || windowTitle === "" ? "" : `window="${escapeText(String(windowTitle))}"`,
		`nodes="${String(nodes.length)}"`,
		`schema_version="1"`,
		`truncated="${snapshot.truncated === true || budgetTrimmed || anonymousTrimmed ? "true" : "false"}">`
	].filter((part) => part !== "").join(" ");
	const footer = "Element positions are 0–1000 fractions of the attached window screenshot (same space as click/input_text). A new snapshot replaces these positions; prefer a visible element position when the screenshot is ambiguous.</ax_snapshot>";
	const text = [header, ...lines, footer].join("\n");
	if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
		const trimmed = [header, ...lines.slice(0, Math.floor(lines.length / 2)), footer].join("\n");
		return trimmed;
	}
	return text;
}

/**
 * 为当前前台窗口抓一份 AX 文本快照。
 * @param foreground inspectForeground 结果；需要 pid。
 * @param region 本次观察截图的逻辑坐标区域（screen.bounds）。
 * @returns 文本块，或 undefined（关闭/失败/树太浅）。
 */
export async function observeAxSnapshot(foreground, region) {
	if (settings.enabled === false || existsSync(HELPER_PATH) === false) return undefined;
	const pid = Number(foreground?.pid);
	if (Number.isInteger(pid) === false || pid <= 0) return undefined;
	const snapshot = await runHelper(pid, settings.maxNodes);
	if (snapshot === undefined) return undefined;
	// 浅树（Electron/Web 常见）价值低、体积小但仍是纯噪声：按格式化后真正保留的
	// 节点数判断，低于 axMinNodes 直接不附（原始树里含大量被过滤的容器/菜单）。
	return formatAxSnapshot(snapshot, foreground, region, settings.minNodes);
}
