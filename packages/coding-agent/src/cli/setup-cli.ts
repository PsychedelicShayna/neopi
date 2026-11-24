/**
 * Setup CLI command handler.
 *
 * Handles `npi setup` for onboarding and `npi setup <component>` for optional dependencies.
 */
import * as path from "node:path";
import { APP_NAME, getProjectDir, getPythonEnvDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { getLocale, type Locale, t } from "@oh-my-pi/pi-utils/i18n";
import { formatKeyHint } from "@oh-my-pi/pi-tui/key-hint-format";
import { Settings } from "../config/settings";
import { ModelRegistry } from "../config/model-registry";
import { resolveRoleChain } from "../config/model-resolver";
import { roleCandidatePool } from "../config/model-roles";
import { checkPythonKernelAvailability } from "../eval/py/kernel";
import { discoverAuthStorage } from "../sdk";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { downloadSttModel, isSttModelCached } from "../stt/downloader";
import { isSttModelKey, STT_MODEL_OPTIONS } from "../stt/models";
import { downloadTtsModel, isTtsLocalModelKey, isTtsModelCached, TTS_LOCAL_MODELS } from "../tts";
import { selectSetupModel } from "@oh-my-pi/pi-tui/apps/setup-model-picker";
import { setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";

import { cfgPythonInterpreter } from "../eval/settings";
import { cfgTuiVimMode } from "../modes/settings";

export type SetupComponent = "python" | "speech";

export interface SetupCommandArgs {
	component: SetupComponent;
	flags: {
		json?: boolean;
		check?: boolean;
	};
}

const VALID_COMPONENTS: SetupComponent[] = ["python", "speech"];

const MANAGED_PYTHON_ENV = getPythonEnvDir();

/**
 * Parse setup subcommand arguments.
 * Returns undefined if not a setup command.
 */
export function parseSetupArgs(args: string[]): SetupCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "setup") {
		return undefined;
	}

	if (args.length < 2) {
		console.error(chalk.red(`${t("cli.commands.shell.usage")} ${APP_NAME} setup <component>`));
		console.error(t("cli.commands.setup.valid_components", { components: VALID_COMPONENTS.join(", ") }));
		process.exit(1);
	}

	const component = args[1];
	if (!VALID_COMPONENTS.includes(component as SetupComponent)) {
		console.error(chalk.red(t("cli.commands.setup.unknown_component", { component })));
		console.error(t("cli.commands.setup.valid_components", { components: VALID_COMPONENTS.join(", ") }));
		process.exit(1);
	}

	const flags: SetupCommandArgs["flags"] = {};
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			flags.json = true;
		} else if (arg === "--check" || arg === "-c") {
			flags.check = true;
		}
	}

	return {
		component: component as SetupComponent,
		flags,
	};
}

export interface PythonCheckResult {
	available: boolean;
	pythonPath?: string;
	usingManagedEnv?: boolean;
	managedEnvPath?: string;
}

function managedPythonPath(): string {
	return process.platform === "win32"
		? path.join(MANAGED_PYTHON_ENV, "Scripts", "python.exe")
		: path.join(MANAGED_PYTHON_ENV, "bin", "python");
}

/**
 * Check Python environment and kernel dependencies.
 */
export async function checkPythonSetup(cwd: string, interpreter?: string): Promise<PythonCheckResult> {
	const availability = await checkPythonKernelAvailability(cwd, interpreter, { forceProbe: true });
	return {
		available: availability.ok,
		pythonPath: availability.pythonPath,
		usingManagedEnv: availability.pythonPath === managedPythonPath(),
		managedEnvPath: MANAGED_PYTHON_ENV,
	};
}

/**
 * Install Python packages using uv (preferred) or pip.
 */
// Python installation helper removed: the subprocess runner has no Python
// package dependencies beyond a working interpreter. `npi setup python --check`
// remains as a probe; users install optional libs (pandas, matplotlib, ...)
// directly via pip or the in-process `%pip` magic.

/**
 * Run the setup command.
 */
export async function runSetupCommand(cmd: SetupCommandArgs): Promise<void> {
	switch (cmd.component) {
		case "python":
			await handlePythonSetup(cmd.flags);
			break;
		case "speech":
			await handleSpeechSetup(cmd.flags);
			break;
	}
}

