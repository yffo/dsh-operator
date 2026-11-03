// 技能预检（0.67.0）
//
// 技能存的是「工具名 + 参数」。工具名会随插件版本变化（改名、下线、条件注册），
// 等到回放第 3 步才报 unsupported tool，既浪费前面的动作，也说不清到底缺什么。
// 这里在**执行任何一步之前**做一次静态预检。

/**
 * 检查技能引用的工具是否都还在。
 * @param {Array<{tool: string, args?: object}>} steps
 * @param {Iterable<string>} availableTools 当前可用工具名集合
 * @returns {{ ok: boolean, problems: Array<{ index: number, tool: string, reason: string }> }}
 */
export function preflightSkill(steps, availableTools) {
	const available = new Set(availableTools);
	const problems = [];
	const list = Array.isArray(steps) ? steps : [];
	list.forEach((step, index) => {
		const tool = typeof step?.tool === "string" ? step.tool : "";
		if (tool === "") {
			problems.push({ index, tool, reason: "缺少工具名" });
			return;
		}
		if (available.has(tool) === false) {
			problems.push({ index, tool, reason: "当前环境没有这个工具（可能改名、下线或被配置关闭）" });
		}
	});
	return { ok: problems.length === 0, problems };
}

/** 把预检结果拼成一句可操作的话。 */
export function describePreflight(problems) {
	if (!Array.isArray(problems) || problems.length === 0) return "";
	const parts = problems.map((item) => `第 ${item.index + 1} 步「${item.tool || "(空)"}」：${item.reason}`);
	return `技能无法回放：${parts.join("；")}。用 skill_show 查看后更新技能，或删掉它重存。`;
}
