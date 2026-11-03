// 操作约定注入（0.88.0）
//
// 背景：2026-11-03 杨总贴图指出——插件在「想开访达」时先点了前台 DSH 的「文件」菜单，
// 才发现点错 App；然后每操作一次就新建一个访达窗口，窗口越堆越多。
// 这两件事都是**模型选择路径**的问题，光靠工具校验不够，还要把约定摆到它眼前。
//
// 这一段很短，只在启动时注册一次，不占多少 token。

/** 系统提示里的节名（排在手交接之后）。 */
export const CONVENTIONS_SECTION_NAME = "tool:operator-conventions";
/** 节的排序值。 */
export const CONVENTIONS_SECTION_ORDER = 1750;

const RULES = [
	"菜单栏属于**前台 App**：用 ax_menu 前先 open_app 目标应用并用 verify_state {kind:\"frontmost_app\"} 确认；ax_menu 传 app:\"应用名\" 会在前台不匹配时直接拒绝。",
	"**复用窗口，不要新建**：要看/操作某个文件夹用 open_in_finder（激活已有窗口）；只有明确要求「新建窗口」时才走 文件/新建访达窗口。同一个目标反复新建会让窗口越堆越多。",
	"优先语义操作：原生控件用 ax_press / ax_set_value（背景投递、不抢焦点），坐标 click 是兜底；网页内容优先 browser_* 通道。",
	"删除/支付/退出类动作必须带 confirm:true，且只在用户明确同意后传。",
	"做完先自查：目标窗口在最上层吗？动作回包里的 app/path 对不对？不对就重新观察，不要连续重试同一个动作。"
];

/**
 * 把操作约定注入系统提示。
 * @param {object} ctx 插件上下文（需要 ctx.systemPrompt.section）
 * @returns {{ injected: boolean, reason?: string }}
 */
export function registerOperatingConventions(ctx) {
	const prompt = ctx?.systemPrompt;
	if (prompt === undefined || prompt === null || typeof prompt.section !== "function") {
		return { injected: false, reason: "no-system-prompt" };
	}
	try {
		prompt.section({
			name: CONVENTIONS_SECTION_NAME,
			order: CONVENTIONS_SECTION_ORDER,
			text: () => `## 桌面操作约定\n${RULES.map((rule) => `- ${rule}`).join("\n")}`
		});
		return { injected: true };
	} catch (error) {
		return { injected: false, reason: error instanceof Error ? error.message : String(error) };
	}
}
