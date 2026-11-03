// 输入框上方「正在操作」卡片（0.107+）：数据源、状态机与降级
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "client", "client.js"), "utf8");

const MiniReact = {
	createElement(type, props, ...children) {
		return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true) };
	},
	Component: class Component {
		constructor(props) {
			this.props = props ?? {};
			this.state = {};
		}
		setState(next) {
			this.state = { ...this.state, ...(typeof next === "function" ? next(this.state) : next) };
		}
	}
};

/** 造一个 client 环境：记录槽位注册，并可注入假 sessions。 */
function loadClient({ sessions } = {}) {
	let captured = null;
	const sandbox = {
		window: { __ModuleLoader__: { load: (def) => { captured = def; } } },
		console,
		Date,
		JSON,
		Math,
		Object,
		Array,
		String,
		Number,
		Boolean,
		Error,
		Promise,
		setInterval: () => 0,
		clearInterval: () => {}
	};
	vm.runInNewContext(source, sandbox, { filename: "client/client.js" });
	const mod = captured.factory((name) => {
		if (name === "react") return MiniReact;
		throw new Error(`unexpected require: ${name}`);
	});
	const registered = [];
	const services = { sessions };
	const inject = (names, fn) => {
		const scope = { inject };
		let ok = true;
		for (const name of Array.isArray(names) ? names : []) {
			if (services[name] !== undefined) scope[name] = services[name];
			else ok = false;
		}
		if (ok) fn(scope);
	};
	const ctx = {
		slots: {
			inject(_slot, fn) {
				fn();
			},
			register(options, component) {
				registered.push({ options, component });
				return () => {};
			}
		},
		inject
	};
	mod.apply(ctx);
	const dock = registered.find((entry) => entry.options && entry.options.name === "conversation.input.dock");
	return { dock, registered };
}

/** 造一个假 sessions 服务：list + binding + eventSource（+ 可选的 operatorExecution 投影）。 */
function fakeSessions({ entries = [], running = false, retained = true, projection } = {}) {
	const listeners = new Set();
	const state = { ids: ["s1"], byId: { s1: { running, retainedBy: retained ? { mainView: 1 } : {} } } };
	return {
		list: {
			getSnapshot: () => state,
			subscribe: (fn) => {
				listeners.add(fn);
				return () => listeners.delete(fn);
			}
		},
		binding: () => {
			const binding = {
				eventSource: {
					getSnapshot: () => ({ entries }),
					subscribe: () => () => {}
				}
			};
			if (projection !== undefined) {
				binding.session = {
					projections: {
						faceOf: (key) => (key === "operatorExecution" ? { getSnapshot: () => projection, subscribe: () => () => {} } : undefined)
					}
				};
			}
			return binding;
		}
	};
}

function callEvent(callId, name, args, time = 1000) {
	return { event: { type: "tool/call", time, seq: 1, data: { callId, name, arguments: args, turn: 1, step: 1 } } };
}

function resultEvent(callId, time = 2200, isError = false) {
	return { event: { type: "tool/result", time, seq: 2, data: { message: { source: { callId }, isError } } } };
}

/** 把组件树拍平成文本行（MiniReact 的 children 在 node.children）。 */
function renderTexts(component) {
	const out = [];
	const walk = (node) => {
		if (node === null || node === undefined) return;
		if (Array.isArray(node)) return node.forEach(walk);
		if (typeof node === "string" || typeof node === "number") return void out.push(String(node));
		if (node.children) node.children.forEach(walk);
	};
	walk(component.render());
	return out;
}

/** 造一份宿主投影视图（operatorExecution 的 view）。 */
function projection(overrides = {}) {
	const now = Date.now();
	return {
		state: "working",
		tool: "click",
		step: 1,
		startedAt: now - 2000,
		updatedAt: now - 1000,
		callStartedAt: now - 2000,
		callFinishedAt: 0,
		failed: false,
		reason: "",
		approvalTool: "",
		callId: "",
		turn: -1,
		...overrides
	};
}

// 0.107.0：输入框上方「正在操作」卡片（DSH 原生 conversation.input.dock，不依赖第三方插件）
function mountDock(dock, sessionId = "s1") {
	const props = dock.options.inject(sessionId);
	return new dock.component(props);
}

test("输入框上方卡片的注册：拿得到 sessions 才注册", () => {
	const withSessions = loadClient({ sessions: fakeSessions() });
	assert.ok(withSessions.dock, "应该注册 conversation.input.dock");
	assert.equal(withSessions.dock.options.id, "dsh-operator-activity");
	assert.equal(typeof withSessions.dock.options.inject, "function");
	const withoutSessions = loadClient({});
	assert.equal(withoutSessions.dock, undefined, "没有 sessions 就不注册");
});

