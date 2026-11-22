import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type {
	MixtureDraftResponse,
	MixtureSaveResponse,
	MixtureSourceDocument,
	MixturesDocument,
	MixturesResponse,
} from "@npi-deck/protocol";
import type { startMixtureWebEditor } from "@oh-my-pi/pi-coding-agent/moa/web-server";
import { feature, hasFeature, loadBackend, resolveBackendSelection, resolveManifest, sdk } from "./backend/runtime.ts";
import { getDeckModelRegistry } from "./auth-singleton.ts";
import { InProcessAgentBridge } from "./bridge/in-process.ts";
import type { Config } from "./config.ts";
import { buildMixturesRouter } from "./routes-mixtures.ts";

import { privateBackendTest } from "./backend/private-test.ts";

if (privateBackendTest(import.meta.path)) {
const root = await mkdtemp(path.join(tmpdir(), "deck-mixtures-test-"));
const project = path.join(root, "project");
const nested = path.join(project, "nested");
const outside = path.join(root, "outside");
await mkdir(nested, { recursive: true });
await mkdir(outside);
const backend = resolveBackendSelection();
if (!backend) throw new Error("mixture route tests require a configured NeoPi backend");
await loadBackend(backend);
if (!hasFeature("mixture-config") || !hasFeature("mixtures")) throw new Error("backend lacks the mixture features these tests exercise");
if (!hasFeature("mixture-authoring")) throw new Error("backend lacks the shared mixture authoring API");

// The deck's shared registry: the one the bridge lists picker models from and chats resolve against.
const registry = await getDeckModelRegistry();
const model = (id: string) => ({ id, name: id, reasoning: false, input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 1_000 });
// Keyed members resolve against getAvailable(); no request is ever sent.
registry.registerProvider("deck-test", { baseUrl: "http://127.0.0.1:1/v1", apiKey: "deck-test-key", api: "openai-completions", models: [model("writer"), model("editor")] });

const config: Config = { defaultCwd: project, extraWorkspaces: [nested], host: "127.0.0.1", port: 0, devMode: true, idleTimeoutMs: 0, dbPath: path.join(root, "db"), uploadsRoot: path.join(root, "uploads") };
const bridge = new InProcessAgentBridge({ idleTimeoutMs: 0 });
const app = buildMixturesRouter(bridge, config);
const pickerMixtures = async (cwd = project) => (await bridge.listModels({ cwd })).filter(info => info.isMixture).map(info => info.id);
const request = (url: string, init?: RequestInit) => app.request(`http://127.0.0.1${url}`, init);
const load = async (cwd = project) => (await (await request(`/mixtures?cwd=${encodeURIComponent(cwd)}`)).json()) as MixturesResponse;
const save = (body: unknown) => request("/mixtures", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const file = path.join(project, "MIXTURES.toml");
const sourceAt = (loaded: MixturesResponse, at: string): MixtureSourceDocument => {
	const found = loaded.sources.find(source => source.path === at);
	if (!found) throw new Error(`no source ${at} in ${loaded.sources.map(source => source.path).join(", ")}`);
	return found;
};
/** The workspace-root file, where the editor saves by default. */
const rootSource = (loaded: MixturesResponse) => loaded.sources.find(source => source.id === loaded.defaultSource)!;
const saveRoot = (loaded: MixturesResponse, doc: MixturesDocument, baseHash = rootSource(loaded).hash) => save({ cwd: project, source: loaded.defaultSource, baseHash, doc });
const writeDoc = (at: string, doc: MixturesDocument) => writeFile(at, feature("mixture-config").serializeMixturesConfig(doc as never));

const member = (id: string) => ({ id, model: `deck-test/${id}`, systemPrompt: `You are the ${id}.`, tools: false });
const chain = (name: string, description?: string) => ({ name, ...(description ? { description } : {}), entry: "writer", members: [member("writer"), member("editor")], edges: [{ from: "writer", to: "editor", x: { output: true as const } }] });
const withRoute = (name: string) => {
	const definition = chain(name);
	return {
		...definition,
		members: [{ ...definition.members[0]!, route: { instructions: "Choose the editor for revisions or the alternate for a second opinion." } }, definition.members[1]!, { ...member("editor"), id: "alternate" }],
		edges: [
			{ ...definition.edges[0]!, when: "The draft needs revisions." },
			{ from: "writer", to: "alternate", when: "The draft needs a second opinion.", x: { output: true as const } },
		],
	};
};
const withInvalidEntry = (name: string) => ({ ...chain(name), entry: "missing" });

beforeEach(async () => {
	for (const at of [file, path.join(project, ".omp"), path.join(nested, ".omp"), path.join(nested, "MIXTURES.toml"), path.join(outside, "MIXTURES.toml")]) await rm(at, { recursive: true, force: true });
});
afterAll(async () => {
	await bridge.dispose();
	registry.unregisterProvider("deck-test");
	// The parent keeps this child's agent storage alive until process exit.
	await rm(project, { recursive: true, force: true });
	await rm(outside, { recursive: true, force: true });
});

test("validation accepts linear and routed mixtures and reports NeoPi's remaining capability gates", async () => {
	const draft = await request("/mixtures/draft", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cwd: project, input: { kind: "document", doc: { mixtures: [chain("linear"), withRoute("routed"), withInvalidEntry("invalid")] } } }),
	});
	expect(draft.status).toBe(200);
	const body = (await draft.json()) as { validation: MixtureSourceDocument["validation"] };
	expect(body.validation.map(report => [report.name, report.runnable])).toEqual([["linear", true], ["routed", true], ["invalid", false]]);
	for (const report of body.validation.slice(0, 2)) {
		expect(report.errors).toEqual([]);
		expect(report.unsupported).toEqual([]);
		expect(report.revision).toEqual(expect.any(String));
	}
	expect(body.validation[2]!.errors).toEqual([expect.objectContaining({ code: "entry.unresolved", path: "entry" })]);
	expect(body.validation[2]!.unsupported).toEqual([]);
	const capabilities = (await load()).capabilities;
	expect(capabilities.milestone).toBe("M2");
	expect(capabilities.gates.filter(gate => gate.gated).map(gate => gate.feature)).toEqual(["tools", "fanout", "steering", "serve"]);
	expect(capabilities.gates.filter(gate => !gate.gated).map(gate => gate.feature)).toEqual([
		"verdict", "route", "terminate", "routing", "transcript", "toolTrace", "maxTraversals", "cycles", "budgetUsd", "wallClockMinutes", "onLimit", "limitTarget",
	]);
});

