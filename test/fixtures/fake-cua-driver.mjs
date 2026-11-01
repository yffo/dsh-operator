#!/usr/bin/env node
// 测试用假 cua-driver：实现 status / call <tool> <json> 两个子命令，输出固定 fixture。
// 通过环境变量控制行为，方便单测覆盖失败分支。
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const JPEG_1X1 = Buffer.from(
	"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
	"base64"
);

const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64"
);

/** 去掉 cli 全局选项，返回子命令与参数。 */
function parseArgv(argv) {
	let socket;
	const rest = [...argv];
	while (rest[0] === "--socket") {
		socket = rest[1];
		rest.splice(0, 2);
	}
	return { socket, command: rest[0], args: rest.slice(1) };
}

function logInvocation(line) {
	const logPath = process.env.FAKE_CUA_LOG;
	if (typeof logPath === "string" && logPath.length > 0) appendFileSync(logPath, `${JSON.stringify(line)}\n`);
}

function windowsFixture() {
	return {
		current_space_id: 1,
		windows: [
			{
				app_name: "FakeApp",
				title: "Fake Report",
				pid: 4242,
				window_id: 7,
				bounds: { x: 100, y: 80, width: 640, height: 480 },
				layer: 0,
				on_current_space: true,
				is_on_screen: true,
				z_index: 9,
				current_space_id: 1,
				space_ids: [1]
			},
			{
				app_name: "FakeApp",
				title: "Fake Hidden",
				pid: 4242,
				window_id: 8,
				bounds: { x: 200, y: 120, width: 400, height: 300 },
				layer: 0,
				on_current_space: false,
				is_on_screen: false,
				z_index: 3,
				current_space_id: 2,
				space_ids: [2]
			}
		]
	};
}

/** 读 run_steps 的 fixture，或从 env 覆盖。 */
function runStepsFixture(payload) {
	if (process.env.FAKE_CUA_STALE_ONCE === "1") {
		const marker = process.env.FAKE_CUA_STALE_MARKER;
		if (typeof marker === "string" && marker.length > 0 && existsSync(marker) === false) {
			writeFileSync(marker, "1");
			return {
				ok: false,
				executed: 0,
				failed_step: 0,
				steps: [
					{
						ok: false,
						step_index: 0,
						tool: Array.isArray(payload?.steps) ? String(payload.steps[0]?.tool ?? "click") : "click",
						error: "element_token is stale; call get_window_state again to refresh; pid 4242 has no current snapshot"
					}
				]
			};
		}
	}
	const override = process.env.FAKE_CUA_RUN_STEPS;
	if (typeof override === "string" && override.length > 0) {
		const parsed = JSON.parse(override);
		if (parsed.observe === void 0) parsed.observe = { summary: "1 element changed", state: { snapshot_id: "s00000009", tree_markdown: "- [0] AXWindow \"Fake Report\"\n  - [1] AXButton \"Done\"" } };
		return parsed;
	}
	return {
		ok: true,
		steps: [{ ok: true, tool: Array.isArray(payload?.steps) ? String(payload.steps[0]?.tool ?? "click") : "click" }],
		observe: {
			summary: "1 element changed",
			state: { snapshot_id: "s00000009", tree_markdown: "- [0] AXWindow \"Fake Report\"\n  - [1] AXButton \"Done\"" }
		}
	};
}

function windowStateFixture(payload) {
	const wantShot = payload?.include_screenshot === true;
	const blocked = wantShot && process.env.FAKE_CUA_GWS_FAIL === "direct_capture_consent_required";
	if (wantShot && !blocked && typeof payload?.screenshot_out_file === "string") {
		writeFileSync(payload.screenshot_out_file, process.env.FAKE_CUA_PNG === "1" ? PNG_1X1 : JPEG_1X1);
	}
	if (process.env.FAKE_CUA_TREE_FORMAT_ELEMENTS === "1" || payload?.tree_format === "elements") {
		return {
			app_name: "FakeApp",
			pid: payload?.pid ?? 4242,
			window_id: payload?.window_id ?? 7,
			snapshot_id: "s00000002",
			element_count: 2,
			returned_element_count: 2,
			total_element_count: 2,
			elements_complete: false,
			tree_format: "elements",
			elements: [
				{ element_index: 0, element_token: "s00000002:0", role: "AXWindow", label: "Fake Report" },
				{ element_index: 1, element_token: "s00000002:1", role: "AXButton", label: "Done" }
			]
		};
	}
	return {
		app_name: "FakeApp",
		pid: payload?.pid ?? 4242,
		window_id: payload?.window_id ?? 7,
		window_title: "Fake Report",
		snapshot_id: "s00000004",
		element_count: 2,
		returned_element_count: 2,
		total_element_count: 2,
		elements_complete: true,
		tree_format: "markdown",
		truncated: false,
		tree_markdown: "- [0] AXWindow \"Fake Report\" [actions=[raise]]\n  - [1] AXButton \"Done\" [actions=[press]]",
		...blocked
			? {
					screenshot_error: {
						code: "px_capture_unavailable",
						reason:
							"direct_capture_consent_required: screen capture skipped. Ask the user to run `cua-driver permissions grant` and choose Allow once; the accessibility tree is unaffected."
					}
				}
			: {}
	};
}

const { command, args } = parseArgv(process.argv.slice(2));
if (command === "status") {
	logInvocation({ command: "status", args });
	console.log("Cua Driver daemon is running");
	console.log("socket: /tmp/fake-cua.sock");
	console.log("pid: 12345");
	console.log("permission mode: standard (built_in_default)");
	process.exit(0);
}
if (command === "call") {
	const tool = args[0];
	const payload = args[1] === void 0 ? {} : JSON.parse(args[1]);
	logInvocation({ command: "call", tool, payload });
	if (tool === "list_windows") {
		const fixture = windowsFixture();
		if (payload.on_screen_only === true) fixture.windows = fixture.windows.filter((window) => window.is_on_screen);
		console.log(JSON.stringify(fixture));
		process.exit(0);
	}
	if (tool === "get_screen_size") {
		console.log(JSON.stringify({ width: 1512, height: 982, scale_factor: 2 }));
		process.exit(0);
	}
	if (tool === "get_window_state") {
		console.log(JSON.stringify(windowStateFixture(payload)));
		process.exit(0);
	}
	if (tool === "run_steps") {
		console.log(JSON.stringify(runStepsFixture(payload)));
		process.exit(0);
	}
	console.log(JSON.stringify({ ok: true, tool }));
	process.exit(0);
}
console.error(`fake-cua-driver: unknown command ${String(command)}`);
process.exit(2);
