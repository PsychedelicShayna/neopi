import { formatBytes } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { getCatalog, getLocale, type Locale, t } from "@oh-my-pi/pi-utils/i18n";
import {
	DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY,
	getTinyLocalModelSpec,
	isTinyLocalModelKey,
	TINY_LOCAL_MODELS,
	type TinyLocalModelKey,
} from "../tiny/models";
import {
	ensureSmolLmWeights,
	getSmolLmModelDir,
	SMOLLM_LABEL,
	SMOLLM_TOTAL_BYTES,
	smolLmWeightsReady,
} from "../predict/smollm-weights";
import { shutdownTinyTitleClient, tinyTitleClient, tinyWorkerUsesMlx } from "../tiny/title-client";

/** CLI key for the word-completion model (`spelling.autocomplete` `auto`/`smollm`). */
const SMOLLM_KEY = "smollm";
export const TINY_MODEL_CHOICES = [...TINY_LOCAL_MODELS.map(spec => spec.key), SMOLLM_KEY, "all"];

export type TinyModelsAction = "download" | "list";

export interface TinyModelsCommandArgs {
	action: TinyModelsAction;
	model?: string;
	flags: {
		json?: boolean;
	};
}

/** One progress snapshot for the terminal bar. */
interface CliProgress {
	/** Percent 0–100, when known. */
	progress?: number;
	loaded?: number;
	total?: number;
	file?: string;
	ready?: boolean;
}

interface ProgressReporter {
	onProgress(event: CliProgress): void;
	finish(ok: boolean): void;
}

interface DownloadResult {
	model: string;
	ok: boolean;
	error?: string;
}

function writeLine(text = ""): void {
	process.stdout.write(`${text}\n`);
}

const ACTIONABLE_DOWNLOAD_ERROR_LINE = /PI_TINY_|CUDA|cuDNN|cudnn|libcudnn|tiny-title-runtime|onnxruntime-node/i;

function downloadErrorSummary(error: string | undefined): string | undefined {
	const lines =
		error
			?.split(/\r?\n/)
			.map(line => line.trim().replace(/^Error:\s*/, ""))
			.filter(line => line.length > 0) ?? [];
	const first = lines[0];
	if (!first) return undefined;
	const details = lines.slice(1).filter(line => ACTIONABLE_DOWNLOAD_ERROR_LINE.test(line));
	if (details.length === 0) return first;
	return [first, ...details].join("\n");
}

export function resolveModels(model: string | undefined, mlx = tinyWorkerUsesMlx()): TinyLocalModelKey[] {
	return resolveModelsForLocale(model, mlx, getLocale());
}

function resolveModelsForLocale(model: string | undefined, mlx: boolean, locale: Locale): TinyLocalModelKey[] {
	if (!model) return [DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY];
	// `all` is a prefetch convenience: skip models the active backend refuses before
	// load, so the bulk download stays green when every *usable* model succeeds.
	if (model === "all")
		return TINY_LOCAL_MODELS.filter(
			spec => mlx || !("onnxUnsupportedReason" in spec) || !spec.onnxUnsupportedReason,
		).map(spec => spec.key);
	if (!isTinyLocalModelKey(model)) {
		const values = TINY_LOCAL_MODELS.map(spec => spec.key).join(", ");
		throw new Error(
			t(locale, "cli.commands.tiny-models.unknown_model", { model, values, wordCompletion: SMOLLM_KEY }),
		);
	}
	return [model];
}

async function listModels(json: boolean | undefined): Promise<void> {
	const wordCompletion = {
		key: SMOLLM_KEY,
		label: SMOLLM_LABEL,
		description: "Word completion (spelling.autocomplete auto/smollm)",
		bytes: SMOLLM_TOTAL_BYTES,
		dir: getSmolLmModelDir(),
		ready: await smolLmWeightsReady(),
	};
	if (json) {
		writeLine(JSON.stringify({ models: TINY_LOCAL_MODELS, wordCompletion }));
		return;
	}
	writeLine(chalk.bold(t("cli.commands.tiny-models.title")));
	for (const spec of TINY_LOCAL_MODELS) {
		const defaultMark =
			spec.key === DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY ? chalk.cyan(` ${t("cli.commands.tiny-models.default")}`) : "";
		writeLine(`${chalk.cyan(spec.key)}${defaultMark}`);
		const descriptionKey = `cli.commands.tiny-models.description.${spec.key}`;
		const description = Object.hasOwn(getCatalog(), descriptionKey) ? t(descriptionKey) : spec.description;
		writeLine(`  ${spec.label} — ${description}`);
	}
	const status = wordCompletion.ready
		? chalk.green(t("cli.commands.tiny-models.downloaded"))
		: chalk.dim(t("cli.commands.tiny-models.not_downloaded"));
	writeLine(`${chalk.cyan(SMOLLM_KEY)}`);
	const description = t("cli.commands.tiny-models.word_completion");
	writeLine(`  ${SMOLLM_LABEL} — ${description}, ${formatBytes(SMOLLM_TOTAL_BYTES)}, ${status}`);
	writeLine(`  ${chalk.dim(wordCompletion.dir)}`);
}