test("Deck and /moa web load, draft, guard and rewrite the same lossy source", async () => {
	const { values } = await resolveManifest(backend.path, {
		"mixture-authoring": {
			tier: "optional-feature",
			consumers: [],
			exports: {
				startMixtureWebEditor: {
					module: "@oh-my-pi/pi-coding-agent/moa/web-server",
					export: "startMixtureWebEditor",
				},
			},
		},
	});
	const start = values.get("mixture-authoring")?.startMixtureWebEditor as typeof startMixtureWebEditor | undefined;
	if (!start) throw new Error("the selected backend does not export its web editor");

	const agentDir = sdk().getAgentDir();
	const settings = await sdk().Settings.loadReadOnly({ cwd: project, agentDir });
	const editor = start({ cwd: project, agentDir, settings, registry });
	try {
		const canonical = feature("mixture-config").serializeMixturesConfig({ mixtures: [chain("rewrite")] });
		const original = `roles = false\nunknown_option = true\n\n${canonical}`;
		await writeFile(file, original);

		const webRequest = (route: string, method?: "POST" | "PUT", body?: unknown) =>
			fetch(new URL(route, editor.url), {
				signal: AbortSignal.timeout(3_000),
				...(method
					? {
							method,
							headers: { "Content-Type": "application/json", Origin: new URL(editor.url).origin },
							body: JSON.stringify(body),
						}
					: {}),
			});
		const loaded = await load();
		const deck = rootSource(loaded);
		const webLoad = await webRequest("mixtures?scope=project");
		expect(webLoad.status).toBe(200);
		expect(await webLoad.json()).toMatchObject({
			doc: deck.doc,
			hash: deck.hash,
			toml: deck.toml,
			parseDiagnostics: deck.parseDiagnostics,
		});
		expect(deck.doc.mixtures.map(mixture => mixture.name)).toEqual(["rewrite"]);
		expect(deck.parseDiagnostics).toEqual([
			expect.stringContaining("roles"),
			expect.stringContaining("saving writes the canonical form"),
		]);

		const deckDraft = await request("/mixtures/draft", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ cwd: project, input: { kind: "document", doc: deck.doc } }),
		});
		const webDraft = await webRequest("mixtures/draft", "POST", { scope: "project", doc: deck.doc });
		expect(deckDraft.status).toBe(200);
		expect(webDraft.status).toBe(deckDraft.status);
		const { doc, toml, parseDiagnostics } = (await deckDraft.json()) as MixtureDraftResponse;
		expect(await webDraft.json()).toMatchObject({ doc, toml, parseDiagnostics });
		expect(toml).toBe(canonical);

		const deckBody = { cwd: project, source: loaded.defaultSource, baseHash: deck.hash, doc: deck.doc };
		const webBody = { scope: "project", baseHash: deck.hash, doc: deck.doc };
		const deckRefused = await save(deckBody);
		const webRefused = await webRequest("mixtures", "PUT", webBody);
		expect(deckRefused.status).toBe(409);
		expect(webRefused.status).toBe(deckRefused.status);
		const refusal = await deckRefused.json();
		expect(refusal).toMatchObject({ code: "rewrite-loses-source", parseDiagnostics: deck.parseDiagnostics });
		expect(await webRefused.json()).toEqual(refusal);
		expect(await readFile(file, "utf8")).toBe(original);

		const deckSaved = await save({ ...deckBody, confirmCanonicalRewrite: true });
		expect(deckSaved.status).toBe(200);
		const { source } = (await deckSaved.json()) as MixtureSaveResponse;
		expect(await readFile(file, "utf8")).toBe(canonical);
		await writeFile(file, original);

		const webSaved = await webRequest("mixtures", "PUT", { ...webBody, confirmCanonicalRewrite: true });
		expect(webSaved.status).toBe(deckSaved.status);
		expect(await webSaved.json()).toMatchObject({
			hash: source.hash,
			toml: source.toml,
			parseDiagnostics: source.parseDiagnostics,
		});
		expect(await readFile(file, "utf8")).toBe(canonical);
	} finally {
		editor.stop();
	}
});

