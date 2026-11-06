import { afterAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { parseSettingsToml as parse } from "@oh-my-pi/pi-utils/settings-toml";
import type { ModelsConfigResponse, ModelsConfigSaveResponse } from "@npi-deck/protocol";
import { loadBackend, resolveBackendSelection, sdk } from "./backend/runtime.ts";
import { getDeckModelRegistry } from "./auth-singleton.ts";
import { buildModelsConfigRouter, replaceModelsFile } from "./routes-models-config.ts";
import { privateBackendTest } from "./backend/private-test.ts";

if (privateBackendTest(import.meta.path)) {
const root = await mkdtemp(path.join(tmpdir(), "deck-models-config-test-"));
const backend = resolveBackendSelection();
if (!backend) throw new Error("models.toml tests require a configured NeoPi backend");
await loadBackend(backend);
const agentDir = sdk().getAgentDir();
if (!agentDir.startsWith(tmpdir())) throw new Error("refusing to edit a non-temporary agent dir");
await mkdir(agentDir, { recursive: true });
const modelsFile = path.join(agentDir, "models.toml");
const backupFile = `${modelsFile}.bak`;
const priorModels = await Bun.file(modelsFile).exists() ? await readFile(modelsFile, "utf8") : null;
const app = buildModelsConfigRouter();
const request = (url: string, init?: RequestInit) => app.request(`http://127.0.0.1${url}`, init);
const send = (method: "PUT" | "POST", url: string, body: unknown) => request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const load = async () => await (await request("/models-config")).json() as ModelsConfigResponse;
const PLACEHOLDER = /<npi-deck-masked:[0-9a-f]{16}>/;
const COMMENT = /^# <npi-deck-comment:[0-9a-f]{16}>$/;
const BETA_URL = /(\[providers.beta\]\nbaseUrl = )"<npi-deck-masked:[0-9a-f]{16}>"/;
const SECRETS = ["sk-acme-live-77aa0b", "sk-bearer-3c4d1e", "svc-live-9a8b7c6d", "meta-tag-5e6f7a8b", "route-secret-1a2b3c4d", "override-secret-2b3c4d5e", "sk-shared-key-5b1e"];
const FIXTURE = `# Custom providers for the deck tests
[providers.acme]
baseUrl = "https://llm.acme.test/v1"
api = "openai-completions"
apiKey = "sk-acme-live-77aa0b"   # literal key
headers = { Authorization = "Bearer sk-bearer-3c4d1e", X-Service = "svc-live-9a8b7c6d" }
requestMetadata = { team = "meta-tag-5e6f7a8b" }
[[providers.acme.models]]
id = "acme-large"
contextWindow = 128000
headers = { X-Model-Route = "route-secret-1a2b3c4d" }
[providers.acme.modelOverrides.acme-old.headers]
X-Override = "override-secret-2b3c4d5e"
[providers.beta]
baseUrl = "https://beta.test/v1"
api = "openai-completions"
apiKey = "sk-shared-key-5b1e"
models = [{ id = "beta-small" }]
[providers.gamma]
baseUrl = "https://gamma.test/v1"
api = "openai-completions"
apiKey = "sk-shared-key-5b1e"
models = [{ id = "gamma-mini" }]
`;
const expectNoSecret = (text: string, secrets: readonly string[] = SECRETS) => { for (const secret of secrets) expect(text).not.toContain(secret); };
const provider = (name: string, url: string, id = `${name}-model`, extra = "") => `[providers.${JSON.stringify(name)}]\nbaseUrl = ${JSON.stringify(url)}\napi = "openai-completions"\nauth = "none"\nmodels = [{ id = ${JSON.stringify(id)}${extra} }]\n`;

beforeEach(async () => { await writeFile(modelsFile, FIXTURE, { mode: 0o600 }); await rm(backupFile, { force: true }); });
afterAll(async () => { if (priorModels === null) await rm(modelsFile, { force: true }); else await writeFile(modelsFile, priorModels); await rm(backupFile, { force: true }); await rm(root, { recursive: true, force: true }); });

test("every header, requestMetadata, apiKey and URL is masked in native TOML and summary", async () => {
 const response = await request("/models-config");
 expect(response.status).toBe(200); expectNoSecret(await response.clone().text());
 const body = await response.json() as ModelsConfigResponse;
 expect(body.path).toBe(modelsFile); expect(body.error).toBeUndefined();
 expect(body.raw).not.toContain("Custom providers"); expect(body.raw).not.toContain("literal key");
 expect(body.raw!.split("\n")[0]).toMatch(COMMENT);
 expect(body.raw).toMatch(/X-Service = "<npi-deck-masked:[0-9a-f]{16}>"/);
 expect(body.providers.find(p => p.name === "acme")).toMatchObject({ apiKeySet: true, auth: "apiKey", headers: ["Authorization", "X-Service"], models: [{ id: "acme-large", contextWindow: 128000 }], modelOverrides: ["acme-old"] });
});

test("saving masked TOML keeps credentials and comments, backs up, and refreshes registry", async () => {
 const before = await load(); const edited = before.raw! + provider("delta", "https://delta.test/v1", "delta-fresh");
 const validated = await send("POST", "/models-config/validate", { raw: edited }); expect(validated.status).toBe(200); expectNoSecret(await validated.text());
 const response = await send("PUT", "/models-config", { raw: edited, revision: before.revision }); expect(response.status).toBe(200); expectNoSecret(await response.clone().text());
 const saved = await response.json() as ModelsConfigSaveResponse;
 const onDisk = await readFile(modelsFile, "utf8"); expect(onDisk).toContain('# literal key');
 const parsed = parse(onDisk) as { providers: Record<string, Record<string, unknown>> };
 expect(parsed.providers.acme).toMatchObject({ apiKey: SECRETS[0], headers: { Authorization: `Bearer ${SECRETS[1]}`, "X-Service": SECRETS[2] }, requestMetadata: { team: SECRETS[3] }, models: [{ id: "acme-large", headers: { "X-Model-Route": SECRETS[4] } }], modelOverrides: { "acme-old": { headers: { "X-Override": SECRETS[5] } } } });
 expect(parsed.providers.gamma!.apiKey).toBe(SECRETS[6]); expect((await stat(modelsFile)).mode & 0o777).toBe(0o600);
 expect(saved.backupPath).toBe(await realpath(backupFile)); expect(await readFile(backupFile, "utf8")).toBe(FIXTURE);
 expect(saved.registry).toMatchObject({ refreshed: true, missingModels: [] }); expect(saved.registry.error).toBeUndefined();
 expect((await getDeckModelRegistry()).find("delta", "delta-fresh")).toBeDefined(); expect(saved.providers.map(p => p.name)).toEqual(["acme", "beta", "gamma", "delta"]);
});

test("a credential placeholder outside a whole credential position is refused", async () => {
 const { raw, revision } = await load(); const placeholder = /apiKey = "(<npi-deck-masked:[0-9a-f]+>)"/.exec(raw!)![1]!;
 const cases = [raw!.replace('id = "beta-small"', `id = "beta-small", name = "${placeholder}"`), raw!.replace('id = "gamma-mini"', `id = "${placeholder}"`), raw!.replace('[providers.gamma]', `[providers."${placeholder}"]`), raw!.replace(BETA_URL, `$1"https://beta.test/v1?key=${placeholder}"`), raw!.replace(BETA_URL, `$1"${placeholder}"`), raw!.replace('api = "openai-completions"', `api = "${placeholder}"`), raw! + `# ${placeholder}\n`, raw!.replace(/Authorization = "<npi-deck-masked:[0-9a-f]+>"/, `Authorization = "Bearer ${placeholder}"`)];
 for (const document of cases) for (const [method, url] of [["POST", "/models-config/validate"], ["PUT", "/models-config"]] as const) { const response = await send(method, url, { raw: document, revision }); expect(response.status).toBe(400); const text = await response.text(); expect(JSON.parse(text).error).toContain("can only be restored as the whole value"); expectNoSecret(text); }
 expect(await readFile(modelsFile, "utf8")).toBe(FIXTURE); expect(await Bun.file(backupFile).exists()).toBe(false);
});

test("short credentials elsewhere withhold TOML; long credentials elsewhere cannot be restored", async () => {
 await writeFile(modelsFile, provider("tiny", "https://example.test/v1", "tiny-zq9").replace('auth = "none"', 'apiKey = "zq9"'));
 const short = await load(); expect(short.raw).toBeNull(); expect(short.rawUnavailable).toBeDefined(); expect(short.providers).toEqual([]); expect(JSON.stringify(short)).not.toContain("zq9");
 await writeFile(modelsFile, FIXTURE.replace('id = "beta-small"', 'id = "beta-small", name = "backup of sk-acme-live-77aa0b"'));
 const long = await load(); expectNoSecret(JSON.stringify(long)); expect(long.providers.find(p => p.name === "beta")!.models[0]!.name).toMatch(PLACEHOLDER);
 expect((await send("PUT", "/models-config", { raw: long.raw!, revision: long.revision })).status).toBe(400);
});

test("URL query, encoded components, host labels and path tokens fail closed when repeated", async () => {
 const cases = [["https://gw.test/v1?token=sk-live-123", "sk-live-123"], ["https://gw.test/v1?token=sk%2Dlive%2D456", "sk-live-456"], ["https://gw.test/keys/sk-path-tok-4242", "sk-path-tok-4242"], ["https://tenant-7f3a9c2e.gw.test/v1", "tenant-7f3a9c2e"], ["https://gw.test/v1%3Ftoken%3Dsk-live-789", "sk-live-789"], ["https://gw.test/v1?auth=Bearer%20sk-live-321", "sk-live-321"]];
 for (const [url, secret] of cases) { await writeFile(modelsFile, provider("gw", url!, secret!)); const body = await load(); expect(body.raw).toBeNull(); expect(body.providers).toEqual([]); expect(JSON.stringify(body)).not.toContain(secret!); }
 for (const [name, url] of [["openai", "https://api.openai.com/v1"], ["anthropic", "https://api.anthropic.com"], ["openrouter", "https://openrouter.ai/api/v1"]]) { await writeFile(modelsFile, provider(name!, url!)); const body = await load(); expect(body.raw).toMatch(/baseUrl = "<npi-deck-masked:[0-9a-f]{16}>"/); expect(body.providers).toMatchObject([{ name, baseUrl: "https://••••••" }]); }
});

test("every baseUrl restores exactly, URL replacements remain secret in responses", async () => {
 const urls = ["https://gateway.test/v1?token=sk-query-live-1111", "https://svc-user:pw%2Duserinfo%2D2222@userinfo.test:8443/v1", "https://frag.test/v1#sk-fragment-live-3333", "https://pct.test/v1%3Ftoken%3Dsk-pct-live-4444", "https://sk-host-live-7777.gw.test/v1", "https://gw.test/v1/keys/sk-path-live-8888", "http://plain.test/v1"];
 const modelUrl = "https://model.test/v2?key=sk-model-live-5555";
 await writeFile(modelsFile, urls.map((url, i) => provider(`p${i}`, url, `model-${i}`, i === 0 ? `, baseUrl = ${JSON.stringify(modelUrl)}` : "")).join(""));
 const body = await load(); expectNoSecret(JSON.stringify(body), [...urls, modelUrl, "svc-user", "pw-userinfo-2222", "sk-query-live-1111"]);
 expect(body.raw!.match(/baseUrl = "<npi-deck-masked:[0-9a-f]{16}>"/g)).toHaveLength(8);
 const validated = await send("POST", "/models-config/validate", { raw: body.raw! }); expect(validated.status).toBe(200);
 const edited = body.raw!.replace(/(\[providers\."p6"\]\nbaseUrl = )"[^"]+"/, '$1"http://replaced.test/v9"');
 const saved = await send("PUT", "/models-config", { raw: edited, revision: body.revision }); expect(saved.status).toBe(200); expectNoSecret(await saved.text(), [...urls, modelUrl, "replaced.test"]);
 const disk = parse(await readFile(modelsFile, "utf8")) as { providers: Record<string, { baseUrl: string; models: Array<{ baseUrl?: string }> }> };
 for (let i = 0; i < 6; i++) expect(disk.providers[`p${i}`]!.baseUrl).toBe(urls[i]);
 expect(disk.providers.p0!.models[0]!.baseUrl).toBe(modelUrl); expect(disk.providers.p6!.baseUrl).toBe("http://replaced.test/v9");
});

test("all comment text is hidden and unchanged comments restore verbatim, edited comments stay typed", async () => {
 const header = ["# retired hunter2", "# retired hunter2; password changed", "# apiKey: <npi-deck-masked:0000000000000000> sk-other-live-123", "# keep me exactly:  spacing & symbols #1"];
 await writeFile(modelsFile, `${header.join("\n")}\n${FIXTURE}`); const body = await load();
 expectNoSecret(JSON.stringify(body), [...SECRETS, "hunter2", "password changed", "sk-other-live-123", "0000000000000000", "keep me", "Custom providers", "literal key"]);
 const lines = body.raw!.split("\n"); for (const line of lines.slice(0, 5)) expect(line).toMatch(COMMENT);
 const edited = [lines[0], "# retired, rotated on 2026-09-01", lines[3], "# added in the deck", ...lines.slice(4)].join("\n");
 const saved = await send("PUT", "/models-config", { raw: edited, revision: body.revision }); expect(saved.status).toBe(200); expectNoSecret(await saved.text(), [...SECRETS, "hunter2", "rotated on", "added in the deck"]);
 const disk = await readFile(modelsFile, "utf8"); expect(disk.split("\n").slice(0, 5)).toEqual([header[0]!, "# retired, rotated on 2026-09-01", header[3]!, "# added in the deck", "# Custom providers for the deck tests"]);
 expect(disk).toContain('apiKey = "sk-acme-live-77aa0b"   # literal key'); expect(disk).not.toContain("sk-other-live-123");
});

test("comment placeholders are refused outside unchanged comments and unknown comments are stale", async () => {
 const { raw, revision } = await load(); const comment = /# (<npi-deck-comment:[0-9a-f]{16}>)/.exec(raw!)![1]!;
 for (const document of [raw!.replace('id = "beta-small"', `id = "${comment}"`), raw!.replace('[providers.gamma]', `[providers."${comment}"]`), raw!.replace(`# ${comment}`, `# ${comment} plus a note`)]) { const response = await send("PUT", "/models-config", { raw: document, revision }); expect(response.status).toBe(400); expect((await response.json() as { error: string }).error).toContain("comment placeholder"); }
 expect((await send("PUT", "/models-config", { raw: raw!.replace(comment, "<npi-deck-comment:0123456789abcdef>"), revision })).status).toBe(409);
 expect(await readFile(modelsFile, "utf8")).toBe(FIXTURE); expect(await Bun.file(backupFile).exists()).toBe(false);
});

test("revisions are keyed rather than offline credential oracles", async () => {
 const file = provider("pin", "https://pin.test/v1").replace('auth = "none"', 'apiKey = "zz42"'); await writeFile(modelsFile, file); const body = await load();
 const reconstruct = (guess: string) => body.raw!.replace(/baseUrl = "[^"]+"/, 'baseUrl = "https://pin.test/v1"').replace(/apiKey = "[^"]+"/, `apiKey = ${JSON.stringify(guess)}`);
 expect(reconstruct("zz42")).toBe(file); const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
 expect(Array.from({ length: 100 }, (_, n) => `zz${String(n).padStart(2, "0")}`).filter(guess => [sha256(reconstruct(guess)), sha256(guess)].includes(body.revision))).toEqual([]);
 expect((await send("PUT", "/models-config", { raw: body.raw!.replace("pin-model", "pin-model-2"), revision: body.revision })).status).toBe(200);
 expect(await readFile(modelsFile, "utf8")).toContain('apiKey = "zz42"');
});

test("backup replaces a symlink rather than writing through it and stays owner-only", async () => {
 const victim = path.join(root, "victim.txt"); await writeFile(victim, "do not touch\n"); await symlink(victim, backupFile);
 const { raw, revision } = await load(); const response = await send("PUT", "/models-config", { raw: raw!.replace("contextWindow = 128000", "contextWindow = 64000"), revision }); expect(response.status).toBe(200);
 expect(await readFile(victim, "utf8")).toBe("do not touch\n"); expect((await lstat(backupFile)).isSymbolicLink()).toBe(false); expect((await stat(backupFile)).mode & 0o777).toBe(0o600); expect(await readFile(backupFile, "utf8")).toBe(FIXTURE);
});

test("compare-and-replace refuses concurrent edits without temp or backup leftovers", async () => {
 const concurrent = `${FIXTURE}# edited in the TUI meanwhile\n`; await writeFile(modelsFile, concurrent); let status: unknown;
 try { replaceModelsFile(modelsFile, "[providers]\n", FIXTURE); } catch (err) { status = (err as { status?: unknown }).status; }
 expect(status).toBe(409); expect(await readFile(modelsFile, "utf8")).toBe(concurrent); expect(await Bun.file(backupFile).exists()).toBe(false); expect((await readdir(agentDir)).filter(name => name.endsWith(".tmp"))).toEqual([]);
});

test("invalid TOML and schema errors leave both file and backup untouched", async () => {
 const { raw, revision } = await load();
 for (const document of [raw!.replace(BETA_URL, '[providers.beta]\nignored = "url"'), raw!.replace("contextWindow = 128000", "contextWindow = -5"), raw!.replace('api = "openai-completions"', 'api = "not-an-api"'), `${raw!}broken = [\n`]) {
  for (const [method, url] of [["POST", "/models-config/validate"], ["PUT", "/models-config"]] as const) { const response = await send(method, url, { raw: document, revision }); expect(response.status).toBe(400); expectNoSecret(await response.text()); }
 }
 expect(await readFile(modelsFile, "utf8")).toBe(FIXTURE); expect(await Bun.file(backupFile).exists()).toBe(false);
});

test("stale revisions and unknown credentials refuse writes", async () => {
 const { raw, revision } = await load(); await writeFile(modelsFile, `${FIXTURE}# concurrent\n`);
 expect((await send("PUT", "/models-config", { raw: raw!, revision })).status).toBe(409); expect(await readFile(modelsFile, "utf8")).toBe(`${FIXTURE}# concurrent\n`);
 const fresh = await load(); expect((await send("PUT", "/models-config", { raw: fresh.raw!.replace(PLACEHOLDER, "<npi-deck-masked:0123456789abcdef>"), revision: fresh.revision })).status).toBe(409); expect(await Bun.file(backupFile).exists()).toBe(false);
});

test("invalid files are masked or withheld without revealing parser content", async () => {
 await writeFile(modelsFile, FIXTURE.replace('baseUrl = "https://beta.test/v1"\n', "")); const invalid = await load(); expect(invalid.error).toContain('Provider beta: "baseUrl" is required'); expect(invalid.providers).toEqual([]); expect(invalid.raw).toMatch(PLACEHOLDER);
 await writeFile(modelsFile, '[providers.acme]\napiKey = "sk-acme-live-77aa0b\n'); const broken = await load(); expectNoSecret(JSON.stringify(broken)); expect(broken.raw).toBeNull(); expect(broken.rawUnavailable).toBeDefined(); expect(broken.error).toBeDefined();
});

test("legacy YAML imports to TOML without altering the legacy source", async () => {
 const legacy = path.join(agentDir, "models.yaml"); const text = 'providers:\n  imported:\n    baseUrl: https://import.test/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: imported-model\n';
 await rm(modelsFile); await writeFile(legacy, text);
 try { const body = await load(); expect(body.path).toBe(modelsFile); expect(body.providers[0]!.name).toBe("imported"); expect(await readFile(legacy, "utf8")).toBe(text); expect(parse(await readFile(modelsFile, "utf8"))).toHaveProperty("providers.imported"); const saved = await send("PUT", "/models-config", { raw: body.raw!.replace("imported-model", "imported-new"), revision: body.revision }); expect(saved.status).toBe(200); expect(await readFile(legacy, "utf8")).toBe(text); } finally { await rm(legacy, { force: true }); }
});

test("newly submitted credentials are never repeated by validation errors or summaries", async () => {
	const secret = "sk-newly-submitted-98765";
	const documents = [
		provider("fresh", "https://fresh.test/v1").replace('auth = "none"', `apiKey = "${secret}"`).replace('id = "fresh-model"', `id = "${secret}"`),
		`[providers.fresh]\napiKey = "${secret}\n`,
		provider("fresh", "https://fresh.test/v1").replace('api = "openai-completions"', `api = "${secret}"`).replace('auth = "none"', `apiKey = "${secret}"`),
	];
	for (const raw of documents) {
		const response = await send("POST", "/models-config/validate", { raw });
		expect(response.status).toBe(400);
		expect(await response.text()).not.toContain(secret);
	}
	expect(await readFile(modelsFile, "utf8")).toBe(FIXTURE);
});
}
