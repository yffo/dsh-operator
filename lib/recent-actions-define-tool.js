// 最近动作记录 + GUI 总开关（0.64.2 / 0.69.0 / 0.79.0）
//
// 0.64.0 的教训：不要替换宿主的 registry，只包装 operator 自己的 defineTool。
// 0.69.0 再加一道「GUI 总开关」：配置 `guiTools: false` 时，所有会碰键鼠/窗口/
// 浏览器的工具在执行前直接拒绝，技能/计划/交接/失败样本照常可用。
// 0.79.0 顺手把成功的 GUI 动作记进技能候选（仅内存），供 skill_suggest 提草案。

import { recordRecentAction } from "./recent-actions.js";
import { recordCandidate, sessionKeyOf } from "./skill-candidates.js";
import { isGuiToolName } from "./gui-tool-names.js";

export { isGuiToolName };

let guiToolsEnabled = true;

/** 设置 GUI 工具开关（插件 apply 时按配置调用）。 */
export function setGuiToolsEnabled(value) {
	guiToolsEnabled = value !== false;
}

/** 当前是否允许 GUI 工具。 */
export function guiToolsAllowed() {
	return guiToolsEnabled;
}

/**
 * 给 operator 自己的 defineTool 加上「最近动作」记录与 GUI 开关。
 * 只替换 `execute`，其余字段（name/parameters/output…）原样透传；
 * 包装失败时退回原始定义，不影响工具注册。
 * @param {Function} rawDefineTool @deepseek-ai/dsh-tools 的 defineTool
 * @returns {Function} 带记录与开关能力的 defineTool
 */
export function instrumentDefineTool(rawDefineTool) {
	return (definition) => {
		try {
			if (definition !== null && typeof definition === "object" && typeof definition.execute === "function") {
				const name = String(definition.name ?? "tool");
				const execute = definition.execute;
				return rawDefineTool({
					...definition,
					execute: async (...callArgs) => {
						if (guiToolsEnabled === false && isGuiToolName(name)) {
							throw new Error(`guiTools=false：GUI 工具「${name}」已被配置关闭（只读模式）；要操作桌面请把配置里的 guiTools 打开并重启`);
						}
						try {
							const value = await execute(...callArgs);
							// 0.82.0：很多工具用返回值表达失败（不抛错），不能再一律记成功
							const succeeded = !(value !== null && typeof value === "object"
								&& (value.ok === false || value.pressed === false || value.satisfied === false));
							recordRecentAction(name, succeeded, succeeded ? undefined : String(value?.error ?? value?.observed ?? ""));
							// 0.79.0：成功的 GUI 动作进技能候选；0.82.0：回放不喂候选（否则自己吃自己）
							if (succeeded && callArgs[1]?.replay !== true) {
								try {
									recordCandidate(name, callArgs[0], sessionKeyOf(callArgs[1]));
								} catch {
									// 候选记录失败不影响主流程
								}
							}
							return value;
						} catch (error) {
							recordRecentAction(name, false, String(error?.message ?? error));
							throw error;
						}
					}
				});
			}
		} catch {
			// 包装失败就按原样定义。
		}
		return rawDefineTool(definition);
	};
}
