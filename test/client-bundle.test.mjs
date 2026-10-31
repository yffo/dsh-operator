import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientPath = join(root, "client", "client.js");

/** 本插件在客户端注册行视图的 wire 工具（与 client/client.js 的 ROWS 保持一致）。 */
const ROW_TOOLS = [
	"task_profile",
	"plan_create",
	"plan_update",
	"plan_run",
	"plan_list",
	"plan_delete",
	"skill_save",
	"skill_run",
	"skill_list",
	"operator_status",
	"browser_dom_probe",
	"browser_dom_snapshot",
	"browser_dom_click",
	"browser_dom_fill",
	"cu_observe",
	"cu_act"
];

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const source = readFileSync(clientPath, "utf8");

test("package.json 声明了 web 客户端入口与导出", () => {
	assert.equal(pkg.dsh?.client?.platform, "web", "dsh.client.platform 必须是 web");
	assert.equal(pkg.exports?.["./client"], "./client/client.js");
	assert.ok(pkg.files?.includes("client"), "发布产物必须包含 client/");
});

test("client/client.js 是语法正确的经典脚本（非 ESM 入口）", () => {
	execFileSync(process.execPath, ["--check", clientPath], { stdio: "pipe" });
	assert.ok(source.includes("window.__ModuleLoader__.load"), "必须通过 __ModuleLoader__ 注册");
	assert.ok(source.includes('id: "dsh-operator"'), "模块 id 必须是 dsh-operator");
	assert.ok(!source.includes("\nimport "), "客户端 bundle 不应包含 ESM import 语句");
});

test("client/client.js 为每个 operator 工具注册 keyed toolview 行", () => {
	assert.ok(source.includes("tool.call.toolview"), "必须注册 tool.call.toolview");
	for (const tool of ROW_TOOLS) {
		assert.ok(source.includes(`${tool}:`), `缺少 ${tool} 的行标签`);
	}
});

test("client/client.js 不使用 React hooks（视图可能被宿主直接调用）", () => {
	for (const hook of ["useState", "useEffect", "useMemo", "useRef", "useReducer"]) {
		assert.ok(!source.includes(`${hook}(`), `客户端卡片不应使用 hooks：${hook}`);
	}
});

test("client/client.js 结果摘要会去掉重复的工具名前缀", () => {
	assert.ok(source.includes("stripToolPrefix"), "应有 stripToolPrefix 辅助函数");
});

test("client/client.js 从 props.toolName 取工具名（block 上没有该字段）", () => {
	assert.ok(source.includes("props.toolName"), "应优先读取 props.toolName");
	assert.ok(!source.includes("block.toolName ?? "), "block.toolName 只应作为兜底");
});

test("client/client.js 只依赖 react 基座，不引入其他包", () => {
	const requires = [...new Set([...source.matchAll(/require\((["'])([^"']+)\1\)/g)].map((match) => match[2]))];
	assert.deepEqual(requires, ["react"], `客户端只允许 require('react')，实际：${requires.join(", ")}`);
});

test("client/client.js 为失败样本/浏览器通道/技能列表提供富卡片摘要", () => {
	assert.ok(source.includes("function richSummary("), "应有 richSummary 解析器");
	assert.ok(source.includes("channels · AppleScript"), "browser_dom_probe 应显示通道状态");
	assert.ok(source.includes("links / "), "browser_dom_snapshot 应显示 links/controls 计数");
	assert.ok(source.includes("skill(s)"), "skill_list 应汇总技能名与步数");
	assert.ok(source.includes("/failures?[^\\n]*/i"), "operator_status 应抽取失败样本计数");
	assert.ok(source.includes("data-tone"), "富卡片应带 data-tone 供样式区分");
	assert.ok(source.includes("extra-"), "富卡片应有 extra 明细行");
});
