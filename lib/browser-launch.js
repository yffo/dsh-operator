// 自带浏览器实例：按需启动一个**独立 profile** 的 Chrome/Edge/Brave（独立 cookie、独立调试端口），
// 用完 browser_close 关掉，临时 profile 目录一并清理。
//
// 为什么放在插件里：用户在任务里经常需要「干净登录环境」或「后台跑长任务不干扰自己的浏览器」，
// 而插件默认只连用户已开着的浏览器。独立实例是按需的，用完即关，不常驻、不占资源。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 常见浏览器安装路径（macOS）。 */
export const BROWSER_CANDIDATES = {
	chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	edge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	brave: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
	chromium: "/Applications/Chromium.app/Contents/MacOS/Chromium"
};

/**
 * 找到可用的浏览器可执行文件。
 * @param {string} [browser] auto / chrome / edge / brave / chromium
 * @param {(path: string) => boolean} [exists] 单测注入
 * @returns {{browser: string, path: string} | undefined}
 */
export function resolveBrowserExecutable(browser = "auto", exists = (path) => existsSync(path)) {
	const keys = browser === undefined || browser === "" || browser === "auto" ? Object.keys(BROWSER_CANDIDATES) : [browser];
	for (const key of keys) {
		const path = BROWSER_CANDIDATES[key];
		if (path !== undefined && exists(path)) return { browser: key, path };
	}
	return undefined;
}

/**
 * 组装启动参数（纯函数，便于测试）。
 * @param {{port: number, userDataDir: string, url?: string, headless?: boolean}} options
 * @returns {string[]}
 */
export function buildLaunchArgs({ port, userDataDir, url, headless, windowSize }) {
	const args = [
		`--remote-debugging-port=${String(port)}`,
		`--user-data-dir=${userDataDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-features=Translate,MediaRouter"
	];
	// 视口尺寸只能启动时定：运行时 Emulation 覆盖在部分 Chrome 版本上不改变 layout viewport（实测 156 无效）
	const width = Number(windowSize?.width);
	const height = Number(windowSize?.height);
	if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
		args.push(`--window-size=${String(Math.round(width))},${String(Math.round(height))}`);
	}
	if (headless === true) args.push("--headless=new");
	args.push(typeof url === "string" && url !== "" ? url : "about:blank");
	return args;
}

/** 取一个空闲的本机端口（让系统分配，避免撞端口）。 */
export async function freePort() {
	const server = net.createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	await new Promise((resolve) => server.close(() => resolve(void 0)));
	return port;
}

/** 读取 CDP 的 /json/version；失败返回 undefined。 */
async function cdpVersion(port, timeoutMs = 1500) {
	try {
		const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
		if (response.ok === false) return undefined;
		return await response.json();
	} catch {
		return undefined;
	}
}

/**
 * 启动一个独立实例并等到调试端口可用。
 * @param {{browser?: string, headless?: boolean, userDataDir?: string, url?: string, port?: number, timeoutMs?: number}} [options]
 * @returns {Promise<{pid: number, port: number, profileDir: string, browser: string, executable: string, headless: boolean, temporaryProfile: boolean}>}
 */
export async function launchBrowser(options = {}) {
	const resolved = resolveBrowserExecutable(options.browser ?? "auto");
	if (resolved === undefined) throw new Error("没找到可用的浏览器：只支持本机已安装的 Chrome / Edge / Brave / Chromium");
	const port = Number.isInteger(options.port) && options.port > 0 ? options.port : await freePort();
	const temporaryProfile = typeof options.userDataDir !== "string" || options.userDataDir === "";
	const profileDir = temporaryProfile ? await mkdtemp(join(tmpdir(), "dsh-operator-browser-")) : options.userDataDir;
	const args = buildLaunchArgs({ port, userDataDir: profileDir, url: options.url, headless: options.headless === true, windowSize: options.windowSize });
	const child = spawn(resolved.path, args, { detached: true, stdio: "ignore" });

	// 等端口可用；期间浏览器可能还在启动或停在首次运行页
	const deadline = Date.now() + (Number.isInteger(options.timeoutMs) ? options.timeoutMs : 25000);
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`浏览器启动后立刻退出（exit ${String(child.exitCode)}）：${resolved.path}`);
		if ((await cdpVersion(port)) !== undefined) {
			child.unref();
			await rm(profileDir + "/SingletonLock", { force: true }).catch(() => void 0);
			return { pid: child.pid, port, profileDir, browser: resolved.browser, executable: resolved.path, headless: options.headless === true, temporaryProfile };
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	try {
		child.kill("SIGTERM");
	} catch {
		// 已经退出就算了
	}
	throw new Error(`浏览器在限定时间内没有打开调试端口 ${String(port)}（可能停在首次运行/恢复页；可先手动打开一次）`);
}

/**
 * 关闭实例：优先走 CDP 的 Browser.close（让浏览器自己收尾），拿不到端口就杀进程。
 * @param {{port: number, pid?: number, profileDir?: string, removeProfile?: boolean}} options
 * @returns {Promise<{closed: boolean, note: string}>}
 */
export async function closeBrowser(options) {
	const notes = [];
	const version = await cdpVersion(options.port);
	if (version !== undefined && typeof version.webSocketDebuggerUrl === "string") {
		try {
			const socket = new WebSocket(version.webSocketDebuggerUrl);
			await new Promise((resolve, reject) => {
				socket.onopen = resolve;
				socket.onerror = () => reject(new Error("CDP 连接失败"));
			});
			socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
			await new Promise((resolve) => setTimeout(resolve, 600));
			try {
				socket.close();
			} catch {
				// 已经断开
			}
			notes.push("已通过 CDP 关闭");
		} catch (error) {
			notes.push(`CDP 关闭失败：${String(error?.message ?? error)}`);
		}
	} else {
		notes.push("调试端口已不可达（可能已退出）");
	}
	if (Number.isInteger(options.pid) && options.pid > 0) {
		try {
			process.kill(options.pid, "SIGTERM");
			notes.push("已发送 SIGTERM");
		} catch {
			// 进程已经没了
		}
	}
	if (options.removeProfile === true && typeof options.profileDir === "string" && options.profileDir.includes("dsh-operator-browser-")) {
		await rm(options.profileDir, { recursive: true, force: true }).catch(() => void 0);
		notes.push("已清理临时 profile");
	}
	return { closed: true, note: notes.join("；") };
}
