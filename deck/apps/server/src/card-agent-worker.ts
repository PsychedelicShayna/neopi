import { loadBackend, sdk, feature, hasFeature } from "./backend/runtime.ts";
import { cardReadTools } from "./card-read-tools.ts";
import { createKbAgentTools } from "./kb-cli-extension.ts";

interface Input {
	id: string;
	cwd: string;
	agentDir: string;
	prompt: string;
	readOnly: boolean;
	model?: string;
	role?: string;
	kbEndpoint?: string;
	kbToken?: string;
}

async function main(): Promise<void> {
	const input = JSON.parse(await Bun.stdin.text()) as Input;
	await loadBackend();
	const core = sdk();
	const settings = await core.Settings.loadIsolated({ cwd: input.cwd, agentDir: input.agentDir });
	if (hasFeature("advisors")) feature("advisors").cfgAdvisorEnabled.override(settings, false);
	const authStorage = await core.discoverAuthStorage(input.agentDir);
	const modelRegistry = new core.ModelRegistry(authStorage, `${input.agentDir}/models.toml`);
	await modelRegistry.refresh("offline");
	const kbTools = input.kbEndpoint && input.kbToken ? createKbAgentTools(input.kbEndpoint, input.kbToken) : [];
	const customTools = input.readOnly
		? [...cardReadTools(input.cwd), ...kbTools.filter(tool => tool.name === "kb_read")]
		: kbTools;
	const allowedNames = customTools.map(tool => tool.name);
	const { session } = await core.createAgentSession({
		cwd: input.cwd,
		agentDir: input.agentDir,
		settings,
		authStorage,
		modelRegistry,
		sessionManager: core.SessionManager.inMemory(input.cwd),
		modelPattern: input.model ?? (input.role ? `@${input.role.replace(/^@/, "")}` : undefined),
		agentId: input.id,
		agentDisplayName: input.id,
		skipPythonPreflight: true,
		customTools,
		...(input.readOnly
			? {
					restrictToolNames: true,
					allowRestrictedCustomTools: true,
					toolNames: allowedNames,
					disableExtensionDiscovery: true,
					enableMCP: false,
					enableLsp: false,
					enableIrc: false,
					skills: [],
					slashCommands: [],
					promptTemplates: [],
					contextFiles: [],
				}
			: {}),
	});
	try {
		if (input.readOnly) {
			const enabled = session.getEnabledToolNames();
			if (enabled.length !== allowedNames.length || enabled.some(name => !allowedNames.includes(name))) {
				throw new Error(`Readonly capability clamp failed: ${enabled.join(",")}`);
			}
		}
		session.subscribe(event => {
			process.stdout.write(JSON.stringify(event) + "\n");
		});
		const onAbort = () => {
			void session.abort();
		};
		process.once("SIGTERM", onAbort);
		process.once("SIGINT", onAbort);
		try {
			await session.prompt(input.prompt);
		} finally {
			process.off("SIGTERM", onAbort);
			process.off("SIGINT", onAbort);
		}
	} finally {
		await session.dispose();
	}
}

if (import.meta.main) {
	try {
		await main();
		process.exit(0);
	} catch (error) {
		console.error(String(error));
		process.exit(1);
	}
}
