import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MixtureWorkspace } from "@oh-my-pi/pi-coding-agent/moa/registration";
import type { MixtureIssue } from "@oh-my-pi/pi-coding-agent/moa/types";
import { type MixtureWebEditor, startMixtureWebEditor } from "@oh-my-pi/pi-coding-agent/moa/web-server";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import * as tern from "@oh-my-pi/pi-coding-agent/tools/browser/tern/user-page";
import * as openUtils from "@oh-my-pi/pi-coding-agent/utils/open";
import type { MixturesConfigDoc } from "@oh-my-pi/pi-tui/overlays/mixture-types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";
import { createMoaFixture, createMoaSession, DRAFT_THEN_EDIT_TOML, type MoaFixture } from "./helpers/moa-setup";

interface Validation {
	errors: MixtureIssue[];
	warnings: MixtureIssue[];
}

interface SourceRow {
	id: string;
	kind: "user" | "project";
	path: string;
	displayPath: string;
	hash: string | null;
	exists: boolean;
	broken?: string;
	readOnly?: string;
	mixtures: { name: string; status: string | null; shadowedBy?: string; revision?: string; members: number }[];
}

interface Snapshot {
	id: string;
	path: string;
	doc: MixturesConfigDoc;
	hash: string | null;
	text: string | null;
	toml: string;
	broken?: string;
	parseDiagnostics: string[];
	validation: Validation;
}

interface Saved {
	files: Snapshot[];
	sources: SourceRow[];
	roster: { name: string; revision: string }[];
}

interface SaveFile {
	sourceId: string;
	baseHash: string | null;
	doc: MixturesConfigDoc;
	confirmCanonicalRewrite?: boolean;
}

function request(url: string, route: string, init?: RequestInit): Promise<Response> {
	return fetch(new URL(route, url), { signal: AbortSignal.timeout(5_000), ...init });
}

async function json<T>(response: Response, status = 200): Promise<T> {
	const body: unknown = await response.json();
	expect(response.status, JSON.stringify(body)).toBe(status);
	return body as T;
}

async function sources(url: string): Promise<SourceRow[]> {
	return (await json<{ sources: SourceRow[] }>(await request(url, "mixtures/sources"))).sources;
}

function source(url: string, id: string): Promise<Snapshot> {
	return request(url, `mixtures/source?id=${id}`).then(response => json<Snapshot>(response));
}

function send(
	url: string,
	route: string,
	method: "POST" | "PUT",
	body: unknown,
	origin: string | null = new URL(url).origin,
) {
	const headers = new Headers({ "Content-Type": "application/json" });
	if (origin !== null) headers.set("Origin", origin);
	return request(url, route, { method, headers, body: JSON.stringify(body) });
}

const save = (url: string, files: SaveFile[], origin?: string | null) =>
	send(url, "mixtures/save", "PUT", { files }, origin);
const draft = (url: string, sourceId: string, doc: MixturesConfigDoc) =>
	send(url, "mixtures/draft", "POST", { sourceId, doc });

// Use an explicit HTTP Host rather than relying on Fetch to forward this header.
function statusForHost(url: string, host: string): Promise<number | undefined> {
	const { promise, resolve, reject } = Promise.withResolvers<number | undefined>();
	const req = http.get(
		url,
		{ agent: false, headers: { Host: host }, signal: AbortSignal.timeout(3_000) },
		response => {
			response.on("error", reject);
			response.on("end", () => resolve(response.statusCode));
			response.resume();
		},
	);
	req.on("error", reject);
	return promise;
}

