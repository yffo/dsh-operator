#!/usr/bin/env node
/**
 * 失败样本汇总：把 ~/.dsh/dsh-operator/failures/*.jsonl 归纳成可读报告。
 *
 * 用法：
 *   node scripts/failures.mjs            # 看最近汇总
 *   node scripts/failures.mjs --json     # 输出 JSON（给脚本/issue 用）
 *   node scripts/failures.mjs --dir /tmp/x --top 5
 *   node scripts/failures.mjs --files    # 只列文件大小
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { digestFailures, failureDir } from "../lib/failure-store.js";

function parseArgs(argv) {
	const args = { dir: failureDir(), top: 10, json: false, files: false };
	for (let i = 0; i < argv.length; i += 1) {
		const item = argv[i];
		if (item === "--json") args.json = true;
		else if (item === "--files") args.files = true;
		else if (item === "--dir") args.dir = argv[++i];
		else if (item === "--top") args.top = Number(argv[++i] ?? 10);
		else if (item === "-h" || item === "--help") args.help = true;
	}
	return args;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log("usage: node scripts/failures.mjs [--json] [--files] [--dir <path>] [--top N]");
		return;
	}
	if (args.files) {
		if (existsSync(args.dir) === false) {
			console.log("no failure dir yet:", args.dir);
			return;
		}
		for (const name of readdirSync(args.dir).sort()) {
			const stat = statSync(join(args.dir, name));
			console.log(`${name}\t${stat.size} bytes`);
		}
		return;
	}
	const digest = digestFailures({ dir: args.dir, top: args.top });
	if (args.json) {
		console.log(JSON.stringify({ dir: args.dir, ...digest }, null, 2));
		return;
	}
	console.log(`失败样本目录: ${args.dir}`);
	console.log(`总条数: ${digest.total}`);
	if (digest.total === 0) {
		console.log("（空——这是好事）");
		return;
	}
	const section = (title, rows) => {
		console.log(`\n${title}`);
		for (const [key, count] of rows) console.log(`  ${String(count).padStart(4)}  ${key}`);
	};
	section("按工具:", digest.byTool);
	section("按分类:", digest.byKind);
	section("按错误:", digest.byMessage);
	console.log("\n按天:");
	for (const [day, count] of digest.byDay) console.log(`  ${day}  ${count}`);
	console.log("\n最近 5 条:");
	for (const row of digest.recent) {
		console.log(`  ${row.t}  ${row.tool}  ${row.kind}  ${row.message}`);
	}
	console.log("\n提示: 修完问题后把对应失败行删掉即可（或整目录归档），不要提交到仓库。");
}

main();
