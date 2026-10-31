#!/usr/bin/env node
/**
 * 浏览器 DOM 通道 spike（0.11.1）：用临时 profile + headless Chrome + CDP 验证
 * 「读 DOM → 点按钮 → 校验变化」的完整链路。
 *
 * 不碰用户正在用的 Chrome：独立 user-data-dir、独立调试端口、跑完即清理。
 * 用法：node scripts/browser-spike.mjs [--keep]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cdpConnect, parseDevToolsActivePort } from "../lib/browser-dom.js";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGE = `data:text/html,${encodeURIComponent(`<!doctype html><html><head><title>spike-home</title></head>
<body><h1>DOM spike</h1><p id="msg">before</p><button id="go" onclick="document.getElementById('msg').textContent='after'">go</button></body></html>`)}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPortFile(profileDir, timeoutMs = 15000) {
	const path = join(profileDir, "DevToolsActivePort");
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) {
			const parsed = parseDevToolsActivePort(readFileSync(path, "utf8"));
			if (parsed) return parsed;
		}
		await sleep(100);
	}
	return null;
}

async function main() {
	const keep = process.argv.includes("--keep");
	const profileDir = mkdtempSync(join(tmpdir(), "dsh-operator-cdp-"));
	const chrome = spawn(
		CHROME,
		["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"],
		{ stdio: "ignore" }
	);
	let client;
	try {
		const active = await waitForPortFile(profileDir);
		if (!active) throw new Error("DevToolsActivePort 未生成（Chrome 启动失败？）");
		const versionRes = await fetch(`http://127.0.0.1:${active.port}/json/version`);
		const version = await versionRes.json();
		client = await cdpConnect(version.webSocketDebuggerUrl);
		const { targetId } = await client.send("Target.createTarget", { url: PAGE });
		const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
		const evaluate = async (expression) => {
			const result = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
			if (result.exceptionDetails) throw new Error(`page exception: ${result.exceptionDetails.text}`);
			return result.result?.value;
		};
		const title = await evaluate("document.title || document.querySelector('h1')?.textContent || ''");
		const before = await evaluate("document.getElementById('msg').textContent");
		const clicked = await evaluate("document.getElementById('go').click(); 'clicked'");
		const after = await evaluate("document.getElementById('msg').textContent");
		const bodyText = await evaluate("document.body.innerText");
		console.log(JSON.stringify({ ok: title === "spike-home" && before === "before" && after === "after", title, before, clicked, after, bodyText: bodyText.slice(0, 60) }, null, 2));
		const ok = before === "before" && after === "after" && bodyText.includes("DOM spike");
		console.log(JSON.stringify({ ok }, null, 2));
		process.exitCode = ok ? 0 : 1;
	} finally {
		try {
			client?.close();
		} catch {
			/* ignore */
		}
		chrome.kill("SIGTERM");
		await sleep(300);
		if (!keep) rmSync(profileDir, { recursive: true, force: true });
		else console.log(`profileDir kept: ${profileDir}`);
	}
}

main().catch((error) => {
	console.error("browser spike failed:", error.message);
	process.exitCode = 1;
});
