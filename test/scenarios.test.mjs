import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(join(root, "bench", "scenarios.json"), "utf8"));
const LAYERS = ["L0", "L1", "L2", "exception"];

test("scenarios.json：分层与数量", () => {
	assert.equal(data.schemaVersion, 1);
	assert.ok(data.layers && typeof data.layers === "object");
	for (const layer of LAYERS) assert.ok(typeof data.layers[layer] === "string" && data.layers[layer].length > 0, `缺 layer 说明：${layer}`);
	assert.ok(Array.isArray(data.scenarios));
	assert.ok(data.scenarios.length >= 30, "场景矩阵至少 30 条");
	for (const layer of LAYERS) {
		const count = data.scenarios.filter((item) => item.layer === layer).length;
		assert.ok(count >= 8, `layer ${layer} 至少 8 条，实际 ${count}`);
	}
});

test("scenarios.json：每条字段完整且 id 唯一", () => {
	const ids = new Set();
	for (const item of data.scenarios) {
		assert.match(item.id, /^[A-Z0-9]+-\d{2}$/, `id 格式不对：${item.id}`);
		assert.ok(!ids.has(item.id), `id 重复：${item.id}`);
		ids.add(item.id);
		assert.ok(LAYERS.includes(item.layer), `${item.id}: layer 非法`);
		assert.ok(typeof item.title === "string" && item.title.length > 0, `${item.id}: 缺 title`);
		assert.ok(typeof item.goal === "string" && item.goal.length > 10, `${item.id}: goal 太短`);
		assert.ok(Array.isArray(item.success) && item.success.length > 0, `${item.id}: success 必须是非空数组`);
		for (const line of item.success) assert.ok(typeof line === "string" && line.length > 0, `${item.id}: success 项必须是非空字符串`);
		assert.ok(typeof item.timeoutSec === "number" && item.timeoutSec >= 30 && item.timeoutSec <= 600, `${item.id}: timeoutSec 非法`);
	}
});

test("scenarios.json：危险/网络场景必须显式标注", () => {
	for (const item of data.scenarios) {
		// 会改用户数据或花钱/联网的场景，必须在 goal 或 success 里交代边界（0.11.1 接 runner 时再细化）。
		if (/删除|发送|购买|提交/.test(item.title)) {
			assert.ok(item.success.length >= 2, `${item.id}: 破坏性场景必须给出至少两条验收`);
		}
	}
});
