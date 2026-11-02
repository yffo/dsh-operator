// dsh-operator 剪贴板工具（macOS 原生 pbcopy/pbpaste）
//
// 竞品的常见缺口：把长文本/图片/文件放进剪贴板，再用一次 Cmd+V 完成输入——
// 比逐字输入省 token，也比截图+OCR 稳。读取是隐私敏感操作，输出有硬上限。

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";

export const CLIPBOARD_TOOL_NAMES = ["clipboard_read", "clipboard_write"];

const DEFAULT_MAX_CHARS = 4000;
const HARD_MAX_CHARS = 20000;
const APPLE_SCRIPT_TIMEOUT_MS = 4000;

function defaultRun(command, args, options = {}) {
	return new Promise((resolve) => {
		const child = execFile(command, args, { timeout: APPLE_SCRIPT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
			resolve({ ok: error === null, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), error: error === null ? undefined : error.message });
		});
		if (options.input !== undefined) {
			child.stdin?.end(String(options.input));
		}
	});
}

/** 把一段文本截到上限，并标记是否截断（也用于单测）。 */
export function clampClipboardText(text, maxChars = DEFAULT_MAX_CHARS) {
	const limit = Number.isInteger(Number(maxChars)) && Number(maxChars) > 0 ? Math.min(HARD_MAX_CHARS, Number(maxChars)) : DEFAULT_MAX_CHARS;
	const value = String(text ?? "");
	if (value.length <= limit) return { text: value, truncated: false };
	return { text: value.slice(0, limit), truncated: true };
}

/** 生成“把文件放到剪贴板”的 AppleScript；拒绝非绝对路径，避免相对路径在 oascript 里乱解析。 */
export function clipboardFileScript(filePath, asImage = false) {
	const value = String(filePath ?? "");
	if (value.startsWith("/") === false) throw new Error("clipboard: file path must be absolute");
	const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return asImage
		? `set the clipboard to (read (POSIX file "${escaped}") as TIFF picture)`
		: `set the clipboard to POSIX file "${escaped}"`;
}

/**
 * 注册剪贴板工具（仅 macOS；其他平台跳过）。
 * @param {object} ctx 宿主上下文。
 * @param {object} config 插件配置。
 * @param {{defineTool:Function, version:string, run?:Function}} deps
 * @returns {{registered:boolean, names:string[]}}
 */
export function registerClipboardTools(ctx, config, { defineTool, version, run = defaultRun } = {}) {
	if (process.platform !== "darwin") return { registered: false, names: [] };
	void config;
	void version;
	// 必须经 ctx.tools.register 注册；直接调 defineTool 只是拼装定义，宿主看不到（0.46.2 修复）。
	const register = (definition) => {
		const registered = defineTool(definition);
		if (ctx !== null && typeof ctx === "object" && ctx.tools !== undefined && typeof ctx.tools.register === "function") return ctx.tools.register(registered);
		return registered;
	};

	register({
		name: "clipboard_read",
		description: "Read the macOS clipboard: list available types and (optionally) the plain-text content, truncated to max_chars. Privacy-sensitive: only call when the user asks or the text is needed for the current step. Images/files are reported by type only, never dumped.",
		parameters: {
			max_chars: { type: "integer", description: "Maximum text characters to return (default 4000, hard cap 20000)." },
			include_types: { type: "boolean", description: "Also list the clipboard's available pasteboard types (extra ~80ms)." }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					schemaVersion: { type: "number", required: true },
					text: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
		},
		isConcurrencySafe: () => true,
		presentCall: () => "Read clipboard",
		execute: async (args) => {
			const textResult = await run("pbpaste", ["-Prefer", "txt"]);
			const { text, truncated } = clampClipboardText(textResult.stdout, args?.max_chars);
			let types = [];
			if (args?.include_types === true) {
				const info = await run("osascript", ["-e", "clipboard info"]);
				types = String(info.stdout ?? "")
					.split("\n")
					.map((line) => line.split(",")[0]?.trim().replace(/^«class |»$/g, ""))
					.filter((name) => name !== undefined && name !== "");
			}
			const chars = text.length;
			const head = chars === 0 ? "clipboard: empty text" : `clipboard: ${String(chars)} chars${truncated ? " (truncated)" : ""}`;
			const typeLine = types.length === 0 ? "" : `\ntypes: ${types.join(", ")}`;
			const body = text === "" ? "" : `\ntext:\n${text}`;
			return { schemaVersion: 1, text: `${head}${typeLine}${body}` };
		}
	});

	register({
		name: "clipboard_write",
		description: "Replace the macOS clipboard with exactly one value: plain text (best for long strings you then paste with Cmd+V), an image from an absolute path, or a file URL from an absolute path. Returns what was written.",
		parameters: {
			text: { type: "string", description: "Plain text to put on the clipboard." },
			image_path: { type: "string", description: "Absolute path to an image file; put the image itself on the clipboard." },
			file_path: { type: "string", description: "Absolute path to a file; put a file URL on the clipboard (paste into Finder/upload fields)." }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					schemaVersion: { type: "number", required: true },
					text: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
		},
		isConcurrencySafe: () => false,
		presentCall: (args) => `Write clipboard (${String(args?.text !== undefined ? "text" : args?.image_path !== undefined ? "image" : "file")})`,
		execute: async (args) => {
			const provided = [args?.text !== undefined, args?.image_path !== undefined, args?.file_path !== undefined].filter(Boolean).length;
			if (provided !== 1) return { schemaVersion: 1, text: "clipboard_write: exactly one of text / image_path / file_path is required" };
			if (args?.text !== undefined) {
				const text = String(args.text);
				const wrote = await run("pbcopy", [], { input: text });
				if (wrote.ok !== true) return { schemaVersion: 1, text: `clipboard_write: pbcopy failed: ${wrote.error ?? wrote.stderr}` };
				return { schemaVersion: 1, text: `clipboard_write: text · ${String(text.length)} chars` };
			}
			const isImage = args?.image_path !== undefined;
			const filePath = String(isImage ? args.image_path : args.file_path);
			if (filePath.startsWith("/") === false) return { schemaVersion: 1, text: "clipboard_write: path must be absolute" };
			if (existsSync(filePath) === false) return { schemaVersion: 1, text: "clipboard_write: file not found" };
			if (isImage === true && statSync(filePath).isFile() === false) return { schemaVersion: 1, text: "clipboard_write: not a regular file" };
			const script = clipboardFileScript(filePath, isImage);
			const wrote = await run("osascript", ["-e", script]);
			if (wrote.ok !== true) return { schemaVersion: 1, text: `clipboard_write: osascript failed: ${wrote.error ?? wrote.stderr}` };
			return { schemaVersion: 1, text: `clipboard_write: ${isImage ? "image" : "file"} · ${filePath}` };
		}
	});

	return { registered: true, names: [...CLIPBOARD_TOOL_NAMES] };
}
