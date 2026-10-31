#!/usr/bin/env node
/**
 * dsh-operator 加载预检（headless 引导）。
 *
 * 目的：JS/插件改动先在一个**隔离的临时 DSH_HOME** 里以 headless profile 真实引导一次，
 * 让「插件 apply 时抛错」在用户重启 App 之前就暴露出来。0.10.5 / 0.17.0 / 0.18.0
 * 三次问题都是这样抓到的，因此固化成脚本。
 *
 * 用法：
 *   node scripts/preflight.mjs            # 人读输出，成功 exit 0，失败 exit 1
 *   node scripts/preflight.mjs --json     # 机器可读
 *   node scripts/preflight.mjs --keep     # 保留临时 DSH_HOME（排查）
 *
 * 判定：
 * - stderr/stdout 出现 JsonSchemaError / SchemaError / failed to apply / Invalid plugin
 *   / "Error: plugin"（大小写不敏感）→ 失败；
 * - "1 entry did not activate" 是允许的：headless 没有 sessionController，code-agent 注册预期 pending；
 * - 命令缺失（dsh 不在 PATH）→ 跳过并 exit 0，打印 skip 原因（CI 里通常没有 dsh）。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HARD_ERROR_RE = /JsonSchemaError|SchemaError|failed to apply|invalid plugin|\bError:\s*plugin\b|plugin apply failed/i;

/** 解析 CLI 参数。未知 flag 直接抛错，避免静默误用。 */
export function parsePreflightArgs(argv) {
	const args = { json: false, keep: false, timeoutMs: 60_000 };
	for (const arg of argv) {
		if (arg === "--json") args.json = true;
		else if (arg === "--keep") args.keep = true;
		else if (arg.startsWith("--timeout=")) {
			const value = Number(arg.slice("--timeout=".length));
			if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid --timeout: ${arg}`);
			args.timeoutMs = value;
		} else throw new Error(`unknown argument: ${arg}（支持 --json / --keep / --timeout=<ms>）`);
	}
	return args;
}

/** 从引导输出里判定是否存在「插件加载失败」。纯函数，便于单测。 */
export function classifyPreflightOutput(output) {
	const text = String(output ?? "");
	const hardErrors = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && HARD_ERROR_RE.test(line));
	const pendingWarnings = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /did not activate/i.test(line));
	return {
		ok: hardErrors.length === 0,
		hardErrors,
		pendingWarnings,
		// headless 里 code-agent 预期 pending，不算失败
		note: pendingWarnings.length > 0 ? "1 entry pending（预期：headless 无 sessionController 的 code-agent）" : void 0
	};
}

/** 执行隔离环境里的 headless 引导；返回 { ok, skipped, reason, output }。 */
export function runPreflight({ repo = root, timeoutMs = 60_000, keep = false, env: baseEnv = process.env } = {}) {
	const home = mkdtempSync(join(tmpdir(), "dsh-operator-preflight-"));
	const env = { ...baseEnv, DSH_HOME: home };
	try {
		let output = "";
		try {
			output += execFileSync("dsh", ["plugin", "--profile", "headless", "add", "--save-exact", `file:${repo}`], {
				env,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: timeoutMs
			});
		} catch (error) {
			if (error?.code === "ENOENT") return { ok: true, skipped: true, reason: "dsh 不在 PATH（CI 环境正常跳过）" };
			output += `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.message ?? error}`;
		}
		try {
			output += execFileSync("dsh", ["--profile", "headless", "--json", "hi"], {
				env,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: timeoutMs
			});
		} catch (error) {
			if (error?.code === "ENOENT") return { ok: true, skipped: true, reason: "dsh 不在 PATH（CI 环境正常跳过）" };
			output += `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.message ?? error}`;
		}
		const verdict = classifyPreflightOutput(output);
		return { ...verdict, skipped: false, home, output };
	} finally {
		if (!keep) rmSync(home, { recursive: true, force: true });
		else console.error(`preflight DSH_HOME kept: ${home}`);
	}
}

function main() {
	const args = parsePreflightArgs(process.argv.slice(2));
	const result = runPreflight({ timeoutMs: args.timeoutMs, keep: args.keep });
	if (args.json) {
		console.log(JSON.stringify({ ok: result.ok, skipped: result.skipped ?? false, reason: result.reason, hardErrors: result.hardErrors ?? [], note: result.note }, null, 2));
	} else if (result.skipped) {
		console.log(`preflight skipped: ${result.reason}`);
	} else if (result.ok) {
		console.log("preflight ok：headless 引导无插件加载错误");
		if (result.note) console.log(`  note: ${result.note}`);
	} else {
		console.error("preflight FAILED：headless 引导发现插件加载错误");
		for (const line of result.hardErrors ?? []) console.error(`  ${line}`);
	}
	if (!result.ok) process.exit(1);
}

if (process.argv[1] !== void 0 && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(`preflight error: ${error && error.message ? error.message : String(error)}`);
		process.exit(1);
	}
}
