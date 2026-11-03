import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runDoctor } from "../scripts/doctor.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fakeDeps({ files, statModes = {}, run = () => ({ ok: true, stdout: "", stderr: "", error: "" }) }) {
	const isFile = (path) => Object.hasOwn(files, path);
	return {
		exists: (path) => isFile(path),
		stat: (path) => {
			if (!isFile(path) && statModes[path] === undefined) throw new Error(`ENOENT ${path}`);
			return { mode: statModes[path] ?? 0o100644, size: String(files[path] ?? "").length };
		},
		read: (path) => {
			if (!isFile(path)) throw new Error(`ENOENT ${path}`);
			return files[path];
		},
		readdir: () => [],
		access: () => undefined,
		mkdir: () => undefined,
		write: () => undefined,
		rm: () => undefined,
		run
	};
}

function happyDeps() {
	const dshHome = "/tmp/dsh-home";
	const app = "/Applications/DeepSeek Harness.app";
	const profile = join(dshHome, "profiles", "desktop");
	const operatorDir = join(profile, "node_modules", "dsh-operator");
	const files = {
		[join(app, "Contents", "Info.plist")]: "<plist/>",
		[join(profile, "package.json")]: JSON.stringify({
			// 0.72.0：清单身份是 doctor 的必查项
			name: "dsh-profile-desktop",
			dependencies: { "dsh-operator": "file:/tmp/repo" },
			dsh: { profile: { bundles: ["dsh-operator", "dshmarket"] } }
		}),
		[join(operatorDir, "package.json")]: JSON.stringify({ version: "0.11.0" }),
		[join(dshHome, "dsh-operator", "audit.jsonl")]: "x".repeat(10),
		[join("/tmp/home", "Library", "Application Support", "@deepseek-ai", "dsh-desktop", "Cookies")]: "db"
	};
	const statModes = { [join(operatorDir, "lib", "bin", "ax-snapshot")]: 0o100755 };
	Object.assign(files, { [join(operatorDir, "lib", "bin", "ax-snapshot")]: "binary" });
	const run = (command, args) => {
		if (command.endsWith("plutil")) return { ok: true, stdout: "0.2.1-rc.5\n", stderr: "", error: "" };
		if (command.endsWith("lipo")) return { ok: true, stdout: "Architectures in the fat file: ax-snapshot are: x86_64 arm64", stderr: "", error: "" };
		if (command.endsWith("ax-snapshot")) return { ok: true, stdout: "{}", stderr: "", error: "" };
		if (command.endsWith("screencapture")) return { ok: true, stdout: "", stderr: "", error: "" };
		if (command.endsWith("sqlite3")) return { ok: true, stdout: "6\n", stderr: "", error: "" };
		return { ok: false, stdout: "", stderr: "", error: `unexpected ${command}` };
	};
	return { platform: "darwin", nodeVersion: "v22.0.0", homedir: "/tmp/home", deps: fakeDeps({ files, statModes, run }) };
}

test("doctor：健康环境应该全部通过", async () => {
	const report = await runDoctor({ dshHome: "/tmp/dsh-home", appPath: "/Applications/DeepSeek Harness.app", injected: happyDeps() });
	assert.equal(report.fatal, 0, JSON.stringify(report.results.filter((item) => item.level === "fail")));
	assert.equal(report.ok, true);
	assert.ok(report.results.some((item) => item.text.includes("AX helper 是通用二进制")));
	assert.ok(report.results.some((item) => item.text.includes("profile 依赖含 dsh-operator")));
});

test("doctor：非 darwin + 缺安装副本时，AX helper 只记「macOS-only 跳过」不误判为致命", async () => {
	const deps = {
		platform: "linux",
		nodeVersion: "v18.19.0",
		deps: fakeDeps({ files: {} })
	};
	const report = await runDoctor({ dshHome: "/tmp/dsh-home", appPath: "/Applications/DeepSeek Harness.app", injected: deps });
	assert.ok(report.fatal >= 1, `期望至少 1 个致命项（安装副本缺失），实际 ${report.fatal}`);
	assert.equal(report.ok, false);
	const text = report.results.map((item) => item.text).join("\n");
	assert.match(text, /UNVERIFIED/);
	assert.match(text, /linux/);
	assert.match(text, /安装副本不存在/);
	assert.match(text, /AX helper 仅 macOS：linux 上扩展工具不注册（跳过；该平台未验证）/);
	assert.doesNotMatch(text, /AX helper 不存在/);
});


test("doctor：清单被插件清单覆盖（name 缺失 + bundles 为空）必须致命", async () => {
	const injected = happyDeps();
	const profile = join("/tmp/dsh-home", "profiles", "desktop");
	injected.deps.read = (path) => (path === join(profile, "package.json")
		? JSON.stringify({ name: "dsh-operator", dsh: { bundle: { patch: "./cordis.patch.yml" } } })
		: "{}");
	const report = await runDoctor({ dshHome: "/tmp/dsh-home", appPath: "/Applications/DeepSeek Harness.app", injected });
	assert.equal(report.ok, false);
	const text = report.results.map((item) => item.text).join("\n");
	assert.match(text, /清单身份异常/);
	assert.match(text, /bundles 为空/);
	assert.match(text, /authenticatedUrl/);
});

test("doctor：cookie 40 条以上给警告，65 条以上判致命", async () => {
	for (const [count, expectLevel, pattern] of [[45, "warn", />40/], [70, "fail", /431 阈值/]]) {
		const injected = happyDeps();
		const baseRun = injected.deps.run;
		injected.deps.run = (command, args, options) => (command.endsWith("sqlite3")
			? { ok: true, stdout: `${count}\n`, stderr: "", error: "" }
			: baseRun(command, args, options));
		const report = await runDoctor({ dshHome: "/tmp/dsh-home", appPath: "/Applications/DeepSeek Harness.app", injected });
		const item = report.results.find((entry) => entry.text.includes("dsh-auth cookie"));
		assert.equal(item?.level, expectLevel, `cookie ${count} 条应判 ${expectLevel}，实际 ${item?.level}`);
		assert.match(item.text, pattern);
	}
});
