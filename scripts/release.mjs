#!/usr/bin/env node
/**
 * dsh-operator 发布脚本（0.16.0 起）。
 *
 * 把一个版本发出去涉及的步骤固定下来，避免每次手打：校验版本 → 确认工作区干净
 * → 改 package.json → 跑全量测试 → commit → tag → push → 同步安装副本 → doctor。
 *
 * 安全边界：
 * - 默认**只打印计划**，不加 `--yes` 不会动 git；
 * - 工作区不干净直接拒绝（避免把未提交改动混进 release commit）；
 * - 只改 package.json、只提交这一个文件（README 变更应随功能提交先行）；
 * - tag 已存在、版本格式非法、测试失败都会中止，不做 force 操作。
 *
 * 用法：
 *   npm run release -- 0.16.0            # 打印计划
 *   npm run release -- 0.16.0 --yes      # 真发：改版本 + 测试 + commit + tag + push
 *   npm run release -- 0.16.0 --yes --install   # 再同步安装副本并跑 doctor
 *   npm run release -- 0.16.0 --yes --skip-tests --install
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const INSTALLED_PACKAGE = "~/.dsh/profiles/desktop/node_modules/dsh-operator";

/** 校验 semver-ish 版本号（允许 -rc.1 这类预发布后缀）。 */
export function validateVersion(version) {
	if (typeof version !== "string" || !VERSION_RE.test(version)) {
		throw new Error(`invalid version: ${String(version)}（期望形如 0.16.0 或 0.16.0-rc.1）`);
	}
	return version;
}

/** 解析 CLI 参数；未知 flag / 多余位置参数直接抛错，避免静默误操作。 */
export function parseReleaseArgs(argv) {
	const args = { version: void 0, yes: false, dryRun: false, install: false, skipTests: false };
	for (const raw of argv) {
		const arg = String(raw);
		if (arg === "--yes") args.yes = true;
		else if (arg === "--dry-run") args.dryRun = true;
		else if (arg === "--install") args.install = true;
		else if (arg === "--skip-tests") args.skipTests = true;
		else if (arg.startsWith("--")) throw new Error(`unknown flag: ${arg}`);
		else if (args.version === void 0) args.version = arg;
		else throw new Error(`unexpected argument: ${arg}`);
	}
	return args;
}

function run(cmd, args, { capture = false } = {}) {
	return execFileSync(cmd, args, {
		cwd: root,
		encoding: "utf8",
		stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit"
	});
}

function capture(cmd, args) {
	try {
		return run(cmd, args, { capture: true }).trim();
	} catch (error) {
		const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
		throw new Error(`${cmd} ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
	}
}

export function worktreeClean() {
	return capture("git", ["status", "--porcelain"]) === "";
}

export function tagExists(version) {
	return capture("git", ["tag", "--list", `v${version}`]) !== "";
}

export function currentVersion() {
	return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
}

function setVersion(version) {
	const path = join(root, "package.json");
	const pkg = JSON.parse(readFileSync(path, "utf8"));
	pkg.version = version;
	writeFileSync(path, `${JSON.stringify(pkg, null, "\t")}\n`);
}

/** 生成发布计划（纯函数，便于测试与 dry-run 打印）。 */
export function planRelease(args) {
	validateVersion(args.version);
	const steps = [
		{ id: "preflight", detail: "工作区干净（git status --porcelain 为空）" },
		{ id: "bump", detail: `package.json ${currentVersion()} → ${args.version}` },
		{ id: "test", detail: args.skipTests ? "跳过 npm test（--skip-tests）" : "npm test 全量" },
		{ id: "commit", detail: `git add package.json && git commit -m "release: v${args.version}"` },
		{ id: "tag", detail: `git tag -a v${args.version}` },
		{ id: "push", detail: "git push origin main --tags" }
	];
	if (args.install) {
		steps.push({ id: "install", detail: "dsh plugin remove/add 后跑 doctor" });
	}
	return steps;
}

function main() {
	const args = parseReleaseArgs(process.argv.slice(2));
	if (args.version === void 0) {
		console.error("usage: npm run release -- <version> [--yes] [--install] [--skip-tests] [--dry-run]");
		process.exit(2);
	}
	validateVersion(args.version);
	const steps = planRelease({ ...args, skipTests: args.skipTests });
	const existing = tagExists(args.version);
	console.log(`release plan: v${args.version} (current ${currentVersion()})`);
	for (const step of steps) console.log(`  - ${step.id}: ${step.detail}`);
	if (existing) {
		console.error(`tag v${args.version} already exists; refusing to reuse it`);
		process.exit(1);
	}
	if (!args.yes || args.dryRun) {
		console.log("\ndry run: 未改动任何文件。确认无误后加 --yes 执行（可再加 --install 同步安装副本）。");
		return;
	}
	if (!worktreeClean()) {
		console.error("worktree is not clean; commit or stash changes before releasing");
		process.exit(1);
	}
	setVersion(args.version);
	if (!args.skipTests) run("npm", ["test"]);
	run("git", ["add", "package.json"]);
	run("git", ["commit", "-m", `release: v${args.version}`]);
	run("git", ["tag", "-a", `v${args.version}`, "-m", `dsh-operator ${args.version}`]);
	run("git", ["push", "origin", "main", "--tags"]);
	if (args.install) {
		run("dsh", ["plugin", "--profile", "desktop", "remove", "dsh-operator"]);
		run("dsh", ["plugin", "--profile", "desktop", "add", "--save-exact", `file:${root}`]);
		run("node", [join(process.env.HOME ?? "~", ".dsh/profiles/desktop/node_modules/dsh-operator/scripts/doctor.mjs")]);
	}
	console.log(`\nreleased v${args.version}. 记得：重启 App 让 JS 改动生效；客户端卡片改动刷新页面即可。`);
	console.log(`安装副本：${INSTALLED_PACKAGE}`);
}

if (process.argv[1] !== void 0 && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(`release failed: ${error && error.message ? error.message : String(error)}`);
		process.exit(1);
	}
}
