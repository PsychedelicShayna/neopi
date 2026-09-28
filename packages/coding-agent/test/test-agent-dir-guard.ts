import { beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils/temp";

const codingAgentDir = path.resolve(import.meta.dir, "..");
const guardActiveEnvironmentKey = "NPI_TEST_STORAGE_GUARD_ACTIVE";
const allowedStorageRoot = os.tmpdir();
const suiteRoot = fs.mkdtempSync(path.join(allowedStorageRoot, "npi-test-agent-dir-"));
const guardedEnvironmentKeys = [
	"NPI_TEST_ALLOWED_STORAGE_ROOT",
	"PI_CODING_AGENT_DIR",
	"PI_CONFIG_DIR",
	"OMP_PROFILE",
	"PI_PROFILE",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
] as const;
const suiteEnvironment = new Map(guardedEnvironmentKeys.map(key => [key, process.env[key]]));
suiteEnvironment.set("NPI_TEST_ALLOWED_STORAGE_ROOT", allowedStorageRoot);
suiteEnvironment.set("PI_CODING_AGENT_DIR", path.join(suiteRoot, "agent"));
suiteEnvironment.set("OMP_PROFILE", undefined);
suiteEnvironment.set("PI_PROFILE", undefined);
suiteEnvironment.set("XDG_DATA_HOME", path.join(suiteRoot, "xdg-data"));
suiteEnvironment.set("XDG_STATE_HOME", path.join(suiteRoot, "xdg-state"));
suiteEnvironment.set("XDG_CACHE_HOME", path.join(suiteRoot, "xdg-cache"));
const testGlobal = globalThis as typeof globalThis & {
	__npiTestDirectoryGuardEnabled?: boolean;
	__npiTestResetDirsFromEnv?: () => void;
	__npiTestStorageGuardActive?: () => boolean;
};
testGlobal.__npiTestDirectoryGuardEnabled = true;

function applyEnvironment(environment: ReadonlyMap<(typeof guardedEnvironmentKeys)[number], string | undefined>): void {
	for (const key of guardedEnvironmentKeys) {
		const value = environment.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	testGlobal.__npiTestResetDirsFromEnv?.();
}

function runsCodingAgentTest(): boolean {
	const testPath = path.resolve(Bun.main);
	return testPath === codingAgentDir || testPath.startsWith(`${codingAgentDir}${path.sep}`);
}

function applyGuardScope(): void {
	if (runsCodingAgentTest()) {
		process.env[guardActiveEnvironmentKey] = "1";
	} else {
		delete process.env[guardActiveEnvironmentKey];
	}
}
testGlobal.__npiTestStorageGuardActive = runsCodingAgentTest;

applyEnvironment(suiteEnvironment);
applyGuardScope();

beforeEach(() => {
	applyEnvironment(suiteEnvironment);
	applyGuardScope();
});

process.once("exit", () => {
	removeSyncWithRetries(suiteRoot);
});
