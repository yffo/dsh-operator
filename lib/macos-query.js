// dsh-operator：macOS 侧查询封装（窗口列表 / 显示器 / 前台 App）
//
// 全部走 lib/bin/ax-snapshot --list-windows（纯查询，不动 UI）。失败一律返回 undefined，
// 由调用方决定降级；短缓存 200ms，避免同一轮里重复 spawn。
//
// 只在 darwin 上注册；Windows 侧暂不提供（0.6.x 文档里写明）。

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELPER_PATH = join(dirname(fileURLToPath(import.meta.url)), "bin", "ax-snapshot");
const TIMEOUT_MS = 4000;
const CACHE_MS = 200;

let cache = { at: 0, value: undefined };

export function windowQueryAvailable() {
	return process.platform === "darwin" && existsSync(HELPER_PATH);
}

function runHelper(args) {
	return new Promise((resolve) => {
		execFile(
			HELPER_PATH,
			args,
			{ timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
			(error, stdout) => {
				if (error !== null) {
					resolve(undefined);
					return;
				}
				try {
					resolve(JSON.parse(String(stdout)));
				} catch {
					resolve(undefined);
				}
			}
		);
	});
}

/**
 * 列窗口 + 显示器 + 前台 App。
 * @param {{ pid?: number, titleContains?: string, appContains?: string, limit?: number }} [options]
 * @returns {Promise<{frontmostPid:number, frontmostApp:string, displays:object[], windows:object[], truncated:boolean}|undefined>}
 */
export async function listWindows(options = {}) {
	if (windowQueryAvailable() === false) return undefined;
	const now = Date.now();
	let value = cache.value;
	if (value === undefined || now - cache.at > CACHE_MS) {
		const args = ["--list-windows"];
		if (Number.isInteger(options.pid) && options.pid > 0) args.push("--pid", String(options.pid));
		value = await runHelper(args);
		cache = { at: Date.now(), value };
	}
	if (value === undefined) return undefined;
	return {
		...value,
		windows: filterWindows(value.windows, options)
	};
}

function filterWindows(windows, options) {
	const titleNeedle = typeof options.titleContains === "string" ? options.titleContains.trim().toLowerCase() : "";
	const appNeedle = typeof options.appContains === "string" ? options.appContains.trim().toLowerCase() : "";
	let rows = Array.isArray(windows) ? windows : [];
	if (titleNeedle !== "") rows = rows.filter((row) => String(row.title ?? "").toLowerCase().includes(titleNeedle));
	if (appNeedle !== "") rows = rows.filter((row) => String(row.app ?? "").toLowerCase().includes(appNeedle));
	const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(200, options.limit) : rows.length;
	return rows.slice(0, limit);
}

/** 只取显示器列表。 */
export async function listDisplays() {
	const value = await listWindows({});
	return value?.displays;
}

/** 清掉缓存（真机测试 / 动作后立刻查询时用）。 */
export function invalidateWindowCache() {
	cache = { at: 0, value: undefined };
}
