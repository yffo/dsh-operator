#!/usr/bin/env node
/**
 * 0.6.0 扩展工具自检：
 * - verify_state 的谓词评估（纯参数校验分支 + 未知 kind）
 * - audit-log 的脱敏/截断/开关/写盘格式
 * - registerOperatorTools 注册面（list_windows / screenshot_window / verify_state）
 * - 依赖窗口助手的分支在无 helper 时优雅降级
 *
 * 用法：node scripts/test-operator.mjs
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configureAuditLog, audit } from "../lib/audit-log.js";
import { windowQueryAvailable } from "../lib/macos-query.js";
import { evaluatePredicate, registerOperatorTools } from "../lib/operator-tools.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
function check(ok, label) {
	if (!ok) failures.push(label);
	console.log(`${ok ? "✓" : "✗"} ${label}`);
}

const dir = await mkdtemp(join(tmpdir(), "dsh-operator-test-"));
const logPath = join(dir, "audit.jsonl");

// ---------- audit-log ----------
configureAuditLog({ enabled: true, path: logPath });
audit("action", {
	n: 42,
	flag: true,
	long: "x".repeat(80),
	list: [1, 2, 3],
	obj: { nested: "hide" },
	nothing: null
});
audit("plugin_start", { platform: "darwin" });
const lines = (await readFile(logPath, "utf8")).trim().split("\n");
const first = JSON.parse(lines[0]);
const second = JSON.parse(lines[1]);
check(lines.length === 2, "audit 写入两行 JSONL");
check(typeof first.t === "string" && first.event === "action", "记录含时间戳与事件名");
check(first.n === 42 && first.flag === true, "数字/布尔原样保留");
check(first.long.length === 41 && first.long.endsWith("…"), "长字符串截断到 40+省略号");
check(first.list === "array:3", "数组只记长度");
check(first.obj === "object", "对象只记类型，不落内容");
check(first.nothing === undefined && first.undefined === undefined, "null/undefined 不落盘");
check(second.event === "plugin_start", "多事件按序追加");

configureAuditLog({ enabled: false, path: logPath });
audit("should_not_write", { n: 1 });
const afterDisable = (await readFile(logPath, "utf8")).trim().split("\n").length;
check(afterDisable === 2, "关闭审计后不再写入");
configureAuditLog({ enabled: true, path: logPath });

// ---------- evaluatePredicate 参数校验分支 ----------
const unknown = await evaluatePredicate({ kind: "nonsense" });
check(unknown.ok === false && unknown.observed.includes("unknown kind"), "未知 kind 返回 ok=false");

const noContains = await evaluatePredicate({ kind: "window_title" });
check(noContains.ok === false && noContains.observed.includes("contains is required"), "window_title 缺 contains 报错");

const appEmpty = await evaluatePredicate({ kind: "app_running", contains: "  " });
check(appEmpty.ok === false && appEmpty.observed.includes("contains is required"), "app_running 空 contains 报错");

const helper = await windowQueryAvailable();
const noAx = await evaluatePredicate({ kind: "ax_text", contains: "不可能出现的文本", pid: 999999 });
check(noAx.ok === false, "ax_text 在无效 pid 下不抛错（ok=false）");

// ---------- registerOperatorTools 注册面 ----------
const registered = [];
const fakeCtx = {
	tools: { register: (tool) => registered.push(tool) },
	attachments: {},
	get: () => undefined
};
registerOperatorTools(fakeCtx, { axMaxNodes: 120 }, { backend: {}, defineTool: (definition) => definition, AttachmentId: (value) => value });
const names = registered.map((tool) => tool.name);
check(registered.length === 3, "注册三个扩展工具");
check(names.includes("list_windows") && names.includes("screenshot_window") && names.includes("verify_state"), "工具名齐全");
const verify = registered.find((tool) => tool.name === "verify_state");
check(
	verify !== undefined && Object.keys(verify.parameters).length >= 10 && Array.isArray(verify.parameters.kind.enum) && verify.parameters.kind.enum.length === 5,
	"verify_state 参数面完整（kind 枚举 5 种）"
);
check(
	registered.every((tool) => typeof tool.description === "string" && tool.description.length > 20),
	"每个工具都有可读描述"
);

// ---------- DSH schema 编译器规则：每个 object 必须显式声明 additionalProperties ----------
function collectObjectViolations(node, path, out) {
	if (node === null || typeof node !== "object") return out;
	if (Array.isArray(node)) {
		node.forEach((item, index) => collectObjectViolations(item, `${path}[${String(index)}]`, out));
		return out;
	}
	if (node.type === "object") {
		if (node.additionalProperties !== false) out.push(path);
		if (node.properties !== undefined) {
			for (const [key, child] of Object.entries(node.properties)) collectObjectViolations(child, `${path}.properties.${key}`, out);
		}
	}
	if (node.items !== undefined) collectObjectViolations(node.items, `${path}.items`, out);
	return out;
}
const schemaViolations = [];
for (const tool of registered) {
	const schema = tool.output?.schema;
	if (schema === undefined) schemaViolations.push(`${tool.name}:missing-output-schema`);
	else collectObjectViolations(schema, tool.name, schemaViolations);
	if (schema?.properties !== undefined && schema.additionalProperties !== false) schemaViolations.push(`${tool.name}:root`);
}
check(schemaViolations.length === 0, `所有输出 schema 的 object 都显式声明 additionalProperties（违规：${schemaViolations.join("; ") || "无"}）`);

// ---------- verify_state 执行：超时为 false 且只报事实 ----------
if (verify !== undefined) {
	const fakeExec = { signal: { aborted: false, throwIfAborted() {}, addEventListener() {} }, agent: undefined };
	const result = await verify.execute({ kind: "app_running", contains: "__dsh_operator_never__", timeout_ms: 0 }, fakeExec);
	check(result.satisfied === false && result.polls >= 1, "verify_state 超时返回 satisfied=false 并带 polls");
	check(typeof result.elapsedMs === "number" && result.schemaVersion === 1, "verify_state 输出含 elapsedMs/schemaVersion");
}

// ---------- screenshot_window 参数校验 ----------
const shot = registered.find((tool) => tool.name === "screenshot_window");
if (shot !== undefined) {
	let rejected = false;
	try {
		await shot.execute({ window_id: 0 }, { signal: { aborted: false, throwIfAborted() {}, addEventListener() {} } });
	} catch {
		rejected = true;
	}
	check(rejected, "screenshot_window 拒绝非法 window_id");
}

// ---------- list_windows 输出形状（helper 可用时） ----------
const list = registered.find((tool) => tool.name === "list_windows");
if (list !== undefined && helper === true) {
	const output = await list.execute({ limit: 5 }, { signal: { aborted: false, throwIfAborted() {}, addEventListener() {} } });
	check(typeof output.text === "string" && output.text.startsWith("<windows"), "list_windows 输出 <windows> 文本");
	check(output.text.includes('schema_version="1"'), "list_windows 输出带 schema_version");
	check(output.schemaVersion === 1, "list_windows 结构字段 schemaVersion=1");
}

await rm(dir, { recursive: true, force: true });

if (failures.length > 0) {
	console.error(`\n✗ 扩展工具自检失败 ${failures.length} 项`);
	process.exitCode = 1;
} else {
	console.log("\n✓ 扩展工具自检全部通过");
}