test("save is compare-and-swap on the loaded hash and verifies the file it wrote", async () => {
	const before = await load();
	expect(rootSource(before).exists).toBe(false);
	const first = await saveRoot(before, { mixtures: [chain("first")] });
	expect(first.status).toBe(200);
	const saved = (await first.json()) as MixtureSaveResponse;
	expect(saved.source.exists).toBe(true);
	expect(saved.source.doc.mixtures.map(mixture => mixture.name)).toEqual(["first"]);
	expect(await readFile(file, "utf8")).toContain('name = "first"');

	// A second editor that loaded before the first save must not overwrite it.
	const stale = await saveRoot(before, { mixtures: [chain("second")] });
	expect(stale.status).toBe(409);
	expect(await readFile(file, "utf8")).toContain('name = "first"');

	// An external edit also moves the hash.
	await writeFile(file, `${await readFile(file, "utf8")}\n`);
	const external = await saveRoot(before, { mixtures: [chain("second")] }, saved.source.hash);
	expect(external.status).toBe(409);
});

test("a writer holding NeoPi's file lock finishes before the save reads the hash", async () => {
	const before = await load();
	let pending: Response | Promise<Response> | undefined;
	await feature("mixture-config").withFileLock(file, async () => {
		pending = saveRoot(before, { mixtures: [chain("deck")] });
		await Bun.sleep(300);
		// Another lock holder (a second deck process) writes while the save waits for the lock.
		await writeDoc(file, { mixtures: [chain("other-process")] });
	});
	const response = await pending!;
	expect(response.status).toBe(409);
	expect(await readFile(file, "utf8")).toContain('name = "other-process"');
});

