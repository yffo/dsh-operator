// cua-driver 启动路径回归（审计 M11）：spawn 失败不能让宿主进程崩。
import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureCuaDaemon } from "../lib/cua-driver.js";

test("ensureCuaDaemon：spawn 失败要报可读错误（M11）", async () => {
	const missing = join(tmpdir(), "definitely-missing-cua-driver-for-test");
	await assert.rejects(
		() => ensureCuaDaemon(missing, { timeoutMs: 1200 }),
		/(daemon 没有起来|spawn 失败)/
	);
});