test("卡片：运行中显示标题/目标/步骤行（含步号）", () => {
	const base = Date.now() - 6000;
	const sessions = fakeSessions({
		entries: [
			callEvent("c1", "ax_press", '{"index":1}', base),
			resultEvent("c1", base + 300),
			callEvent("c2", "open_in_finder", '{"path":"/Users/yangfu/yffto"}', base + 1000)
		],
		projection: projection({ tool: "open_in_finder", step: 2, callId: "c2", callStartedAt: base + 1000, callFinishedAt: 0 })
	});
	const { dock } = loadClient({ sessions });
	const texts = renderTexts(mountDock(dock));
	assert.ok(texts.includes("正在操作"), texts.join("|"));
	assert.ok(texts.some((t) => t.includes("第 2 步")), texts.join("|"));
	assert.ok(texts.includes("目标：打开访达 · /Users/yangfu/yffto"), texts.join("|"));
	assert.ok(texts.includes("打开访达"), texts.join("|"));
	assert.ok(texts.includes("按控件"), texts.join("|"));
	assert.ok(texts.some((t) => t.includes("已完成 · 后台 · 0.3s")), texts.join("|"));
	assert.ok(texts.includes("按下一个界面控件"), `每步要有人话说明：${texts.join("|")}`);
});

test("卡片：等确认时出现确认门与真实原因", () => {
	const sessions = fakeSessions({
		entries: [
			{ event: { type: "approval/asked", time: Date.now() - 500, seq: 9, data: { id: "a1", toolName: "bash", reason: "escalate sandbox to danger-full-access: 要改对比度设置" } } }
		],
		projection: projection({ state: "waiting-person", tool: "click", approvalTool: "bash", step: 3 })
	});
	const { dock } = loadClient({ sessions });
	const texts = renderTexts(mountDock(dock));
	assert.ok(texts.includes("等你确认"), texts.join("|"));
	assert.ok(texts.includes("需要确认：执行命令"), texts.join("|"));
	assert.ok(texts.some((t) => t.includes("要改对比度设置")), `确认门要带真实原因：${texts.join("|")}`);
	assert.ok(texts.some((t) => t.includes("在对话输入框上方")), texts.join("|"));
	assert.ok(texts.includes("在对话里确认"), texts.join("|"));
});

test("卡片：结束后折成一行并留到用户手动关闭", () => {
	const base = Date.now() - 9000;
	const ended = fakeSessions({
		entries: [callEvent("c1", "ax_press", '{"index":1}', base), resultEvent("c1", base + 300)],
		projection: projection({ state: "ended", step: 1, callStartedAt: base, callFinishedAt: base + 300, updatedAt: Date.now() - 1000, reason: "turn-end" })
	});
	const { dock } = loadClient({ sessions: ended });
	const panel = mountDock(dock);
	const texts = renderTexts(panel);
	assert.ok(texts.includes("已结束"), texts.join("|"));
	assert.ok(!texts.includes("调用详情"), `折叠后不该展开步骤：${texts.join("|")}`);
	const stale = fakeSessions({
		projection: projection({ state: "ended", step: 1, updatedAt: Date.now() - 5 * 60 * 1000 })
	});
	const staleDock = loadClient({ sessions: stale }).dock;
	const stalePanel = mountDock(staleDock);
	assert.ok(stalePanel.render() !== null, "结束很久也还在（折叠成一行，等用户关）");
	assert.ok(!renderTexts(stalePanel).includes("调用详情"), "仍然保持折叠");
});

test("卡片：没有操作（idle/无投影）时不占高度", () => {
	const idle = loadClient({ sessions: fakeSessions({ projection: projection({ state: "idle" }) }) }).dock;
	assert.equal(mountDock(idle).render(), null);
	const noProjection = loadClient({ sessions: fakeSessions() }).dock;
	assert.equal(mountDock(noProjection).render(), null, "投影缺席时不显示（底部细条兜底）");
});

test("卡片：拿不到状态源不崩", () => {
	const { dock } = loadClient({ sessions: fakeSessions() });
	const withoutProps = new dock.component({});
	assert.equal(withoutProps.render(), null);
});