async function handlePythonSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	const cwd = getProjectDir();
	const projectSettings = await Settings.init({ cwd });
	const interpreter = cfgPythonInterpreter.get(projectSettings)?.trim() || undefined;
	const check = await checkPythonSetup(cwd, interpreter);

	if (flags.json) {
		console.log(JSON.stringify(check, null, 2));
		if (!check.available) process.exit(1);
		return;
	}

	if (!check.pythonPath) {
		console.error(chalk.red(`${theme.status.error} ${t("cli.commands.setup.python_not_found")}`));
		console.error(chalk.dim(t("cli.commands.setup.python_install_hint")));
		process.exit(1);
	}

	console.log(chalk.dim(`Python: ${check.pythonPath}`));
	if (check.usingManagedEnv) {
		console.log(chalk.dim(t("cli.commands.setup.python_managed_env", { path: String(check.managedEnvPath) })));
	}

	if (check.available) {
		console.log(chalk.green(`\n${theme.status.success} ${t("cli.commands.setup.python_ready")}`));
		return;
	}

	console.error(chalk.red(`\n${theme.status.error} ${t("cli.commands.setup.python_interpreter_failed")}`));
	process.exit(1);
}

/**
 * One installable speech dependency. `isReady`/`status` are read-only probes;
 * `pick` (optional) lets an interactive user choose + persist a model; `ensure`
 * performs the download, streaming a normalized progress event.
 */
interface SpeechComponent {
	labelKey: string;
	isReady(): Promise<boolean>;
	status(locale?: Locale): Promise<string>;
	pick?(): Promise<boolean>;
	ensure(onProgress: (progress: { stage: string; percent?: number }) => void): Promise<void>;
}

function buildSpeechComponents(settings: Settings, registry: ModelRegistry, json: boolean): SpeechComponent[] {
	const resolveModelId = (role: "speech" | "dictation"): string => {
		const candidate = resolveRoleChain(role, settings, roleCandidatePool(role, settings, registry)).find(
			entry => entry.model.provider === "local",
		);
		if (!candidate) throw new Error(t(json ? "en" : getLocale(), "cli.commands.setup.no_local_model", { role }));
		return candidate.model.id;
	};
	const localRoleModelIds = (role: "speech" | "dictation") =>
		new Set(
			roleCandidatePool(role, settings, registry)
				.filter(model => model.provider === "local")
				.map(model => model.id),
		);
	const sttOptions = STT_MODEL_OPTIONS.filter(option => localRoleModelIds("dictation").has(option.value));
	const ttsOptions = TTS_LOCAL_MODELS.filter(model => localRoleModelIds("speech").has(model.key)).map(
		({ key, label, description }) => ({ value: key, label, description }),
	);

	return [
		{
			labelKey: "cli.commands.setup.stt_model",
			isReady: () => isSttModelCached(resolveModelId("dictation")),
			status: async (locale = getLocale()) => {
				const key = resolveModelId("dictation");
				return (await isSttModelCached(key)) ? key : t(locale, "cli.commands.setup.not_downloaded", { model: key });
			},
			pick: async () => {
				const current = resolveModelId("dictation");
				const chosen = await selectSetupModel(t("cli.commands.setup.stt_model"), sttOptions, current);
				if (chosen === null) return false;
				if (isSttModelKey(chosen)) {
					settings.setModelRole("dictation", `local/${chosen}`);
					await settings.flush();
				}
				return true;
			},
			ensure: onProgress =>
				downloadSttModel(resolveModelId("dictation"), progress =>
					onProgress({
						stage: t("cli.commands.setup.downloading_model", { model: progress.label }),
						percent: progress.percent,
					}),
				),
		},
		{
			labelKey: "cli.commands.setup.tts_model",
			isReady: () => isTtsModelCached(resolveModelId("speech")),
			status: async (locale = getLocale()) => {
				const key = resolveModelId("speech");
				return (await isTtsModelCached(key)) ? key : t(locale, "cli.commands.setup.not_downloaded", { model: key });
			},
			pick: async () => {
				const current = resolveModelId("speech");
				const chosen = await selectSetupModel(t("cli.commands.setup.tts_model"), ttsOptions, current);
				if (chosen === null) return false;
				if (isTtsLocalModelKey(chosen)) {
					settings.setModelRole("speech", `local/${chosen}`);
					await settings.flush();
				}
				return true;
			},
			ensure: async onProgress => {
				const ok = await downloadTtsModel(resolveModelId("speech"), progress =>
					onProgress({ stage: progress.stage, percent: progress.percent }),
				);
				if (!ok) throw new Error(t("cli.commands.setup.tts_download_failed"));
			},
		},
	];
}

