// 技能步数统计（0.67.0）
//
// G3 的验收是「同类任务第二次执行步数下降 ≥50%」，但之前没有任何基线可言。
// 这里为每条技能记一条极小的运行统计：首次成功步数 = 基线，最近一次步数 = 现状。
//
// 只存步数与成败，不存参数、不存页面文本；单文件 `~/.dsh/dsh-operator/skill-stats.json`，
// 最多 200 条（超出丢最早更新的），写入原子替换。

import { closeSync, openSync, statSync, unlinkSync } from "node:fs";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_ENTRIES = 200;
let overrides = {};

/** 覆盖统计文件路径（测试用）。传 null 恢复默认。 */
export function configureSkillStats(options = {}) {
	overrides = { ...options };
}

export function statsPath() {
	if (overrides.file !== undefined && overrides.file !== null) return overrides.file;
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "dsh-operator", "skill-stats.json");
}

/** @returns {Record<string, {first:number, last:number, best:number, runs:number, ok:number, updatedAt:string}>} */
/** 锁文件超时（0.83.0）：拿不到就报错，而不是无限等。 */
const LOCK_WAIT_MS = 2000;
/** 锁文件超过这个年龄视为残留（进程崩了没释放）。 */
const LOCK_STALE_MS = 5000;

/** 同步睡几毫秒（不引第三方依赖）。 */
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 用锁文件包住一次「读-改-写」（0.83.0）。
 * 两个 DSH 进程同时 recordSkillRun 会互相覆盖，之前只靠 tmp 文件名带 pid，防不住跨进程。
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function withStatsLock(fn) {
	const lock = `${statsPath()}.lock`;
	// 0.114.1：数据目录还不存在时（首次运行 / 新 DSH_HOME），抢锁会 ENOENT 直接抛——
	// 建目录必须发生在 openSync 之前，不能等 writeStats 里才建。
	mkdirSync(dirname(lock), { recursive: true });
	const started = Date.now();
	let acquired = false;
	while (acquired === false) {
		try {
			closeSync(openSync(lock, "wx"));
			acquired = true;
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock);
			} catch {
				// 残留锁已被别的进程清掉
			}
			if (Date.now() - started > LOCK_WAIT_MS) throw new Error("skill-stats: 统计锁超时（有进程占用超过 2s）");
			sleepSync(5);
		}
	}
	try {
		return fn();
	} finally {
		try {
			unlinkSync(lock);
		} catch {
			// 已被清理
		}
	}
}

export function readStats() {
	const file = statsPath();
	if (existsSync(file) === false) return {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return parsed !== null && typeof parsed === "object" && Array.isArray(parsed) === false ? parsed : {};
	} catch {
		// 0.82.0：损坏文件先备份，避免下一次写入把整份历史覆盖掉
		try {
			renameSync(file, `${file}.corrupt`);
		} catch {
			// 备份失败就算了，至少不静默覆盖
		}
		return {};
	}
}

export function readSkillStats(name) {
	const all = readStats();
	return all[name] ?? null;
}

/**
 * 记一次运行。只有「执行成功」的场次才算基线/最好成绩。
 * @param {string} name
 * @param {{ steps: number, ok: boolean, now?: number }} run
 * @returns {{ first:number, last:number, best:number, runs:number, targetMet:boolean, deltaPercent:number }}
 */
export function recordSkillRun(name, run) {
	const steps = Number.isFinite(run?.steps) && run.steps > 0 ? Math.round(run.steps) : 0;
	const ok = run?.ok === true;
	const now = Number.isFinite(run?.now) ? run.now : Date.now();
	// 0.83.0：读-改-写整体加锁，避免两个进程同时写丢更新
	return withStatsLock(() => recordSkillRunLocked(name, { steps, ok, now }));
}

/**
 * 已加锁的实现体。
 * @param {string} name
 * @param {{ steps: number, ok: boolean, now: number }} run
 */
function recordSkillRunLocked(name, run) {
	const { steps, ok, now } = run;
	const all = readStats();
	const previous = all[name];
	const prevFirst = Number(previous?.first ?? 0);
	const prevBest = Number(previous?.best ?? 0);
	const entry = {
		// 0.77.0：失败轮会先建一条 first=0 的记录；之后成功必须能把基线立起来
		first: prevFirst > 0 ? prevFirst : (ok && steps > 0 ? steps : 0),
		// 0.82.0：失败轮不再改写 last——否则「跑到第 2 步失败」能把达标指标刷出来
		last: ok && steps > 0 ? steps : (previous?.last ?? 0),
		best: ok && steps > 0 ? (prevBest > 0 ? Math.min(prevBest, steps) : steps) : prevBest,
		runs: (previous?.runs ?? 0) + 1,
		ok: (previous?.ok ?? 0) + (ok ? 1 : 0),
		updatedAt: new Date(now).toISOString()
	};
	if (!Number.isFinite(entry.best)) entry.best = 0;
	all[name] = entry;
	all[name]._updated = now;
	writeStats(all);
	delete all[name]._updated;
	const { targetMet, deltaPercent } = evaluateRun(entry);
	return { ...entry, targetMet, deltaPercent };
}

/**
 * 判断这一次是否达标（≤ 首次步数的 50%）并给出相对变化。
 * @param {{first:number, last:number}} entry
 */
export function evaluateRun(entry) {
	const first = Number(entry?.first ?? 0);
	const last = Number(entry?.last ?? 0);
	if (first <= 0 || last <= 0) return { targetMet: false, deltaPercent: 0 };
	const deltaPercent = Math.round(((last - first) / first) * 100);
	return { targetMet: last * 2 <= first, deltaPercent };
}

/**
 * 技能健康度（0.81.0）：给 skill_list 排序与失效标记用。
 * @param {{runs?:number, ok?:number}} stat
 * @returns {"new"|"ok"|"flaky"|"stale"}
 */
export function judgeSkillHealth(stat) {
	const runs = Number(stat?.runs ?? 0);
	const ok = Number(stat?.ok ?? 0);
	if (runs <= 0) return "new";
	// 只失败过一次还说明不了问题，至少两次全败才判失效
	if (ok === 0) return runs >= 2 ? "stale" : "ok";
	if (ok * 2 < runs) return "flaky";
	return "ok";
}

/** 生成一行人类可读的对比文案。 */
export function describeRun(entry) {
	const { targetMet, deltaPercent } = evaluateRun(entry);
	if ((entry?.first ?? 0) <= 0) return "尚无成功基线（该技能还没有一次全步成功）";
	const sign = deltaPercent > 0 ? "+" : "";
	const verdict = targetMet ? "达标（≤50%）" : "未达标";
	return `步数 ${entry.last}／首次基线 ${entry.first}（${sign}${deltaPercent}%，${verdict}）`;
}

function writeStats(all) {
	const entries = Object.entries(all)
		.sort((a, b) => (b[1]?._updated ?? 0) - (a[1]?._updated ?? 0))
		.slice(0, MAX_ENTRIES);
	const trimmed = {};
	for (const [name, value] of entries) {
		const { _updated, ...rest } = value ?? {};
		void _updated;
		trimmed[name] = rest;
	}
	const file = statsPath();
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(trimmed, null, 2)}\n`, "utf8");
	renameSync(tmp, file);
}
