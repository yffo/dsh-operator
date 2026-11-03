import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { axRpcCall, closeAxRpc } from "../lib/ax-rpc.js";

const dir = mkdtempSync(join(tmpdir(), "ax-rpc-"));
const echo = join(dir, "echo-helper");
writeFileSync(echo, `#!/usr/bin/env node
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    const request = JSON.parse(line);
    process.stdout.write(JSON.stringify({ id: request.id, code: 0, output: JSON.stringify({ ok: true, argv: request.argv }) }) + "\\n");
    index = buffer.indexOf("\\n");
  }
});
`);
chmodSync(echo, 0o755);
const silent = join(dir, "silent-helper");
writeFileSync(silent, "#!/usr/bin/env node\nprocess.stdin.resume();\n");
chmodSync(silent, 0o755);

test("常驻通道：一次启动多次请求", async () => {
	const first = await axRpcCall(echo, ["--one"]);
	const second = await axRpcCall(echo, ["--two"]);
	assert.deepEqual(first, { ok: true, argv: ["--one"] });
	assert.deepEqual(second, { ok: true, argv: ["--two"] });
	closeAxRpc();
});

test("常驻通道：调用方回退时返回 undefined", async () => {
	const missing = await axRpcCall(join(dir, "not-here"), ["--x"]);
	assert.equal(missing, undefined);
});

test("常驻通道：超时返回 undefined 并回收进程", async () => {
	const value = await axRpcCall(silent, ["--x"], 120);
	assert.equal(value, undefined);
	closeAxRpc();
});

test.after(() => {
	closeAxRpc();
	rmSync(dir, { recursive: true, force: true });
});