/**
 * Unified `npi setup speech` flow. Drives every {@link SpeechComponent} through
 * one path: report (`--json`/`--check`) or install (interactive pick + ensure
 * with single-line progress; non-TTY skips pickers and installs configured
 * values).
 */
async function handleSpeechSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	const settings = await Settings.init({ cwd: getProjectDir() });
	setMenuSearchVimMode(cfgTuiVimMode.get(settings));
	const authStorage = await discoverAuthStorage(undefined, { settings });
	const registry = new ModelRegistry(authStorage, undefined, { settings });
	const components = buildSpeechComponents(settings, registry, flags.json === true);

	if (flags.json) {
		const report: Record<string, { ready: boolean; status: string }> = {};
		let allReady = true;
		for (const component of components) {
			const ready = await component.isReady();
			if (!ready) allReady = false;
			report[t("en", component.labelKey)] = { ready, status: await component.status("en") };
		}
		console.log(JSON.stringify(report, null, 2));
		if (!allReady) process.exit(1);
		return;
	}

	if (flags.check) {
		console.log(chalk.bold(t("cli.commands.setup.speech_dependencies")));
		let allReady = true;
		for (const component of components) {
			const ready = await component.isReady();
			if (!ready) allReady = false;
			const mark = ready ? chalk.green(t("cli.commands.setup.ok")) : chalk.yellow(t("cli.commands.setup.missing"));
			console.log(`  ${mark} ${t(component.labelKey)}: ${await component.status()}`);
		}
		if (!allReady) process.exit(1);
		return;
	}

	const interactive = Boolean(process.stdout.isTTY);
	for (const component of components) {
		if (interactive && component.pick) {
			await component.pick();
		}
		const model = t(component.labelKey);
		if (await component.isReady()) {
			console.log(chalk.green(`${theme.status.success} ${t("cli.commands.setup.component_ready", { model })}`));
			continue;
		}
		console.log(chalk.dim(t("cli.commands.setup.preparing_component", { model })));
		try {
			await component.ensure(progress => {
				const percent = typeof progress.percent === "number" ? ` (${progress.percent}%)` : "";
				process.stdout.write(`\r${chalk.dim(`${progress.stage}${percent}`)}\x1b[K`);
			});
			process.stdout.write("\n");
		} catch (err) {
			process.stdout.write("\n");
			const msg = err instanceof Error ? err.message : t("cli.commands.setup.component_failed", { model });
			console.error(chalk.red(`${theme.status.error} ${msg}`));
			process.exit(1);
		}
	}

	console.log(chalk.green(`\n${theme.status.success} ${t("cli.commands.setup.speech_ready")}`));
	console.log(chalk.dim(t("cli.commands.setup.speech_hint", { key: formatKeyHint("space") })));
}

/**
 * Print setup command help.
 */
export function printSetupHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} setup`)} - ${t("cli.commands.setup.help_title")}

${chalk.bold(t("cli.commands.shell.usage"))}
  ${APP_NAME} setup                     ${t("cli.commands.setup.help_wizard")}
  ${APP_NAME} setup <component> [options]

${chalk.bold(t("cli.commands.setup.components"))}
  python    ${t("cli.commands.setup.help_python")}
  speech    ${t("cli.commands.setup.help_speech")}

${chalk.bold(t("cli.config.help.options"))}
  -c, --check   ${t("cli.commands.setup.help_check")}
  --json        ${t("cli.commands.setup.help_json")}

${chalk.bold(t("cli.config.help.examples"))}
  ${APP_NAME} setup                  ${t("cli.commands.setup.help_wizard")}
  ${APP_NAME} setup python           ${t("cli.commands.setup.example_python")}
  ${APP_NAME} setup speech           ${t("cli.commands.setup.example_speech")}
  ${APP_NAME} setup speech --check   ${t("cli.commands.setup.example_speech_check")}
  ${APP_NAME} setup python --check   ${t("cli.commands.setup.example_python_check")}
`);
}
