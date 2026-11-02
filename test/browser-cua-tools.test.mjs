import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";

import { configureAuditLog } from "../lib/audit-log.js";
import { configureFailureStore, failureDir } from "../lib/failure-store.js";
import {
	BROWSER_TOOL_NAMES,
	browserToolsStatus,
	compactJson,
	dedupeStateText,
	hintForBrowserError,
	REFS_UNCHANGED_NOTE,
	registerBrowserTools,
	shouldRecoverWithSnapshot,
	summarizeState
} from "../lib/browser-cua-tools.js";

// 失败样本写临时目录，别污染真实 ~/.dsh/dsh-operator/failures。
configureFailureStore({ dir: mkdtempSync(join(tmpdir(), "dsh-browser-fail-")) });

let dir;
let fakeBin;
const previousBin = process.env.DSH_OPERATOR_CUA_BIN;
const previousOff = process.env.DSH_OPERATOR_BROWSER;

before(() => {
	dir = mkdtempSync(join(tmpdir(), "dsh-operator-browser-cua-"));
	fakeBin = join(dir, "cua-driver");
	writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n");
	chmodSync(fakeBin, 0o755);
	process.env.DSH_OPERATOR_CUA_BIN = fakeBin;
	delete process.env.DSH_OPERATOR_BROWSER;
	configureAuditLog({ enabled: false });
});

afterEach(() => {
	delete process.env.DSH_OPERATOR_BROWSER;
});

after(() => {
	if (previousBin === undefined) delete process.env.DSH_OPERATOR_CUA_BIN;
	else process.env.DSH_OPERATOR_CUA_BIN = previousBin;
	if (previousOff === undefined) delete process.env.DSH_OPERATOR_BROWSER;
	else process.env.DSH_OPERATOR_BROWSER = previousOff;
	configureAuditLog({ enabled: true });
	rmSync(dir, { recursive: true, force: true });
});

function setup(config = {}, call) {
	const tools = {};
	const ctx = { tools: { register: (tool) => { tools[tool.name] = tool; } } };
	const handle = registerBrowserTools(ctx, config, { defineTool: (definition) => definition, version: "0.25.0", ...(call === undefined ? {} : { call }) });
	return { tools, handle };
}

test("注册全部 browser_* 工具，schema 与 execute 齐备", () => {
	const { tools, handle } = setup();
	assert.equal(handle.registered, true);
	assert.deepEqual(handle.names, [...BROWSER_TOOL_NAMES]);
	assert.equal(Object.keys(tools).length, BROWSER_TOOL_NAMES.length);
	for (const name of BROWSER_TOOL_NAMES) {
		assert.equal(typeof tools[name].description, "string");
		assert.ok(tools[name].description.length > 20);
		assert.equal(typeof tools[name].execute, "function");
		assert.equal(typeof tools[name].parameters, "object");
	}
});

test("DSH_OPERATOR_BROWSER=0 时不注册", () => {
	process.env.DSH_OPERATOR_BROWSER = "0";
	const { tools, handle } = setup();
	assert.equal(handle.registered, false);
	assert.equal(handle.reason, "disabled");
	assert.equal(Object.keys(tools).length, 0);
});

test("hintForBrowserError 把拒绝码翻成人话", () => {
	assert.match(hintForBrowserError("refused: browser_consent_required"), /browser_state/);
	assert.match(hintForBrowserError("browser_requires_setup: call browser_prepare"), /foreground/);
	assert.match(hintForBrowserError("background_unavailable"), /foreground/);
	assert.match(hintForBrowserError("stale ref p1:3"), /browser_state/);
	assert.equal(hintForBrowserError("unrelated failure"), undefined);
});

test("summarizeState 汇总 tab 与 target", () => {
	const text = summarizeState({
		target_id: "t1",
		tab_id: "tab-2",
		tabs: [
			{ tab_id: "tab-1", title: "首页", url: "https://example.com/", active: false },
			{ tab_id: "tab-2", title: "登录", url: "https://example.com/login", active: true }
		],
		outline: "button 登录"
	});
	assert.match(text, /target_id=t1/);
	assert.match(text, /tab_id=tab-2/);
	assert.match(text, /tab-2 \(active\): 登录/);
	assert.match(text, /button 登录/);
});

test("summarizeState 兜底为紧凑 JSON", () => {
	assert.match(summarizeState({ foo: "bar" }), /"foo":"bar"/);
});