test("a MIXTURES.toml that is a symlink is never written through, dangling or not", async () => {
	const target = path.join(outside, "MIXTURES.toml");
	// Dangling: the link's target does not exist, so a follow-the-link write would create it.
	await symlink(target, file);
	let loaded = await load();
	expect(rootSource(loaded).readOnly).toContain("symbolic link");
	expect(rootSource(loaded).hash).not.toBe("absent");
	expect((await saveRoot(loaded, { mixtures: [chain("escape")] }, "absent")).status).toBe(409);
	expect(await Bun.file(target).exists()).toBe(false);

	// Pointing at an existing outside file.
	await writeDoc(target, { mixtures: [chain("outside")] });
	const outsideText = await readFile(target, "utf8");
	loaded = await load();
	expect((await saveRoot(loaded, { mixtures: [chain("escape")] })).status).toBe(409);
	expect(await readFile(target, "utf8")).toBe(outsideText);
});

test("a .omp directory linked elsewhere is refused as a write target", async () => {
	await writeDoc(path.join(outside, "MIXTURES.toml"), { mixtures: [chain("linked")] });
	await symlink(outside, path.join(project, ".omp"));
	const loaded = await load();
	const linked = sourceAt(loaded, path.join(project, ".omp", "MIXTURES.toml"));
	const response = await save({ cwd: project, source: linked.id, baseHash: linked.hash, doc: { mixtures: [chain("escape")] } });
	expect(response.status).toBe(409);
	expect(await readFile(path.join(outside, "MIXTURES.toml"), "utf8")).toContain('name = "linked"');
});

test("definitions with validation errors block a save unless carried over unchanged", async () => {
	const start = await load();
	const refused = await saveRoot(start, { mixtures: [chain("ok"), withInvalidEntry("invalid")] });
	expect(refused.status).toBe(422);
	const rejected = (await refused.json()) as { blocked: number[]; validation: MixtureSourceDocument["validation"] };
	expect(rejected.blocked).toEqual([1]);
	expect(rejected.validation[1]!.errors).toEqual([expect.objectContaining({ code: "entry.unresolved", path: "entry" })]);
	expect(await Bun.file(file).exists()).toBe(false);

	// A hand-written non-runnable definition already on disk survives an edit of its neighbour.
	await writeDoc(file, { mixtures: [chain("ok"), withInvalidEntry("invalid")] });
	const loaded = await load();
	const onDisk = rootSource(loaded).doc;
	const kept = await saveRoot(loaded, { mixtures: [{ ...onDisk.mixtures[0]!, description: "edited" }, onDisk.mixtures[1]!] });
	expect(kept.status).toBe(200);
	const result = (await kept.json()) as MixtureSaveResponse;
	expect(result.source.doc.mixtures.map(mixture => [mixture.name, mixture.description])).toEqual([["ok", "edited"], ["invalid", undefined]]);
	expect(result.source.doc.mixtures[1]).toEqual(onDisk.mixtures[1]);
	expect(result.source.validation.map(report => report.runnable)).toEqual([true, false]);
	expect(result.source.validation[1]!.errors).toEqual([expect.objectContaining({ code: "entry.unresolved", path: "entry" })]);

	// Carry-over permission does not extend to edits of the invalid definition.
	const savedText = await readFile(file, "utf8");
	const changed = await saveRoot(await load(), { mixtures: [result.source.doc.mixtures[0]!, { ...result.source.doc.mixtures[1]!, description: "changed" }] });
	expect(changed.status).toBe(422);
	expect(((await changed.json()) as { blocked: number[] }).blocked).toEqual([1]);
	expect(await readFile(file, "utf8")).toBe(savedText);
});

