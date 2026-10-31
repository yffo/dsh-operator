import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	currentVersion,
	parseReleaseArgs,
	planRelease,
	validateVersion,
	worktreeClean
} from "../scripts/release.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "scripts", "release.mjs"), "utf8");

test("validateVersion 只接受 semver-ish 版本号", () => {
	assert.equal(validateVersion("0.16.0"), "0.16.0");
	assert.equal(validateVersion("1.2.3-rc.1"), "1.2.3-rc.1");
	for (const bad of ["", "v0.16.0", "0.16", "0.16.0.1", "../0.16.0"]) {
		assert.throws(() => validateVersion(bad), /invalid version/, `应拒绝 ${bad}`);
	}
});

test("parseReleaseArgs 解析版本与开关，未知/多余参数报错", () => {
	const args = parseReleaseArgs(["0.16.0", "--yes", "--install", "--skip-tests"]);
	assert.deepEqual(args, { version: "0.16.0", yes: true, dryRun: false, install: true, skipTests: true, skipPreflight: false });
	assert.equal(parseReleaseArgs(["0.16.0", "--dry-run"]).dryRun, true);
	assert.throws(() => parseReleaseArgs(["--nope", "0.16.0"]), /unknown flag/);
	assert.throws(() => parseReleaseArgs(["0.16.0", "0.17.0"]), /unexpected argument/);
});

test("planRelease 生成预检/改版本/测试/提交/打 tag/推送步骤，--install 追加安装步骤", () => {
	const plain = planRelease({ version: "9.9.9", skipTests: false, install: false });
	assert.deepEqual(
		plain.map((step) => step.id),
		["preflight", "bump", "test", "boot", "commit", "tag", "push"]
	);
	assert.match(plain.find((step) => step.id === "commit").detail, /v9\.9\.9/);
	const full = planRelease({ version: "9.9.9", skipTests: true, install: true });
	assert.ok(full.some((step) => step.id === "install"));
	assert.match(full.find((step) => step.id === "test").detail, /skip-tests/);
	assert.match(planRelease({ version: "9.9.9", skipTests: false, skipPreflight: true }).find((step) => step.id === "boot").detail, /skip-preflight/);
	assert.equal(parseReleaseArgs(["0.16.0", "--skip-preflight"]).skipPreflight, true);
});

test("脚本安全边界：默认 dry-run、--yes 才执行、工作区不干净拒绝、tag 已存在拒绝", () => {
	assert.ok(source.includes("if (!args.yes || args.dryRun)"), "默认必须只打印计划");
	assert.ok(source.includes("worktree is not clean"), "工作区不干净必须拒绝");
	assert.ok(source.includes("already exists; refusing"), "tag 已存在必须拒绝");
	assert.ok(source.includes("validateVersion(args.version)"), "执行前必须校验版本");
	for (const unsafe of ["git push --force", "--force", "git reset --hard", "git tag -d"]) {
		assert.ok(!source.includes(unsafe), `发布脚本不应包含危险操作：${unsafe}`);
	}
});

test("仓库状态探测函数返回布尔值（不误报）", () => {
	assert.equal(typeof worktreeClean(), "boolean");
	assert.match(currentVersion(), /^\d+\.\d+\.\d+/);
});
