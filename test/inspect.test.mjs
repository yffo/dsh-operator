import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("inspect --json：输出可解析且字段齐全", () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-inspect-"));
	try {
		const out = execFileSync(process.execPath, ["scripts/inspect.mjs", "--json"], {
			cwd: new URL("..", import.meta.url).pathname,
			env: { ...process.env, DSH_HOME: home },
			encoding: "utf8"
		});
		const report = JSON.parse(out);
		assert.equal(typeof report.version, "string");
		assert.equal(typeof report.audit.lines, "number");
		assert.equal(report.failures.total, 0);
		assert.equal(report.store.plans, 0);
		assert.ok(report.testFiles > 0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
