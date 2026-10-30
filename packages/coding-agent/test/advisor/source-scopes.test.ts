import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAdvisorConfigs, listNamedAdvisors, loadWatchdogConfigFile, resolveAdvisorConfigEditPath, saveWatchdogConfigFile } from "../../src/advisor/config";
import { SessionManager } from "../../src/session/session-manager";
import * as sessionPaths from "../../src/session/session-paths";

const scratch: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(scratch.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
async function project() {
	const parent = path.join(os.homedir(), ".cache", "npi-canary");
	await fs.mkdir(parent, { recursive: true });
	const dir = await fs.mkdtemp(path.join(parent, "advisor-source-scopes-"));
	scratch.push(dir);
	await fs.mkdir(path.join(dir, ".git"));
	return { dir, agentDir: path.join(dir, "user"), root: path.join(dir, "WATCHDOG.yml"), native: path.join(dir, ".omp", "WATCHDOG.yml") };
}

describe("advisor exact source scopes", () => {
	it("lists both project files together, while root wins an identical legacy name", async () => {
		const p = await project();
		await Bun.write(p.native, "advisors:\n  - name: Native only\n  - name: Shared\n    instructions: native\n");
		await Bun.write(p.root, "advisors:\n  - name: Root only\n  - name: Shared\n    instructions: root\n");
		const discovered = await discoverAdvisorConfigs(p.dir, p.agentDir);
		expect(discovered.files).toEqual([{ path: p.native, scope: "project-omp" }, { path: p.root, scope: "project" }]);
		expect(discovered.advisors.map(advisor => advisor.name)).toEqual(["Native only", "Shared", "Root only"]);
		expect(discovered.advisors.find(advisor => advisor.name === "Shared")?.instructions).toBe("root");
		const named = await listNamedAdvisors(p.dir, p.agentDir);
		expect(named.map(advisor => [advisor.name, advisor.scope, advisor.sourcePath])).toEqual([
			["Native only", "project-omp", p.native], ["Shared", "project-omp", p.native],
			["Root only", "project", p.root], ["Shared", "project", p.root],
		]);
		await fs.rm(p.root);
		const after = await discoverAdvisorConfigs(p.dir, p.agentDir);
		expect(after.advisors.find(advisor => advisor.name === "Shared")?.instructions).toBe("native");
	});

	it("preserves distinct persistent identities even when project names coincide", async () => {
		const p = await project();
		await Bun.write(p.native, "advisors:\n  - id: native-id\n    name: Shared\n");
		await Bun.write(p.root, "advisors:\n  - id: root-id\n    name: Shared\n");
		expect((await discoverAdvisorConfigs(p.dir, p.agentDir)).advisors.map(advisor => advisor.id)).toEqual(["native-id", "root-id"]);
	});

	it("stores session advisors beside session settings and restores them on resume", async () => {
		vi.spyOn(sessionPaths, "writeTerminalBreadcrumb").mockImplementation(() => {});
		const p = await project();
		const manager = SessionManager.create(p.dir, path.join(p.dir, "sessions"));
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile()!;
		const sessionDir = manager.getArtifactsDir()!;
		expect(sessionDir).toBe(sessionFile.slice(0, -6));
		const file = await resolveAdvisorConfigEditPath("session", { projectDir: p.dir, agentDir: p.agentDir, sessionDir });
		await saveWatchdogConfigFile(file, { advisors: [{ name: "Session only", instructions: "Follow this session" }] });
		await manager.close();
		const resumed = await SessionManager.open(sessionFile, undefined, undefined, { suppressBreadcrumb: true });
		try {
			expect(resumed.getArtifactsDir()).toBe(sessionDir);
			const discovered = await discoverAdvisorConfigs(p.dir, p.agentDir, resumed.getArtifactsDir()!);
			expect(discovered.advisors).toMatchObject([{ name: "Session only", sourceScope: "session", instructions: "Follow this session" }]);
			expect((await loadWatchdogConfigFile(file)).advisors[0].name).toBe("Session only");
			expect((await discoverAdvisorConfigs(p.dir, p.agentDir)).advisors).toEqual([]);
		} finally { await resumed.close(); }
	});
});
