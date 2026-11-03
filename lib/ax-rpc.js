// dsh-operator AX 助手常驻通道（A2）
//
// 每次观察 spawn 一个 ax-snapshot 要付 Swift/AppKit 启动费（实测 ~90ms，冷启动更高）。
// 这里用 helper 的 `--rpc` 模式常驻一个进程：stdin 逐行 `{id, argv}`，stdout 回 JSON 行。
// 任何异常（启动失败、超时、进程退出）都让调用方回退到一次性 spawn，行为不变。

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";

const DEFAULT_TIMEOUT_MS = 5000;

let child = null;
let childStat = undefined;
let buffer = "";
let sequence = 0;
const pending = new Map();

function rpcDisabled() {
	return process.env.DSH_OPERATOR_AX_RPC === "0";
}

function failPending(reason) {
	for (const entry of pending.values()) {
		clearTimeout(entry.timer);
		entry.settle(undefined);
	}
	pending.clear();
	buffer = "";
	if (child !== null) {
		const stale = child;
		child = null;
		childStat = undefined;
		try {
			stale.kill("SIGTERM");
		} catch {
			// 进程已退出
		}
	}
	void reason;
}

function handleLine(line) {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	const entry = pending.get(message?.id);
	if (entry === undefined) return;
	pending.delete(message.id);
	clearTimeout(entry.timer);
	if (message.code !== 0) {
		entry.settle(undefined);
		return;
	}
	try {
		entry.settle(JSON.parse(String(message.output)));
	} catch {
		entry.settle(undefined);
	}
}

function binaryStat(helperPath) {
	try {
		const info = statSync(helperPath);
		return `${String(info.size)}:${String(info.mtimeMs)}`;
	} catch {
		return undefined;
	}
}

function ensureChild(helperPath) {
	// 插件升级会替换 helper 二进制：路径不变但内容变了，常驻进程必须重建。
	const current = binaryStat(helperPath);
	if (child !== null && current !== childStat) {
		failPending("AX helper binary changed");
	}
	if (child !== null) return child;
	const proc = spawn(helperPath, ["--rpc"], { stdio: ["pipe", "pipe", "ignore"] });
	// 常驻进程不能把宿主的事件循环钉住：测试/CLI 结束后要能自然退出。
	proc.unref();
	proc.stdin.unref?.();
	proc.stdout.unref?.();
	child = proc;
	childStat = current;
	proc.stdout.setEncoding("utf8");
	proc.stdout.on("data", (chunk) => {
		buffer += chunk;
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			if (line.trim() !== "") handleLine(line);
			index = buffer.indexOf("\n");
		}
	});
	proc.on("exit", () => {
		if (child === proc) failPending("AX helper exited");
	});
	proc.on("error", () => {
		if (child === proc) failPending("AX helper failed to start");
	});
	return proc;
}

/**
 * 通过常驻进程执行一次 helper 命令。
 * @param {string} helperPath ax-snapshot 路径。
 * @param {string[]} args helper 参数。
 * @param {number} [timeoutMs]
 * @returns {Promise<object|undefined>} helper 输出的 JSON；不可用时返回 undefined（调用方回退 spawn）。
 */
export function axRpcCall(helperPath, args, timeoutMs = DEFAULT_TIMEOUT_MS) {
	if (rpcDisabled() || existsSync(helperPath) === false) return Promise.resolve(undefined);
	let proc;
	try {
		proc = ensureChild(helperPath);
	} catch {
		return Promise.resolve(undefined);
	}
	return new Promise((resolve) => {
		const id = (sequence += 1);
		let settled = false;
		const settle = (value) => {
			if (settled === true) return;
			settled = true;
			resolve(value);
		};
		const timer = setTimeout(() => {
			pending.delete(id);
			settle(undefined);
			failPending("AX helper timeout");
		}, timeoutMs);
		pending.set(id, { timer, settle });
		try {
			proc.stdin.write(`${JSON.stringify({ id, argv: args })}\n`);
		} catch {
			pending.delete(id);
			clearTimeout(timer);
			settle(undefined);
			failPending("AX helper stdin closed");
		}
	});
}

/** 关闭常驻进程（测试与插件卸载时用）。 */
export function closeAxRpc() {
	failPending("closed");
}
