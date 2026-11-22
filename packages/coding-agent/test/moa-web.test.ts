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
import type { MixtureConfigScope, MixturesConfigDoc } from "@oh-my-pi/pi-tui/overlays/mixture-types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";
import { createMoaFixture, createMoaSession, DRAFT_THEN_EDIT_TOML, type MoaFixture } from "./helpers/moa-setup";

interface Validation {
	errors: MixtureIssue[];
	warnings: MixtureIssue[];
}

interface Snapshot {
	cwd: string;
	scope: MixtureConfigScope;
	sourcePath: string;
	doc: MixturesConfigDoc;
	hash: string | null;
	models: string[];
	validation: Validation;
}

interface Saved {
	hash: string | null;
	validation: Validation;
	registered: boolean;
}

function request(url: string, route: string, init?: RequestInit): Promise<Response> {
	return fetch(new URL(route, url), { signal: AbortSignal.timeout(3_000), ...init });
}

async function json<T>(response: Response, status = 200): Promise<T> {
	const body: unknown = await response.json();
	expect(response.status, JSON.stringify(body)).toBe(status);
	return body as T;
}

function getScope(url: string, scope: MixtureConfigScope): Promise<Snapshot> {
	return request(url, `mixtures?scope=${scope}`).then(response => json<Snapshot>(response));
}