test("a saved routed mixture becomes a picker model without a restart, even while a chat holds the workspace", async () => {
	// A live chat in the workspace keeps its scope's roster; a save must replace it, not wait for release.
	const agentDir = sdk().getAgentDir();
	const chat = await feature("mixtures").MixtureWorkspace.retain("test-live-chat", { cwd: project, agentDir, registry, settings: await sdk().Settings.loadReadOnly({ cwd: project, agentDir }) });
	try {
		expect(await pickerMixtures()).not.toContain("fresh");
		const response = await saveRoot(await load(), { mixtures: [withRoute("fresh")] });
		expect(response.status).toBe(200);
		const result = (await response.json()) as MixtureSaveResponse;
		expect(result.picker).toEqual(["fresh"]);
		expect(await pickerMixtures()).toEqual(["fresh"]);
		expect(chat.scope.find("fresh")).toBeDefined();

		// Removing it from the file removes it from the picker too.
		const removed = await saveRoot(await load(), { mixtures: [] });
		expect(removed.status).toBe(200);
		expect(await Bun.file(file).exists()).toBe(false);
		expect(await pickerMixtures()).toEqual([]);
	} finally {
		chat.release();
	}
});

test("a saved definition NeoPi refuses never reaches the picker", async () => {
	await writeDoc(file, { mixtures: [chain("listed"), withInvalidEntry("refused")] });
	const loaded = await load();
	const onDisk = rootSource(loaded).doc;
	expect(rootSource(loaded).validation[1]!.runnable).toBe(false);
	expect(rootSource(loaded).validation[1]!.errors).toEqual([expect.objectContaining({ code: "entry.unresolved", path: "entry" })]);
	// Editing only the runnable neighbour saves both and registers only the runnable one.
	const response = await saveRoot(loaded, { mixtures: [{ ...onDisk.mixtures[0]!, description: "edited" }, onDisk.mixtures[1]!] });
	expect(response.status).toBe(200);
	expect(((await response.json()) as MixtureSaveResponse).picker).toEqual(["listed"]);
	expect(await pickerMixtures()).toEqual(["listed"]);
});

test("nested .omp and ancestor MIXTURES.toml files are listed in NeoPi's order and the leaf's definition is the one registered", async () => {
	// `project` is an ancestor of the `nested` workspace, outside its root (no VCS: the root is the workspace itself).
	await writeDoc(file, { mixtures: [chain("shared", "ancestor")] });
	const leaf = path.join(nested, ".omp", "MIXTURES.toml");
	await mkdir(path.dirname(leaf));
	await writeDoc(leaf, { mixtures: [chain("shared", "leaf")] });
	const loaded = await load(nested);
	const ancestor = sourceAt(loaded, file);
	const leafSource = sourceAt(loaded, leaf);
	expect(ancestor.order).toBeLessThan(leafSource.order);
	expect(ancestor.readOnly).toContain("outside the workspace root");
	expect(leafSource.readOnly).toBeUndefined();
	// Ids are opaque, not paths; an unknown id is refused.
	expect(leafSource.id).not.toContain(path.sep);
	expect((await save({ cwd: nested, source: "not-a-source", baseHash: "absent", doc: { mixtures: [] } })).status).toBe(400);
	expect((await save({ cwd: nested, source: ancestor.id, baseHash: ancestor.hash, doc: { mixtures: [] } })).status).toBe(409);

	const response = await save({ cwd: nested, source: leafSource.id, baseHash: leafSource.hash, doc: { mixtures: [chain("shared", "leaf edited")] } });
	expect(response.status).toBe(200);
	expect(((await response.json()) as MixtureSaveResponse).picker).toContain("shared");
	const discovered = (await (await request(`/mixtures/discovered?cwd=${encodeURIComponent(nested)}`)).json()) as { mixtures: Array<{ name: string; definition: { description?: string } }> };
	expect(discovered.mixtures.find(item => item.name === "shared")?.definition.description).toBe("leaf edited");
	expect(await readFile(file, "utf8")).toContain('description = "ancestor"');
});
}
