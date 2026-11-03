import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureAuditLog } from "../lib/audit-log.js";
configureAuditLog({ enabled: false });
import {
	classifyFailure,
	configureFailureStore,
	digestFailures,
	failureDir,
	recordFailure,
	renderFailureReport,
	sanitizeArgs,
	suggestForKind
} from "../lib/failure-store.js";

function tempDir() {
	return mkdtempSync(join(tmpdir(), "dsh-operator-failures-"));
}

test("classifyFailure：常见错误归类", () => {
	assert.equal(classifyFailure(new Error("computer-use: 退出应用 shortcut [cmd + q] is guarded.")), "guard_rejected");
	assert.equal(classifyFailure(new Error("verify_state: timed out after 3 polls")), "timeout");
	assert.equal(classifyFailure(new Error("list_windows: window query unavailable (helper missing)")), "unavailable");
	assert.equal(classifyFailure(new Error("no matching scroll area found")), "not_found");
	assert.equal(classifyFailure(new Error("cancelled by user")), "cancelled");
	assert.equal(classifyFailure(new Error("boom")), "error");
});

test("sanitizeArgs：文本只留长度，枚举保留", () => {
	const out = sanitizeArgs({
		direction: "down",
		page: true,
		count: 2,
		text: "机密内容",
		path: "/Users/x/secret.txt",
		index: 5
	});
	assert.equal(out.direction, "down");
	assert.equal(out.page, true);
	assert.equal(out.count, 2);
	assert.equal(out.index, 5);
	assert.equal(out.text_len, 4);
	assert.equal(out.path_len, "/Users/x/secret.txt".length);
	assert.equal(JSON.stringify(out).includes("机密内容"), false);
});

test("recordFailure：落盘 JSONL、可汇总、不抛错", () => {
	const dir = tempDir();
	try {
		assert.equal(recordFailure({ tool: "click", error: new Error("x") }, { dir }), true);
		recordFailure({ tool: "ax_press", error: new Error("no target pid") }, { dir });
		const digest = digestFailures({ dir });
		assert.equal(digest.total, 2);
		assert.equal(digest.byTool.length, 2);
		assert.equal(digest.byKind.reduce((sum, [, count]) => sum + count, 0), 2);
		assert.deepEqual(digest.byPair[0], ["click·error", 1]);
		assert.equal(digest.byPair.length, 2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("digestFailures：空目录与坏行不崩", () => {
	const dir = tempDir();
	try {
		assert.equal(digestFailures({ dir }).total, 0);
		writeFileSync(join(dir, "2026-11-01.jsonl"), "not-json\n{\"t\":\"2026-11-01T00:00:00.000Z\",\"tool\":\"a\",\"kind\":\"error\",\"message\":\"m\"}\n");
		const digest = digestFailures({ dir });
		assert.equal(digest.total, 1);
		assert.equal(digest.recent[0].tool, "a");
		assert.equal(digest.byDay.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("configureFailureStore：覆盖与恢复默认目录", () => {
	const dir = tempDir();
	try {
		configureFailureStore({ dir });
		assert.equal(failureDir(), dir);
		recordFailure({ tool: "x", error: new Error("boom") });
		assert.ok(readFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), "utf8").includes("\"tool\":\"x\""));
	} finally {
		configureFailureStore({ dir: undefined });
		assert.notEqual(failureDir(), dir);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("失败样本库接线：扩展工具 execute 抛错与返回 error 都会被记录", async () => {
	const { configureOperatorToolsInternals, registerOperatorTools, resetOperatorToolsInternals } = await import("../lib/operator-tools.js");
	const dir = tempDir();
	const tools = [];
	const fakeBackend = {};
	const defineTool = (definition) => definition;
	const ctx = { tools: { register: (definition) => tools.push(definition) } };
	try {
		configureFailureStore({ dir });
		configureOperatorToolsInternals({
			listWindows: async () => undefined,
			pressAx: async () => ({ pressed: false, error: "element not found" })
		});
		registerOperatorTools(ctx, { failureSamples: true, guard: false }, { backend: fakeBackend, defineTool });
		const listWindows = tools.find((tool) => tool.name === "list_windows");
		assert.ok(listWindows, "list_windows registered");
		await assert.rejects(() => listWindows.execute({}), /unavailable/);
		const axPress = tools.find((tool) => tool.name === "ax_press");
		const result = await axPress.execute({ index: 1, pid: 1 }, { signal: { throwIfAborted() {} } });
		assert.equal(result.pressed, false);
		const digest = digestFailures({ dir });
		assert.ok(digest.total >= 2);
		assert.ok(digest.byTool.some(([tool]) => tool === "ax_press"));
	} finally {
		configureFailureStore({ dir: undefined });
		resetOperatorToolsInternals();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("renderFailureReport：markdown 含策略与下一步建议", () => {
	const dir = tempDir();
	try {
		configureFailureStore({ dir });
		recordFailure({ tool: "ax_press", error: new Error("element not found"), args: { index: 1 } });
		recordFailure({ tool: "click", error: new Error("guarded control: 不允许"), args: {} });
		const digest = digestFailures({ dir });
		const markdown = renderFailureReport(digest, { dir, generatedAt: "2026-11-01T00:00:00.000Z" });
		assert.match(markdown, /# dsh-operator 失败样本归纳/);
		assert.match(markdown, /总条数：2/);
		assert.match(markdown, /## 策略与下一步/);
		assert.equal(suggestForKind("not_found").includes("刷新一次 AX 快照"), true);
		assert.equal(suggestForKind("guard_rejected").includes("确认目标应用"), true);
		assert.match(markdown, /## 最近样本/);
	} finally {
		configureFailureStore({ dir: undefined });
		rmSync(dir, { recursive: true, force: true });
	}
});

// 0.86.0：失败样本落盘前要过密钥扫描
test("失败样本：错误文本里的密钥被替换", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dsh-failure-redact-"));
	configureFailureStore({ dir });
	try {
		recordFailure("browser_open", new Error("open failed: https://x.test/cb?access_token=sk-live-SECRET-12345"));
		const { readdirSync, readFileSync } = await import("node:fs");
		const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
		const raw = readFileSync(join(dir, files[0]), "utf8");
		assert.doesNotMatch(raw, /sk-live-SECRET-12345/, "明文密钥不能落盘");
	} finally {
		configureFailureStore({});
		rmSync(dir, { recursive: true, force: true });
	}
});
