import { afterEach, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __resetDirsFromEnvForTests, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const codingAgentDir = path.resolve(import.meta.dir, "..");
const runsCodingAgentTests =
	path.resolve(process.cwd()) === codingAgentDir ||
	process.argv.some(argument => path.resolve(process.cwd(), argument).startsWith(`${codingAgentDir}${path.sep}`));

if (runsCodingAgentTests) {
	const forbiddenAgentDir = path.join(os.homedir(), process.env.PI_CONFIG_DIR || ".omp", "agent");
	const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "npi-test-agent-dir-"));
	const suiteAgentDir = path.join(suiteRoot, "agent");
	const guardedEnvironmentKeys = [
		"NPI_TEST_FORBIDDEN_AGENT_DIR",
		"PI_CODING_AGENT_DIR",
		"PI_CONFIG_DIR",
		"OMP_PROFILE",
		"PI_PROFILE",
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
		"XDG_CACHE_HOME",
	] as const;
	let testRoot: string | undefined;

	process.env.NPI_TEST_FORBIDDEN_AGENT_DIR = forbiddenAgentDir;
	setAgentDir(suiteAgentDir);
	const suiteEnvironment = new Map(guardedEnvironmentKeys.map(key => [key, process.env[key]]));

	function restoreSuiteEnvironment(): void {
		for (const key of guardedEnvironmentKeys) {
			const value = suiteEnvironment.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__resetDirsFromEnvForTests();
	}

	beforeEach(() => {
		restoreSuiteEnvironment();
		testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "npi-test-case-agent-dir-"));
		setAgentDir(path.join(testRoot, "agent"));
	});

	afterEach(() => {
		const completedRoot = testRoot;
		testRoot = undefined;
		restoreSuiteEnvironment();
		if (completedRoot) removeSyncWithRetries(completedRoot);
	});

	process.once("exit", () => {
		if (testRoot) removeSyncWithRetries(testRoot);
		removeSyncWithRetries(suiteRoot);
	});
}
