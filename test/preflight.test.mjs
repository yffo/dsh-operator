import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPreflightOutput, parsePreflightArgs } from "../scripts/preflight.mjs";

test("parsePreflightArgs：默认值与开关，未知参数报错", () => {
	assert.deepEqual(parsePreflightArgs([]), { json: false, keep: false, timeoutMs: 60000 });
	assert.equal(parsePreflightArgs(["--json", "--keep"]).keep, true);
	assert.equal(parsePreflightArgs(["--timeout=3000"]).timeoutMs, 3000);
	assert.throws(() => parsePreflightArgs(["--nope"]), /unknown argument/);
	assert.throws(() => parsePreflightArgs(["--timeout=0"]), /invalid --timeout/);
});

test("classifyPreflightOutput：插件加载错误判失败", () => {
	for (const line of [
		"JsonSchemaError: unsupported JSON schema: parameters.type must be a value schema object",
		"Error: plugin apply failed",
		"Invalid plugin: dsh-operator"
	]) {
		assert.equal(classifyPreflightOutput(line).ok, false, line);
	}
});

test("classifyPreflightOutput：只有 expected pending 警告时仍通过", () => {
	const result = classifyPreflightOutput("dsh: warning: 1 entry did not activate\n");
	assert.equal(result.ok, true);
	assert.equal(result.pendingWarnings.length, 1);
	assert.match(result.note, /code-agent/);
	assert.equal(classifyPreflightOutput("").ok, true);
});
