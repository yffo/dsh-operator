/**
 * 运行状态汇总（0.13.0）：给模型/用户一个「插件现在什么状态」的快照。
 * 只做只读统计，不执行任何 GUI 动作；目录与配置都可注入，便于单测。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { areExtendedToolsSupported, extendedToolsSkipReason, isVerifiedPlatform, platformSummary } from "./platform.js";
import { readHandoff, summarizeHandoff } from "./state-handoff.js";

export function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

function countLines(path) {
	if (existsSync(path) === false) return 0;
	try {
		return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").length;
	} catch {
		return 0;
	}
}

function countFiles(dir) {
	if (existsSync(dir) === false) return 0;
	try {
		return readdirSync(dir).filter((name) => name.endsWith(".json") || name.endsWith(".jsonl")).length;
	} catch {
		return 0;
	}
}

export function collectStatus(options = {}) {
	const home = options.home ?? dshHome();
	const dataDir = options.dataDir ?? join(home, "dsh-operator");
	const planDir = options.planDir ?? join(dataDir, "plans");
	const skillDir = options.skillDir ?? join(dataDir, "skills");
	const failuresDir = options.failuresDir ?? join(dataDir, "failures");
	const auditPath = options.auditPath ?? join(dataDir, "audit.jsonl");
	const config = options.config ?? {};
	const version = options.version ?? "unknown";
	const installedVersion = typeof options.installedVersion === "string" && options.installedVersion.length > 0 ? options.installedVersion : void 0;
	const platform = options.platform ?? process.platform;
	const seamProvider = typeof options.seamProvider === "string" && options.seamProvider.length > 0 ? options.seamProvider : void 0;
	const extendedToolsSupported = areExtendedToolsSupported(platform);
	const plans = countFiles(planDir);
	const skills = countFiles(skillDir);
	const failures = countFiles(failuresDir);
	const auditLines = countLines(auditPath);
	let auditBytes = 0;
	try {
		auditBytes = existsSync(auditPath) ? statSync(auditPath).size : 0;
	} catch {
		auditBytes = 0;
	}
	const verified = isVerifiedPlatform(platform);
	const lines = [
		`dsh-operator ${version} (${platform})`,
		`platform: ${platformSummary(platform)}`,
		...(installedVersion === void 0 || installedVersion === version ? [] : [`profile: 磁盘上是 ${installedVersion}，运行中是 ${version} —— 重启 App 才会加载新版`]),
		extendedToolsSupported
			? `tools: extended surface registered on macOS; axMaxNodes ${String(config.axMaxNodes ?? 120)}; failureSamples ${config.failureSamples !== false ? "on" : "off"}; browserCdpPort ${String(config.browserCdpPort ?? 0)}`
			: `tools: ${extendedToolsSkipReason(platform)}; failureSamples ${config.failureSamples !== false ? "on" : "off"}; browserCdpPort ${String(config.browserCdpPort ?? 0)}`,
		...(seamProvider === void 0 ? [] : [`seam provider: ${seamProvider}`]),
		...(options.browserTools === void 0 || typeof options.browserTools !== "object" ? [] : [options.browserTools.registered === true
			? `browser tools: registered (${String(Array.isArray(options.browserTools.names) ? options.browserTools.names.length : 0)} tools)`
			: `browser tools: skipped — ${String(options.browserTools.reason ?? "unknown")}（browser_dom_* 仍可用）`]),
		...(options.handoff === null ? [] : [options.handoff === void 0 ? summarizeHandoff(readHandoff()) : summarizeHandoff(options.handoff)]),
		`data: ${dataDir}`,
		`skills ${skills} · plans ${plans} · failures files ${failures} · audit ${auditLines} lines (${auditBytes} B)`
	];
	return {
		schemaVersion: 1,
		text: lines.join("\n"),
		version,
		platform,
		platformVerified: verified,
		extendedToolsSupported,
		dataDir,
		skills,
		plans,
		failureFiles: failures,
		failureRecords: countFailures(failuresDir),
		auditLines,
		auditBytes,
		axMaxNodes: Number(config.axMaxNodes ?? 120),
		failureSamples: config.failureSamples !== false,
		browserCdpPort: Number(config.browserCdpPort ?? 0),
		...(seamProvider === void 0 ? {} : { seamProvider })
	};
}

function countFailures(failuresDir) {
	if (existsSync(failuresDir) === false) return 0;
	let total = 0;
	try {
		for (const name of readdirSync(failuresDir)) {
			if (name.endsWith(".jsonl")) total += countLines(join(failuresDir, name));
		}
	} catch {
		return total;
	}
	return total;
}