test("summarizeState 输出元素 refs，供 browser_click 直接使用", () => {
	const text = summarizeState({ target_id: "t1", tab_id: "tab1", refs: [{ ref: "p2:2", node: "a", label: "href=https://iana.org/help/example-domains" }] });
	assert.match(text, /refs \(1\)/);
	assert.match(text, /p2:2 a href=https:\/\/iana\.org/);
});

test("compactJson 超长时截断并提示", () => {
	const text = compactJson({ blob: "x".repeat(50) }, 20);
	assert.ok(text.length < 120);
	assert.match(text, /已截断/);
});

test("browser_open 拒绝非 http(s) 协议", async () => {
	const { tools } = setup();
	const value = await tools.browser_open.execute({ url: "file:///etc/passwd" }, {});
	assert.equal(value.ok, false);
	assert.match(value.text, /http/);
});

test("browser_state 缺参时给出明确提示", async () => {
	const { tools } = setup();
	const value = await tools.browser_state.execute({}, {});
	assert.equal(value.ok, false);
	assert.match(value.text, /pid\+window_id|target_id/);
});

test("browser_select 要求 ref 且 label/value 二选一", async () => {
	const { tools } = setup();
	const missing = await tools.browser_select.execute({ ref: "p1:2" }, {});
	assert.equal(missing.ok, false);
	const both = await tools.browser_select.execute({ ref: "p1:2", label: "a", value: "b" }, {});
	assert.equal(both.ok, false);
});

test("CDP 工具在 browserCdpPort=0 时给出开启指引", async () => {
	const { tools } = setup({ browserCdpPort: 0 });
	for (const name of ["browser_wait", "browser_console", "browser_network"]) {
		assert.equal(typeof tools[name].execute, "function");
		const value = await tools[name].execute({});
		assert.equal(value.ok, false);
		assert.match(value.text, /browserCdpPort/);
		assert.match(value.text, /remote-debugging-port/);
	}
});

test("CDP 工具在端口连不上时返回失败而不是抛错", async () => {
	const { tools } = setup({ browserCdpPort: 1 });
	const value = await tools.browser_wait.execute({ timeout_ms: 800 });
	assert.equal(value.ok, false);
	assert.match(value.text, /browser_wait 失败|CDP 后端不可用/);
});

test("browser_key 未绑定 pid 时给出绑定指引", async () => {
	const { tools } = setup({});
	const value = await tools.browser_key.execute({ key: "return" });
	assert.equal(value.ok, false);
	assert.match(value.text, /browser_state/);
});

test("browser_key 缺 key 时直接拒绝", async () => {
	const { tools } = setup({});
	const value = await tools.browser_key.execute({ pid: 123 });
	assert.equal(value.ok, false);
	assert.match(value.text, /需要 key/);
});

test("dedupeStateText：同一页面连续快照折叠 refs，页面变了回全文", () => {
	const state = {
		target_id: "t-dedupe-1",
		tab_id: "tab-dedupe-1",
		refs: Array.from({ length: 12 }, (_value, index) => ({ ref: `p1:${index}`, node: "link", label: `link ${index} with a fairly long label` }))
	};
	const text = summarizeState(state);
	const first = dedupeStateText(text, state);
	assert.equal(first, text);
	const second = dedupeStateText(text, state);
	assert.equal(second.includes(REFS_UNCHANGED_NOTE), true);
	assert.equal(second.includes("refs (2):"), false);
	const changed = { ...state, refs: [...state.refs, { ref: "p1:99", node: "link", label: "新元素" }] };
	const third = dedupeStateText(summarizeState(changed), changed);
	assert.equal(third.includes("refs (13):"), true);
});

test("dedupeStateText：小快照不折叠（说明行反而更长）", () => {
	const state = { target_id: "t-small", tab_id: "tab-small", refs: [{ ref: "p1:0", node: "link", label: "x" }] };
	const text = summarizeState(state);
	assert.equal(dedupeStateText(text, state), text);
	assert.equal(dedupeStateText(text, state), text);
});

test("dedupeStateText：没有 refs 时原样返回", () => {
	const text = "target_id=t1\ntab_id=tab";
	assert.equal(dedupeStateText(text, { target_id: "t1", tab_id: "tab", tabs: [] }), text);
});

