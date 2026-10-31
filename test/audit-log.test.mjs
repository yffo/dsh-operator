import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit, auditLogPath, configureAuditLog } from "../lib/audit-log.js";

function tempPath() {
	const dir = mkdtempSync(join(tmpdir(), "dsh-operator-audit-"));
	return join(dir, "audit.jsonl");
}

function readLines(path) {
	return readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
}

afterEach(() => {
	configureAuditLog({ enabled: true, path: tempPath() });
});

test("audit：写入 JSONL，字段只保留标量", () => {
	const path = tempPath();
	configureAuditLog({ path });
	audit("action", {
		effect: "confirmed",
		settleMs: 500,
		ax: true,
		skipped: undefined,
		empty: null,
		text: "hi",
		long: "x".repeat(60),
		list: [1, 2, 3],
		obj: { a: 1 }
	});
	assert.equal(auditLogPath(), path);
	const rows = readLines(path);
	assert.equal(rows.length, 1);
	const row = JSON.parse(rows[0]);
	assert.equal(row.event, "action");
	assert.equal(row.effect, "confirmed");
	assert.equal(row.settleMs, 500);
	assert.equal(row.ax, true);
	assert.equal(row.empty, undefined);
	assert.equal(row.skipped, undefined);
	assert.equal(row.text, "hi");
	assert.equal(row.long.length, 41); // 40 + 省略号
	assert.ok(row.long.endsWith("…"));
	assert.equal(row.list, "array:3");
	assert.equal(row.obj, "object");
	assert.match(row.t, /^\d{4}-\d{2}-\d{2}T/);
});

test("audit：关闭后不写文件", () => {
	const path = tempPath();
	configureAuditLog({ enabled: false, path });
	audit("action", { effect: "confirmed" });
	assert.equal(existsSync(path), false);
});

test("audit：超过 5MB 轮转为 .1，新文件继续写", () => {
	const path = tempPath();
	configureAuditLog({ path });
	writeFileSync(path, "x".repeat(5 * 1024 * 1024 + 10), "utf8");
	audit("rotate_probe", { n: 1 });
	// 轮转是「改名」：原文件移动到 .1，path 本身暂时不存在
	assert.equal(existsSync(`${path}.1`), true);
	assert.equal(existsSync(path), false);
	audit("rotate_probe", { n: 2 });
	const rows = readLines(path);
	assert.equal(rows.length, 1);
	assert.equal(JSON.parse(rows[0]).event, "rotate_probe");
	assert.equal(JSON.parse(rows[0]).n, 2);
	// .1 保留轮转前的旧内容
	assert.ok(readFileSync(`${path}.1`, "utf8").startsWith("xxxx"));
});

test("audit：目录不存在时自动创建；写盘错误不影响调用", () => {
	const path = join(mkdtempSync(join(tmpdir(), "dsh-operator-audit-")), "nested", "deep", "audit.jsonl");
	configureAuditLog({ path });
	assert.doesNotThrow(() => audit("plugin_start", { version: "0.9.0" }));
	assert.equal(readLines(path).length, 1);
	// 指向一个无法创建文件的位置（父路径是文件）——audit 应吞掉错误
	const blocked = join(tmpdir(), `dsh-operator-blocked-${String(Date.now())}`);
	writeFileSync(blocked, "not a dir", "utf8");
	configureAuditLog({ path: join(blocked, "audit.jsonl") });
	assert.doesNotThrow(() => audit("should_not_throw"));
});
