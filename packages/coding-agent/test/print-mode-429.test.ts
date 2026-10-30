import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const CLI = path.join(import.meta.dir, "../src/cli.ts");

// Exercise the real CLI, transport, session recovery and process exit. In particular,
// a session retry must not secretly spend another six HTTP attempts underneath it.
describe("print mode provider retry budget (#627)", () => {
	for (const scenario of [
		{ name: "exhausts the configured budget", retries: 2, enabled: true, mode: "text", attempts: 3 },
		{ name: "honors zero retries", retries: 0, enabled: true, mode: "text", attempts: 1 },
		{ name: "honors disabled retries", retries: 2, enabled: false, mode: "text", attempts: 1 },
		{ name: "reports JSON-mode failures on stderr", retries: 1, enabled: true, mode: "json", attempts: 2 },
		{ name: "does not renew the budget on fallback", retries: 1, enabled: true, mode: "text", attempts: 2, fallback: true },
	]) {
		it(scenario.name, async () => {
			const root = await TempDir.create("@npi-print-429-");
			const agentDir = path.join(root.path(), "agent");
			const home = path.join(root.path(), "home");
			const work = path.join(root.path(), "work");
			let requests = 0;
			const requestedModels: string[] = [];
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(req) {
					requests++;
					requestedModels.push(((await req.json()) as { model: string }).model);
					return Response.json(
						{ error: { message: "gateway connection failed\nsource: unreachable-test", type: "rate_limit_error" } },
						{ status: 429, headers: { "retry-after": "0.001" } },
					);
				},
			});
			try {
				await fs.mkdir(work, { recursive: true });
				await fs.mkdir(home, { recursive: true });
				await Bun.write(path.join(agentDir, "config.yml"), [
					"retry:", `  enabled: ${scenario.enabled}`, `  maxRetries: ${scenario.retries}`,
					"  baseDelayMs: 1", "  maxDelayMs: 100", `  modelFallback: ${"fallback" in scenario}`,
					"  fallbackChains:", "    default: [fakeai/alternate]",
					"compaction:", "  enabled: false", "",
				].join("\n"));
				await Bun.write(path.join(agentDir, "models.yml"), [
					"providers:", "  fakeai:", `    baseUrl: http://127.0.0.1:${server.port}/v1`,
					"    apiKey: test-key", "    api: openai-completions", "    models:",
					"      - id: fake-model", "        reasoning: false", "        input: [text]",
					"        contextWindow: 128000", "        maxTokens: 4096",
					"      - id: alternate", "        reasoning: false", "        input: [text]",
					"        contextWindow: 128000", "        maxTokens: 4096", "",
				].join("\n"));
				const child = Bun.spawn([
					process.execPath, CLI, "-p", "--mode", scenario.mode,
					"--no-session", "--no-title", "--no-skills", "--no-rules", "--no-lsp",
					"--model", "fakeai/fake-model", "Reply with OK",
				], {
					cwd: work,
					env: {
						PATH: process.env.PATH,
						HOME: home,
						PI_CODING_AGENT_DIR: agentDir,
						PI_TEST_RUNTIME: "1",
						XDG_CONFIG_HOME: path.join(home, ".config"),
						XDG_DATA_HOME: path.join(home, ".local/share"),
						XDG_STATE_HOME: path.join(home, ".local/state"),
						XDG_CACHE_HOME: path.join(home, ".cache"),
					},
					stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000,
				});
				const [code, stdout, stderr] = await Promise.all([
					child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
				]);
				expect(stderr).toContain("gateway connection failed");
				expect(child.signalCode).toBeNull(); // must exit itself, not the short watchdog
				expect(code).toBe(1);
				expect(requests).toBe(scenario.attempts);
				const errorLines = stderr.split("\n").filter(line => line.startsWith("Error:"));
				expect(errorLines).toHaveLength(1);
				expect(errorLines[0]).toContain(
					`HTTP 429 fakeai/${"fallback" in scenario ? "alternate" : "fake-model"}`,
				);
				if ("fallback" in scenario) expect(requestedModels).toEqual(["fake-model", "alternate"]);
				expect(errorLines[0]).toContain(`after ${scenario.attempts} attempt`);
				expect(errorLines[0]).toContain("source: unreachable-test");
				if (scenario.mode === "json") {
					const events = stdout.trim().split("\n").map(line => JSON.parse(line));
					expect(events.some(event => event.type === "auto_retry_end" && event.success === false)).toBe(true);
				}
			} finally {
				server.stop(true);
				await root.remove();
			}
		}, 25_000);
	}
});