function write(
	url: string,
	method: "POST" | "PUT",
	body: {
		scope: MixtureConfigScope;
		doc: MixturesConfigDoc;
		baseHash?: string | null;
		confirmCanonicalRewrite?: boolean;
	},
	origin: string | null = new URL(url).origin,
): Promise<Response> {
	const headers = new Headers({ "Content-Type": "application/json" });
	if (origin !== null) headers.set("Origin", origin);
	return request(url, method === "POST" ? "mixtures/draft" : "mixtures", {
		method,
		headers,
		body: JSON.stringify(body),
	});
}

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

	it("serves the editor and its script only under the capability URL", async () => {
		const url = open();
		expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[^/]+\/$/);

		const page = await request(url, "");
		expect(page.status).toBe(200);
		expect(page.headers.get("content-type")).toContain("text/html");
		expect(await page.text()).toMatch(/<script\b[^>]*\bsrc=["'](?:\.\/)?editor\.js["']/i);
		const script = await request(url, "editor.js");
		expect(script.status).toBe(200);
		expect(script.headers.get("content-type")).toContain("javascript");
		expect((await script.text()).trim()).not.toBe("");

		for (const route of ["/", "/editor.js", "/mixtures?scope=user", "/not-the-token/mixtures?scope=user"]) {
			const response = await request(url, route);
			await json(response, 404);
		}
	});

	it("rejects an unexpected Host, foreign Origin, and writes without Origin", async () => {
		const url = open();
		const target = new URL("mixtures?scope=project", url);
		const foreign = "http://foreign.invalid";
		const { doc } = await getScope(url, "user");
		const body = { scope: "project" as const, doc, baseHash: null };

		expect(await statusForHost(target.href, target.host)).toBe(200);
		expect(await statusForHost(target.href, `foreign.invalid:${target.port}`)).toBe(403);

		const read = await request(url, "mixtures?scope=project", { headers: { Origin: foreign } });
		expect(read.headers.has("access-control-allow-origin")).toBe(false);
		await json(read, 403);
		for (const method of ["POST", "PUT"] as const) {
			await json(await write(url, method, body, foreign), 403);
			await json(await write(url, method, body, null), 403);
		}
		expect(await Bun.file(path.join(fixture!.cwd, "MIXTURES.toml")).exists()).toBe(false);
	});

	it("previews and saves canonical graph TOML at the selected project or user source", async () => {
		const url = open();
		const project = await getScope(url, "project");
		const user = await getScope(url, "user");
		expect(project).toMatchObject({
			cwd: fixture!.cwd,
			scope: "project",
			sourcePath: path.join(fixture!.cwd, "MIXTURES.toml"),
			doc: { mixtures: [] },
			hash: null,
		});
		expect(user.sourcePath).toBe(path.join(fixture!.agentDir, "MIXTURES.toml"));
		expect(user.scope).toBe("user");
		expect(user.models).toContain("fake/writer");
		expect(user.doc.mixtures.map(item => item.name)).toEqual(["draft-then-edit"]);
		expect(user.hash).toMatch(/^[a-f0-9]{64}$/);

		const original = user.doc.mixtures[0]!;
		const projectDoc = { mixtures: [{ ...original, name: "project-pipeline" }] };
		const preview = await json<{ validation: Validation; toml: string }>(
			await write(url, "POST", { scope: "project", doc: projectDoc }),
		);
		expect(preview.validation.errors).toEqual([]);
		expect(Bun.TOML.parse(preview.toml)).toMatchObject({
			mixtures: [{ name: "project-pipeline", entry: "writer" }],
		});
		expect(preview.toml).toContain('system_prompt = "Draft a complete answer."');
		expect(await Bun.file(project.sourcePath).exists()).toBe(false);

		const projectSave = await json<Saved>(
			await write(url, "PUT", { scope: "project", doc: projectDoc, baseHash: project.hash }),
		);
		expect(projectSave.hash).toMatch(/^[a-f0-9]{64}$/);
		expect(projectSave.validation.errors).toEqual([]);
		expect(await Bun.file(project.sourcePath).text()).toBe(preview.toml);
		expect(await getScope(url, "project")).toMatchObject({ doc: projectDoc, hash: projectSave.hash });
		const stale = await json<{ error: string }>(
			await write(url, "PUT", { scope: "project", doc: { mixtures: [] }, baseHash: project.hash }),
			409,
		);
		expect(stale.error).toContain("changed since it was loaded");
		expect(await Bun.file(user.sourcePath).text()).toBe(DRAFT_THEN_EDIT_TOML);

		const userDoc = { mixtures: [{ ...original, name: "user-pipeline" }] };
		const userSave = await json<Saved>(await write(url, "PUT", { scope: "user", doc: userDoc, baseHash: user.hash }));
		expect(userSave.hash).not.toBe(user.hash);
		expect(await getScope(url, "user")).toMatchObject({ doc: userDoc, hash: userSave.hash });
		expect(Bun.TOML.parse(await Bun.file(user.sourcePath).text())).toMatchObject({
			mixtures: [{ name: "user-pipeline" }],
		});
		expect(await Bun.file(project.sourcePath).text()).toBe(preview.toml);
	});

	it("loads source the canonical codec cannot preserve and requires a hash-bound confirmation", async () => {
		const url = open();
		const sourcePath = (await getScope(url, "project")).sourcePath;
		const original = `roles = false\nunknown_option = true\n\n${DRAFT_THEN_EDIT_TOML}`;
		await Bun.write(sourcePath, original);
		const { doc, hash, parseDiagnostics } = await json<Snapshot & { parseDiagnostics: string[] }>(
			await request(url, "mixtures?scope=project"),
		);
		expect(doc.mixtures.map(item => item.name)).toEqual(["draft-then-edit"]);
		expect(parseDiagnostics).toEqual([
			expect.stringContaining("roles"),
			expect.stringContaining("saving writes the canonical form"),
		]);

		const body = { scope: "project", doc, baseHash: hash } as const;
		const refused = await json<{ code: string; parseDiagnostics: string[] }>(await write(url, "PUT", body), 409);
		expect(refused).toMatchObject({ code: "rewrite-loses-source", parseDiagnostics });
		expect(await Bun.file(sourcePath).text()).toBe(original);

		const confirmed = { ...body, confirmCanonicalRewrite: true };
		await Bun.write(sourcePath, `${original}\n# edited in another process`);
		const stale = await json<{ error: string }>(await write(url, "PUT", confirmed), 409);
		expect(stale.error).toContain("changed since it was loaded");
		await Bun.write(sourcePath, original);

		await json(await write(url, "PUT", confirmed));
		expect(Bun.TOML.parse(await Bun.file(sourcePath).text())).toMatchObject({
			mixtures: [{ name: "draft-then-edit" }],
		});
		expect(await Bun.file(sourcePath).text()).not.toContain("unknown_option");
	});

	it("keeps two project working directories isolated despite sharing an agent directory", async () => {
		const first = context();
		const second = { ...first, cwd: temp.join("other-project") };
		await fs.mkdir(second.cwd);
		const firstSource = path.join(first.cwd, "MIXTURES.toml");
		const secondSource = path.join(second.cwd, "MIXTURES.toml");
		await Bun.write(firstSource, DRAFT_THEN_EDIT_TOML.replace("draft-then-edit", "first-project"));
		const secondToml = DRAFT_THEN_EDIT_TOML.replace("draft-then-edit", "second-project");
		await Bun.write(secondSource, secondToml);

		const firstUrl = open(first);
		const secondUrl = open(second);
		const firstDoc = await getScope(firstUrl, "project");
		const secondDoc = await getScope(secondUrl, "project");
		expect(firstDoc).toMatchObject({ cwd: first.cwd, sourcePath: firstSource });
		expect(secondDoc).toMatchObject({ cwd: second.cwd, sourcePath: secondSource });
		expect(firstDoc.doc.mixtures.map(item => item.name)).toEqual(["first-project"]);
		expect(secondDoc.doc.mixtures.map(item => item.name)).toEqual(["second-project"]);
		const doc = { mixtures: [{ ...firstDoc.doc.mixtures[0]!, name: "edited-first-project" }] };
		await json(await write(firstUrl, "PUT", { scope: "project", doc, baseHash: firstDoc.hash }));
		expect((await getScope(firstUrl, "project")).doc.mixtures.map(item => item.name)).toEqual([
			"edited-first-project",
		]);
		expect(await getScope(secondUrl, "project")).toEqual(secondDoc);
		expect(await Bun.file(secondSource).text()).toBe(secondToml);
		expect(await Bun.file(path.join(first.agentDir, "MIXTURES.toml")).text()).toBe(DRAFT_THEN_EDIT_TOML);
	});

	it("returns core validation for an invalid draft and refuses to save it", async () => {
		const url = open();
		const { doc, hash, sourcePath } = await getScope(url, "user");
		const body = { scope: "user" as const, doc: { mixtures: [{ ...doc.mixtures[0]!, entry: "missing" }] } };
		const result = await json<{ validation: Validation }>(await write(url, "POST", body), 422);
		expect(result.validation.errors).toContainEqual({
			code: "entry.unresolved",
			path: "mixtures[0].entry",
			message: 'entry "missing" does not name a member',
		});
		expect(await Bun.file(sourcePath).text()).toBe(DRAFT_THEN_EDIT_TOML);

		const rejected = await json<{ error: string }>(await write(url, "PUT", { ...body, baseHash: hash }), 422);
		expect(rejected.error).toContain('entry "missing" does not name a member');
		expect(await Bun.file(sourcePath).text()).toBe(DRAFT_THEN_EDIT_TOML);
	});

	it("refreshes the retained workspace roster and notifies after saving", async () => {
		const ctx = context();
		const workspace = await MixtureWorkspace.retain("web-editor", ctx);
		try {
			const onSaved = vi.fn<(message: string) => void>();
			const url = open(ctx, onSaved);
			const { doc, hash } = await getScope(url, "user");
			expect(ctx.registry.find("mixture", "draft-then-edit")).toBeDefined();
			const updated = { mixtures: [{ ...doc.mixtures[0]!, name: "live-pipeline" }] };
			const saved = await json<Saved>(await write(url, "PUT", { scope: "user", doc: updated, baseHash: hash }));
			expect(saved.registered).toBe(true);
			expect(ctx.registry.find("mixture", "draft-then-edit")).toBeUndefined();
			expect(ctx.registry.find("mixture", "live-pipeline")).toBeDefined();
			expect(onSaved).toHaveBeenCalledTimes(1);
			expect(onSaved).toHaveBeenCalledWith(expect.stringMatching(/saved.*roster/i));

			const discovered = await json<{ cwd: string; mixtures: { name: string; revision: string }[] }>(
				await request(url, "mixtures/discovered"),
			);
			expect(discovered).toEqual({
				cwd: ctx.cwd,
				mixtures: [{ name: "live-pipeline", revision: expect.stringMatching(/\S/) }],
			});
		} finally {
			workspace.release();
		}
	});

	it.each([
		["/moa web", "project"],
		["/moa web user", "user"],
	] as const)("opens a real editor at the requested scope for %s", async (command, scope) => {
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
			expect(await executeBuiltinSlashCommand(command, { ctx })).toBe(true);
			expect(errors).toEqual([]);
			expect(dock).toHaveBeenCalledTimes(1);
			const url = dock.mock.calls[0]![0];
			expect(dock).toHaveBeenCalledWith(url, "beside");
			expect(browser).toHaveBeenCalledTimes(1);
			expect(browser).toHaveBeenCalledWith(url);
			expect(statuses.join("\n")).toContain(url);
			const snapshot = await json<Snapshot>(await request(url, "mixtures"));
			expect(snapshot.cwd).toBe(fixture!.cwd);
			expect(snapshot.scope).toBe(scope);
			const { doc: userDoc } = await getScope(url, "user");
			const doc = { mixtures: [{ ...userDoc.mixtures[0]!, name: "launched-editor" }] };
			await json<Saved>(await write(url, "PUT", { scope, doc, baseHash: snapshot.hash }));
			expect(session.getRegisteredMixture("launched-editor")).toBeDefined();
			expect(statuses.at(-1)).toContain(`Saved ${scope} MIXTURES.toml and refreshed the mixture roster`);
		} finally {
			browser.mockRestore();
			dock.mockRestore();
			await session.dispose();
		}
	});
});
