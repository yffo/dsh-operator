import { test } from "node:test";
import assert from "node:assert/strict";
import { filterWindows, listDisplays, listWindows, windowQueryAvailable } from "../lib/macos-query.js";

const WINDOWS = [
	{ windowID: 1, pid: 100, app: "微信", title: "微信", bounds: { x: 0, y: 0, width: 800, height: 600 }, layer: 0, onScreen: true },
	{ windowID: 2, pid: 200, app: "访达", title: "dsh-operator", bounds: { x: 10, y: 10, width: 900, height: 700 }, layer: 0, onScreen: true },
	{ windowID: 3, pid: 200, app: "访达", title: "下载", bounds: { x: 20, y: 20, width: 900, height: 700 }, layer: 0, onScreen: false }
];

test("filterWindows：标题/App 过滤大小写不敏感且可组合", () => {
	assert.deepEqual(
		filterWindows(WINDOWS, { titleContains: "DSH" }).map((row) => row.windowID),
		[2]
	);
	assert.deepEqual(
		filterWindows(WINDOWS, { appContains: "访达" }).map((row) => row.windowID),
		[2, 3]
	);
	assert.deepEqual(
		filterWindows(WINDOWS, { appContains: "访达", titleContains: "下载" }).map((row) => row.windowID),
		[3]
	);
});

test("filterWindows：空条件返回全部，limit 生效并 clamp 到 200", () => {
	assert.equal(filterWindows(WINDOWS).length, 3);
	assert.equal(filterWindows(WINDOWS, { limit: 1 }).length, 1);
	assert.equal(filterWindows(WINDOWS, { limit: 0 }).length, 3);
	assert.equal(filterWindows(WINDOWS, { limit: 99999 }).length, 3);
	const many = Array.from({ length: 300 }, (_v, index) => ({ windowID: index + 1, app: "X", title: "T" }));
	assert.equal(filterWindows(many, { limit: 99999 }).length, 200);
});

test("filterWindows：非数组/空串安全", () => {
	assert.deepEqual(filterWindows(undefined), []);
	assert.deepEqual(filterWindows(null, { titleContains: "x" }), []);
	assert.equal(filterWindows(WINDOWS, { titleContains: "   " }).length, 3);
	assert.deepEqual(filterWindows([{ windowID: 9 }], { titleContains: undefined, appContains: undefined }).length, 1);
});

test("windowQueryAvailable 返回布尔值（不依赖具体平台断言）", () => {
	assert.equal(typeof windowQueryAvailable(), "boolean");
});

test("listWindows/listDisplays：无可用 helper 时安全降级为 undefined", async () => {
	if (windowQueryAvailable() === true) {
		// 有 helper 的真机环境：结构断言（不依赖具体窗口内容）
		const value = await listWindows({});
		assert.ok(value === undefined || (Array.isArray(value.windows) && Array.isArray(value.displays)));
		const displays = await listDisplays();
		assert.ok(displays === undefined || Array.isArray(displays));
		return;
	}
	assert.equal(await listWindows({}), undefined);
	assert.equal(await listDisplays(), undefined);
});
