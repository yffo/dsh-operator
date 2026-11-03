import assert from "node:assert/strict";
import { test } from "node:test";

import { buildLaunchArgs, resolveBrowserExecutable } from "../lib/browser-launch.js";

test("resolveBrowserExecutable：按 auto 顺序找已安装的浏览器", () => {
	const found = resolveBrowserExecutable("auto", (path) => path.includes("Google Chrome"));
	assert.deepEqual(found, { browser: "chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
});

test("resolveBrowserExecutable：指定浏览器时才看那一个", () => {
	const exists = (path) => path.includes("Microsoft Edge");
	assert.equal(resolveBrowserExecutable("edge", exists)?.browser, "edge");
	assert.equal(resolveBrowserExecutable("chrome", exists), undefined);
});

test("resolveBrowserExecutable：一个都没装返回 undefined", () => {
	assert.equal(resolveBrowserExecutable("auto", () => false), undefined);
});

test("buildLaunchArgs：端口、独立 profile、首启跳过", () => {
	const args = buildLaunchArgs({ port: 9333, userDataDir: "/tmp/prof" });
	assert.ok(args.includes("--remote-debugging-port=9333"));
	assert.ok(args.includes("--user-data-dir=/tmp/prof"));
	assert.ok(args.includes("--no-first-run"));
	assert.equal(args.at(-1), "about:blank", "默认开空白页");
});

test("buildLaunchArgs：headless 与起始 URL", () => {
	const args = buildLaunchArgs({ port: 9222, userDataDir: "/tmp/p", headless: true, url: "https://example.com" });
	assert.ok(args.includes("--headless=new"));
	assert.equal(args.at(-1), "https://example.com");
});

test("buildLaunchArgs：window_size 转成 --window-size", () => {
	const args = buildLaunchArgs({ port: 9222, userDataDir: "/tmp/p", windowSize: { width: 1280, height: 800 } });
	assert.ok(args.includes("--window-size=1280,800"));
});

test("buildLaunchArgs：没有 window_size 时不加窗口参数", () => {
	const args = buildLaunchArgs({ port: 9222, userDataDir: "/tmp/p" });
	assert.ok(args.every((flag) => flag.startsWith("--window-size=") === false));
});
