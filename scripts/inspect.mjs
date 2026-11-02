#!/usr/bin/env node
/**
 * 巡检：一条命令看「体积/失败热点/存量」有没有异常增长。
 * 只读：不调用模型、不改任何文件。
 *
 *   npm run inspect          # 文本报告
 *   npm run inspect -- --json
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { digestFailures, failureDir, suggestForKind } from "../lib/failure-store.js";
import { dshHome } from "../lib/status.js";

const json = process.argv.includes("--json");
const root = new URL("..", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const dataDir = join(dshHome(), "dsh-operator");
const auditPath = join(dataDir, "audit.jsonl");

const bytesOf = (path) => {
	try {
		return existsSync(path) ? statSync(path).size : 0;
	} catch {
		return 0;
	}
};
const linesOf = (path) => {
	try {
		if (!existsSync(path)) return 0;
		const text = readFileSync(path, "utf8");
		let lines = 0;
		for (const ch of text) if (ch === "\n") lines += 1;
		return text.endsWith("\n") ? lines : lines + 1;
	} catch {
		return 0;
	}
};
const countFiles = (dir) => {
	try {
		return readdirSync(dir).filter((name) => name.endsWith(".json")).length;
	} catch {
		return 0;
	}
};

const failures = digestFailures({ dir: failureDir(), top: 5, recent: 0 });
const testCount = (() => {
	try {
		return readdirSync(join(root, "test")).filter((name) => name.endsWith(".test.mjs")).length;
	} catch {
		return 0;
	}
})();
const report = {
	version: pkg.version,
	audit: { lines: linesOf(auditPath), bytes: bytesOf(auditPath) },
	failures: { total: failures.total, byPair: failures.byPair, byDay: failures.byDay.slice(-7) },
	store: { plans: countFiles(join(dataDir, "plans")), skills: countFiles(join(dataDir, "skills")) },
	testFiles: testCount
};

if (json) {
	console.log(JSON.stringify(report, null, 2));
} else {
	const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
	const lines = [
		`dsh-operator ${report.version} 巡检`,
		`audit: ${report.audit.lines} 行 · ${kb(report.audit.bytes)}`,
		`plans ${report.store.plans} · skills ${report.store.skills} · test files ${report.testFiles}`,
		`failures: ${report.failures.total}`
	];
	if (report.failures.total > 0) {
		lines.push(`  hot: ${report.failures.byPair.map(([key, count]) => `${key}(${count})`).join(", ")}`);
		const kinds = new Set(report.failures.byPair.map(([key]) => key.split("·")[1] ?? "error"));
		for (const kind of kinds) lines.push(`  next: ${suggestForKind(kind)}`);
		const days = report.failures.byDay.filter(([, count]) => count > 0);
		if (days.length > 0) lines.push(`  按天: ${days.map(([day, count]) => `${day}(${count})`).join(", ")}`);
	} else {
		lines.push("  （空——这是好事）");
	}
	if (report.audit.bytes > 5 * 1024 * 1024) lines.push("  提示: audit 超过 5 MB，可归档到 ~/.dsh/backups 后清空");
	console.log(lines.join("\n"));
}
