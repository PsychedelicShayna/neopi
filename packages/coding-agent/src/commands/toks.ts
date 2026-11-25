/**
 * Count a file or text through every embedded offline tokenizer and print a
 * per-encoding stats table (see `crates/natives/src/utok`).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { APP_NAME, formatBytes } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { t } from "@oh-my-pi/pi-utils/i18n";
import { toksHelp as commandHelp } from "../cli/command-help";

/** Display name and served model lines per native encoding; `Record` keeps it exhaustive. */
const ENCODINGS: Record<natives.Encoding, { name: string; models: string }> = {
	[natives.Encoding.O200kBase]: { name: "o200k_base", models: "GPT-4o · o1 · GPT-5+" },
	[natives.Encoding.Cl100kBase]: { name: "cl100k_base", models: "GPT-3.5 · GPT-4" },
	[natives.Encoding.ClaudeV3]: { name: "claude-v3", models: "Claude 3 … Opus 4.6" },
	[natives.Encoding.ClaudeV47]: { name: "claude-v47", models: "Opus 4.7–4.9" },
	[natives.Encoding.ClaudeV5]: { name: "claude-v5", models: "Opus 5+" },
	[natives.Encoding.ClaudeV5Sonnet]: { name: "claude-v5-sonnet", models: "Sonnet/Fable 5+ · Haiku 5.5" },
	[natives.Encoding.Qwen3]: { name: "qwen3", models: "Qwen 3.5+" },
	[natives.Encoding.DeepSeekV3]: { name: "deepseek-v3", models: "DeepSeek V3–V4" },
	[natives.Encoding.KimiK2]: { name: "kimi-k2", models: "Kimi K2–K3" },
	[natives.Encoding.Glm5]: { name: "glm5", models: "GLM-5.x" },
	[natives.Encoding.Jev]: { name: "jev", models: "TypeSafe Jev 1.13" },
};

type Source = { kind: "file"; path: string } | { kind: "text" };

/** Reads `input` as a file when it names one; any other input is literal text. */
async function resolveInput(input: string): Promise<{ source: Source; text: string }> {
	const filePath = path.resolve(input);
	// Unstattable (missing, name too long, invalid chars) means it is text, not a path.
	const stat = await fs.stat(filePath).catch(() => undefined);
	if (stat?.isDirectory()) throw new CliUsageError(t("cli.commands.toks.isDirectory", { input }));
	if (stat?.isFile()) return { source: { kind: "file", path: filePath }, text: await Bun.file(filePath).text() };
	return { source: { kind: "text" }, text: input };
}

/** Unicode scalar count: UTF-16 length minus the trailing half of each surrogate pair. */
function countChars(text: string): number {
	let low = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xdc00 && code <= 0xdfff) low++;
	}
	return text.length - low;
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	let lines = 0;
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++;
	return text.endsWith("\n") ? lines : lines + 1;
}

const int = (n: number): string => n.toLocaleString("en-US");

export default class Toks extends Command {
	static description = commandHelp.description;
	static args = {
		input: Args.string({
			description: "File path, or literal text when it does not name a file",
			required: true,
			multiple: true,
		}),
	};
	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
	};

	static examples = [
		`${APP_NAME} toks README.md`,
		`${APP_NAME} toks "The quick brown fox jumps over the lazy dog"`,
		`${APP_NAME} toks src/main.ts --json`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Toks);
		const input = (args.input ?? []).join(" ");
		if (input.length === 0) throw new CliUsageError(t("cli.commands.toks.missingInput"));

		const { source, text } = await resolveInput(input);
		const bytes = Buffer.byteLength(text, "utf-8");
		const chars = countChars(text);
		const lines = countLines(text);
		const rows = Object.values(natives.Encoding).map(encoding => ({
			encoding,
			...ENCODINGS[encoding],
			tokens: natives.countTokens(text, encoding),
		}));

		if (flags.json) {
			process.stdout.write(`${JSON.stringify({ source, bytes, chars, lines, encodings: rows }, null, 2)}\n`);
			return;
		}

		const baseline = rows.find(row => row.encoding === natives.Encoding.O200kBase)?.tokens ?? 0;
		const label =
			source.kind === "file"
				? path.relative(process.cwd(), source.path) || source.path
				: t("cli.commands.toks.text");
		const charCount = t(chars === 1 ? "cli.commands.toks.char" : "cli.commands.toks.chars", { count: int(chars) });
		const lineCount = t(lines === 1 ? "cli.commands.toks.line" : "cli.commands.toks.lines", { count: int(lines) });
		const out = [
			t("cli.commands.toks.inputRow", { input: chalk.dim(t("cli.commands.toks.input")), label }),
			t("cli.commands.toks.sizeRow", {
				size: chalk.dim(t("cli.commands.toks.size")),
				bytes: formatBytes(bytes),
				chars: charCount,
				lines: lineCount,
			}),
			"",
			chalk.dim(
				t("cli.commands.toks.encoding").padEnd(18) +
					t("cli.commands.toks.models").padEnd(22) +
					t("cli.commands.toks.tokens").padStart(10) +
					t("cli.commands.toks.ratio").padStart(11) +
					t("cli.commands.toks.delta").padStart(10),
			),
		];
		for (const row of rows) {
			const ratio = row.tokens > 0 ? (chars / row.tokens).toFixed(2) : "—";
			const delta =
				row.encoding === natives.Encoding.O200kBase || baseline === 0
					? "—"
					: `${row.tokens >= baseline ? "+" : ""}${(((row.tokens - baseline) / baseline) * 100).toFixed(1)}%`;
			out.push(
				`${row.name.padEnd(18)}${chalk.dim(row.models.padEnd(22))}${chalk.bold(int(row.tokens).padStart(10))}${ratio.padStart(11)}${delta.padStart(10)}`,
			);
		}
		process.stdout.write(`${out.join("\n")}\n`);
	}
}