test("shouldRecoverWithSnapshot：只对 ref 过期/找不到这类错误补快照", () => {
	assert.equal(shouldRecoverWithSnapshot("refused: browser_ref_stale: ref p1:2 is stale"), true);
	assert.equal(shouldRecoverWithSnapshot("the page navigated or the snapshot was superseded"), true);
	assert.equal(shouldRecoverWithSnapshot("element not found: #nope"), true);
	assert.equal(shouldRecoverWithSnapshot("browser_consent_required: grant needed"), false);
	assert.equal(shouldRecoverWithSnapshot("background_unavailable"), false);
	assert.equal(shouldRecoverWithSnapshot(""), false);
});

test("browser_open：导航后自动附最新快照，wait:false 时跳过", async () => {
	const calls = [];
	const call = async (tool, args) => {
		calls.push({ tool, args });
		if (tool === "browser_navigate") return { ok: true, result: { ok: true } };
		if (tool === "get_browser_state") {
			return {
				ok: true,
				result: {
					target_id: "t-open",
					tab_id: "tab-open",
					refs: Array.from({ length: 12 }, (_value, index) => ({ ref: `p1:${index}`, node: "link", label: `link ${index}` }))
				}
			};
		}
		return { ok: false, error: `unexpected ${tool}` };
	};
	const { tools } = setup({}, call);
	const bind = await tools.browser_state.execute({ target_id: "t-open", tab_id: "tab-open" }, {});
	assert.equal(bind.ok, true);
	calls.length = 0;
	const opened = await tools.browser_open.execute({ url: "https://example.com", target_id: "t-open", tab_id: "tab-open" }, {});
	assert.equal(opened.ok, true);
	assert.match(opened.text, /已打开 https:\/\/example\.com/);
	assert.match(opened.text, /refs \(12\)|refs_unchanged/);
	assert.deepEqual(calls.map((item) => item.tool), ["browser_navigate", "get_browser_state"]);
	calls.length = 0;
	const skipped = await tools.browser_open.execute({ url: "https://example.com", wait: false, target_id: "t-open", tab_id: "tab-open" }, {});
	assert.equal(skipped.ok, true);
	assert.deepEqual(calls.map((item) => item.tool), ["browser_navigate"]);
});

test("browser_click text：优先 semantic_v2 的 name/role，取不到时回退 dom_refs_v1", async () => {
	const seen = [];
	const variants = [
		{ snapshot_format: "semantic_v2", refs: [{ ref: "p2:1", role: "button", name: "保存草稿" }] },
		{ refs: [{ ref: "p3:4", node: "link", label: "保存草稿" }] }
	];
	let round = 0;
	const call = async (tool, args) => {
		if (tool === "get_browser_state") {
			const format = args.snapshot_format ?? "dom_refs_v1";
			seen.push(format);
			if (format === "semantic_v2" && seen.filter((item) => item === "semantic_v2").length > 1) {
				return { ok: false, error: "semantic_v2 unsupported" };
			}
			const picked = format === "semantic_v2" ? variants[0] : variants[1];
			round += 1;
			return { ok: true, result: { target_id: "t-v2", tab_id: "tab-v2", refs: picked.refs } };
		}
		if (tool === "browser_click") return { ok: true, result: {} };
		return { ok: false, error: `unexpected ${tool}` };
	};
	const { tools } = setup({}, call);
	await tools.browser_state.execute({ target_id: "t-v2", tab_id: "tab-v2" }, {});
	const v2 = await tools.browser_click.execute({ text: "保存" }, {});
	assert.equal(v2.ok, true);
	assert.match(v2.text, /已点击 p2:1/);
	assert.ok(seen.includes("semantic_v2"));
	const fallback = await tools.browser_click.execute({ text: "保存" }, {});
	assert.equal(fallback.ok, true);
	assert.match(fallback.text, /已点击 p3:4/);
	assert.ok(seen.includes("dom_refs_v1"));
});

