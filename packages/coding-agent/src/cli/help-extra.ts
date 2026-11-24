import "@oh-my-pi/pi-utils/env";
import { APP_NAME } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils/dirs";
import { logger } from "@oh-my-pi/pi-utils";
import { setLocale, t, type TranslationValues } from "@oh-my-pi/pi-utils/i18n";
import { Settings } from "../config/settings";
import { BUILTIN_TOOL_HELP, type BuiltinToolHelp } from "../tools/builtin-names";
import { cfgLanguage } from "../modes/settings";

/** Load the configured language without initializing the interactive session or writing settings. */
export async function initializeCliLanguage(): Promise<void> {
	try {
		const settings = await Settings.loadReadOnly();
		setLocale(cfgLanguage.get(settings));
	} catch (error) {
		logger.warn("Could not load language for CLI; using English", { error: String(error) });
		setLocale("en");
	}
}

export function translateHelpHeading(key: string, fallback: string, values?: TranslationValues): string {
	const translated = t(key, values);
	return translated === key ? fallback : translated;
}

function renderBuiltinToolSummary(name: string, help: BuiltinToolHelp): string {
	const key = `cli.extraHelp.tool.${name}`;
	const summary = translateHelpHeading(key, help.summary);
	if (help.defaultState !== "detected") return summary;
	const condition = translateHelpHeading(`${key}.detectedWhen`, help.detectedWhen);
	return t("cli.extraHelp.toolDetected", { summary, condition });
}

/** Lists tools in `BUILTIN_TOOL_HELP` entry order, which ranks them by how often they are used. */
function renderBuiltinTools(group: "default" | "optional"): string {
	return Object.entries(BUILTIN_TOOL_HELP)
		.filter(([, help]) => (help.defaultState === "off") === (group === "optional"))
		.map(([name, help]) => `  ${name.padEnd(14)}- ${renderBuiltinToolSummary(name, help)}`)
		.join("\n");
}

