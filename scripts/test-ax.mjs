#!/usr/bin/env node
/**
 * P1-6 AX 观察的自检：
 * - formatAxSnapshot 的过滤/排序/坐标换算/截断行为（纯函数，无外部依赖）
 * - 辅助程序不存在/无权限时 observeAxSnapshot 静默返回 undefined
 * - lib/bin/ax-snapshot 已构建且可执行
 *
 * 用法：node scripts/test-ax.mjs
 */

import { chmod, access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { formatAxSnapshot, observeAxSnapshot, configureAxObservation } from "../lib/ax-observer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
function check(ok, label) {
	if (!ok) failures.push(label);
	console.log(`${ok ? "✓" : "✗"} ${label}`);
}

// ---------- 纯函数：格式化 ----------
const sample = {
	pid: 123,
	appName: "示例应用",
	windowTitle: "设置",
	windowFrame: { x: 100, y: 200, width: 800, height: 600 },
	nodes: [
		{ index: 0, depth: 0, role: "AXWindow", title: "设置", value: "", frame: { x: 100, y: 200, width: 800, height: 600 } },
		{ index: 1, depth: 1, role: "AXMenuBarItem", title: "文件", value: "", frame: { x: 100, y: 0, width: 40, height: 20 } },
		{ index: 2, depth: 1, role: "AXButton", title: "显示器", value: "", frame: { x: 500, y: 400, width: 200, height: 100 } },
		{ index: 3, depth: 2, role: "AXStaticText", title: "", value: "内建显示器", frame: { x: 500, y: 500, width: 100, height: 20 } },
		{ index: 4, depth: 2, role: "AXSecureTextField", title: "密码", value: "[secure]", frame: { x: 500, y: 520, width: 100, height: 20 } },
		{ index: 5, depth: 1, role: "AXButton", title: "窗口外", value: "", frame: { x: 2000, y: 2000, width: 10, height: 10 } },
		{ index: 6, depth: 1, role: "AXGroup", title: "", value: "", frame: { x: 120, y: 220, width: 50, height: 20 } }
	],
	truncated: true
};

const text = formatAxSnapshot(sample, { appName: "示例应用", windowTitle: "设置" });
check(typeof text === "string", "formatAxSnapshot 返回文本");
check(text.includes('<ax_snapshot app="示例应用" window="设置" nodes="4" truncated="true">'), "头部包含 app/window/nodes/truncated");
check(text.includes('[2] AXButton "显示器" @(625,417)'), "按钮标题与 0–1000 坐标换算正确");
check(text.includes('value="内建显示器"'), "静态文本以 value 呈现");
check(text.includes("[4] AXSecureTextField"), "安全输入框保留但值不外泄");
check(!text.includes("AXMenuBarItem"), "菜单栏节点被过滤");
check(!text.includes("窗口外"), "窗口外节点被过滤");
check(!text.includes("AXGroup"), "无身份的容器节点被过滤");
check(text.includes("0–1000"), "尾部说明坐标空间");

// 截图区域比窗口大（同一 App 多窗口并集）时，坐标要按截图区域换算。
const unionText = formatAxSnapshot(sample, { appName: "示例应用" }, { x: 100, y: 100, width: 1600, height: 900 });
check(unionText.includes('[2] AXButton "显示器" @(313,389)'), "按截图区域归一化（多窗口并集）");
check(!unionText.includes("窗口外"), "截图区域外的节点仍被过滤");
check(formatAxSnapshot(sample, { appName: "示例应用" }, { x: 0, y: 0, width: 0, height: 0 }).includes("@(625,417)"), "非法区域退回窗口 frame 归一化");

check(formatAxSnapshot({ nodes: [] }, {}) === undefined, "空节点返回 undefined");
check(formatAxSnapshot({ windowFrame: sample.windowFrame, nodes: sample.nodes.filter(n => n.role === "AXButton") }, {}) === undefined, "重要节点少于 4 个时返回 undefined");

// ---------- 辅助程序 ----------
const helperPath = join(root, "lib", "bin", "ax-snapshot");
let helperExists = true;
try {
	await access(helperPath, constants.X_OK);
} catch {
	helperExists = false;
}
check(helperExists, "lib/bin/ax-snapshot 已构建且可执行");
if (helperExists) {
	const info = await stat(helperPath);
	check(info.size > 10_000, `辅助程序大小合理（${String(info.size)} B）`);
	try {
		await chmod(helperPath, 0o755);
	} catch {
		// 忽略：安装目录可能只读
	}
}

configureAxObservation({ enabled: true, maxNodes: 60 });
const noPid = await observeAxSnapshot({ appName: "无 pid" });
check(noPid === undefined, "无 pid 时不尝试 AX");

configureAxObservation({ enabled: false, maxNodes: 60 });
const disabled = await observeAxSnapshot({ pid: process.pid, appName: "node" });
check(disabled === undefined, "关闭 AX 观察时返回 undefined");

if (failures.length > 0) {
	console.error(`\n✗ AX 自检失败 ${failures.length} 项`);
	process.exitCode = 1;
} else {
	console.log("\n✓ AX 自检全部通过");
}
