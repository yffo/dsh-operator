#!/usr/bin/env node
/**
 * 场景矩阵 CLI（0.12.3）
 *
 *   node scripts/scenarios.mjs list [--layer L0] [--id L0-01] [--search 关键词] [--json]
 *   node scripts/scenarios.mjs sheet [--layer L0] [--out bench/2026-11-01-scenarios-sheet.md]
 *   node scripts/scenarios.mjs record --id L0-01 --success true --steps 5 --seconds 42 [--cost 0.12] [--failure timeouts] [--note "…"]
 *   node scripts/scenarios.mjs report [--file bench/results/2026-11-01-scenarios.jsonl]
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRunSheet, filterScenarios, loadScenarios, localDate, parseRecords, recordLine, renderSummaryTable, summarizeRecords } from "../lib/scenarios.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const resultsDir = join(root, "bench", "results");

function parseArgs(argv) {
	const flags = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg.startsWith("--") === false) continue;
		const key = arg.slice(2);
		const next = argv[index + 1];
		if (next === undefined || next.startsWith("--")) {
			flags[key] = true;
		} else {
			flags[key] = next;
			index += 1;
		}
	}
	return flags;
}

function today() {
	return localDate();
}

function summarizeId(scenarios, flags) {
	return filterScenarios(scenarios, { layer: flags.layer, id: flags.id, search: flags.search });
}

const [command, ...rest] = process.argv.slice(2);
const flags = parseArgs(rest);
const scenarios = loadScenarios();

switch (command) {
	case "list": {
		const selected = summarizeId(scenarios, flags);
		if (flags.json === true) {
			console.log(JSON.stringify(selected, null, 2));
			break;
		}
		for (const item of selected) console.log(`${item.id}\t${item.layer}\t${item.title}\t(${item.timeoutSec}s)`);
		console.log(`共 ${selected.length} 条`);
		break;
	}
	case "sheet": {
		const selected = summarizeId(scenarios, flags);
		const markdown = buildRunSheet(selected);
		const out = typeof flags.out === "string" ? flags.out : join(root, "bench", `${today()}-scenarios-sheet.md`);
		writeFileSync(out, markdown);
		console.log(`已生成 ${out}（${selected.length} 条）`);
		break;
	}
	case "record": {
		const record = {
			id: String(flags.id ?? ""),
			success: String(flags.success ?? "") === "true",
			steps: Number(flags.steps ?? Number.NaN),
			seconds: Number(flags.seconds ?? Number.NaN),
			...(flags.cost === undefined ? {} : { costCny: Number(flags.cost) }),
			...(flags.failure === undefined ? {} : { failureKind: String(flags.failure) }),
			...(flags.note === undefined ? {} : { note: String(flags.note) })
		};
		const line = recordLine(record);
		mkdirSync(resultsDir, { recursive: true });
		const file = join(resultsDir, `${today()}-scenarios.jsonl`);
		appendFileSync(file, `${line}\n`);
		console.log(`已记录 ${record.id} → ${file}`);
		break;
	}
	case "report": {
		let file = typeof flags.file === "string" ? flags.file : undefined;
		if (file === undefined) {
			const candidates = existsSync(resultsDir) ? readdirSync(resultsDir).filter((name) => name.endsWith("-scenarios.jsonl")).sort() : [];
			if (candidates.length === 0) {
				console.error("没有跑分记录（先 record）");
				process.exit(2);
			}
			file = join(resultsDir, candidates[candidates.length - 1]);
		}
		const records = parseRecords(readFileSync(file, "utf8"));
		const summary = summarizeRecords(records);
		console.log(`# ${file}\n`);
		console.log(renderSummaryTable(summary));
		break;
	}
	default:
		console.error("用法：node scripts/scenarios.mjs <list|sheet|record|report> [--layer --id --search --json --out --file --success --steps --seconds --cost --failure --note]");
		process.exit(2);
}