test("browser_click text：唯一匹配直接点、歧义列候选、找不到给提示", async () => {
	const clicked = [];
	const refs = [
		{ ref: "p1:0", node: "link", label: "登录" },
		{ ref: "p1:1", node: "button", label: "登录并同意" },
		{ ref: "p1:2", node: "link", label: "帮助" }
	];
	const call = async (tool, args) => {
		if (tool === "get_browser_state") return { ok: true, result: { target_id: "t-text", tab_id: "tab-text", refs } };
		if (tool === "browser_click") { clicked.push(args.ref); return { ok: true, result: {} }; }
		return { ok: false, error: `unexpected ${tool}` };
	};
	const { tools } = setup({}, call);
	await tools.browser_state.execute({ target_id: "t-text", tab_id: "tab-text" }, {});
	const unique = await tools.browser_click.execute({ text: "帮助" }, {});
	assert.equal(unique.ok, true);
	assert.deepEqual(clicked, ["p1:2"]);
	const ambiguous = await tools.browser_click.execute({ text: "登录" }, {});
	assert.equal(ambiguous.ok, false);
	assert.match(ambiguous.text, /匹配到 2 个元素/);
	assert.match(ambiguous.text, /p1:0/);
	const picked = await tools.browser_click.execute({ text: "登录", index: 1 }, {});
	assert.equal(picked.ok, true);
	assert.deepEqual(clicked, ["p1:2", "p1:1"]);
	const missing = await tools.browser_click.execute({ text: "不存在的按钮" }, {});
	assert.equal(missing.ok, false);
	assert.match(missing.text, /没有找到/);
	const empty = await tools.browser_click.execute({}, {});
	assert.equal(empty.ok, false);
	assert.match(empty.text, /ref.*或 text|需要 ref/);
});

test("browser_* 失败会写入失败样本（browser_click）", async () => {
	const call = async (tool) => (tool === "browser_click" ? { ok: false, error: "ref p9:9 is stale — the snapshot was superseded" } : { ok: true, result: { target_id: "t-fail", tab_id: "tab-fail" } });
	const { tools } = setup({ failureSamples: true }, call);
	await tools.browser_state.execute({ target_id: "t-fail", tab_id: "tab-fail" }, {});
	const value = await tools.browser_click.execute({ ref: "p9:9" }, {});
	assert.equal(value.ok, false);
	const dir = failureDir();
	const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
	const rows = files.flatMap((name) => readFileSync(join(dir, name), "utf8").trim().split("\n").filter(Boolean)).map((line) => JSON.parse(line));
	const hit = rows.find((row) => row.tool === "browser_click");
	assert.ok(hit, "应有 browser_click 的失败样本");
	assert.equal(hit.kind, "not_found");
	assert.match(hit.message, /stale/);
});

test("browser_prepare：给 app 名自动解析窗口；歧义时列候选；找不到给提示", async () => {
	const windows = [
		{ pid: 100, window_id: 11, app: "Google Chrome", title: "GitHub — Chrome" },
		{ pid: 100, window_id: 12, app: "Google Chrome", title: "Docs — Chrome" },
		{ pid: 200, window_id: 21, app: "Safari", title: "Example" }
	];
	const preps = [];
	const call = async (tool, args) => {
		if (tool === "list_windows") return { ok: true, result: { windows } };
		if (tool === "browser_prepare") { preps.push(args); return { ok: true, result: { attached: true } }; }
		return { ok: true, result: {} };
	};
	const { tools } = setup({}, call);
	const ambiguous = await tools.browser_prepare.execute({ app: "Chrome" }, {});
	assert.equal(ambiguous.ok, false);
	assert.match(ambiguous.text, /匹配到 2 个窗口/);
	const picked = await tools.browser_prepare.execute({ app: "Chrome", window_title: "Docs" }, {});
	assert.equal(picked.ok, true);
	assert.equal(preps[0].pid, 100);
	assert.equal(preps[0].window_id, 12);
	assert.deepEqual(preps[0].strategy, { kind: "existing_profile" });
	const missing = await tools.browser_prepare.execute({ app: "Firefox" }, {});
	assert.equal(missing.ok, false);
	assert.match(missing.text, /没有找到/);
	const neither = await tools.browser_prepare.execute({}, {});
	assert.equal(neither.ok, false);
	assert.match(neither.text, /需要 pid \+ window_id/);
});

test("browser_download：下载后报告新增文件（名称 + 大小，不读内容）", async () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-download-"));
	writeFileSync(join(root, "old.txt"), "old");
	const call = async (tool, args) => {
		if (tool === "get_browser_state") return { ok: true, result: { target_id: "t-dl", tab_id: "tab-dl" } };
		if (tool === "browser_download") { writeFileSync(join(root, "report.pdf"), "x".repeat(2048)); return { ok: true, result: {} }; }
		return { ok: true, result: {} };
	};
	const { tools } = setup({}, call);
	await tools.browser_state.execute({ target_id: "t-dl", tab_id: "tab-dl" }, {});
	const ok = await tools.browser_download.execute({ ref: "p1:4", destination_root: root, confirm: true }, {});
	assert.equal(ok.ok, true);
	assert.match(ok.text, /已下载 1 个文件/);
	assert.match(ok.text, /report\.pdf（2\.0 KB）/);
	assert.equal(ok.text.includes("x".repeat(32)), false, "不应回传文件内容");
	const noNew = await tools.browser_download.execute({ ref: "p1:4", destination_root: mkdtempSync(join(tmpdir(), "dsh-download-")), confirm: true }, {});
	assert.equal(noNew.ok, true);
});

