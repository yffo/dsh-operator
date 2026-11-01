/**
 * dsh-operator —— Web 客户端半侧（0.23.0，手写、零构建链）。
 *
 * 客户端模块系统要求的格式就是一句 `window.__ModuleLoader__.load({ id, factory })`；
 * factory 里 `require('react')` 拿到的是外壳冻结的平台基座，因此本文件不引入任何依赖，
 * 也不走打包器。它做两件事：
 *
 * 1. 把本插件自己的 wire 工具在对话里换成「活动卡片」：状态点 / 中文标题 / 目标 /
 *    耗时 / 执行模式徽标 / 分段进度 / 每步一行 / 缩略截图 / 失败原因与建议 / 折叠。
 * 2. 渲染失败时保持最小信息（工具名 + 状态），绝不牵连其他卡片。
 *
 * 设计真源：docs/TOOLVIEW-CARDS.md；P0 进度与宿主契约：docs/TOOLVIEW-P0-HANDOFF.md。
 *
 * 数据全部来自 ToolCallOwnerProps 的冻结 `block`，不从宿主拉取额外状态：
 * - phase: preparing | start | result；
 * - 运行中耗时 = Date.now() - block.time；已结算耗时 = block.time - block.callTime；
 * - 结果图片 = content 里的 { type:"image", attachment }，经 props.loadImage 换 URL。
 *
 * 视图可能被宿主当普通函数调用，所以本文件不使用 React hooks；折叠/展开/灯箱/走秒
 * 都走原生 DOM（ref 回调 + dataset + setInterval），这是 client-bundle 测试的硬约束。
 *
 * 改这个文件后刷新页面即可生效；但 dsh.client 声明首次生效需要重启 App。
 */