function makeProgressReporter(label: string, json: boolean | undefined): ProgressReporter {
	if (json || !process.stdout.isTTY) {
		return { onProgress: () => undefined, finish: () => undefined };
	}
	let lastWidth = 0;
	let lastProgress = -1;
	const render = (event: CliProgress): void => {
		const progress = event.progress ?? lastProgress;
		if (progress >= 0 && progress < lastProgress + 1 && !event.ready) return;
		if (progress >= 0) lastProgress = progress;
		const ratio = progress >= 0 ? Math.max(0, Math.min(1, progress / 100)) : 0;
		const barWidth = 30;
		const filled = Math.round(ratio * barWidth);
		const bar = `${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`;
		const pct = progress >= 0 ? `${Math.floor(progress).toString().padStart(3, " ")}%` : " --%";
		const bytes = event.loaded && event.total ? ` ${formatBytes(event.loaded)}/${formatBytes(event.total)}` : "";
		const file = event.file ? ` ${event.file.split("/").at(-1) ?? event.file}` : "";
		const statusLabel = t(event.ready ? "cli.commands.tiny-models.ready" : "cli.commands.tiny-models.downloading");
		const line = `${chalk.cyan(statusLabel)} ${label} [${bar}] ${pct}${bytes}${file}`;
		process.stdout.write(`\r${line.padEnd(lastWidth)}`);
		lastWidth = line.length;
	};
	return {
		onProgress: render,
		finish(ok) {
			const suffix = ok
				? chalk.green(t("cli.commands.tiny-models.done"))
				: chalk.red(t("cli.commands.tiny-models.failed"));
			process.stdout.write(`\r${`${label}: ${suffix}`.padEnd(lastWidth)}\n`);
		},
	};
}

async function downloadOne(modelKey: TinyLocalModelKey, json: boolean | undefined): Promise<DownloadResult> {
	const label = getTinyLocalModelSpec(modelKey)?.label ?? modelKey;
	if (!json && !process.stdout.isTTY) {
		writeLine(t("cli.commands.tiny-models.downloading_model", { label, model: modelKey }));
	}
	const progress = makeProgressReporter(label, json);
	const result = await tinyTitleClient.downloadModel(modelKey, {
		onProgress: event => {
			if (event.modelKey !== modelKey) return;
			progress.onProgress({ ...event, ready: event.status === "ready" });
		},
	});
	progress.finish(result.ok);
	const error = downloadErrorSummary(result.error);
	if (!json && !process.stdout.isTTY) {
		if (result.ok) writeLine(t("cli.commands.tiny-models.downloaded_model", { label }));
		else if (error) writeLine(t("cli.commands.tiny-models.download_failed_detail", { label, error }));
		else writeLine(t("cli.commands.tiny-models.download_failed", { label }));
	} else if (!json && !result.ok && error) {
		writeLine(t("cli.commands.tiny-models.model_failed", { label, error }));
	}
	return result.error ? { model: modelKey, ok: result.ok, error: result.error } : { model: modelKey, ok: result.ok };
}

/** Fetch the word-completion model the composer would otherwise download on first use. */
async function downloadSmolLm(json: boolean | undefined): Promise<DownloadResult> {
	if (!json && !process.stdout.isTTY) {
		writeLine(t("cli.commands.tiny-models.downloading_model", { label: SMOLLM_LABEL, model: SMOLLM_KEY }));
	}
	const progress = makeProgressReporter(SMOLLM_LABEL, json);
	try {
		await ensureSmolLmWeights({
			onProgress: (loaded, file) =>
				progress.onProgress({
					progress: (loaded / SMOLLM_TOTAL_BYTES) * 100,
					loaded,
					total: SMOLLM_TOTAL_BYTES,
					file,
					ready: loaded === SMOLLM_TOTAL_BYTES,
				}),
		});
		progress.finish(true);
		if (!json && !process.stdout.isTTY) {
			writeLine(t("cli.commands.tiny-models.downloaded_to", { label: SMOLLM_LABEL, path: getSmolLmModelDir() }));
		}
		return { model: SMOLLM_KEY, ok: true };
	} catch (error) {
		progress.finish(false);
		const message = error instanceof Error ? error.message : String(error);
		if (!json) writeLine(t("cli.commands.tiny-models.model_failed", { label: SMOLLM_LABEL, error: message }));
		return { model: SMOLLM_KEY, ok: false, error: message };
	}
}

export async function runTinyModelsCommand(command: TinyModelsCommandArgs): Promise<void> {
	if (command.action === "list") {
		await listModels(command.flags.json);
		return;
	}

	const wantsSmolLm = command.model === SMOLLM_KEY || command.model === "all";
	const locale = command.flags.json ? "en" : getLocale();
	const models =
		command.model === SMOLLM_KEY ? [] : resolveModelsForLocale(command.model, tinyWorkerUsesMlx(), locale);
	const results: DownloadResult[] = [];
	try {
		for (const model of models) {
			results.push(await downloadOne(model, command.flags.json));
		}
	} finally {
		await shutdownTinyTitleClient();
	}
	if (wantsSmolLm) results.push(await downloadSmolLm(command.flags.json));

	if (command.flags.json) {
		writeLine(JSON.stringify({ results }));
	}
	if (results.some(result => !result.ok)) {
		throw new Error(t(locale, "cli.commands.tiny-models.downloads_failed"));
	}
}
