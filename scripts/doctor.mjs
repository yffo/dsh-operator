#!/usr/bin/env node
/**
 * dsh-operator 自检（doctor）：一条命令回答「为什么装了不工作」。
 *
 * 用法：
 *   node scripts/doctor.mjs            # 人类可读
 *   node scripts/doctor.mjs --json     # 机器可读（贴 issue 时用，已脱敏）
 *
 * 检查项：Node/DSH 版本、profile 挂载、helper 架构与执行位、屏幕录制、辅助功能、目录可写、审计/失败样本目录。
 * 退出码：0 = 全部通过或有非致命警告；1 = 存在致命问题。
 */
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { platformSummary } from "../lib/platform.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..");
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const PROFILE = join(DSH_HOME, "profiles", "desktop");
const APP = "/Applications/DeepSeek Harness.app";

function defaultDeps() {
	return {
		platform: process.platform,
		nodeVersion: process.version,
		// 0.72.0：可注入，测试里用来定位 cookie 库
		homedir: homedir(),
		deps: {
			exists: existsSync,
			stat: statSync,
			read: readFileSync,
			readdir: readdirSync,
			access: accessSync,
			mkdir: mkdirSync,
			write: writeFileSync,
			rm: rmSync,
			run: (command, args, options = {}) =>
				new Promise((resolve) => {
					execFile(command, args, { timeout: options.timeout ?? 8000, ...options }, (error, stdout, stderr) => {
						resolve({ ok: error === null, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), error: error?.message ?? "" });
					});
				})
		}
	};
}

function check(condition, okText, failText, level = "fail") {
	return condition ? { level: "ok", text: okText } : { level, text: failText };
}

/**
 * @param {object} options
 * @param {string} [options.dshHome]
 * @param {string} [options.appPath]
 * @param {object} [options.injected] 测试注入的 deps（覆盖默认）
 */
