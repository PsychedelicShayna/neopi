import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveBackendSelection } from "./backend/runtime.ts";

test("a failed pre-backend probe recovers after loading the backend", () => {
	const backend = resolveBackendSelection();
	if (!backend) throw new Error("Registry recovery tests require a configured NeoPi backend");
	const home = mkdtempSync(path.join(tmpdir(), "deck-registry-recovery-"));
	const agentDir = path.join(home, "agent");
	mkdirSync(agentDir);
	writeFileSync(path.join(agentDir, "models.toml"), `[providers.recovery-fixture]
baseUrl = "http://127.0.0.1:1/v1"
api = "openai-completions"
auth = "none"
models = [{ id = "recovered-model" }]
`, { mode: 0o600 });
	const authUrl = pathToFileURL(path.join(import.meta.dir, "auth-singleton.ts")).href;
	const runtimeUrl = pathToFileURL(path.join(import.meta.dir, "backend/runtime.ts")).href;
	try {
		const proc = Bun.spawnSync([process.execPath, "--eval", `
import assert from "node:assert/strict";
import { getDeckModelRegistry } from ${JSON.stringify(authUrl)};
import { loadBackend, resolveBackendSelection, sdk } from ${JSON.stringify(runtimeUrl)};
const failed = getDeckModelRegistry();
assert.equal(getDeckModelRegistry(), failed, "concurrent probes must share initialization");
await assert.rejects(failed);
await loadBackend(resolveBackendSelection());
const recovered = getDeckModelRegistry();
assert.equal(getDeckModelRegistry(), recovered, "post-load probes must share initialization");
const registry = await recovered;
assert.equal(registry.find("recovery-fixture", "recovered-model")?.id, "recovered-model", registry.getError()?.message ?? sdk().getAgentDir());
assert.equal(await getDeckModelRegistry(), registry, "successful initialization remains cached");
console.log("Registry recovered and loaded the isolated model");
process.exit(0);
`], {
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				NPI_DECK_HOME: home,
				NPI_DECK_BACKEND: backend.path,
				PI_CODING_AGENT_DIR: agentDir,
				XDG_CONFIG_HOME: path.join(home, "config"),
				XDG_CACHE_HOME: path.join(home, "cache"),
				XDG_DATA_HOME: path.join(home, "data"),
				XDG_STATE_HOME: path.join(home, "state"),
				OMP_PROFILE: "",
				PI_PROFILE: "",
			},
		});
		expect(proc.exitCode, `${proc.stdout.toString()}\n${proc.stderr.toString()}`).toBe(0);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}, 120_000);