test("卡片：结束后折叠，新一轮开始自动展开", () => {
	const { dock } = loadClient({ sessions: fakeSessions() });
	const now = Date.now();
	const makeView = (state) => ({
		state,
		tool: "ax_press",
		step: 1,
		startedAt: now - 3000,
		updatedAt: now - 1000,
		callStartedAt: now - 2000,
		callFinishedAt: state === "ended" ? now - 1000 : 0,
		failed: false,
		reason: "",
		approvalTool: "",
		callId: "c1"
	});
	const snap = { sessionId: "s1", running: false, view: makeView("working"), call: null, calls: [], approval: null };
	const source = { getSnapshot: () => snap, subscribe: () => () => {} };
	const panel = new dock.component({ operatorStatusSource: source });
	panel.sync();
	assert.equal(panel.state.collapsed, false, "运行中展开");
	snap.view = makeView("ended");
	panel.sync();
	assert.equal(panel.state.collapsed, true, "结束后自动收起");
	snap.view = makeView("working");
	panel.sync();
	assert.equal(panel.state.collapsed, false, "新一轮开始自动展开（上一次的折叠不延续）");
});

test("卡片：本轮还在跑但两次动作之间 → 「正在执行」而不是「已结束」", () => {
	const base = Date.now() - 4000;
	const sessions = fakeSessions({
		running: true,
		entries: [callEvent("c1", "ax_press", '{"index":1}', base), resultEvent("c1", base + 300)],
		projection: projection({ state: "working", step: 1, callId: "c1", callStartedAt: base, callFinishedAt: base + 300, updatedAt: base + 400 })
	});
	const { dock } = loadClient({ sessions });
	const texts = renderTexts(mountDock(dock));
	assert.ok(texts.includes("正在执行"), `应显示正在执行：${texts.join("|")}`);
	assert.ok(!texts.includes("已结束"), texts.join("|"));
});

test("卡片：点关闭后隐藏，下一次操作再出现", () => {
	const base = Date.now() - 4000;
	const sessions = fakeSessions({
		running: true,
		entries: [callEvent("c1", "ax_press", '{"index":1}', base), resultEvent("c1", base + 300)],
		projection: projection({ state: "working", step: 1, callId: "c1", callStartedAt: base, callFinishedAt: 0 })
	});
	const { dock } = loadClient({ sessions });
	const panel = mountDock(dock);
	assert.ok(panel.render() !== null);
	panel.close();
	assert.equal(panel.render(), null, "关闭后不渲染");
});

test("卡片：本轮没碰过电脑就不能说「正在执行」", () => {
	const base = Date.now() - 30000;
	const sessions = fakeSessions({
		running: true,
		entries: [
			callEvent("c1", "ax_press", '{"index":1}', base), // 上一回合动过电脑
			resultEvent("c1", base + 300),
			{ event: { type: "turn/start", time: base + 5000, seq: 9, data: { turn: 2 } } } // 本轮开始了，但只写代码
		],
		projection: projection({ state: "ended", step: 1, callId: "c1", turn: 1, updatedAt: base + 1000 })
	});
	const { dock } = loadClient({ sessions });
	const texts = renderTexts(mountDock(dock));
	assert.ok(!texts.includes("正在执行"), `本轮没操作电脑，不该显示正在执行：${texts.join("|")}`);
	assert.ok(texts.includes("已结束"), texts.join("|"));
});

test("卡片：挂载时已经结束 → 默认折叠", () => {
	const sessions = fakeSessions({
		projection: projection({ state: "ended", step: 1, callId: "c1", updatedAt: Date.now() - 1000, callFinishedAt: Date.now() - 1000 })
	});
	const { dock } = loadClient({ sessions });
	const panel = mountDock(dock);
	const texts = renderTexts(panel);
	assert.ok(texts.includes("已结束"), texts.join("|"));
	assert.ok(!texts.includes("查看窗口列表"), `折叠后不该展开步骤：${texts.join("|")}`);
});

test("卡片：行可用键盘展开（Enter/空格）", () => {
	const base = Date.now() - 5000;
	const sessions = fakeSessions({
		entries: [callEvent("c1", "ax_press", '{"index":1}', base), resultEvent("c1", base + 300)],
		projection: projection({ state: "working", step: 1, callId: "c1", callStartedAt: base, callFinishedAt: 0, turn: 1 })
	});
	const { dock } = loadClient({ sessions });
	const panel = mountDock(dock);
	const tree = panel.render();
	const rows = [];
	const walk = (node) => {
		if (node === null || node === undefined) return;
		if (Array.isArray(node)) return node.forEach(walk);
		if (node.props && node.props.role === "button" && typeof node.props.onKeyDown === "function") rows.push(node);
		(node.children || []).forEach(walk);
	};
	walk(tree);
	assert.ok(rows.length > 0, "行应该是可聚焦的按钮角色");
	const row = rows[0];
	assert.equal(row.props["aria-expanded"], "false");
	row.props.onKeyDown({ key: "Enter", preventDefault() {} });
	assert.equal(panel.state.openCall, "c1", "回车应展开细节");
	assert.doesNotThrow(() => panel.render(), "展开后渲染不应抛错");
});