test("registerBrowserTools：注册成功后 browserToolsStatus 反映注册结果", () => {
	const { handle } = setup({}, async () => ({ ok: true, result: {} }));
	assert.equal(handle.registered, true);
	const state = browserToolsStatus();
	assert.equal(state.registered, true);
	assert.equal(state.names.length, BROWSER_TOOL_NAMES.length);
});


test("cua-driver 的 status:refused 记成失败（browser_download 审批被拒）", async () => {
	const call = async (tool) => {
		if (tool === "get_browser_state") return { ok: true, result: { target_id: "t-ref", tab_id: "tab-ref", refs: [] } };
		if (tool === "browser_download") {
			return {
				ok: true,
				result: {
					status: "refused",
					refusal: { code: "browser_consent_required", message: "browser_download requires approval through the MCP host's destructive-tool confirmation flow" }
				}
			};
		}
		return { ok: false, error: `unexpected ${tool}` };
	};
	const { tools } = setup({}, call);
	await tools.browser_state.execute({ target_id: "t-ref", tab_id: "tab-ref" }, {});
	const download = await tools.browser_download.execute({ ref: "p1:0", destination_root: "/tmp", confirm: true }, {});
	assert.equal(download.ok, false);
	assert.match(download.text, /approval|确认|拒绝|consent/i);
	assert.match(download.text, /destructive-tool confirmation|宿主确认/);
});


test("browser_download / set_input_files 的 stale ref 也会自动补快照", async () => {
	const call = async (tool) => {
		if (tool === "get_browser_state") return { ok: true, result: { target_id: "t-x", tab_id: "tab-x", refs: [{ ref: "p9:1", node: "a", label: "x" }] } };
		if (tool === "browser_download" || tool === "browser_set_input_files") return { ok: false, error: "ref p1:0 is stale — the page navigated" };
		return { ok: false, error: `unexpected ${tool}` };
	};
	const { tools } = setup({}, call);
	await tools.browser_state.execute({ target_id: "t-x", tab_id: "tab-x" }, {});
	const dl = await tools.browser_download.execute({ ref: "p1:0", destination_root: "/tmp", confirm: true }, {});
	assert.equal(dl.ok, false);
	assert.match(dl.text, /已自动重新取快照/);
	const files = await tools.browser_set_input_files.execute({ ref: "p1:1", files: ["/etc/hosts"] }, {});
	assert.equal(files.ok, false);
	assert.match(files.text, /已自动重新取快照/);
});


test("summarizeState：refs 超过 max_refs 时截断并说明还有多少", () => {
	const refs = Array.from({ length: 6 }, (_, index) => ({ ref: `p1:${String(index)}`, node: "a", label: `href=/${String(index)}` }));
	const text = summarizeState({ refs }, { maxRefs: 2 });
	assert.match(text, /^refs \(6\):/m);
	assert.match(text, /- p1:0 a href=\/0/);
	assert.doesNotMatch(text, /p1:2/);
	assert.match(text, /还有 4 个没列出/);
});


test("browser_click refresh:true 时把点击后的快照一起返回", async () => {
	let clicks = 0;
	const call = async (tool) => {
		if (tool === "browser_click") {
			clicks += 1;
			return { ok: true, result: { clicked: true } };
		}
		if (tool === "get_browser_state") return { ok: true, result: { target_id: "t-1", tab_id: "tab-1", refs: [{ ref: "p2:1", node: "a", label: "href=/next" }] } };
		return { ok: false, error: `unexpected ${tool}` };
	};
	const { tools } = setup({}, call);
	await tools.browser_state.execute({ target_id: "t-1", tab_id: "tab-1" }, {});
	const plain = await tools.browser_click.execute({ ref: "p1:1" }, {});
	assert.doesNotMatch(plain.text, /点击后的快照/);
	const refreshed = await tools.browser_click.execute({ ref: "p1:1", refresh: true }, {});
	assert.match(refreshed.text, /点击后的快照/);
	assert.match(refreshed.text, /p2:1/);
	assert.equal(clicks, 2);
});
