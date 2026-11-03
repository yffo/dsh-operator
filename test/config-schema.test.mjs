// 0.97.1：Config schema 只能使用 schemastery 真正提供的方法。
// 教训：0.96 写了 z.string().optional()，schemastery 没有 optional()，
// 模块加载期抛错 → 整个插件不激活（工具全消失）。单测绿不代表插件能加载。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "lib", "computer-use", "index.js"), "utf8");

test("Config schema 不使用 schemastery 不存在的 .optional()", () => {
	const start = source.indexOf("const Config = z.object({");
	assert.ok(start > 0, "应能定位 Config 定义");
	const end = source.indexOf("});", start);
	const block = source.slice(start, end);
	assert.doesNotMatch(block, /\.optional\(/, "schemastery 没有 optional()，字段默认即可选；改用 .default() 或留空");
});

// 审计 L12：文档里承诺的 browserSession 必须真的进 schema（否则 schemastery 会丢掉它）
test("Config 声明了 browserSession 配置", () => {
	const start = source.indexOf("const Config = z.object({");
	const end = source.indexOf("});", start);
	const block = source.slice(start, end);
	assert.match(block, /browserSession:\s*z\.string\(\)\.default\("dsh-operator"\)/);
	assert.match(source, /browserSession:\s*typeof config\.browserSession/, "resolve 也要透传");
});
