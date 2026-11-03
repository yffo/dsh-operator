import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { audit, auditLogPath, configureAuditLog } from "../lib/audit-log.js";

function tempDir() {
	return mkdtempSync(join(tmpdir(), "dsh-operator-audit-"));
}

test("auditLog：脱敏规则（字符串截断、数组只留长度、对象留类型）", () => {
	const dir = tempDir();
	const path = join(dir, "audit.jsonl");
	try {
		configureAuditLog({ path });
		audit("action", {
			tool: "click",
			count: 3,
			ok: true,
			title: "x".repeat(60),
			items: [1, 2, 3],
			nested: { a: 1 },
			skip: undefined
		});
		const line = JSON.parse(readFileSync(path, "utf8").trim());
		assert.equal(line.event, "action");
		assert.equal(line.tool, "click");
		assert.equal(line.count, 3);
		assert.equal(line.ok, true);
		assert.equal(line.skip, undefined);
		assert.equal(line.items, "array:3");
		assert.equal(line.nested, "object");
		assert.equal(line.title.length, 41, "40 字符 + 省略号");
		assert.equal(line.title.endsWith("…"), true);
		// 不出现原文（截断后的前缀仍属同源数据，这里只断言长度与省略号）
		assert.equal(line.title.includes(path), false);
	} finally {
		configureAuditLog({});
		rmSync(dir, { recursive: true, force: true });
	}
});

test("auditLog：超过 maxBytes 轮转一份 .1", () => {
	const dir = tempDir();
	const path = join(dir, "audit.jsonl");
	try {
		configureAuditLog({ path, maxBytes: 400 });
		for (let i = 0; i < 20; i += 1) audit("action", { tool: "click", i, note: "y".repeat(30) });
		assert.equal(existsSync(`${path}.1`), true, "应产生轮转文件");
		const currentLines = existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length : 0;
		const rotated = readFileSync(`${path}.1`, "utf8").trim().split("\n").filter(Boolean).length;
		assert.ok(rotated >= 1);
		assert.ok(currentLines < 20, "轮转后当前文件不应包含全部记录");
		// 单备份轮转：只保证最新一条还在（更早的可能被下一次轮转覆盖）
		const all = [
			...(existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : []),
			...readFileSync(`${path}.1`, "utf8").trim().split("\n").filter(Boolean)
		].map((line) => JSON.parse(line));
		assert.ok(all.some((row) => row.i === 19), "最后一条记录不应丢失");
	} finally {
		configureAuditLog({});
		rmSync(dir, { recursive: true, force: true });
	}
});

test("auditLog：enabled=false 不写文件；默认路径可读", () => {
	const dir = tempDir();
	const path = join(dir, "audit.jsonl");
	try {
		configureAuditLog({ path, enabled: false });
		audit("action", { tool: "click" });
		assert.equal(existsSync(path), false);
	} finally {
		configureAuditLog({});
		rmSync(dir, { recursive: true, force: true });
	}
	assert.match(auditLogPath(), /audit\.jsonl$/);
});