describe("Mixture web editor", () => {
	let temp: TempDir;
	let fixture: MoaFixture | undefined;
	const editors: MixtureWebEditor[] = [];

	beforeEach(async () => {
		temp = TempDir.createSync("@moa-web-");
		fixture = await createMoaFixture(temp);
	});

	afterEach(() => {
		for (const editor of editors.splice(0)) editor.stop();
		fixture?.authStorage.close();
		fixture = undefined;
		temp.removeSync();
	});

	function context(cwd = fixture!.cwd) {
		const { agentDir, registry } = fixture!;
		return { cwd, agentDir, registry, settings: Settings.isolated() };
	}

	function open(ctx = context(), onSaved?: (message: string) => void): string {
		const editor = startMixtureWebEditor({ ...ctx, onSaved });
		editors.push(editor);
		return editor.url;
	}

	async function userAndProject(url: string) {
		const list = await sources(url);
		const user = list.find(row => row.kind === "user")!;
		const project = list.find(row => row.path === path.join(fixture!.cwd, "MIXTURES.toml"))!;
		return { list, user, project };
	}

	it("serves the page and every asset it loads only under the capability URL", async () => {
		const url = open();
		expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[^/]+\/$/);

		const page = await request(url, "");
		expect(page.status).toBe(200);
		expect(page.headers.get("content-type")).toContain("text/html");
		const scripts = [...(await page.text()).matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(
			match => match[1]!,
		);
		expect(scripts.length).toBeGreaterThan(0);
		for (const src of scripts) {
			const script = await request(url, src);
			expect(script.status, src).toBe(200);
			expect(script.headers.get("content-type")).toContain("javascript");
			expect((await script.text()).trim()).not.toBe("");
		}
		await json(await request(url, "assets/not-a-file.js"), 404);
		await json(await request(url, "assets/constructor"), 404);
		for (const route of ["/", `/${scripts[0]}`, "/mixtures/sources", "/not-the-token/bootstrap"]) {
			await json(await request(url, route), 404);
		}
	});

	it("rejects an unexpected Host, foreign Origin, and writes without Origin", async () => {
		const url = open();
		const target = new URL("mixtures/sources", url);
		const foreign = "http://foreign.invalid";
		const { project } = await userAndProject(url);
		const files = [{ sourceId: project.id, baseHash: null, doc: { mixtures: [] } }];

		expect(await statusForHost(target.href, target.host)).toBe(200);
		expect(await statusForHost(target.href, `foreign.invalid:${target.port}`)).toBe(403);

		const read = await request(url, "mixtures/sources", { headers: { Origin: foreign } });
		expect(read.headers.has("access-control-allow-origin")).toBe(false);
		await json(read, 403);
		await json(await save(url, files, foreign), 403);
		await json(await save(url, files, null), 403);
		await json(
			await send(url, "mixtures/draft", "POST", { sourceId: project.id, doc: { mixtures: [] } }, foreign),
			403,
		);
		expect(await Bun.file(project.path).exists()).toBe(false);
	});

	it("lists every source on the search path, ancestors included, without collapsing same-name mixtures", async () => {
		const nested = path.join(fixture!.cwd, "pkg");
		await fs.mkdir(nested);
		await Bun.write(path.join(fixture!.cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
		await Bun.write(path.join(nested, "MIXTURES.toml"), DRAFT_THEN_EDIT_TOML);
		const url = open(context(nested));

		const list = await sources(url);
		const userRow = list.find(row => row.kind === "user")!;
		const leaf = list.find(row => row.path === path.join(nested, "MIXTURES.toml"))!;
		expect(userRow.mixtures).toEqual([
			expect.objectContaining({ name: "draft-then-edit", status: "shadowed", shadowedBy: leaf.id, members: 2 }),
		]);
		expect(leaf.mixtures).toEqual([expect.objectContaining({ name: "draft-then-edit", runnable: true })]);
		expect(leaf.mixtures[0]!.shadowedBy).toBeUndefined();
		expect(new Set(list.map(row => row.id)).size).toBe(list.length);
		expect(list[0]!.kind).toBe("user");
		expect(list.slice(1).every(row => row.kind === "project")).toBe(true);
		expect(list.at(-1)!.path).toBe(leaf.path);
		expect(list.some(row => row.path === path.join(fixture!.cwd, "MIXTURES.toml") && !row.exists)).toBe(true);
	});

	it("loads a source with its raw text, and flags a broken file instead of offering an empty graph", async () => {
		const url = open();
		const { user, project } = await userAndProject(url);
		const snapshot = await source(url, user.id);
		expect(snapshot).toMatchObject({ text: DRAFT_THEN_EDIT_TOML, hash: user.hash, path: user.path });
		expect(snapshot.doc.mixtures.map(item => item.name)).toEqual(["draft-then-edit"]);
		expect(snapshot.broken).toBeUndefined();
		expect(await source(url, project.id)).toMatchObject({ text: null, hash: null, doc: { mixtures: [] } });

		await Bun.write(project.path, "[[mixtures]\nname = ");
		const broken = await source(url, project.id);
		expect(broken.broken).toMatch(/^Invalid TOML/);
		expect((await sources(url)).find(row => row.id === project.id)?.broken).toMatch(/^Invalid TOML/);
		const refused = await json<{ code: string }>(
			await save(url, [{ sourceId: project.id, baseHash: broken.hash, doc: { mixtures: [] } }]),
			409,
		);
		expect(refused.code).toBe("broken-source");
		expect(await Bun.file(project.path).text()).toBe("[[mixtures]\nname = ");

		await json(await request(url, "mixtures/source?id=0123456789abcdef"), 404);
	});

	it("validates drafts without failing the request and reports what each member resolves to", async () => {
		const url = open();
		const { user } = await userAndProject(url);
		const { doc } = await source(url, user.id);
		const bad = { mixtures: [{ ...doc.mixtures[0]!, entry: "missing" }] };
		const result = await json<{
			validation: Validation;
			reports: { members: Record<string, unknown> }[];
			toml: string;
		}>(await draft(url, user.id, bad));
		expect(result.validation.errors).toContainEqual({
			code: "entry.unresolved",
			path: "mixtures[0].entry",
			message: 'entry "missing" does not name a member',
		});
		expect(result.reports[0]!.members).toEqual({
			writer: { model: "fake/writer" },
			editor: { model: "fake/editor" },
		});
		expect(Bun.TOML.parse(result.toml)).toMatchObject({ mixtures: [{ entry: "missing" }] });
		await json(await draft(url, "not-a-source", bad), 400);
		expect(await Bun.file(user.path).text()).toBe(DRAFT_THEN_EDIT_TOML);
	});

	it("moves a mixture between scopes in one save, refreshing the roster and every source", async () => {
		const ctx = context();
		const workspace = await MixtureWorkspace.retain("web-editor", ctx);
		try {
			const onSaved = vi.fn<(message: string) => void>();
			const url = open(ctx, onSaved);
			const { user, project } = await userAndProject(url);
			const { doc } = await source(url, user.id);
			const moved = { ...doc.mixtures[0]!, name: "project-pipeline" };

			const result = await json<Saved>(
				await save(url, [
					{ sourceId: project.id, baseHash: null, doc: { mixtures: [moved] } },
					{ sourceId: user.id, baseHash: user.hash, doc: { mixtures: [] } },
				]),
			);
			expect(result.files.map(file => file.id)).toEqual([project.id, user.id]);
			expect(result.files[1]).toMatchObject({ hash: null, text: null });
			expect(await Bun.file(user.path).exists()).toBe(false);
			expect(Bun.TOML.parse(await Bun.file(project.path).text())).toMatchObject({
				mixtures: [{ name: "project-pipeline" }],
			});
			expect(result.roster.map(item => item.name)).toEqual(["project-pipeline"]);
			expect(result.sources.find(row => row.id === project.id)?.mixtures).toEqual([
				expect.objectContaining({ name: "project-pipeline", status: "registered" }),
			]);
			expect(ctx.registry.find("mixture", "draft-then-edit")).toBeUndefined();
			expect(ctx.registry.find("mixture", "project-pipeline")).toBeDefined();
			expect(onSaved).toHaveBeenCalledWith(expect.stringMatching(/saved.*roster/i));

			const stale = await json<{ conflicts: { sourceId: string; current: Snapshot }[] }>(
				await save(url, [{ sourceId: user.id, baseHash: user.hash, doc }]),
				409,
			);
			expect(stale.conflicts).toEqual([
				{ sourceId: user.id, current: expect.objectContaining({ hash: null, text: null }) },
			]);
			expect(await Bun.file(user.path).exists()).toBe(false);
		} finally {
			workspace.release();
		}
	});

	it("refuses an invalid save per file and writes nothing", async () => {
		const url = open();
		const { user, project } = await userAndProject(url);
		const { doc } = await source(url, user.id);
		const invalid = { mixtures: [{ ...doc.mixtures[0]!, name: "broken", entry: "missing" }] };
		const refused = await json<{ files: { sourceId: string; blocked: number[]; validation: Validation }[] }>(
			await save(url, [
				{ sourceId: project.id, baseHash: null, doc: invalid },
				{ sourceId: user.id, baseHash: user.hash, doc: { mixtures: [] } },
			]),
			422,
		);
		expect(refused.files.map(file => [file.sourceId, file.blocked])).toEqual([[project.id, [0]]]);
		expect(refused.files[0]!.validation.errors[0]!.path).toBe("mixtures[0].entry");
		expect(await Bun.file(user.path).text()).toBe(DRAFT_THEN_EDIT_TOML);
		expect(await Bun.file(project.path).exists()).toBe(false);
		await json(await save(url, []), 400);
		await json(await save(url, [{ sourceId: user.id, baseHash: "not-a-hash", doc }]), 400);
	});

	it("requires a hash-bound confirmation before dropping source the codec cannot keep", async () => {
		const url = open();
		const { project } = await userAndProject(url);
		const original = `roles = false\nunknown_option = true\n\n${DRAFT_THEN_EDIT_TOML}`;
		await Bun.write(project.path, original);
		const { doc, hash, parseDiagnostics, text } = await source(url, project.id);
		expect(text).toBe(original);
		expect(parseDiagnostics).toEqual([expect.stringContaining("roles"), expect.stringContaining("canonical form")]);

		const file = { sourceId: project.id, baseHash: hash, doc };
		const refused = await json<{ code: string }>(await save(url, [file]), 409);
		expect(refused.code).toBe("rewrite-loses-source");
		expect(await Bun.file(project.path).text()).toBe(original);

		await json(await save(url, [{ ...file, confirmCanonicalRewrite: true }]));
		expect(await Bun.file(project.path).text()).not.toContain("unknown_option");
	});

	it("keeps two project working directories isolated despite sharing an agent directory", async () => {
		const first = context();
		const second = { ...first, cwd: temp.join("other-project") };
		await fs.mkdir(second.cwd);
		const secondToml = DRAFT_THEN_EDIT_TOML.replace("draft-then-edit", "second-project");
		await Bun.write(path.join(second.cwd, "MIXTURES.toml"), secondToml);
		const firstUrl = open(first);
		const secondUrl = open(second);
		const secondSources = await sources(secondUrl);
		const secondProject = secondSources.find(row => row.kind === "project" && row.exists)!;

		// Another launch's source id is not addressable here.
		await json(await request(firstUrl, `mixtures/source?id=${secondProject.id}`), 404);
		await json(
			await save(firstUrl, [{ sourceId: secondProject.id, baseHash: secondProject.hash, doc: { mixtures: [] } }]),
			409,
		);
		expect(await Bun.file(path.join(second.cwd, "MIXTURES.toml")).text()).toBe(secondToml);
	});

	it("bootstraps models, roles, judges, defaults, presets and limits from the harness", async () => {
		const url = open();
		const boot = await json<{
			cwd: string;
			selected: string | null;
			models: { selector: string; role?: true; resolved?: string | null }[];
			defaults: Record<string, unknown>;
			bundled: { envelopes: Record<string, string>; roles: Record<string, string>; partial: string };
			limits: Record<string, number>;
		}>(await request(url, "bootstrap"));
		expect(boot.cwd).toBe(fixture!.cwd);
		expect(boot.selected).toBeNull();
		const firstConcrete = boot.models.findIndex(model => !model.role);
		expect(boot.models.slice(0, firstConcrete).every(model => model.selector.startsWith("@"))).toBe(true);
		expect(boot.models.slice(firstConcrete).map(model => model.selector)).toContain("fake/writer");
		expect(boot.models.some(model => model.selector.startsWith("mixture/"))).toBe(false);
		expect(boot.defaults).toMatchObject({ maxHops: 24, hardMaxHops: 200, onLimit: "pause", threshold: 0.5 });
		expect(Object.keys(boot.bundled.envelopes)).toContain("handoff");
		expect(Object.keys(boot.bundled.roles)).toContain("judge");
		expect(boot.bundled.partial.trim()).not.toBe("");
		expect(boot.limits).toMatchObject({ members: 32, edges: 128, fileBytes: 4 * 1024 * 1024 });
	});

	it("opens a real editor from /moa web and saves into the session's roster", async () => {
		const settings = Settings.isolated();
		const session = await createMoaSession(fixture!, { settings });
		const dock = vi.spyOn(tern, "openTernPage").mockResolvedValue(null);
		const browser = vi.spyOn(openUtils, "openPath").mockImplementation(() => {});
		try {
			const statuses: string[] = [];
			const errors: string[] = [];
			const ctx = createInteractiveModeContext({
				session,
				sessionManager: session.sessionManager,
				settings,
				showStatus: message => {
					statuses.push(message);
				},
				showError: message => {
					errors.push(message);
				},
			});
			expect(await executeBuiltinSlashCommand("/moa web", { ctx })).toBe(true);
			expect(errors).toEqual([]);
			const url = dock.mock.calls[0]![0];
			expect(dock).toHaveBeenCalledWith(url, "beside");
			expect(browser).toHaveBeenCalledWith(url);
			expect(statuses.join("\n")).toContain(url);
			const { user } = await userAndProject(url);
			const { doc } = await source(url, user.id);
			const renamed = { mixtures: [{ ...doc.mixtures[0]!, name: "launched-editor" }] };
			await json<Saved>(await save(url, [{ sourceId: user.id, baseHash: user.hash, doc: renamed }]));
			expect(session.getRegisteredMixture("launched-editor")).toBeDefined();
			expect(statuses.at(-1)).toMatch(/Saved .*MIXTURES\.toml and refreshed the mixture roster/);
		} finally {
			browser.mockRestore();
			dock.mockRestore();
			await session.dispose();
		}
	});
});