export async function runDoctor(options = {}) {
	const deps = { ...defaultDeps(), ...(options.injected ?? {}) };
	const dshHome = options.dshHome ?? DSH_HOME;
	const appPath = options.appPath ?? APP;
	const profile = join(dshHome, "profiles", "desktop");
	const operatorDir = join(profile, "node_modules", "dsh-operator");
	const results = [];

	// 1. 平台
	results.push(
		deps.platform === "darwin"
			? { level: "ok", text: `平台 macOS（${deps.platform}，已验证）` }
			: { level: "warn", text: `平台 ${deps.platform}：${platformSummary(deps.platform)}` }
	);

	// 2. Node 版本
	const major = Number(String(deps.nodeVersion).replace(/^v/, "").split(".")[0]);
	results.push(check(major >= 20, `Node ${deps.nodeVersion}`, `Node ${deps.nodeVersion} 偏低（建议 ≥ 20）`, "warn"));

	// 3. DSH 应用与版本
	if (deps.platform === "darwin") {
		const plist = join(appPath, "Contents", "Info.plist");
		if (deps.deps.exists(plist)) {
			const version = await deps.deps.run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", plist]);
			results.push(
				version.ok
					? { level: "ok", text: `DSH 应用存在，版本 ${version.stdout.trim()}` }
					: { level: "warn", text: `DSH 应用存在，但读不到版本（${version.error}）` }
			);
		} else {
			results.push({ level: "fail", text: `找不到 DSH 应用：${appPath}` });
		}
	}

	// 4. profile 与挂载
	const pkgPath = join(profile, "package.json");
	if (!deps.deps.exists(pkgPath)) {
		results.push({ level: "fail", text: `profile 不存在或未初始化：${pkgPath}` });
	} else {
		try {
			const pkg = JSON.parse(String(deps.deps.read(pkgPath, "utf8")));
			const dep = pkg?.dependencies?.["dsh-operator"];
			results.push(dep ? { level: "ok", text: `profile 依赖含 dsh-operator（${dep}）` } : { level: "fail", text: "profile dependencies 里没有 dsh-operator" });
			const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
			// 0.72.0：清单身份与「非空 bundles」——2026-11-02 的启动崩溃就是这两条同时失守
			const manifestName = String(pkg?.name ?? "");
			results.push(
				manifestName === "dsh-profile-desktop"
					? { level: "ok", text: `profile 清单身份正确（${manifestName}）` }
					: { level: "fail", text: `profile 清单身份异常：name=${manifestName || "(缺失)"}（应为 dsh-profile-desktop；被插件清单覆盖时 App 会启动即崩 reading 'authenticatedUrl'，修复：cp package.json.known-good package.json）` }
			);
			results.push(
				bundles.length > 0
					? { level: "ok", text: `dsh.profile.bundles 共 ${bundles.length} 个` }
					: { level: "fail", text: "dsh.profile.bundles 为空：加载器会静默构建空插件树，App 启动即崩（修复：cp package.json.known-good package.json）" }
			);
			results.push(
				bundles.includes("dsh-operator")
					? { level: "ok", text: "dsh.profile.bundles 含 dsh-operator" }
					: { level: "warn", text: "dsh.profile.bundles 里没有 dsh-operator（可能被覆盖）" }
			);
		} catch (error) {
			results.push({ level: "fail", text: `profile package.json 解析失败：${String(error)}` });
		}
	}

	// 5. 安装副本与版本
	const installedPkg = join(operatorDir, "package.json");
	if (deps.deps.exists(installedPkg)) {
		try {
			const version = JSON.parse(String(deps.deps.read(installedPkg, "utf8"))).version;
			results.push({ level: "ok", text: `安装副本 dsh-operator@${version}` });
		} catch {
			results.push({ level: "warn", text: "安装副本存在，但读不到 version" });
		}
	} else {
		results.push({ level: "fail", text: `安装副本不存在：${installedPkg}` });
	}

	// 6. helper：存在、可执行、架构（仅 macOS；其它平台扩展工具不注册，这里记跳过而不是失败）
	const helper = join(operatorDir, "lib", "bin", "ax-snapshot");
	if (deps.platform !== "darwin") {
		results.push({ level: "ok", text: `AX helper 仅 macOS：${deps.platform} 上扩展工具不注册（跳过；该平台未验证）` });
	} else if (deps.deps.exists(helper)) {
		let mode = 0;
		try {
			mode = deps.deps.stat(helper).mode;
		} catch {
			/* ignore */
		}
		results.push(check((mode & 0o111) !== 0, "AX helper 有执行位", "AX helper 缺执行位（chmod 755 lib/bin/ax-snapshot）", "warn"));
		if (deps.platform === "darwin") {
			const lipo = await deps.deps.run("/usr/bin/lipo", ["-info", helper]);
			results.push(
				lipo.ok && lipo.stdout.includes("x86_64") && lipo.stdout.includes("arm64")
					? { level: "ok", text: "AX helper 是通用二进制（arm64 + x86_64）" }
					: { level: "warn", text: "AX helper 不是通用二进制（Intel Mac 上会不可用）" }
			);
			const probe = await deps.deps.run(helper, ["--list-windows"], { timeout: 5000 });
			if (probe.ok) {
				results.push({ level: "ok", text: "AX helper 可执行（窗口查询返回）" });
			} else if (/permission|denied|not authorized/i.test(`${probe.stderr} ${probe.error}`)) {
				results.push({ level: "warn", text: "AX helper 被权限拒绝：去「系统设置 → 隐私与安全性 → 辅助功能/屏幕录制」给 DeepSeek Harness 授权" });
			} else {
				results.push({ level: "warn", text: `AX helper 冒烟失败：${String(probe.error).slice(0, 120)}` });
			}
		}
	} else {
		results.push({ level: "fail", text: `AX helper 不存在：${helper}（重新安装或 npm run build:ax）` });
	}

	// 7. 屏幕录制（screencapture 冒烟）
	if (deps.platform === "darwin") {
		const probePath = join(dshHome, ".doctor-screen.jpg");
		const shot = await deps.deps.run("/usr/sbin/screencapture", ["-x", probePath], { timeout: 8000 });
		if (shot.ok) {
			try {
				deps.deps.rm(probePath, { force: true });
			} catch {
				/* ignore */
			}
			results.push({ level: "ok", text: "屏幕录制权限可用（screencapture 成功）" });
		} else {
			results.push({ level: "warn", text: "屏幕录制不可用：给 DeepSeek Harness 授权「屏幕录制」后重试" });
		}
	}

	// 7b. 屏幕与坐标几何（人话）——「坐标点不准」时先看这里
	if (deps.platform === "darwin" && deps.deps.exists(helper)) {
		const listed = await deps.deps.run(helper, ["--list-windows"], { timeout: 5000 });
		if (listed.ok) {
			try {
				const parsed = JSON.parse(String(listed.stdout ?? ""));
				const displays = Array.isArray(parsed?.displays) ? parsed.displays : [];
				const windows = Array.isArray(parsed?.windows) ? parsed.windows : [];
				const front = windows.find((item) => Number(item.pid) === Number(parsed?.frontmostPid));
				if (displays.length > 0) {
					const desc = displays
						.map((item) => {
							const b = item.bounds ?? {};
							return `${String(b.width)}x${String(b.height)}@${String(item.scale ?? 1)}x`;
						})
						.join("、");
					results.push({ level: "ok", text: `屏幕：${desc}（${String(displays.length)} 块；多屏/混合 DPI 未验证）` });
				}
				if (front !== undefined && front.bounds !== undefined) {
					const b = front.bounds;
					results.push({
						level: "ok",
						text: `前台窗口：${String(front.app ?? "?")} @(${String(b.x)},${String(b.y)}) ${String(b.width)}x${String(b.height)} 逻辑点 — 截图按 scale 放大后才是像素；0–1000 坐标相对这张截图`
					});
				}
			} catch {
				results.push({ level: "warn", text: "窗口列表不是 JSON，跳过屏幕几何检查" });
			}
		}
	}

	// 8. 工作目录可写（审计/失败样本都落这里）
	const dataDir = join(dshHome, "dsh-operator");
	try {
		deps.deps.mkdir(dataDir, { recursive: true });
		const probe = join(dataDir, ".doctor-write-test");
		deps.deps.write(probe, "ok");
		deps.deps.rm(probe, { force: true });
		results.push({ level: "ok", text: `数据目录可写：${dataDir}` });
	} catch {
		results.push({ level: "fail", text: `数据目录不可写：${dataDir}` });
	}

	// 9. 审计/失败样本现状（信息项）
	try {
		const audit = join(dataDir, "audit.jsonl");
		if (deps.deps.exists(audit)) {
			const size = deps.deps.stat(audit).size;
			results.push({ level: "ok", text: `审计日志 ${size} bytes：${audit}` });
		} else {
			results.push({ level: "warn", text: "还没有审计日志（插件可能没加载，或尚未有动作）" });
		}
		const failuresDir = join(dataDir, "failures");
		const count = deps.deps.exists(failuresDir) ? deps.deps.readdir(failuresDir).filter((name) => name.endsWith(".jsonl")).length : 0;
		results.push({ level: "ok", text: `失败样本文件 ${count} 个：${failuresDir}` });
	} catch (error) {
		results.push({ level: "warn", text: `读审计/失败样本目录失败：${String(error)}` });
	}

	// 10. dsh-auth cookie 数量（0.72.0）：约 70 条时请求头破 16KB → 431 → 误报认证失败
	if (deps.platform === "darwin") {
		const homeDir = typeof deps.homedir === "string" && deps.homedir !== "" ? deps.homedir : homedir();
		const cookieDb = join(homeDir, "Library", "Application Support", "@deepseek-ai", "dsh-desktop", "Cookies");
		if (deps.deps.exists(cookieDb)) {
			const counted = await deps.deps.run("/usr/bin/sqlite3", [cookieDb, "select count(*) from cookies where name like 'dsh-auth-%';"]);
			const count = Number(String(counted.stdout ?? "").trim());
			if (counted.ok && Number.isFinite(count)) {
				results.push(
					count >= 65
						? { level: "fail", text: `dsh-auth cookie ${count} 条：已接近 70 条的 431 阈值，会出现「Web authentication failed」（退出 App 后跑 scripts/prune-auth-cookies.sh）` }
						: count >= 40
							? { level: "warn", text: `dsh-auth cookie ${count} 条（>40，建议清理：scripts/prune-auth-cookies.sh）` }
							: { level: "ok", text: `dsh-auth cookie ${count} 条（阈值约 70）` }
				);
			} else {
				results.push({ level: "warn", text: `读 cookie 数量失败：${String(counted.error ?? "").slice(0, 120)}` });
			}
		} else {
			results.push({ level: "warn", text: `找不到 cookie 库：${cookieDb}（桌面端未启动过？）` });
		}
	}

	const fatal = results.filter((item) => item.level === "fail");
	return { results, fatal: fatal.length, ok: fatal.length === 0, repoRoot: REPO_ROOT };
}

function main() {
	const json = process.argv.includes("--json");
	runDoctor().then((report) => {
		if (json) {
			console.log(JSON.stringify(report, null, 2));
		} else {
			const icon = { ok: "✅", warn: "⚠️", fail: "❌" };
			console.log("dsh-operator doctor\n");
			for (const item of report.results) console.log(`${icon[item.level]} ${item.text}`);
			console.log(`\n${report.fatal === 0 ? "没有致命问题。" : `有 ${report.fatal} 个致命问题，先按上面的提示修。`}`);
		}
		process.exitCode = report.ok ? 0 : 1;
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
