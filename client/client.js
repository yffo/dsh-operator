/**
 * dsh-operator 客户端视图：一行状态。
 *
 * 决策（2026-11-02，杨总）：toolview 不再做活动卡片——只留「DSH 正在操作电脑」一行，
 * 避免步骤/缩略图/进度/日志这些重表达带来维护与 token 成本。需要细节时展开「调用详情」。
 *
 * 约束（test/client-bundle.test.mjs 盯着）：
 * - 经典脚本、零构建，只 require("react")；
 * - 不用 hooks（宿主可能直接当普通函数调用）；
 * - 每个 operator 工具一个 keyed 视图。
 */
window.__ModuleLoader__.load({
	id: "dsh-operator",
	factory(require) {
		const React = require("react");
		const h = React.createElement;

		/** 行标签：与 test/client-bundle.test.mjs 的 ROW_TOOLS 保持一致。 */
		const ROWS = {
			task_profile: "task profile",
			plan_create: "plan create",
			plan_update: "plan update",
			plan_run: "plan run",
			plan_list: "plan list",
			plan_delete: "plan delete",
			skill_save: "skill save",
			skill_run: "skill run",
			skill_list: "skill list",
			operator_status: "operator status",
			failure_list: "failures",
			ax_batch: "ax batch",
			browser_dom_probe: "browser probe",
			browser_dom_snapshot: "browser snapshot",
			browser_dom_click: "dom click",
			browser_dom_fill: "dom fill",
			cu_observe: "observe",
			cu_act: "act"
		};

		const KEYS = Object.keys(ROWS);
		const STYLE_ID = "dsh-operator-toolview-css";
		const CSS = [
			".dop-row{display:flex;align-items:center;gap:8px;padding:4px 2px;font-size:0.94em;line-height:1.5;color:inherit;flex-wrap:wrap}",
			".dop-row .dop-dot{flex:none;width:7px;height:7px;border-radius:50%;background:#94a3b8}",
			".dop-row[data-state=\"running\"] .dop-dot{background:#d97706;animation:dopBreath 1.8s ease-in-out infinite}",
			".dop-row[data-state=\"ok\"] .dop-dot{background:#16a34a}",
			".dop-row[data-state=\"error\"] .dop-dot{background:#dc2626},.dop-row[data-state=\"blocked\"] .dop-dot{background:#d97706}",
			".dop-row .dop-text{font-weight:520}",
			".dop-row .dop-tool{color:color-mix(in srgb,currentColor 55%,transparent);font-weight:400}",
			".dop-row .dop-state{color:color-mix(in srgb,currentColor 55%,transparent);font-weight:400}",
			"@keyframes dopBreath{0%,100%{opacity:1}50%{opacity:.35}}",
			"@media (prefers-reduced-motion: reduce){.dop-row[data-state=\"running\"] .dop-dot{animation:none}}"
		].join("\n");

		function ensureStyle() {
			if (typeof document === "undefined") return;
			const existing = document.getElementById(STYLE_ID);
			if (existing !== null) {
				// 热更新后同一 id 的样式表还在，内容可能是旧的——对不上就换掉
				if (existing.textContent !== CSS) existing.textContent = CSS;
				return;
			}
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			(document.head || document.body).appendChild(style);
		}

		/** 结果文本：只要 text 块；没有就回退到 error 描述。 */
		function resultText(block) {
			if (block === null || typeof block !== "object") return null;
			const parts = [];
			if (Array.isArray(block.content)) {
				for (const item of block.content) {
					if (item && item.type === "text" && typeof item.text === "string") parts.push(item.text);
				}
			}
			if (parts.length > 0) return parts.join("\n").trim();
			const error = block.error;
			if (error && typeof error === "object") {
				return typeof error.message === "string" ? error.message : String(error.code ?? "");
			}
			return null;
		}

		function stripToolPrefix(text) {
			if (typeof text !== "string") return text;
			return text
				.replace(/^dsh[-_ ]?operator\s*[:：]\s*/i, "")
				.replace(/^operator\s*[:：]\s*/i, "")
				.trim();
		}

		function stateOf(block) {
			if (block === null || typeof block !== "object") return "running";
			if (!("kind" in block)) return "running";
			if (block.error && typeof block.error === "object" && block.error.code === "interrupted") return "stopped";
			return block.isError === true ? "error" : "ok";
		}

		function stateText(state) {
			if (state === "running") return "";
			if (state === "ok") return "已完成";
			if (state === "error") return "失败";
			return "已中断";
		}

		function durationText(block) {
			if (block === null || typeof block !== "object") return "";
			const start = typeof block.callTime === "number" ? block.callTime : null;
			const end = typeof block.time === "number" ? block.time : null;
			if (start === null || end === null) return "";
			const ms = Math.max(0, end - start);
			if (ms < 1000) return "";
			return `${(ms / 1000).toFixed(1)}s`;
		}

		function details(props, block) {
			const argsRaw = (block && (block.call?.argsRaw ?? block.argsRaw)) || "";
			const output = resultText(block);
			if (argsRaw === "" && output === null) return null;
			return h(
				"details",
				{ className: "dop-details" },
				h("summary", null, "调用详情"),
				argsRaw === "" ? null : h("pre", { className: "dop-pre" }, String(argsRaw).slice(0, 4000)),
				output === null ? null : h("pre", { className: "dop-pre" }, output.slice(0, 4000))
			);
		}

		/** 非 GUI 工具（计划/技能/状态）的中文名——它们不该说「正在操作电脑」。 */
		const OPERATOR_LABELS = {
			task_profile: "任务评估",
			plan_create: "新建计划",
			plan_update: "更新计划",
			plan_run: "执行计划",
			plan_list: "查看计划",
			plan_delete: "删除计划",
			skill_save: "保存技能",
			skill_run: "运行技能",
			skill_list: "技能列表",
			operator_status: "插件状态",
			failure_list: "失败记录"
		};

		function OperatorLine(props) {
			try {
				ensureStyle();
				const block = props && props.block;
				const tool = String((props && props.toolName) || (block && block.toolName) || "operator");
				const state = stateOf(block);
				// GUI 工具说「正在操作电脑」；计划/技能/状态类工具只说「dsh-operator」——
				// 否则 plan_create 这种也会被写成「DSH 正在操作电脑」（2026-11-03 发现的内容错误）。
				const gui = isGuiToolName(tool);
				const label = gui
					? Object.prototype.hasOwnProperty.call(TOOL_LABELS, tool) ? TOOL_LABELS[tool] : (ROWS[tool] ?? tool)
					: (OPERATOR_LABELS[tool] ?? ROWS[tool] ?? tool);
				const lead = gui ? "DSH 正在操作电脑" : "dsh-operator";
				const target = gui ? targetOf(tool, String((block && (block.call?.argsRaw ?? block.argsRaw)) || "")) : "";
				const elapsed = durationText(block);
				const failureReason = state === "error" ? (resultText(block) || (block && block.error && block.error.message) || "") : "";
				// 0.117.2：被守卫拦下不是「失败」——工具行也说「已拦截」，否则模型会当成故障反复重试。
				const guarded = state === "error" && isGuardedResult(failureReason);
				const stateLabel = guarded ? "已拦截" : stateText(state);
				return h(
					"div",
					{ className: "dop-row", "data-tool": tool, "data-state": guarded ? "blocked" : state, title: failureReason === "" ? undefined : String(failureReason).slice(0, 300) },
					h("span", { className: "dop-dot", "aria-hidden": "true" }),
					h("span", { className: "dop-text" }, lead),
					h("span", { className: "dop-tool" }, label),
					target === "" ? null : h("span", { className: "dop-target" }, target),
					stateLabel === "" ? null : h("span", { className: "dop-state" }, elapsed === "" ? stateLabel : `${stateLabel} ${elapsed}`),
					details(props, block)
				);
			} catch (error) {
				const message = error && error.message ? String(error.message) : String(error);
				const tool = props && typeof props.toolName === "string" ? props.toolName : "operator";
				return h(
					"div",
					{ "data-tool": tool, "data-state": "error", style: { padding: "4px 6px", fontSize: "0.92em", opacity: 0.8 } },
					"dsh-operator · ",
					message.slice(0, 160)
				);
			}
		}

		/* ---------- 0.104.0：执行状态改用会话投影（宿主的 operatorExecution 单元） ----------
		 * 之前这条状态条自己翻 binding.eventSource（非公开契约）配对 tool/call+tool/result，
		 * 只能得到「有工具在跑」，拿不到执行状态机（在等确认 / 这一轮结束）。
		 * 现在优先读宿主投影；投影缺席（旧宿主、还没重启）时原样回退到事件推导。
		 */
		const PROJECTION_KEY = "operatorExecution";
		/** 与宿主 lib/execution-projection.js 的 PROJECTION_IDLE_MS 一致：空闲这么久就收起。 */
		const PROJECTION_IDLE_MS = 90 * 1000;

		/**
		 * 会话投影的按 key 指纹（宿主 projection-store 的 faceOf：存在性探测，拿不到返回 undefined）。
		 * binding.session.projections 不是 slot 化 API，但属于会话控制器的公开面（内置 ui-goal 同用法）。
		 */
		function projectionFace(binding) {
			try {
				const session = binding === null || binding === undefined ? undefined : binding.session;
				const projections = session === null || session === undefined ? undefined : session.projections;
				if (projections === undefined || projections === null || typeof projections.faceOf !== "function") return undefined;
				const face = projections.faceOf(PROJECTION_KEY);
				if (face === undefined || face === null || typeof face.getSnapshot !== "function") return undefined;
				return face;
			} catch {
				return undefined;
			}
		}

		/** 事件窗口里最后一条 tool/call 与其配对的 tool/result。 */
		/**
		 * 从参数里挑一个「人看得懂的目标」（0.97.0）。
		 * 原则：宁可显示少一点，也不要显示一坨 JSON。
		 */
		function targetOf(toolName, argsRaw) {
			let args;
			try {
				args = JSON.parse(argsRaw);
			} catch {
				return "";
			}
			if (args === null || typeof args !== "object") return "";
			const pick = (...keys) => {
				for (const key of keys) {
					const value = args[key];
					if (typeof value === "string" && value !== "") return value;
				}
				return "";
			};
			// 按工具类型挑最能说明「在动哪里」的字段
			if (toolName === "ax_menu") return pick("path");
			if (toolName === "ax_press" || toolName === "ax_set_value") return pick("expect_title", "expectTitle") || (Number.isInteger(args.index) ? `#${args.index}` : "");
			if (toolName === "open_app" || toolName === "cua_launch") return pick("name", "bundle_id");
			if (toolName === "open_in_finder" || toolName === "open_in_browser") return pick("path", "url");
			if (toolName === "window_move") return pick("layout", "window_title");
			if (toolName === "hotkey") return Array.isArray(args.keys) ? args.keys.join("+") : "";
			if (toolName.startsWith("browser_")) return pick("url", "selector", "text", "ref");
			if (toolName === "input_text" || toolName === "browser_dom_fill") return pick("text", "value", "selector");
			if (Array.isArray(args.position)) return `(${args.position[0]},${args.position[1]})`;
			return pick("text", "name", "path", "url", "selector");
		}

		/** 同一轮里第几次工具调用（0.97.0）；拿不到 turn 就退化成本次事件窗口内的序号。 */
		function stepOf(list, index, turn) {
			let count = 0;
			let ordinal = 0;
			for (let i = 0; i <= index; i += 1) {
				const event = list[i] && list[i].event;
				if (!event || event.type !== "tool/call") continue;
				const data = event.data || {};
				if (turn !== undefined && data.turn !== undefined && data.turn !== turn) continue;
				count += 1;
				if (i === index) ordinal = count;
			}
			return ordinal === 0 ? count : ordinal;
		}

		function latestCall(entries) {
			const list = Array.isArray(entries) ? entries : [];
			for (let i = list.length - 1; i >= 0; i -= 1) {
				const event = list[i] && list[i].event;
				if (!event || event.type !== "tool/call") continue;
				const data = event.data || {};
				let result = null;
				for (let j = i + 1; j < list.length; j += 1) {
					const later = list[j] && list[j].event;
					if (!later || later.type !== "tool/result") continue;
					const source = later.data && later.data.message && later.data.message.source;
					if (source && source.callId === data.callId) { result = later; break; }
				}
				const argsRaw = typeof data.arguments === "string" ? data.arguments : "";
				const toolName = String(data.name);
				return {
					callId: String(data.callId),
					toolName,
					args: argsRaw,
					target: targetOf(toolName, argsRaw),
					step: stepOf(list, i, data.turn),
					startedAt: event.time,
					finishedAt: result === null ? null : result.time,
					failed: result !== null && result.data.message.isError === true
				};
			}
			return null;
		}

		/* ---------- 0.105.0：侧栏活动面板（普通用户能看懂的「正在操作」） ---------- */

		/**
		 * 是否 GUI 工具（与宿主 lib/gui-tool-names.js 同规则；客户端经典脚本不能 import，
		 * 所以这里复制一份。面板只列「动过电脑」的动作，不列 bash 这类后台命令）。
		 */
		const GUI_EXACT = new Set([
			"click", "input_text", "scroll", "hotkey", "wait", "long_wait", "screenshot", "long_press", "drag",
			"open_in_browser", "open_in_finder", "list_apps", "open_app", "ocr", "screenshot_window",
			"list_windows", "verify_state", "zoom_region", "window_move",
			"cua_act", "cua_observe", "cua_windows", "cua_launch"
		]);
		const GUI_PREFIX = /^(ax_|cua_|cu_|browser_|clipboard_|screenshot_|open_|list_|verify_|zoom_|window_)/;
		function isGuiToolName(name) {
			const tool = String(name ?? "");
			if (tool === "") return false;
			return GUI_EXACT.has(tool) || GUI_PREFIX.test(tool);
		}

		/**
		 * 被安全守卫拦下的结果（0.117.2）：这不是执行失败，重试也照样被拦，
		 * 只有传 confirm（用户确认）才可能通过。卡片/工具行要把它和真失败分开说。
		 */
		function isGuardedResult(text) {
			return /is guarded|guard_rejected|guarded\./i.test(String(text ?? ""));
		}

		/** 事件窗口里最新一个 turn/start 的回合号（判断「本轮有没有做过电脑操作」）。 */
		function latestTurnNumber(entries) {
			const list = Array.isArray(entries) ? entries : [];
			for (let i = list.length - 1; i >= 0; i -= 1) {
				const event = list[i] && list[i].event;
				if (!event || event.type !== "turn/start") continue;
				const turn = event.data ? event.data.turn : undefined;
				if (Number.isFinite(turn)) return Number(turn);
			}
			return null;
		}

		/** 最近一次还没被处理的审批请求（确认门要显示真实原因）。 */
		function latestApproval(entries) {
			const list = Array.isArray(entries) ? entries : [];
			for (let i = list.length - 1; i >= 0; i -= 1) {
				const event = list[i] && list[i].event;
				if (!event || event.type !== "approval/asked") continue;
				const id = event.data ? event.data.id : undefined;
				let decided = false;
				for (let j = i + 1; j < list.length; j += 1) {
					const later = list[j] && list[j].event;
					if (later && later.type === "approval/decided" && later.data && later.data.id === id) {
						decided = true;
						break;
					}
				}
				if (decided) return null;
				return {
					id: String(id ?? ""),
					toolName: String(event.data && event.data.toolName ? event.data.toolName : ""),
					reason: String(event.data && event.data.reason ? event.data.reason : "")
				};
			}
			return null;
		}

		/** 最近 N 次调用（面板的步骤列表用；新的在前，只留 GUI 动作）。 */
		function recentCalls(entries, limit) {
			const list = Array.isArray(entries) ? entries : [];
			const out = [];
			for (let i = list.length - 1; i >= 0 && out.length < limit; i -= 1) {
				const event = list[i] && list[i].event;
				if (!event || event.type !== "tool/call") continue;
				const data = event.data || {};
				let result = null;
				for (let j = i + 1; j < list.length; j += 1) {
					const later = list[j] && list[j].event;
					if (!later || later.type !== "tool/result") continue;
					const source = later.data && later.data.message && later.data.message.source;
					if (source && source.callId === data.callId) { result = later; break; }
				}
				if (isGuiToolName(String(data.name)) === false) continue;
				const argsRaw = typeof data.arguments === "string" ? data.arguments : "";
				let summary = "";
				if (result !== null) {
					const content = result.data && result.data.message ? result.data.message.content : undefined;
					if (Array.isArray(content)) {
						summary = content.filter((item) => item && item.type === "text" && typeof item.text === "string").map((item) => item.text).join(" ").replace(/\s+/g, " ").trim().slice(0, 90);
					}
				}
				out.push({
					callId: String(data.callId),
					toolName: String(data.name),
					target: targetOf(String(data.name), argsRaw),
					turn: Number.isFinite(data.turn) ? Number(data.turn) : -1,
					startedAt: typeof event.time === "number" ? event.time : 0,
					finishedAt: result !== null && typeof result.time === "number" ? result.time : null,
					failed: result !== null && result.data.message.isError === true,
					summary
				});
			}
			return out;
		}

		/** 工具名 → 普通用户看得懂的动词（面板/状态条共用）。 */
		const TOOL_LABELS = {
			click: "点击屏幕",
			long_press: "长按",
			drag: "拖拽",
			input_text: "输入文字",
			scroll: "滚动",
			hotkey: "按快捷键",
			wait: "等画面稳定",
			long_wait: "等待",
			screenshot: "截图",
			screenshot_window: "截取窗口",
			ocr: "识别文字",
			open_app: "打开应用",
			open_in_finder: "打开访达",
			open_in_browser: "打开网页",
			list_apps: "查看应用列表",
			list_windows: "查看窗口",
			window_move: "移动窗口",
			zoom_region: "放大查看",
			verify_state: "校验界面状态",
			ax_press: "按控件",
			ax_menu: "点菜单",
			ax_scroll: "滚动控件",
			ax_set_value: "填表单",
			ax_batch: "批量操作",
			cua_observe: "观察桌面",
			cua_act: "操作桌面",
			cua_windows: "查看窗口",
			cua_launch: "启动应用",
			cu_observe: "观察桌面",
			cu_act: "操作桌面",
			browser_dom_snapshot: "读取网页",
			browser_dom_click: "点击网页",
			browser_dom_fill: "填写网页",
			browser_dom_probe: "检查网页通道",
			browser_state: "读取网页状态",
			browser_prepare: "绑定浏览器",
			browser_open: "打开网页",
			browser_click: "点击网页元素",
			browser_type: "网页输入",
			browser_pointer: "网页指针操作",
			browser_select: "选择下拉项",
			browser_wait: "等网页就绪",
			browser_console: "读网页控制台",
			browser_network: "读网络请求",
			browser_key: "网页按键",
			browser_dialog: "处理网页弹窗",
			browser_download: "下载网页文件",
			browser_set_input_files: "上传文件",
			browser_read: "读取网页文本",
			browser_launch: "启动浏览器",
			browser_close: "关闭浏览器",
			browser_eval: "页面求值",
			browser_selector: "查页面元素",
			browser_screenshot: "网页截图",
			bash: "执行命令",
			write: "写文件",
			edit: "改文件",
			read: "读文件"
		};

		/** 每步的人话说明（第二行；比贴原始输出有用，也不泄露无关内容）。 */
		const TOOL_HINTS = {
			click: "在画面上点一下",
			long_press: "按住鼠标一小会儿",
			drag: "把东西拖到目标位置",
			input_text: "往当前输入框里打字",
			scroll: "滚动页面",
			hotkey: "发送一组快捷键",
			wait: "等画面稳定再继续",
			long_wait: "等一会儿再继续",
			screenshot: "截一张当前画面",
			screenshot_window: "截一个窗口",
			ocr: "识别画面里的文字",
			open_app: "打开一个应用",
			open_in_finder: "打开访达",
			open_in_browser: "打开网页",
			list_apps: "看看有哪些应用",
			list_windows: "看看当前有哪些窗口",
			window_move: "调整窗口位置和大小",
			zoom_region: "放大看某个区域",
			verify_state: "确认界面变成了预期状态",
			ax_press: "按下一个界面控件",
			ax_menu: "点菜单项",
			ax_scroll: "滚动界面区域",
			ax_set_value: "填表单",
			ax_batch: "按顺序做一组操作",
			cua_observe: "读取屏幕上的界面结构",
			cua_act: "在桌面执行一步操作",
			cua_windows: "查看窗口列表",
			cua_launch: "启动应用",
			cu_observe: "读取屏幕上的界面结构",
			cu_act: "在桌面执行一步操作",
			browser_dom_snapshot: "读取网页结构",
			browser_dom_click: "在网页上点击",
			browser_dom_fill: "填写网页表单",
			browser_dom_probe: "检查网页自动化通道"
		};

		/** 人话工具名。 */
		/** 目标摘要：URL / 参数太长时截断，避免一整行只剩它（悬停 title 给全文）。 */
		function targetLabel(target) {
			const text = String(target ?? "");
			return text.length > 60 ? `${text.slice(0, 60)}…` : text;
		}

		function toolLabel(name) {
			if (typeof name !== "string" || name === "") return "操作";
			if (Object.prototype.hasOwnProperty.call(TOOL_LABELS, name)) return TOOL_LABELS[name];
			if (name.startsWith("browser_")) return "浏览器操作";
			if (name.startsWith("ax_")) return "界面操作";
			if (name.startsWith("cua_") || name.startsWith("cu_")) return "桌面操作";
			return name;
		}

		/** 前台/后台：AX、cua-driver、浏览器通道不抢焦点；HID 动作会抢前台。 */
		function toolMode(name) {
			const tool = String(name ?? "");
			if (tool === "") return "";
			if (tool.startsWith("cua_") || tool.startsWith("cu_") || tool.startsWith("ax_") || tool.startsWith("browser_") || tool === "ocr" || tool === "verify_state" || tool === "list_windows" || tool === "list_apps") return "后台";
			return "前台";
		}

		/** 秒数（一位小数）；时间戳缺失或离谱时宁可不显示。 */
		function secondsOf(call, now) {
			if (call === null || call === undefined) return "";
			const end = call.finishedAt === null || call.finishedAt === undefined ? now : call.finishedAt;
			const ms = end - call.startedAt;
			if (!(ms > 0) || ms > 24 * 60 * 60 * 1000) return "";
			return `${(ms / 1000).toFixed(1)}s`;
		}

		function sameStatus(a, b) {
			if (a.sessionId !== b.sessionId) return false;
			if (a.running !== b.running) return false;
			// 投影值由宿主 projection-store 缓存引用：没变化就是同一个对象。
			if (a.view !== b.view) return false;
			// 步骤列表：每 read 都是新数组，按长度 + 最近一条的身份比较。
			const left = Array.isArray(a.calls) ? a.calls : [];
			const right = Array.isArray(b.calls) ? b.calls : [];
			if (left.length !== right.length) return false;
			if (left.length > 0 && (left[0].callId !== right[0].callId || left[0].finishedAt !== right[0].finishedAt)) return false;
			if ((a.turnNow ?? null) !== (b.turnNow ?? null)) return false;
			const approvalLeft = a.approval === undefined ? null : a.approval;
			const approvalRight = b.approval === undefined ? null : b.approval;
			if (approvalLeft === null || approvalRight === null) {
				if (approvalLeft !== approvalRight) return false;
			} else if (approvalLeft.id !== approvalRight.id) return false;
			if (a.call === b.call) return true;
			if (a.call === null || b.call === null) return false;
			return a.call.callId === b.call.callId && a.call.finishedAt === b.call.finishedAt && a.call.failed === b.call.failed;
		}

		/**
		 * 状态源：getSnapshot 必须引用稳定；订阅只在首个订阅者出现时建立。
		 * binding.eventSource 不是公开契约（内置 ui-conversation / session-inspector 也在用），
		 * 所以整条链路都要存在性探测，拿不到就降级为「不显示」。
		 */
		function createOperatorStatus(getSessions, resolveId) {
			const IDLE = Object.freeze({ sessionId: null, running: false, view: null, call: null, calls: [], approval: null, turnNow: null });
			const listeners = new Set();
			let snapshot = IDLE;
			let watchedId = null;
			let watchedBinding;
			let offEvents = null;
			let offView = null;
			let offList = null;

			const read = () => {
				try {
					const sessions = getSessions();
					if (sessions === undefined || sessions === null) return IDLE;
					const state = sessions.list.getSnapshot();
					const id = resolveId();
					const row = id === null || state.byId === undefined ? undefined : state.byId[id];
					const binding = id === null ? undefined : sessions.binding(id);
					// 0.104.0：优先读宿主投影；投影缺席返回 undefined → 回退到事件推导。
					const face = projectionFace(binding);
					const view = face === undefined ? undefined : face.getSnapshot();
					const source = binding === undefined ? undefined : binding.eventSource;
					const entries = source === undefined || typeof source.getSnapshot !== "function" ? [] : source.getSnapshot().entries;
					const projected = view !== undefined && view !== null;
					return {
						sessionId: id,
						running: row === undefined ? false : row.running === true,
						view: projected ? view : null,
						call: projected ? null : latestCall(entries),
						// 0.105.0：步骤列表；0.106.0：确认门原因；0.111.0：当前回合号
						calls: recentCalls(entries, 8),
						approval: latestApproval(entries),
						turnNow: latestTurnNumber(entries)
					};
				} catch {
					return IDLE;
				}
			};

			const publish = () => {
				const next = read();
				if (sameStatus(next, snapshot)) return;
				snapshot = next;
				for (const fn of [...listeners]) {
					try {
						fn();
					} catch (error) {
						console.error("dsh-operator: status listener failed", error);
					}
				}
			};

			const watch = () => {
				// ctx 可能在插件热替换后失效（HMR）：这里任何异常都不能蹦到 React 订阅链上。
				let sessions;
				try {
					sessions = getSessions();
				} catch {
					sessions = undefined;
				}
				if (sessions === undefined || sessions === null) return;
				const id = resolveId();
				const binding = id === null ? undefined : sessions.binding(id);
				if (id === watchedId && binding === watchedBinding) return;
				if (offEvents !== null) { offEvents(); offEvents = null; }
				if (offView !== null) { offView(); offView = null; }
				watchedId = id;
				watchedBinding = binding;
				const source = binding === undefined ? undefined : binding.eventSource;
				if (source !== undefined && typeof source.subscribe === "function") offEvents = source.subscribe(publish);
				const face = projectionFace(binding);
				if (face !== undefined && typeof face.subscribe === "function") offView = face.subscribe(publish);
			};

			return {
				getSnapshot() {
					const next = read();
					if (!sameStatus(next, snapshot)) snapshot = next;
					return snapshot;
				},
				subscribe(fn) {
					listeners.add(fn);
					if (listeners.size === 1) {
						let sessions;
						try {
							sessions = getSessions();
						} catch {
							sessions = undefined;
						}
						if (sessions !== undefined && sessions !== null && typeof sessions.list.subscribe === "function") {
							offList = sessions.list.subscribe(() => { watch(); publish(); });
						}
						try {
							watch();
						} catch (error) {
							console.error("dsh-operator: status watch failed", error);
						}
					}
					return () => {
						listeners.delete(fn);
						if (listeners.size === 0 && offList !== null) { offList(); offList = null; }
						if (listeners.size === 0 && offEvents !== null) { offEvents(); offEvents = null; }
						if (listeners.size === 0 && offView !== null) { offView(); offView = null; }
						if (listeners.size === 0) { watchedId = null; watchedBinding = undefined; }
					};
				}
			};
		}

		/* ---------- 0.107.0：输入框上方「正在操作」卡片（conversation.input.dock） ----------
		 * 落点是 DSH **原生**槽位（Todo / Goal / Queue 同一条），不依赖任何第三方插件。
		 * 视觉与 design/operator-dock-preview.html 对齐：暖色卡片、大圆角、分段进度、确认门、折叠。
		 * 诚实边界：没有缩略图（原生不给第三方图片加载器）、不写总步数分母（宿主不说）、
		 * 确认门只读（面板拿不到审批 RPC）——宁可不做，也不放占位图 / 假按钮。
		 */
		const DOCK_STYLE_ID = "dsh-operator-dock-css";
		const DOCK_CSS = [
			// 与输入框卡片同宽：照宿主 QueueDock 的公式（宽度扣掉左右 clearance 与 dock inset，再居中）。
			".dop-dock{box-sizing:border-box;width:calc(100% - 2 * var(--dsh-composer-side-clearance,16px) - 2 * var(--dsh-composer-dock-inset,8px));max-width:calc(var(--dsh-composer-card-max-width,952px) - 2 * var(--dsh-composer-dock-inset,8px));margin:4px auto 10px;border-radius:18px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 93%,#e8dcc6);box-shadow:0 1px 2px rgba(0,0,0,.04),0 20px 40px -32px rgba(0,0,0,.45);overflow:hidden;animation:dopDockIn .2s ease-out}",
			".dop-dock-head{display:flex;flex-wrap:nowrap;align-items:center;gap:9px;padding:12px 16px 8px;min-width:0}",
			".dop-dock-dot{flex:none;width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex-shrink:0}",
			".dop-dock[data-tone=\"running\"] .dop-dock-dot,.dop-dock[data-tone=\"waiting\"] .dop-dock-dot{background:var(--dsw-alias-state-warn-primary);animation:dopDockBreath 1.6s ease-in-out infinite}",
			".dop-dock[data-tone=\"ok\"] .dop-dock-dot{background:var(--dsw-alias-state-success-primary)}",
			".dop-dock[data-tone=\"error\"] .dop-dock-dot{background:var(--dsw-alias-state-error-primary)}",
			".dop-dock-title{font-size:15.5px;font-weight:650;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dop-dock-step{font-weight:400;color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dop-dock-elapsed{margin-left:auto;padding:2px 9px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums;flex-shrink:0}",
			".dop-dock-badge{padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}",
			".dop-dock-wrap{display:grid;grid-template-rows:1fr;transition:grid-template-rows .28s ease}",
			".dop-dock[data-collapsed=\"1\"] .dop-dock-wrap{grid-template-rows:0fr}",
			".dop-dock-wrap>div{min-height:0;overflow:hidden}",
			".dop-dock[data-tone=\"live\"] .dop-dock-dot{background:var(--dsw-alias-state-success-primary);animation:dopDockBreath 2.4s ease-in-out infinite}",

			".dop-dock-row[data-current=\"1\"] .dop-dock-icon[data-state=\"running\"]{animation:dopDockPulse 1.4s ease-in-out infinite}",
			".dop-dock-collapse,.dop-dock-close{width:30px;height:30px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:.7;transition:background .15s ease,opacity .15s ease;flex-shrink:0}",
			".dop-dock-collapse svg,.dop-dock-close svg{display:block}",
			".dop-dock-collapse:hover,.dop-dock-close:hover{background:var(--dsw-alias-bg-layer-2);opacity:1}",
			".dop-dock-folded{display:flex;align-items:center;justify-content:center;gap:6px;margin:2px 0;padding:5px 8px;border-radius:9px;border:1px dashed var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11.5px;cursor:pointer}",
			".dop-dock-folded:hover{background:var(--dsw-alias-bg-layer-2)}",
			".dop-dock-result{flex-basis:100%;margin-top:1px;font-size:11.5px;color:var(--dsw-alias-label-secondary);opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dop-dock-goal{padding:0 16px 8px;color:var(--dsw-alias-label-secondary);font-size:12.5px}",
			".dop-dock-steps{display:flex;flex-direction:column;gap:3px;padding:0 8px 8px;max-height:240px;overflow-y:auto}",
			".dop-dock-row{display:flex;align-items:center;gap:9px;padding:7px 10px;border-radius:11px;border:1px solid transparent;animation:dopDockRowIn .3s cubic-bezier(.2,.7,.3,1) both}",
			".dop-dock-row[data-fresh=\"1\"]{animation:dopDockFresh 1.2s ease-out both}",
			"@keyframes dopDockFresh{0%{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}100%{background:transparent}}",
			".dop-dock-row[data-current=\"1\"]{background:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-border-l2);box-shadow:0 1px 2px rgba(0,0,0,.04),0 10px 22px -20px rgba(0,0,0,.5)}",
			".dop-dock-icon{flex:none;width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}",
			".dop-dock-icon[data-state=\"ok\"]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 13%,transparent)}",
			".dop-dock-icon[data-state=\"running\"]{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 15%,transparent)}",
			".dop-dock-icon[data-state=\"error\"]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 13%,transparent)}",
			// 0.117.2：被守卫拦截 ≠ 失败——用 warn 色，别用错误红
			".dop-dock[data-tone=\"blocked\"] .dop-dock-dot{background:var(--dsw-alias-state-warn-primary)}",
			".dop-dock-icon[data-state=\"blocked\"]{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 15%,transparent)}",
			".dop-dock-body{flex:1;min-width:0;display:flex;align-items:baseline;gap:6px;overflow:hidden}",
			".dop-dock-name{font-weight:600;font-size:13.5px}",
			".dop-dock-target{flex:1;min-width:0;font-weight:400;font-size:12.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-left:0}",
			".dop-dock-meta{flex:none;font-size:11.5px;color:var(--dsw-alias-label-secondary);opacity:.8;font-variant-numeric:tabular-nums}",
			".dop-dock-details{flex-basis:100%;margin-top:2px}",
			".dop-dock-details summary{cursor:pointer;list-style:none;font-size:11.5px;color:var(--dsw-alias-label-secondary)}",
			".dop-dock-details summary::-webkit-details-marker{display:none}",
			".dop-dock-details summary::before{content:\"▸ \";display:inline-block;transition:transform .15s ease}",
			".dop-dock-details[open] summary::before{transform:rotate(90deg)}",
			".dop-dock-detail-body{flex-basis:100%;margin-top:5px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11.5px;word-break:break-all}",
			".dop-dock-gate{margin:0 14px 12px;padding:10px 12px;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);animation:dopDockRowIn .3s ease-out both}",
			".dop-dock-gate-title{font-weight:650;font-size:13px;color:var(--dsw-alias-state-error-primary)}",
			".dop-dock-gate-reason{margin-top:3px;font-size:12.5px}",
			".dop-dock-gate-note{margin-top:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}",
			".dop-dock-foot{display:flex;align-items:center;gap:10px;padding:8px 16px;border-top:1px solid var(--dsw-alias-border-l2)}",
			".dop-dock-foot-text{flex:1;min-width:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dop-dock-more{padding:2px 10px 0;font-size:11.5px;color:var(--dsw-alias-label-secondary);opacity:.8}",
			".dop-dock-chip{flex:none;padding:3px 11px;border-radius:9px;font-size:12px;font-weight:600;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}",
			".dop-dock[data-collapsed=\"1\"] .dop-dock-head{padding:10px 16px}",
			"@keyframes dopDockIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}",
			"@keyframes dopDockRowIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}",
			"@keyframes dopDockGrow{from{transform:scaleX(0)}to{transform:scaleX(1)}}",
			"@keyframes dopDockBreath{0%,100%{opacity:1}50%{opacity:.4}}",
			"@keyframes dopDockPulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,transparent)}50%{box-shadow:0 0 0 5px color-mix(in srgb,var(--dsw-alias-state-warn-primary) 0%,transparent)}}",
			"@media (prefers-reduced-motion: reduce){.dop-dock,.dop-dock-row,.dop-dock-seg,.dop-dock-dot{animation:none!important}}"
		].join("\n");

		function ensureDockStyle() {
			if (typeof document === "undefined") return;
			const existing = document.getElementById(DOCK_STYLE_ID);
			if (existing !== null) {
				if (existing.textContent !== DOCK_CSS) existing.textContent = DOCK_CSS;
				return;
			}
			const style = document.createElement("style");
			style.id = DOCK_STYLE_ID;
			style.textContent = DOCK_CSS;
			(document.head || document.body).appendChild(style);
		}

		/** 收起/展开箭头（内联 SVG，不依赖任何图标资源）。 */
		function chevronIcon(collapsed) {
			return h(
				"svg",
				{ width: 16, height: 16, viewBox: "0 0 24 24", "aria-hidden": "true", style: { transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform .18s ease" } },
				h("path", { d: "M6 9l6 6 6-6", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" })
			);
		}

		/** 关闭图标。 */
		function closeIcon() {
			return h(
				"svg",
				{ width: 15, height: 15, viewBox: "0 0 24 24", "aria-hidden": "true" },
				h("path", { d: "M6 6l12 12M18 6L6 18", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round" })
			);
		}

		/**
		 * 输入框上方的「正在操作」卡片。
		 * 只在真有操作时出现；运行中展开、结束折成一行、空闲再整张消失。
		 */
		// 0.121.5：关闭状态跟着会话走——切换会话/重新挂载后不复活，直到该会话真的开始新一轮操作。
		// 0.121.6：持久化到 localStorage，重启 App 后也保持关闭。
		const DISMISSED_STORAGE_KEY = "dsh-operator:dismissed-sessions";
		const dismissedSessions = (() => {
			try {
				if (typeof localStorage === "undefined") return new Set();
				const raw = localStorage.getItem(DISMISSED_STORAGE_KEY);
				if (raw === null) return new Set();
				const parsed = JSON.parse(raw);
				return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string" && id !== "") : []);
			} catch {
				return new Set();
			}
		})();
		const persistDismissedSessions = () => {
			try {
				if (typeof localStorage === "undefined") return;
				localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([...dismissedSessions]));
			} catch {
				// 存储不可用就只在内存里生效
			}
		};

		class OperatorDock extends React.Component {
			constructor(props) {
				super(props);
				this.source = props !== null && props !== undefined && typeof props.operatorStatusSource === "object" ? props.operatorStatusSource : null;
				const status = this.source === null || typeof this.source.getSnapshot !== "function" ? null : this.source.getSnapshot();
				// 挂载时已经是「已结束」就直接折叠（热更新/刷新后常见）
				const endedAtMount = status !== null && status.view !== null && status.view.state === "ended";
				this.state = { status, now: Date.now(), collapsed: endedAtMount, expanded: false, openCall: null, freshId: null };
				this.freshTimer = null;
				this.timer = null;
				this.wasActive = false;
				// 用户手动折叠的意图只在本次运行内有效；新一轮开始自动展开
				this.userCollapsed = false;
				// 点了关闭就一直藏着，直到下一次真的开始操作
				this.dismissed = false;
				this.lastState = status !== null && status.view !== null ? status.view.state : null;
				this.lastCallId = null;
			}

			componentDidUpdate() {
				// 0.121.4：正序列表，新步骤出现时自动滚到最新一行（不需要用户手动滚）。
				const el = this.stepsEl;
				if (el === undefined || el === null) return;
				const count = el.children.length;
				if (this.lastStepCount === undefined || count > this.lastStepCount) el.scrollTop = el.scrollHeight;
				this.lastStepCount = count;
			}

			componentDidMount() {
				if (this.source === null || typeof this.source.subscribe !== "function") return;
				this.unsubscribe = this.source.subscribe(() => this.sync());
				this.sync();
			}

			componentWillUnmount() {
				if (this.freshTimer !== null && typeof clearTimeout === "function") clearTimeout(this.freshTimer);
				if (typeof this.unsubscribe === "function") this.unsubscribe();
				this.clearTimer();
			}

			sync() {
				if (this.source === null || typeof this.source.getSnapshot !== "function") return;
				const status = this.source.getSnapshot();
				const view = status === null ? null : status.view;
				const state = view === null ? null : view.state;
				if (state === "working") this.wasActive = true;
				const sessionId = status === null ? null : status.sessionId;
				// 新一轮开始（出现进行中的动作/等确认）时取消「已关闭」
				if (state === "working" && view.callFinishedAt === 0) {
					this.dismissed = false;
					if (typeof sessionId === "string" && dismissedSessions.delete(sessionId) === true) persistDismissedSessions();
				}
				if (state === "waiting-person") {
					this.dismissed = false;
					if (typeof sessionId === "string" && dismissedSessions.delete(sessionId) === true) persistDismissedSessions();
				}
				// 0.121.5：该会话被关过 → 重新挂载（切会话回来）也保持关闭
				if (typeof sessionId === "string" && dismissedSessions.has(sessionId) === true) this.dismissed = true;
				// 新一轮（ended → working）时忘掉上一次的手动折叠
				if (this.lastState === "ended" && state !== "ended") this.userCollapsed = false;
				let collapsed = this.state.collapsed;
				// 只在「刚进入 ended」时自动收起；用户手动展开后不再强行折叠
				if (state === "ended" && this.lastState !== "ended") collapsed = true;
				else if (state === "working" || state === "waiting-person") collapsed = this.userCollapsed;
				this.lastState = state;
				// 新步骤进场时高亮 1.2 秒，让眼睛跟得上
				const latestId = status !== null && Array.isArray(status.calls) && status.calls.length > 0 ? status.calls[0].callId : null;
				if (latestId !== null && latestId !== this.lastCallId) {
					this.lastCallId = latestId;
					if (this.freshTimer !== null && typeof clearTimeout === "function") clearTimeout(this.freshTimer);
					this.freshTimer = typeof setTimeout === "function" ? setTimeout(() => this.setState({ freshId: null }), 1200) : null;
					this.setState({ status, collapsed, freshId: latestId }, () => this.tickTimer());
					return;
				}
				this.setState({ status, collapsed }, () => this.tickTimer());
			}

			tickTimer() {
				const view = this.state.status === null ? null : this.state.status.view;
				const active = view !== null && (view.state === "working" || view.state === "waiting-person");
				if (active && this.timer === null) {
					this.timer = setInterval(() => this.setState({ now: Date.now() }), 1000);
				} else if (!active) {
					this.clearTimer();
				}
			}

			clearTimer() {
				if (this.timer !== null) {
					clearInterval(this.timer);
					this.timer = null;
				}
			}

			toggle() {
				const next = !this.state.collapsed;
				this.userCollapsed = next;
				this.setState({ collapsed: next });
			}

			close() {
				this.dismissed = true;
				const sessionId = this.state.status === null ? null : this.state.status.sessionId;
				if (typeof sessionId === "string" && sessionId !== "") {
					dismissedSessions.add(sessionId);
					persistDismissedSessions();
				}
				if (typeof this.forceUpdate === "function") this.forceUpdate();
				else this.setState({});
			}

			render() {
				ensureDockStyle();
				const status = this.state.status;
				const now = this.state.now;
				const view = status === null ? null : status.view;
				if (view === null || view === undefined || view.state === "idle") return null;
				if (this.dismissed === true) return null;
				const waiting = view.state === "waiting-person";
				const working = view.state === "working";
				const ended = view.state === "ended";

				const calls = status !== null && Array.isArray(status.calls) ? status.calls : [];
				const pending = working && view.callFinishedAt === 0;
				const failed = view.failed === true && !pending;
				// 「本轮还在跑」和「正在执行一次动作」是两件事：前者用会话 running 判定，
				// 否则助手在思考时卡片会显示「已结束」（杨总反馈：明明任务还在执行）。
				// 只在本轮真的做过电脑操作时才算「执行中」；否则助手只是在本轮写代码/思考，
				// 卡片应该老实说「已结束」，不能挂着「正在执行」误导人（杨总 2026-11-03 反馈）。
				const runningTurn = status === null ? null : status.turnNow;
				const lastOpTurn = calls.length > 0 ? calls[0].turn : null;
				const live = status !== null && status.running === true && (runningTurn === null || lastOpTurn === null || runningTurn === lastOpTurn);
				// 0.117.2：被安全守卫拦下的那一步不是「操作失败」——重试也不会过，得先让用户确认。
				const blockedNow = failed && calls.length > 0 && calls[0].failed === true && isGuardedResult(calls[0].summary);
				const tone = waiting ? "waiting" : blockedNow ? "blocked" : failed ? "error" : pending ? "running" : live ? "live" : "ok";
				const headline = waiting ? "等你确认" : blockedNow ? "已拦截 · 需确认" : failed ? "操作失败" : pending ? "正在操作" : live ? "正在执行" : "已结束";
				const step = view.step > 0 ? view.step : calls.length;
				const current = calls.length > 0 ? calls[0] : null;
				const currentTool = waiting && view.approvalTool !== "" ? view.approvalTool : view.tool;
				const goalTarget = current !== null && typeof current.target === "string" && current.target !== "" ? current.target : "";
				const started = view.callStartedAt;
				const end = pending ? now : view.callFinishedAt > 0 ? view.callFinishedAt : view.updatedAt;
				const elapsed = started > 0 && end > started && end - started < 24 * 60 * 60 * 1000 ? (end - started) / 1000 : 0;
				const approvalReason = status !== null && status.approval !== null && status.approval !== undefined && typeof status.approval.reason === "string" ? status.approval.reason.replace(/^escalate sandbox to danger-full-access:\s*/i, "") : "";
				const collapsed = this.state.collapsed;

				const head = h(
					"div",
					{ className: "dop-dock-head" },
					h("span", { className: "dop-dock-dot", "aria-hidden": "true" }),
					h("span", { className: "dop-dock-title" }, headline),
					step > 0 && ended ? h("span", { className: "dop-dock-step" }, live ? ` · 已做 ${step} 步` : ` · 共 ${step} 步`) : step > 0 ? h("span", { className: "dop-dock-step" }, ` · 第 ${step} 步`) : null,
					collapsed && currentTool !== "" ? h("span", { className: "dop-dock-step" }, ` · ${toolLabel(currentTool)}`) : null,
					elapsed > 0.05 ? h("span", { className: "dop-dock-elapsed" }, `${elapsed.toFixed(1)}s`) : null,
					!ended && currentTool !== "" && toolMode(currentTool) === "后台" ? h("span", { className: "dop-dock-badge" }, "后台执行 · 不影响你") : null,
					h("button", { className: "dop-dock-collapse", type: "button", title: collapsed ? "展开" : "收起", onClick: () => this.toggle() }, chevronIcon(collapsed)),
					// 0.119.3：操作进行中不提供关闭按钮。关闭只是隐藏卡片、不影响宿主执行，
					// 但会让人看不到进度、容易错过确认；折叠仍然可用。这一轮结束了才允许关掉。
					ended ? h("button", { className: "dop-dock-close", type: "button", title: "关闭（下次操作再出现）", onClick: () => this.close() }, closeIcon()) : null
				);

				// 只列本回合的动作。回合号优先信事件（客户端立刻可用），
				// 宿主投影的 view.turn 作为对齐依据（旧宿主没有这个字段）。
				const latestTurn = calls.length > 0 ? calls[0].turn : -1;
				const currentTurn = typeof view.turn === "number" && view.turn >= 0 ? view.turn : latestTurn;
				const sameTurn = currentTurn >= 0 ? calls.filter((call) => call.turn === currentTurn) : calls;
				const all = sameTurn.slice().reverse(); // 正序：第 1 步在前
				const expanded = this.state.expanded === true;
				const LIMIT = 8;
				const folded = all.length > LIMIT && !expanded;
				const shown = folded ? all.slice(0, 2).concat(all.slice(-4)) : all;
				const hidden = folded ? all.length - shown.length : 0;
				const foldedNote = folded
					? h("div", { className: "dop-dock-folded", key: "folded", role: "button", tabIndex: 0, title: "展开全部步骤", onClick: () => this.setState({ expanded: true }) }, `⋯ 中间 ${String(all.length - shown.length)} 步已折叠 · 点击展开`)
					: null;
				const rows = shown.map((call) => {
					// 0.117.2：守卫拦截单独一个状态（warn 色 +「已拦截」），不混进「失败」
					const guardedRow = call.failed === true && isGuardedResult(call.summary);
					const rowState = call.failed === true ? (guardedRow ? "blocked" : "error") : call.finishedAt === null ? "running" : "ok";
					const isCurrent = view.callId === call.callId;
					const seconds = secondsOf(call, now);
					const stamp = (() => {
						if (!(call.startedAt > 0)) return "";
						if (ended) {
							try { return new Date(call.startedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }); } catch { return ""; }
						}
						const diff = now - call.startedAt;
						if (diff < 5000) return "刚刚";
						if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`;
						if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
						try { return new Date(call.startedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }); } catch { return ""; }
					})();
					// 正序显示：第 1 步在最上面；步号按本回合真实序号（用全集算，折叠时不串号）
					const baseStep = typeof view.turn === "number" && view.turn === currentTurn && view.step > 0 ? view.step : all.length;
					const number = Math.max(1, baseStep - (all.length - 1 - all.indexOf(call)));
					const meta = `${rowState === "running" ? "进行中" : rowState === "error" ? "失败" : rowState === "blocked" ? "已拦截" : "已完成"}${toolMode(call.toolName) === "" ? "" : ` · ${toolMode(call.toolName)}`}${seconds === "" ? "" : ` · ${seconds}`}${stamp === "" ? "" : ` · ${stamp}`}`;
					return h(
						"div",
						{ className: "dop-dock-row", key: call.callId, "data-current": isCurrent ? "1" : "0", "data-fresh": this.state.freshId === call.callId ? "1" : "0", role: "button", tabIndex: 0, "aria-expanded": this.state.openCall === call.callId ? "true" : "false", title: "点击（或按回车/空格）查看这一步的细节", onClick: () => this.setState((state) => ({ openCall: state.openCall === call.callId ? null : call.callId })), onKeyDown: (event) => { if (event && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); this.setState((state) => ({ openCall: state.openCall === call.callId ? null : call.callId })); } }, style: { flexWrap: "wrap", cursor: "pointer", animationDelay: `${Math.min(shown.indexOf(call), 3) * 40}ms` } },
						h("span", { className: "dop-dock-icon", "data-state": rowState, title: `第 ${number} 步`, "aria-label": `第 ${number} 步` }, String(number)),
						h(
							"div",
							{ className: "dop-dock-body" },
							h("span", { className: "dop-dock-name" }, toolLabel(call.toolName)),
							typeof call.target === "string" && call.target !== "" ? h("span", { className: "dop-dock-target", title: call.target }, targetLabel(call.target)) : null
						),
						h("span", { className: "dop-dock-meta" }, meta),
						(() => {
							// 失败行优先显示错误摘要；其余显示这件事的人话说明
							const failedRow = (rowState === "error" || rowState === "blocked") && typeof call.summary === "string" && call.summary !== "";
							const hint = rowState === "blocked"
								? `被安全守卫拦截 · 需要你确认后才能执行（${toolLabel(call.toolName)}）`
								: failedRow
									? call.summary
									: Object.prototype.hasOwnProperty.call(TOOL_HINTS, call.toolName) ? TOOL_HINTS[call.toolName] : "";
							if (hint === "") return null;
							return h("div", { className: "dop-dock-result", title: hint }, hint);
						})(),
						this.state.openCall === call.callId
							? h(
								"div",
								{ className: "dop-dock-detail-body" },
								`工具 ${call.toolName}${typeof call.target === "string" && call.target !== "" ? ` · 目标 ${targetLabel(call.target)}` : ""}`
							)
							: null
					);
				});

				const gate = waiting
					? h(
						"div",
						{ className: "dop-dock-gate" },
						h("div", { className: "dop-dock-gate-title" }, `需要确认：${toolLabel(currentTool)}`),
						approvalReason === "" ? null : h("div", { className: "dop-dock-gate-reason" }, approvalReason),
						h("div", { className: "dop-dock-gate-note" }, "确认门只在改设置 / 破坏性动作出现；请在对话输入框上方点「允许」或「拒绝」。")
					)
					: null;

				const moreText = hidden > 0 ? ` · 另有 ${hidden} 步更早动作` : "";
				const footText = waiting
					? `第 ${step} 步等你确认：在对话里点允许或拒绝`
					: ended
						? `共 ${step} 步 · 截图在对话里的工具卡上`
						: failed
							? blockedNow
								? `第 ${step} 步被安全守卫拦截 · 你确认后我才能执行（不需要重试）${moreText}`
								: `第 ${step} 步失败：可以重试，或让我接管${moreText}`
							: pending
								? `第 ${step} 步进行中${elapsed > 0.05 ? ` · ${elapsed.toFixed(1)}s` : ""}${moreText}`
								: live
									? `本轮已完成 ${step} 步 · 继续中${moreText}`
									: `第 ${step} 步已完成${moreText}`;

				const body = h(
					"div",
					{ className: "dop-dock-wrap", "data-open": collapsed ? "0" : "1" },
					h(
						"div",
						null,
						h("div", { className: "dop-dock-goal" }, currentTool === "" ? "目标：等待操作" : `目标：${toolLabel(currentTool)}${goalTarget === "" ? "" : ` · ${goalTarget}`}`),
						rows.length === 0 ? null : h("div", { className: "dop-dock-steps", ref: (el) => { this.stepsEl = el; } }, folded ? [rows[0], rows[1], foldedNote, ...rows.slice(2)].filter(Boolean) : rows),
						gate,
						h(
							"div",
							{ className: "dop-dock-foot" },
							h("span", { className: "dop-dock-foot-text" }, footText),
							waiting ? h("span", { className: "dop-dock-chip" }, "在对话里确认") : null
						)
					)
				);

				return h(
					"section",
					{ className: "dop-dock", "data-tone": tone, "data-collapsed": collapsed ? "1" : "0" },
					head,
					body
				);
			}
		}

		return {
			/**
			 * 客户端插件必须显式声明依赖的服务：宿主 ctx 默认不注入 slots，
			 * 直接读 ctx.slots 会抛 cannot get property "slots" without inject，
			 * 表现为启动时 "web boot: 1 entry did not activate / dsh-operator: failed"。
			 */
			inject: ["slots"],
			apply(ctx) {
				for (const key of KEYS) {
					ctx.slots.inject("tool.call.toolview", () =>
						ctx.slots.register({ name: "tool.call.toolview", key }, OperatorLine)
					);
				}
				// 只用子作用域 inject sessions：宿主没有该服务时卡片不显示，toolview 照常工作。
				if (ctx.slots !== undefined && typeof ctx.inject === "function") {
					try {
						ctx.inject(["sessions"], (scoped) => {
							// 0.107.0：输入框上方的「正在操作」卡片——DSH 原生槽位，不依赖任何第三方插件。
							// 每个会话注入一个自己的状态源（卡片跟着它所在的会话走）。
							try {
								ctx.slots.inject("conversation.input.dock", () =>
									ctx.slots.register(
										{
											name: "conversation.input.dock",
											id: "dsh-operator-activity",
											order: 8,
											inject: (sessionId) => ({
												operatorStatusSource: createOperatorStatus(
													() => scoped.sessions,
													() => (typeof sessionId === "string" && sessionId !== "" ? sessionId : null)
												)
											})
										},
										OperatorDock
									)
								);
							} catch (error) {
								console.error("dsh-operator: activity dock unavailable", error);
							}
						});
					} catch (error) {
						console.error("dsh-operator: activity dock unavailable", error);
					}
				}
			}
		};
	}
});