export function getExtraHelpText(): string {
	return `${chalk.bold(t("cli.extraHelp.proxyHeading"))}
  ${APP_NAME} login neoproxy --url https://proxy.example.com
  ${t("cli.extraHelp.proxyPrompt")}
  ${t("cli.extraHelp.proxyModels")}
  ${t("cli.extraHelp.proxyTransport")}

${chalk.bold(t("cli.extraHelp.envHeading"))}
  ${chalk.dim(t("cli.extraHelp.coreProviders"))}
  ANTHROPIC_API_KEY          - ${t("cli.extraHelp.env.ANTHROPIC_API_KEY")}
  ANTHROPIC_OAUTH_TOKEN      - ${t("cli.extraHelp.env.ANTHROPIC_OAUTH_TOKEN")}
  CLAUDE_CODE_USE_FOUNDRY    - ${t("cli.extraHelp.env.CLAUDE_CODE_USE_FOUNDRY")}
  FOUNDRY_BASE_URL           - ${t("cli.extraHelp.env.FOUNDRY_BASE_URL")}
  ANTHROPIC_FOUNDRY_API_KEY  - ${t("cli.extraHelp.env.ANTHROPIC_FOUNDRY_API_KEY")}
  ANTHROPIC_CUSTOM_HEADERS   - ${t("cli.extraHelp.env.ANTHROPIC_CUSTOM_HEADERS")}
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS - ${t("cli.extraHelp.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS")}
  CLAUDE_CODE_CLIENT_CERT    - ${t("cli.extraHelp.env.CLAUDE_CODE_CLIENT_CERT")}
  CLAUDE_CODE_CLIENT_KEY     - ${t("cli.extraHelp.env.CLAUDE_CODE_CLIENT_KEY")}
  NODE_EXTRA_CA_CERTS        - ${t("cli.extraHelp.env.NODE_EXTRA_CA_CERTS")}
  OPENAI_API_KEY             - ${t("cli.extraHelp.env.OPENAI_API_KEY")}
  GEMINI_API_KEY             - ${t("cli.extraHelp.env.GEMINI_API_KEY")}
  COPILOT_GITHUB_TOKEN      - GitHub Copilot

  ${chalk.dim(t("cli.extraHelp.otherProviders"))}
  AZURE_OPENAI_API_KEY       - ${t("cli.extraHelp.env.AZURE_OPENAI_API_KEY")}
  GROQ_API_KEY               - ${t("cli.extraHelp.env.GROQ_API_KEY")}
  CEREBRAS_API_KEY           - ${t("cli.extraHelp.env.CEREBRAS_API_KEY")}
  XAI_API_KEY                - ${t("cli.extraHelp.env.XAI_API_KEY")}
  OPENROUTER_API_KEY         - ${t("cli.extraHelp.env.OPENROUTER_API_KEY")}
  KILO_API_KEY               - ${t("cli.extraHelp.env.KILO_API_KEY")}
  MISTRAL_API_KEY            - ${t("cli.extraHelp.env.MISTRAL_API_KEY")}
  ZAI_API_KEY                - ${t("cli.extraHelp.env.ZAI_API_KEY")}
  UMANS_AI_CODING_PLAN_API_KEY - ${t("cli.extraHelp.env.UMANS_AI_CODING_PLAN_API_KEY")}
  ABLITERATION_API_KEY       - ${t("cli.extraHelp.env.ABLITERATION_API_KEY")}
  KIRO_API_KEY               - ${t("cli.extraHelp.env.KIRO_API_KEY")}
  UMANS_WEBSEARCH_PROVIDER    - ${t("cli.extraHelp.env.UMANS_WEBSEARCH_PROVIDER")}
  MINIMAX_API_KEY            - ${t("cli.extraHelp.env.MINIMAX_API_KEY")}
  OPENCODE_API_KEY           - ${t("cli.extraHelp.env.OPENCODE_API_KEY")}
  CURSOR_ACCESS_TOKEN        - ${t("cli.extraHelp.env.CURSOR_ACCESS_TOKEN")}
  CLINE_API_KEY              - ${t("cli.extraHelp.env.CLINE_API_KEY")}
  COMMAND_CODE_API_KEY       - ${t("cli.extraHelp.env.COMMAND_CODE_API_KEY")}
  CHARM_HYPER_API_KEY        - ${t("cli.extraHelp.env.CHARM_HYPER_API_KEY")}
  AI_GATEWAY_API_KEY         - Vercel AI Gateway
  STEPFUN_API_KEY            - ${t("cli.extraHelp.env.STEPFUN_API_KEY")}
  HELMCODE_API_KEY           - ${t("cli.extraHelp.env.HELMCODE_API_KEY")}
  WAFER_SERVERLESS_API_KEY   - ${t("cli.extraHelp.env.WAFER_SERVERLESS_API_KEY")}
  YOLO_AUTO_API_KEY          - ${t("cli.extraHelp.env.YOLO_AUTO_API_KEY")}
  SINGULARITYAPI_DEV_API_KEY - ${t("cli.extraHelp.env.SINGULARITYAPI_DEV_API_KEY")}
  SINGULARITYAPI_TECH_API_KEY - ${t("cli.extraHelp.env.SINGULARITYAPI_TECH_API_KEY")}
  SCW_SECRET_KEY             - ${t("cli.extraHelp.env.SCW_SECRET_KEY")}
  OTARI_API_KEY              - ${t("cli.extraHelp.env.OTARI_API_KEY")}
  OTARI_BASE_URL             - ${t("cli.extraHelp.env.OTARI_BASE_URL")}

  ${chalk.dim(t("cli.extraHelp.cloudProviders"))}
  AWS_PROFILE                - ${t("cli.extraHelp.env.AWS_PROFILE")}
  GOOGLE_CLOUD_PROJECT       - ${t("cli.extraHelp.env.GOOGLE_CLOUD_PROJECT")}
  GOOGLE_APPLICATION_CREDENTIALS - ${t("cli.extraHelp.env.GOOGLE_APPLICATION_CREDENTIALS")}

  ${chalk.dim(t("cli.extraHelp.searchTools"))}
  EXA_API_KEY                - ${t("cli.extraHelp.env.EXA_API_KEY")}
  BRAVE_API_KEY              - ${t("cli.extraHelp.env.BRAVE_API_KEY")}
  PERPLEXITY_API_KEY         - ${t("cli.extraHelp.env.PERPLEXITY_API_KEY")}
  PERPLEXITY_COOKIES         - ${t("cli.extraHelp.env.PERPLEXITY_COOKIES")}
  TAVILY_API_KEY             - ${t("cli.extraHelp.env.TAVILY_API_KEY")}
  TINYFISH_API_KEY           - ${t("cli.extraHelp.env.TINYFISH_API_KEY")}
  KEENABLE_API_KEY           - ${t("cli.extraHelp.env.KEENABLE_API_KEY")}
  SOFYA_API_KEY              - ${t("cli.extraHelp.env.SOFYA_API_KEY")}
  FIRECRAWL_API_KEY          - ${t("cli.extraHelp.env.FIRECRAWL_API_KEY")}
  ANTHROPIC_SEARCH_API_KEY   - ${t("cli.extraHelp.env.ANTHROPIC_SEARCH_API_KEY")}
  ANTHROPIC_SEARCH_BASE_URL  - ${t("cli.extraHelp.env.ANTHROPIC_SEARCH_BASE_URL")}
  TYPESAFE_API_KEY           - ${t("cli.extraHelp.env.TYPESAFE_API_KEY")}

  ${chalk.dim(t("cli.extraHelp.configuration"))}
  OMP_PROFILE                 - ${t("cli.extraHelp.env.OMP_PROFILE")}
  ${t("cli.extraHelp.alias", { bin: APP_NAME })}
  PI_CODING_AGENT_DIR        - ${t("cli.extraHelp.env.PI_CODING_AGENT_DIR", { configDir: CONFIG_DIR_NAME })}
  PI_PACKAGE_DIR             - ${t("cli.extraHelp.env.PI_PACKAGE_DIR")}
  PI_SMOL_MODEL              - ${t("cli.extraHelp.env.PI_SMOL_MODEL")}
  PI_SLOW_MODEL              - ${t("cli.extraHelp.env.PI_SLOW_MODEL")}
  PI_PLAN_MODEL              - ${t("cli.extraHelp.env.PI_PLAN_MODEL")}
  PI_NO_PTY                  - ${t("cli.extraHelp.env.PI_NO_PTY")}
  ${t("cli.extraHelp.envReference")}
  ${chalk.dim("docs/environment-variables.md")}
${chalk.bold(t("cli.extraHelp.builtinTools"))}
  ${chalk.dim(t("cli.extraHelp.enabledByDefault"))}
${renderBuiltinTools("default")}

  ${chalk.dim(t("cli.extraHelp.optionalTools"))}
${renderBuiltinTools("optional")}

  ${t("cli.extraHelp.browserAndComputer")}

${chalk.bold(t("cli.extraHelp.pluginsHeading"))}
  --plugin-dir <path>        ${t("cli.extraHelp.pluginDir")}

${chalk.bold(t("cli.extraHelp.usefulCommands"))}
  ${APP_NAME} agents unpack           - ${t("cli.extraHelp.unpackSubagents")}
  ${APP_NAME} agents unpack --project - ${t("cli.extraHelp.unpackProjectSubagents")}`;
}