window.__ModuleLoader__.load({
	id: "dsh-operator",
	factory: (require) => {
		const React = require("react");
		const h = React.createElement;

		const ROWS = {
			task_profile: "Task profile",
			plan_create: "Create plan",
			plan_update: "Update plan",
			plan_run: "Run plan",
			plan_list: "List plans",
			plan_delete: "Delete plan",
			skill_save: "Save skill",
			skill_run: "Run skill",
			skill_list: "List skills",
			operator_status: "Operator status",
			failure_list: "Failures",
			ax_batch: "AX batch",
			browser_dom_probe: "Browser channels",
			browser_dom_snapshot: "DOM snapshot",
			browser_dom_click: "DOM click",
			browser_dom_fill: "DOM fill",
			cu_observe: "cu observe",
			cu_act: "cu act"
		};
		const KEYS = Object.keys(ROWS);

		/** 需要确认才允许操作的守卫型工具（展示用，不下发确认）。 */
		const GUARDED = {
			ax_press: true,
			ax_set_value: true,
			ax_menu: true,
			browser_dom_click: true,
			cu_act: true
		};

		/** 会短暂占用前台的工具（其余按后台执行展示）。 */
		const FOREGROUND = {
			open_app: true,
			cu_launch: true
		};

		const STYLE_ID = "dsh-operator-toolview-css";

		const CSS = [
			".dop-card{position:relative;margin:6px 0;padding:10px 12px 8px;border:1px solid var(--dop-line);border-radius:14px;",
			"--dop-line:color-mix(in srgb,currentColor 15%,transparent);",
			"--dop-line-soft:color-mix(in srgb,currentColor 9%,transparent);",
			"--dop-soft:color-mix(in srgb,currentColor 5%,transparent);",
			"--dop-ok:#16a34a;--dop-warn:#b46a00;--dop-err:#dc2626;--dop-accent:#3b5bdb;",
			"font-size:0.94em;line-height:1.5;color:inherit;font-variant-numeric:tabular-nums}",
			".dop-head{display:flex;align-items:flex-start;gap:9px}",
			".dop-main{flex:1;min-width:0}",
			".dop-title{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-weight:620;letter-spacing:.1px}",
			".dop-title .dop-tool{font-weight:400;font-size:11.5px;color:color-mix(in srgb,currentColor 55%,transparent)}",
			".dop-sub{margin-top:1px;font-size:12.5px;color:color-mix(in srgb,currentColor 62%,transparent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dop-meta{display:flex;align-items:center;gap:5px;flex:none}",
			".dop-pill{border:1px solid var(--dop-line);border-radius:999px;padding:2px 7px;font-size:11px;white-space:nowrap;color:color-mix(in srgb,currentColor 70%,transparent)}",
			".dop-pill.dop-mode{color:var(--dop-accent);border-color:color-mix(in srgb,var(--dop-accent) 28%,transparent);background:color-mix(in srgb,var(--dop-accent) 8%,transparent)}",
			".dop-pill.dop-gate{color:#fff;background:var(--dop-warn);border-color:transparent;font-weight:600}",
			".dop-toggle{width:24px;height:24px;padding:0;border:1px solid var(--dop-line);border-radius:8px;background:transparent;color:color-mix(in srgb,currentColor 65%,transparent);cursor:pointer;display:grid;place-items:center;font-size:10px;line-height:1}",
			".dop-toggle:hover{color:inherit;border-color:color-mix(in srgb,currentColor 30%,transparent)}",
			".dop-toggle i{display:block;transition:transform .18s ease}",
			".dop-card[data-open=\"false\"] .dop-toggle i{transform:rotate(-90deg)}",
			".dop-dot{flex:none;width:9px;height:9px;border-radius:50%;margin-top:5px;background:#7b8497}",
			".dop-card[data-state=\"running\"] .dop-dot{background:var(--dop-warn);box-shadow:0 0 0 3px color-mix(in srgb,var(--dop-warn) 18%,transparent);animation:dopBreath 3.2s ease-in-out infinite}",
			".dop-card[data-state=\"ok\"] .dop-dot{background:var(--dop-ok)}",
			".dop-card[data-state=\"error\"] .dop-dot{background:var(--dop-err);box-shadow:0 0 0 3px color-mix(in srgb,var(--dop-err) 16%,transparent)}",
			".dop-card[data-state=\"stopped\"] .dop-dot{background:#64748b}",
			".dop-progress{display:flex;gap:4px;margin:8px 0 2px}",
			".dop-progress i{position:relative;height:4px;flex:1;border-radius:999px;background:var(--dop-line-soft);overflow:hidden}",
			".dop-progress i.done{background:var(--dop-ok)}",
			".dop-progress i.active{background:linear-gradient(90deg,var(--dop-warn),color-mix(in srgb,var(--dop-warn) 40%,var(--dop-line-soft)));transform-origin:left;animation:dopFlow 1s cubic-bezier(.22,.9,.24,1) both}",
			".dop-progress i.active::after{content:\"\";position:absolute;top:-2px;bottom:-2px;left:0;width:58%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.85),transparent);mix-blend-mode:screen;animation:dopComet 1.15s .05s cubic-bezier(.3,.8,.25,1) both}",
			".dop-progress i.active.long::after{animation:dopLong 3.2s ease-in-out .9s infinite}",
			".dop-progress i.err{background:var(--dop-err)}",
			".dop-steps{display:flex;flex-direction:column;gap:2px;margin:6px 0 2px}",
			".dop-step{position:relative;display:flex;align-items:flex-start;gap:9px;padding:6px 4px;border-radius:10px}",
			".dop-step:hover{background:var(--dop-soft)}",
			".dop-step .dop-idx{flex:none;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:11px;border:1px solid var(--dop-line);background:var(--dop-soft);color:color-mix(in srgb,currentColor 70%,transparent)}",
			".dop-step[data-state=\"done\"] .dop-idx{color:var(--dop-ok);border-color:color-mix(in srgb,var(--dop-ok) 35%,transparent);background:color-mix(in srgb,var(--dop-ok) 12%,transparent)}",
			".dop-step[data-state=\"running\"] .dop-idx{color:var(--dop-warn);border-color:color-mix(in srgb,var(--dop-warn) 40%,transparent);background:color-mix(in srgb,var(--dop-warn) 12%,transparent);animation:dopIdx .55s cubic-bezier(.3,1.5,.5,1) both}",
			".dop-step[data-state=\"error\"] .dop-idx,.dop-step[data-state=\"warn\"] .dop-idx{color:var(--dop-err);border-color:color-mix(in srgb,var(--dop-err) 35%,transparent);background:color-mix(in srgb,var(--dop-err) 12%,transparent)}",
			".dop-step .dop-idx{position:relative}",
			".dop-step[data-state=\"running\"] .dop-idx::after{content:\"\";position:absolute;inset:-3px;border-radius:50%;border:1px solid color-mix(in srgb,var(--dop-warn) 55%,transparent);animation:dopPulse 1.8s ease-out infinite}",
			".dop-long{margin:6px 0 0;font-size:12px;color:color-mix(in srgb,currentColor 62%,transparent)}",
			".dop-long[hidden]{display:none}",
			".dop-step .dop-body{flex:1;min-width:0}",
			".dop-step .dop-step-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-weight:560}",
			".dop-step .dop-tag{font-size:11px;font-weight:400;color:color-mix(in srgb,currentColor 58%,transparent)}",
			".dop-step[data-state=\"running\"] .dop-tag{color:var(--dop-warn)}",
			".dop-step[data-state=\"error\"] .dop-tag,.dop-step[data-state=\"warn\"] .dop-tag{color:var(--dop-err)}",
			".dop-step .dop-note{margin-top:1px;font-size:12px;color:color-mix(in srgb,currentColor 60%,transparent);word-break:break-word}",
			".dop-step[data-state=\"running\"].dop-advance::after{content:\"\";position:absolute;inset:0;border-radius:10px;pointer-events:none;background:linear-gradient(102deg,transparent 12%,color-mix(in srgb,var(--dop-warn) 26%,transparent) 46%,transparent 80%);background-size:220% 100%;background-position:130% 0;animation:dopSweep 1.8s cubic-bezier(.2,.7,.25,1) both}",
			".dop-thumb{flex:none;width:74px;height:48px;border:1px solid var(--dop-line);border-radius:8px;overflow:hidden;background:var(--dop-soft);cursor:zoom-in}",
			".dop-thumb:hover{border-color:var(--dop-accent)}",
			".dop-thumb img{display:block;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .25s ease}",
			".dop-gallery{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 2px}",
			".dop-reason{margin:6px 0 2px;padding:7px 9px;border:1px solid color-mix(in srgb,var(--dop-err) 26%,transparent);border-radius:10px;background:color-mix(in srgb,var(--dop-err) 7%,transparent);font-size:12.5px}",
			".dop-reason b{color:var(--dop-err);font-weight:650}",
			".dop-reason .dop-hint{margin-top:2px;color:color-mix(in srgb,currentColor 65%,transparent)}",
			".dop-details{margin-top:6px}",
			".dop-details summary{cursor:pointer;font-size:12px;color:color-mix(in srgb,currentColor 55%,transparent)}",
			".dop-pre{margin:6px 0 0;padding:6px 8px;border-radius:8px;background:var(--dop-soft);overflow:auto;max-height:220px;font-size:11.5px;white-space:pre-wrap;word-break:break-word}",
			".dop-extra{margin-top:4px;font-size:11.5px;color:color-mix(in srgb,currentColor 60%,transparent);display:grid;gap:2px}",
			".dop-card[data-open=\"false\"] .dop-collapsible{display:none}",
			".dop-card[data-tone=\"warn\"]{border-color:color-mix(in srgb,var(--dop-warn) 30%,var(--dop-line))}",
			".dop-lightbox{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;padding:24px;background:rgba(10,12,16,.72);cursor:zoom-out;animation:dopFade .18s ease both}",
			".dop-lightbox img{max-width:92vw;max-height:88vh;border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,.5);background:#fff}",
			"@keyframes dopFlow{0%{transform:scaleX(.18);filter:brightness(1.5)}55%{transform:scaleX(1.03);filter:brightness(1.15)}100%{transform:scaleX(1);filter:none}}",
			"@keyframes dopComet{0%{transform:translateX(-140%);opacity:0}10%{opacity:1}82%{opacity:.9}100%{transform:translateX(150%);opacity:0}}",
			"@keyframes dopLong{0%{transform:translateX(-120%)}100%{transform:translateX(240%)}}",
			"@keyframes dopIdx{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--dop-warn) 50%,transparent)}100%{box-shadow:0 0 0 9px transparent}}",
			"@keyframes dopSweep{0%{background-position:130% 0;opacity:0}18%{opacity:1}100%{background-position:-30% 0;opacity:0}}",
			"@keyframes dopBreath{0%,100%{box-shadow:0 0 0 3px color-mix(in srgb,var(--dop-warn) 18%,transparent)}50%{box-shadow:0 0 0 5px color-mix(in srgb,var(--dop-warn) 7%,transparent)}}",
			"@keyframes dopFade{from{opacity:0}to{opacity:1}}",
			"@keyframes dopPulse{0%{transform:scale(.92);opacity:.6}100%{transform:scale(1.35);opacity:0}}",
			"@media (prefers-reduced-motion: reduce){.dop-card *,.dop-lightbox{animation:none!important}}"
		].join("");

		/** 样式只注入一次；宿主是 SPA，路由切换不会重新加载 factory。 */
		function ensureStyle() {
			if (typeof document === "undefined" || document === null) return;
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			(document.head ?? document.documentElement).appendChild(style);
		}

		function parseArgs(raw) {
			if (typeof raw !== "string" || raw.trim() === "") return null;
			try {
				return JSON.parse(raw);
			} catch {
				return null;
			}
		}

		/** 已结算块的状态；未结算（还在运行）时返回 running。 */
		function stateOf(block) {
			if (!("kind" in block)) return "running";
			if (block.error?.code === "interrupted") return "stopped";
			return block.isError === true ? "error" : "ok";
		}

		/** 结果文本：只取 text 内容，忽略图片等二进制块。 */
		function resultText(block) {
			if (!("kind" in block)) return null;
			const parts = [];
			for (const item of Array.isArray(block.content) ? block.content : []) {
				if (item?.type === "text" && typeof item.text === "string") parts.push(item.text);
			}
			if (parts.length === 0 && block.error !== void 0) parts.push(`${block.error.name}: ${block.error.code}`);
			const text = parts.join("\n").trim();
			return text === "" ? null : text;
		}

		function firstLine(text) {
			if (typeof text !== "string") return "";
			const line = text.split("\n").find((entry) => entry.trim() !== "") ?? "";
			return line.length > 160 ? `${line.slice(0, 157)}…` : line;
		}

		/** 结果文本首行常带 "tool: " 前缀，展示时去掉，避免和左侧标签重复。 */
		function stripToolPrefix(line, tool) {
			const prefix = `${tool}: `;
			return line.startsWith(prefix) ? line.slice(prefix.length) : line;
		}

		/** 摘要：优先从结果里挑信息量最高的一行；运行中则用参数里最有辨识度的字段。 */
		function summaryOf(tool, block, args, output) {
			if (output !== null) {
				if (tool === "operator_status") {
					const versionLine = output.split("\n").find((line) => line.startsWith("dsh-operator")) ?? firstLine(output);
					return firstLine(versionLine);
				}
				return stripToolPrefix(firstLine(output), tool);
			}
			if (args !== null) {
				for (const key of ["goal", "id", "name", "kind", "expect_title"]) {
					const value = args[key];
					if (typeof value === "string" && value.trim() !== "") return firstLine(value);
				}
			}
			return "";
		}

		/**
		 * 三类富卡片：失败样本/浏览器通道/技能列表。
		 * 只解析工具已经返回的文本（不额外拉宿主状态），解析失败时回退到通用首行摘要。
		 */
		function richSummary(tool, output) {
			if (output === null) return null;
			if (tool === "browser_dom_probe") {
				const applescript = /AppleScript: ([^;]+)/.exec(output)?.[1] ?? "unknown";
				const cdp = /CDP: ([^;]+?); config browserCdpPort/.exec(output)?.[1] ?? "unknown";
				const ready = applescript.startsWith("ready") || cdp.startsWith("ready");
				return {
					summary: `channels · AppleScript ${applescript} · CDP ${cdp}`,
					tone: ready ? "ok" : "warn"
				};
			}
			if (tool === "browser_dom_snapshot") {
				const match = /^DOM snapshot: (.*) \((.*)\) — (\d+) links, (\d+) controls$/.exec(output);
				if (match === null) return { summary: firstLine(output), tone: "ok" };
				return {
					summary: `${match[1]} — ${match[3]} links / ${match[4]} controls`,
					extra: [`url: ${match[2]}`],
					tone: "ok"
				};
			}
			if (tool === "skill_list") {
				if (/^No saved skills yet/.test(output)) return { summary: "no saved skills", tone: "ok" };
				const skills = [...output.matchAll(/(^|[\s,])?([\w][\w-]*)\((\d+) steps\)/g)].map((m) => `${m[2]}(${m[3]})`);
				return {
					summary: `${skills.length} skill(s)${skills.length === 0 ? "" : ` · ${skills.join(", ")}`}`,
					extra: skills.length === 0 ? [] : [`skills: ${skills.join(", ")}`],
					tone: "ok"
				};
			}
			if (tool === "ax_batch") {
				const head = /^ax_batch: (\d+)\/(\d+) ok(?: \(failed at step (\d+)\))?/m.exec(output);
				const okCount = Number(head?.[1] ?? "0");
				const total = Number(head?.[2] ?? "0");
				const failedStep = head?.[3];
				return {
					summary: `${okCount}/${total} step(s) ok${failedStep === void 0 ? "" : ` · failed at step ${failedStep}`}`,
					extra: output
						.split("\n")
						.filter((line) => /^\s+\d+\.\s/.test(line))
						.slice(0, 3),
					tone: okCount === total ? "ok" : "warn"
				};
			}
			if (tool === "failure_list") {
				const total = Number(/^failures: (\d+)/m.exec(output)?.[1] ?? "0");
				const kindLine = /by kind: (.+)/.exec(output)?.[1];
				if (total === 0) return { summary: "no failures", tone: "ok" };
				return {
					summary: `${total} failure(s)${kindLine === void 0 ? "" : ` · ${kindLine}`}`,
					extra: output
						.split("\n")
						.filter((line) => line.startsWith("by tool:") || line.startsWith("recent:"))
						.slice(0, 2),
					tone: "warn"
				};
			}
			if (tool === "operator_status") {
				const versionLine = /dsh-operator[^\n]*/.exec(output)?.[0] ?? firstLine(output);
				const counts = /skills:? [^\n]*/.exec(output)?.[0];
				const failures = /failures?[^\n]*/i.exec(output)?.[0];
				const parts = [versionLine, counts, failures].filter((entry) => typeof entry === "string" && entry.trim() !== "");
				return {
					summary: parts.join(" · "),
					extra: output.split("\n").filter((line) => /failure|audit/i.test(line)),
					tone: "ok"
				};
			}
			return null;
		}

		// ------------------------------------------------------------------
		// P0：活动卡片的数据推导（全部来自 block 本身，不拉宿主状态）
		// ------------------------------------------------------------------

		function durationMs(block) {
			const ended = block?.time;
			const started = block?.callTime;
			if (typeof ended === "number" && typeof started === "number") return Math.max(0, ended - started);
			return null;
		}

		function formatMs(ms) {
			if (typeof ms !== "number" || Number.isFinite(ms) === false || ms < 0) return "";
			const seconds = ms / 1000;
			return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
		}

		/** 目标行：尽量拼出「App › 窗口 › 控件」，拼不出就退回参数里最有辨识度的一行。 */
		function targetOf(args) {
			if (args === null || typeof args !== "object") return "";
			const bits = [];
			const push = (value) => {
				if (typeof value === "string" && value.trim() !== "" && bits.includes(value.trim()) === false) bits.push(value.trim());
			};
			push(args.browser);
			push(args.app);
			push(args.app_contains);
			push(args.expect_title);
			push(args.title);
			push(args.title_contains);
			if (args.window_id !== void 0) push(`窗口 ${String(args.window_id)}`);
			push(args.role);
			push(args.path);
			push(args.selector);
			push(args.url);
			if (bits.length === 0) {
				for (const key of ["name", "goal", "id", "query"]) {
					if (typeof args[key] === "string" && args[key].trim() !== "") {
						push(args[key]);
						break;
					}
				}
			}
			return bits.join(" › ");
		}

		function modeOf(tool, args) {
			const foreground =
				(args !== null && typeof args === "object" && (args.delivery_mode === "foreground" || args.fallback_foreground === true)) ||
				FOREGROUND[tool] === true;
			if (foreground) return { text: "前台执行 · 短暂占用", title: "会短暂占用鼠标键盘，期间请不要操作" };
			return { text: "后台执行 · 不影响你", title: "后台执行，不抢占你的鼠标键盘" };
		}

		function describeStep(step) {
			if (step === null || typeof step !== "object") return "";
			const bits = [];
			for (const key of ["expect_title", "title", "description", "path", "value"]) {
				if (typeof step[key] === "string" && step[key].trim() !== "") {
					bits.push(step[key].trim());
					break;
				}
			}
			if (step.index !== void 0) bits.push(`#${String(step.index)}`);
			if (Array.isArray(step.position)) bits.push(`@${step.position.join(",")}`);
			return bits.join(" ");
		}

		/** ax_batch 的 step.action 是英文短名，卡片上给中文动作名。 */
		const ACTION_LABELS = {
			press: "按下控件",
			set_value: "写入字段",
			scroll: "滚动",
			open: "打开",
			focus: "聚焦",
			wait: "等待",
			screenshot: "截图",
			snapshot: "观察",
			menu: "菜单操作",
			click: "点击",
			hotkey: "按键",
			input: "输入文本"
		};

		function actionLabel(action) {
			return ACTION_LABELS[action] ?? action;
		}

		const STEP_STATES = {
			pending: "等待",
			running: "进行中",
			done: "已完成",
			warn: "需要处理",
			error: "失败"
		};

		/**
		 * 步骤列表：ax_batch 从输出逐行解析（运行中退化为参数里声明的步骤），
		 * 其他工具是「一步」——单步卡片不渲染步骤区，避免和标题重复。
		 */
		function stepsOf(tool, args, output, state) {
			const rows = [];
			if (tool === "ax_batch" && output !== null) {
				for (const line of output.split("\n")) {
					const match = /^\s*(\d+)\.\s+([A-Za-z_]+)\s+(ok|FAILED)(?:\s+—\s+(.*))?$/.exec(line);
					if (match === null) continue;
					const ok = match[3] === "ok";
					rows.push({
						index: Number(match[1]),
						title: actionLabel(match[2]),
						note: match[4] ?? (ok ? "" : "失败"),
						state: ok ? "done" : "error"
					});
				}
			}
			if (rows.length === 0 && tool === "ax_batch" && args !== null && Array.isArray(args.steps)) {
				for (let i = 0; i < args.steps.length; i += 1) {
					rows.push({
						index: i + 1,
						title: actionLabel(String(args.steps[i]?.action ?? `步骤 ${i + 1}`)),
						note: describeStep(args.steps[i]),
						state: state === "running" ? (i === 0 ? "running" : "pending") : "pending"
					});
				}
			}
			if (rows.length === 0) rows.push({ index: 1, title: "", note: "", state: state === "running" ? "running" : state });
			return rows;
		}

		/** 结果里的图片附件（宿主 imageReferences 同款校验，不合规就忽略）。 */
		function imagesOf(block) {
			if (!("kind" in block) || Array.isArray(block.content) === false) return [];
			const images = [];
			for (const part of block.content) {
				if (part === null || typeof part !== "object" || part.type !== "image") continue;
				const attachment = part.attachment;
				if (attachment === null || typeof attachment !== "object" || Array.isArray(attachment)) continue;
				if (typeof attachment.attachmentId !== "string" || attachment.attachmentId === "") continue;
				if (typeof attachment.mediaType !== "string") continue;
				images.push(attachment);
			}
			return images;
		}

		/** 把错误翻译成「原因 + 能怎么办」，数据只来自 error 与输出文本。 */
		function reasonOf(block, output, state) {
			if (state !== "error" && state !== "stopped") return null;
			const parts = [];
			if (block.error !== void 0 && block.error !== null) {
				if (typeof block.error.name === "string" && block.error.name !== "") parts.push(block.error.name);
				if (typeof block.error.code === "string" && block.error.code !== "" && block.error.code !== block.error.name) parts.push(block.error.code);
			}
			const text = [parts.join(" / "), output ?? ""].join("\n");
			const lower = text.toLowerCase();
			let hint = "展开「调用详情」看原始错误；换个定位方式（先 observe 再动作）重试通常有效。";
			if (/permission|tcc|authoriz|denied|not allowed/.test(lower)) {
				hint = "权限没开：打开「系统设置 › 隐私与安全性」，给 DeepSeek Harness 勾上辅助功能 / 屏幕录制后重试。";
			} else if (/timeout|timed out/.test(lower)) {
				hint = "等太久：目标 App 可能卡住或被弹窗挡住，先观察窗口，必要时手动处理后再试。";
			} else if (/not found|no match|no such|stale token|missing/.test(lower)) {
				hint = "目标变了：控件可能已消失或界面改版，先重新观察窗口拿到新的索引/token 再动作。";
			} else if (/interrupted|abort/.test(lower)) {
				hint = "这次调用被中断了，现场还在；确认还要继续后重新执行即可。";
			} else if (/suspected_noop/.test(lower)) {
				hint = "动作发出去但界面没变化；先截图确认状态，再决定重试还是换一种操作方式。";
			}
			// 失败行比首行可靠：ax_batch 的输出首行是汇总，真正的错误在「n. action FAILED — 原因」那行。
			const candidates = String(output ?? "")
				.split("\n")
				.map((entry) => entry.trim())
				.filter((entry) => entry !== "");
			const failedLine = candidates.filter((entry) => /failed|error|denied|timeout|not found|interrupted/i.test(entry)).pop();
			const message = block.error?.message;
			const detail =
				typeof message === "string" && message !== "" && message !== "failed at step"
					? message
					: failedLine ?? candidates[0] ?? (parts.join(" / ") || "没有拿到错误细节");
			const body = firstLine(detail);
			return {
				title: state === "stopped" ? "已中断" : "失败",
				body: body === "" ? "没有拿到错误细节" : body,
				hint
			};
		}

		function stateLabel(state) {
			if (state === "running") return "运行中";
			if (state === "ok") return "已完成";
			if (state === "error") return "失败";
			return "已中断";
		}

		// ------------------------------------------------------------------
		// 原生 DOM 交互：灯箱 / 折叠 / 实时耗时（不使用 hooks）
		// ------------------------------------------------------------------

		function openLightbox(url, alt) {
			if (typeof document === "undefined" || typeof url !== "string" || url === "") return;
			const overlay = document.createElement("div");
			overlay.className = "dop-lightbox";
			overlay.setAttribute("role", "dialog");
			overlay.setAttribute("aria-label", alt || "截图预览");
			const image = document.createElement("img");
			image.src = url;
			image.alt = alt || "截图预览";
			overlay.appendChild(image);
			const onKey = (event) => {
				if (event.key === "Escape") close();
			};
			const close = () => {
				overlay.remove();
				document.removeEventListener("keydown", onKey);
			};
			overlay.addEventListener("click", close);
			document.addEventListener("keydown", onKey);
			document.body.appendChild(overlay);
		}

		function Thumb({ attachment, index, loadImage, label }) {
			return h(
				"div",
				{ className: "dop-thumb", title: label || "点击放大截图" },
				h("img", {
					alt: label || "截图",
					"data-dop-attach": String(index),
					ref: (node) => {
						if (node === null || attachment === null || typeof attachment !== "object") return;
						if (typeof loadImage !== "function") return;
						try {
							const cached = typeof loadImage.peek === "function" ? loadImage.peek(attachment) : null;
							if (typeof cached === "string" && cached !== "") {
								node.src = cached;
								node.dataset.dopUrl = cached;
								node.style.opacity = "1";
								return;
							}
							const pending = loadImage(attachment);
							Promise.resolve(pending)
								.then((url) => {
									if (typeof url !== "string" || url === "") return;
									node.src = url;
									node.dataset.dopUrl = url;
									node.style.opacity = "1";
								})
								.catch(() => {
									node.removeAttribute("data-dop-attach");
								});
						} catch {
							node.removeAttribute("data-dop-attach");
						}
					},
					onClick: (event) => {
						event.preventDefault();
						event.stopPropagation();
						const image = event.currentTarget;
						openLightbox(image.dataset.dopUrl || image.src, image.alt);
					}
				})
			);
		}

		function Progress({ steps }) {
			const segments = steps.map((step, index) => {
				let state = "";
				if (step.state === "done") state = "done";
				else if (step.state === "running") state = "active long";
				else if (step.state === "error" || step.state === "warn") state = "err";
				return h("i", { key: `seg-${index}`, className: state, "data-state": step.state });
			});
			return h("div", { className: "dop-progress", "aria-hidden": "true" }, ...segments);
		}

		function StepRow({ step, index, total, attachment, loadImage }) {
			const done = step.state === "done";
			const failed = step.state === "error" || step.state === "warn";
			const mark = done ? "✓" : failed ? "!" : String(index + 1);
			return h(
				"div",
				{
					className: `dop-step${step.state === "running" ? " dop-advance" : ""}`,
					"data-state": step.state
				},
				h("span", { className: "dop-idx", "aria-hidden": "true" }, mark),
				h(
					"div",
					{ className: "dop-body" },
					h(
						"div",
						{ className: "dop-step-title" },
						h("span", null, step.title || `第 ${index + 1} 步`),
						h("span", { className: "dop-tag" }, STEP_STATES[step.state] ?? step.state)
					),
					step.note === "" ? null : h("div", { className: "dop-note" }, step.note)
				),
				attachment === void 0 || attachment === null
					? null
					: h(Thumb, { attachment, index, loadImage, label: step.title || "步骤截图" })
			);
		}

		function Reason({ reason }) {
			return h(
				"div",
				{ className: "dop-reason", role: "note" },
				h("b", null, reason.title),
				"：",
				reason.body,
				h("div", { className: "dop-hint" }, reason.hint)
			);
		}

		function OperatorRow(props) {
			try {
				return renderCard(props);
			} catch (error) {
				const message = error && error.message ? String(error.message) : String(error);
				const tool = props && typeof props.toolName === "string" ? props.toolName : "operator";
				return h(
					"div",
					{ "data-tool": tool, "data-state": "error", style: { padding: "5px 8px", fontSize: "0.92em", opacity: 0.8 } },
					"dop",
					" ",
					tool,
					" · card error: ",
					message.slice(0, 160)
				);
			}
		}

		function renderCard(props) {
			ensureStyle();
			const block = props && props.block;
			if (block === null || typeof block !== "object") throw new Error(`unexpected block: ${typeof block}`);
			const state = stateOf(block);
			const settled = "kind" in block;
			const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? "";
			const args = parseArgs(argsRaw);
			const output = resultText(block);
			const tool = String((props && props.toolName) || block.toolName || "operator");
			const label = ROWS[tool] ?? tool;
			const rich = richSummary(tool, output);
			const summary = rich === null ? summaryOf(tool, block, args, output) : rich.summary;
			const running = state === "running";
			const target = running === true ? targetOf(args) : summary;
			const steps = stepsOf(tool, args, output, state);
			const multi = steps.length > 1;
			const images = imagesOf(block);
			const doneCount = steps.filter((step) => step.state === "done").length;
			const failedAt = steps.findIndex((step) => step.state === "error" || step.state === "warn");
			const currentStep = Math.min(doneCount + 1, steps.length);
			const gate = !settled && GUARDED[tool] === true && args !== null && args.confirm !== true;
			const mode = modeOf(tool, args);
			const reason = reasonOf(block, output, state);
			const total = formatMs(durationMs(block));
			const defaultOpen = running || state === "error";
			const elapsedStart = typeof block.time === "number" ? block.time : Date.now();

			let titleText = stateLabel(state);
			if (multi) {
				if (state === "running") titleText = `正在操作 · 第 ${currentStep}/${steps.length} 步`;
				else if (state === "ok") titleText = `已完成 · ${steps.length} 步`;
				else if (state === "error") titleText = `失败 · 第 ${failedAt < 0 ? steps.length : failedAt + 1}/${steps.length} 步`;
				else titleText = `已中断 · 第 ${doneCount}/${steps.length} 步`;
			} else if (state === "running") {
				titleText = "正在操作";
			}

			const metaNodes = [];
			if (running) {
				metaNodes.push(
					h("span", {
						key: "time",
						className: "dop-pill dop-time",
						"data-dop-elapsed": "",
						ref: (node) => {
							if (node === null) return;
							node.textContent = formatMs(Date.now() - elapsedStart) || "0.0s";
						}
					})
				);
			} else if (total !== "") {
				metaNodes.push(h("span", { key: "time", className: "dop-pill dop-time" }, total));
			}
			if (gate) metaNodes.push(h("span", { key: "gate", className: "dop-pill dop-gate" }, "需要你确认"));
			if (settled && images.length > 0) metaNodes.push(h("span", { key: "shots", className: "dop-pill dop-shots" }, `${images.length} 张截图`));
			metaNodes.push(h("span", { key: "mode", className: "dop-pill dop-mode", title: mode.title }, mode.text));
			metaNodes.push(
				h(
					"button",
					{
						key: "toggle",
						type: "button",
						className: "dop-toggle",
						"aria-label": "展开或收起详情",
						"aria-expanded": defaultOpen ? "true" : "false",
						onClick: (event) => {
							event.preventDefault();
							event.stopPropagation();
							const root = event.currentTarget.closest(".dop-card");
							if (root === null) return;
							const open = root.dataset.open !== "false";
							root.dataset.open = open ? "false" : "true";
							event.currentTarget.setAttribute("aria-expanded", open ? "false" : "true");
						}
					},
					h("i", { "aria-hidden": "true" }, "▾")
				)
			);

			const head = h(
				"div",
				{ className: "dop-head" },
				h("span", { className: "dop-dot", "aria-hidden": "true" }),
				h(
					"div",
					{ className: "dop-main" },
					h(
						"div",
						{ className: "dop-title" },
						h("span", null, titleText),
						h("span", { className: "dop-tool" }, label)
					),
					target === "" ? null : h("div", { className: "dop-sub", title: target }, `${running ? "目标" : "结果"}：${target}`)
				),
				h("div", { className: "dop-meta" }, ...metaNodes)
			);

			const progress = multi ? h(Progress, { steps }) : null;
			const stepNodes = multi
				? h(
					"div",
					{ className: "dop-steps" },
					...steps.map((step, index) =>
						h(StepRow, {
							key: `step-${index}`,
							step,
							index,
							total: steps.length,
							attachment: images[index],
							loadImage: props?.loadImage
						})
					)
				)
				: null;
			const gallery =
				images.length === 0
					? null
					: h(
						"div",
						{ className: "dop-gallery" },
						...images.map((attachment, index) =>
							h(Thumb, {
								key: `shot-${index}`,
								attachment,
								index,
								loadImage: props?.loadImage,
								label: `截图 ${index + 1}`
							})
						)
					);
			const extras =
				rich !== null && Array.isArray(rich.extra) && rich.extra.length > 0
					? h(
						"div",
						{ className: "dop-extra" },
						...rich.extra.map((line, index) => h("div", { key: `extra-${index}` }, line))
					)
					: null;
			const details =
				args === null && output === null
					? null
					: h(
						"details",
						{ className: "dop-details" },
						h("summary", null, "调用详情"),
						args === null ? null : h("pre", { className: "dop-pre" }, JSON.stringify(args, null, 2)),
						output === null ? null : h("pre", { className: "dop-pre" }, output)
					);

			const longHint = running
				? h("div", { className: "dop-long", "data-dop-long": "", hidden: true })
				: null;
			const body = h(
				"div",
				{ className: "dop-collapsible" },
				stepNodes,
				longHint,
				reason === null ? null : h(Reason, { reason }),
				bodyNote(summary, multi, target),
				extras,
				gallery,
				details
			);

			let ticker = null;
			return h(
				"div",
				{
					className: "dop-card",
					"data-tool": tool,
					"data-state": state,
					"data-tone": rich === null ? void 0 : rich.tone,
					ref: (node) => {
						if (node === null) {
							if (ticker !== null) {
								clearInterval(ticker);
								ticker = null;
							}
							return;
						}
						if (node.dataset.open === undefined) node.dataset.open = defaultOpen ? "true" : "false";
						if (running === false) return;
						const start = elapsedStart;
						const update = () => {
							const elapsed = Date.now() - start;
							const holder = node.querySelector("[data-dop-elapsed]");
							if (holder !== null) holder.textContent = formatMs(elapsed) || "0.0s";
							const hint = node.querySelector("[data-dop-long]");
							if (hint !== null) {
								const long = elapsed >= 10000;
								hint.hidden = long === false;
								if (long) hint.textContent = `已耗时 ${formatMs(elapsed)}，仍在执行；你可以继续做别的事`;
							}
						};
						update();
						if (ticker !== null) clearInterval(ticker);
						ticker = setInterval(update, 250);
					}
				},
				head,
				progress,
				body
			);
		}

		/** 单步卡片把摘要放在正文里，避免标题区信息重复但又不丢内容。 */
		function bodyNote(summary, multi, target) {
			if (multi || typeof summary !== "string" || summary.trim() === "" || summary === target) return null;
			return h("div", { className: "dop-extra" }, summary);
		}

		return {
			name: "dsh-operator-client",
			inject: ["slots"],
			apply(ctx) {
				ensureStyle();
				for (const key of KEYS) {
					ctx.slots.inject("tool.call.toolview", () =>
						ctx.slots.register({ name: "tool.call.toolview", key }, OperatorRow)
					);
				}
			}
		};
	}
});
