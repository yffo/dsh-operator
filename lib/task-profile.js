/**
 * 复杂度分层（0.12.0）：按目标文本 + 可选提示，把任务分到 simple / standard / complex 三档，
 * 每档给出观察策略、步数上限、是否先规划、是否批量并行等配置。
 *
 * 目的：简单任务别上重流程（省步数/token），复杂任务别裸奔（先规划、逐步校验）。
 * 纯函数，无副作用；模型可随时用 task_profile 工具查当前建议。
 */

import { suggestTemplate } from "./plan-templates.js";

export const PROFILES = {
	simple: {
		tier: "simple",
		maxSteps: 6,
		observeFirst: false,
		verifyAfterEach: false,
		allowBatch: false,
		requirePlan: false,
		note: "单步或少步操作：直接动作 + 动作后观察即可，不必先写计划"
	},
	standard: {
		tier: "standard",
		maxSteps: 20,
		observeFirst: false,
		verifyAfterEach: true,
		allowBatch: false,
		requirePlan: false,
		note: "常规多步任务：先观察再动作，关键动作后用 verify_state 校验"
	},
	complex: {
		tier: "complex",
		maxSteps: 60,
		observeFirst: true,
		verifyAfterEach: true,
		allowBatch: true,
		requirePlan: true,
		note: "跨应用/长流程：先 plan_create 拆步骤，每步 verify，失败即停并落失败样本"
	}
};

const COMPLEX_SIGNALS = [
	"工作流",
	"流程",
	"跨应用",
	"多个",
	"批量",
	"逐个",
	"然后",
	"之后",
	"接着",
	"登录",
	"注册",
	"表单",
	"填写",
	"核对",
	"对比",
	"提取",
	"整理",
	"部署",
	"安装",
	"配置",
	"迁移",
	"汇总",
	"报告"
];
const SIMPLE_SIGNALS = ["打开", "截图", "点击", "关闭", "切换", "列出", "看一下", "查一下", "复制", "粘贴"];
// 跨应用/多动作的项目化任务：即使没有「登录/批量」等强信号，也要能被分层识别（0.14.1）。
const APP_HINTS = [
	"浏览器", "chrome", "safari", "备忘录", "日历", "系统设置", "访达", "finder", "邮件", "微信",
	"终端", "文档", "word", "excel", "numbers", "pages", "telegram", "slack", "notion"
];
const ACTION_VERBS = [
	"打开", "点击", "输入", "填写", "创建", "新建", "保存", "发送", "复制", "粘贴", "切换", "搜索",
	"提交", "删除", "移动", "拖动", "滚动", "截图", "核对", "记录", "复制", "导出", "导入", "整理"
];
const CONNECTORS = ["再", "然后", "接着", "之后", "同时"];
const TIERS = new Set(["simple", "standard", "complex"]);

/**
 * @param {string} goal
 * @param {{hint?: string, estSteps?: number}} [options]
 * @returns {{tier: string, reason: string, matched: string[], estSteps: number, profile: object}}
 */
export function classifyTask(goal, options = {}) {
	const text = String(goal ?? "").trim();
	const hint = typeof options.hint === "string" ? options.hint.trim() : "";
	if (TIERS.has(hint)) {
		return { tier: hint, reason: "explicit hint", matched: [], estSteps: Number(options.estSteps ?? 0), profile: { ...PROFILES[hint] } };
	}
	const matched = [];
	let score = 0;
	for (const word of COMPLEX_SIGNALS) {
		if (text.includes(word)) {
			matched.push(word);
			score += 2;
		}
	}
	for (const word of SIMPLE_SIGNALS) {
		if (text.includes(word)) {
			matched.push(word);
			score -= 1;
		}
	}
	const lower = text.toLowerCase();
	const apps = [...new Set(APP_HINTS.filter((word) => lower.includes(word)))];
	if (apps.length >= 2) {
		matched.push(`apps:${String(apps.length)}`);
		score += 4;
	}
	const actions = [...new Set(ACTION_VERBS.filter((word) => text.includes(word)))];
	if (actions.length >= 3) {
		matched.push(`actions:${String(actions.length)}`);
		score += 2;
	}
	const connectors = CONNECTORS.reduce((count, word) => count + text.split(word).length - 1, 0);
	if (connectors >= 2) {
		matched.push(`connectors:${String(connectors)}`);
		score += 2;
	}
	const estSteps = Number.isFinite(options.estSteps) ? Math.max(0, Number(options.estSteps)) : 0;
	if (estSteps >= 12) score += 3;
	else if (estSteps >= 6) score += 1;
	if (text.length >= 60) score += 1;
	if (text.length >= 140) score += 1;
	const tier = score >= 4 ? "complex" : score <= 0 ? "simple" : "standard";
	const reason =
		tier === "complex"
			? `score ${score}（含流程/跨应用等信号或步骤估计较高）`
			: tier === "simple"
				? `score ${score}（短任务/单词动作）`
				: `score ${score}（常规多步）`;
	const result = { tier, reason, matched: [...new Set(matched)], estSteps, profile: { ...PROFILES[tier] } };
	// 0.70.0：分层结果直接给出计划模板建议，复杂任务不用从零编排
	result.suggestedTemplate = suggestTemplate(result);
	return result;
}
