import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadMixtureSource, MixtureAuthoringError, saveMixtureSources } from "@oh-my-pi/pi-coding-agent/moa/authoring";
import { ABSENT, type MixtureSource, mixtureSources } from "@oh-my-pi/pi-coding-agent/moa/authoring-files";
import type { MixtureRegistrationContext } from "@oh-my-pi/pi-coding-agent/moa/registration";
import type { MixturesConfigDoc } from "@oh-my-pi/pi-tui/overlays/mixture-types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createMoaFixture, DRAFT_THEN_EDIT_TOML, type MoaFixture } from "./helpers/moa-setup";

describe("transactional mixture save", () => {
	let temp: TempDir;
	let fixture: MoaFixture;
	let ctx: MixtureRegistrationContext;
	let user: MixtureSource;
	let project: MixtureSource;

	beforeEach(async () => {
		temp = TempDir.createSync("@moa-save-");
		fixture = await createMoaFixture(temp);
		ctx = { cwd: fixture.cwd, agentDir: fixture.agentDir, registry: fixture.registry, settings: Settings.isolated() };
		const sources = await mixtureSources(fixture.cwd, { projectDir: fixture.cwd, agentDir: fixture.agentDir });
		user = sources.find(source => source.kind === "user")!;
		project = sources.find(source => source.path === path.join(fixture.cwd, "MIXTURES.toml"))!;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fixture.authStorage.close();
		temp.removeSync();
	});

	/** A move from the user file into the project file, gaining file first. */
	async function moveBatch() {
		const from = await loadMixtureSource(user, ctx);
		const definition = from.doc.mixtures[0]!;
		return {
			from,
			writes: [
				{ source: project, baseHash: ABSENT, doc: { mixtures: [definition] } },
				{ source: user, baseHash: from.hash, doc: { mixtures: [] } },
			],
		};
	}

	/** Fail the first fsync of `dir`, after the rename or unlink there has already taken effect. */
	function failDirectorySyncOnce(dir: string, alsoBeforeFailing?: () => Promise<void>) {
		const open = fs.open;
		let failed = false;
		return vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
			if (!failed && args[0] === dir && args[1] === (constants.O_RDONLY | constants.O_DIRECTORY)) {
				failed = true;
				await alsoBeforeFailing?.();
				throw Object.assign(new Error("EIO: simulated directory fsync failure"), { code: "EIO" });
			}
			return open(...args);
		});
	}

	async function rejection(promise: Promise<unknown>): Promise<MixtureAuthoringError> {
		const error = await promise.then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(MixtureAuthoringError);
		return error as MixtureAuthoringError;
	}

	it("moves a mixture between two files and keeps its revision", async () => {
		const { from, writes } = await moveBatch();
		const revision = from.validation[0]!.revision;
		expect(revision).toMatch(/\S/);

		const [gained, lost] = await saveMixtureSources(writes, ctx);
		expect(gained!.doc.mixtures.map(mixture => mixture.name)).toEqual(["draft-then-edit"]);
		expect(gained!.validation[0]).toMatchObject({ runnable: true, revision });
		expect(lost).toMatchObject({ exists: false, hash: ABSENT, doc: { mixtures: [] } });
		expect(await Bun.file(user.path).exists()).toBe(false);
		expect(Bun.TOML.parse(await Bun.file(project.path).text())).toMatchObject({
			mixtures: [{ name: "draft-then-edit", entry: "writer" }],
		});
	});

	it("refuses the whole batch when any file is stale and writes nothing", async () => {
		const { writes } = await moveBatch();
		const edited = `${DRAFT_THEN_EDIT_TOML}\n# edited elsewhere\n`;
		await Bun.write(user.path, edited);

		const error = await rejection(saveMixtureSources(writes, ctx));
		expect(error.status).toBe(409);
		expect(error.details.conflicts?.map(conflict => conflict.sourceId)).toEqual([user.id]);
		expect(error.details.conflicts?.[0]?.current.text).toBe(edited);
		expect(await Bun.file(project.path).exists()).toBe(false);
		expect(await Bun.file(user.path).text()).toBe(edited);
	});

	it("restores every file it can prove it wrote when a later write fails after taking effect", async () => {
		const { writes } = await moveBatch();
		// The user file is unlinked, then its directory fsync fails: the removal already happened.
		failDirectorySyncOnce(await fs.realpath(fixture.agentDir));

		const error = await rejection(saveMixtureSources(writes, ctx));
		expect(error.details.partial).toBe(false);
		expect(error.details.outcomes).toEqual([
			{ sourceId: project.id, path: project.path, state: "original", hash: ABSENT },
			{ sourceId: user.id, path: user.path, state: "original", hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
		]);
		expect(await Bun.file(user.path).text()).toBe(DRAFT_THEN_EDIT_TOML);
		expect(await Bun.file(project.path).exists()).toBe(false);
	});

	it("leaves a file another writer changed alone and reports each file's state", async () => {
		const { writes } = await moveBatch();
		const foreign = '[[mixtures]]\nname = "someone-else"\n';
		failDirectorySyncOnce(await fs.realpath(fixture.agentDir), () => Bun.write(project.path, foreign).then(() => {}));

		const error = await rejection(saveMixtureSources(writes, ctx));
		expect(error.status).toBe(500);
		expect(error.details.partial).toBe(true);
		const states = Object.fromEntries(
			(error.details.outcomes ?? []).map(outcome => [outcome.sourceId, outcome.state]),
		);
		expect(states).toEqual({ [project.id]: "unknown", [user.id]: "original" });
		// Never deleted: the only copy of someone else's edit stays on disk, and the moved mixture is back home.
		expect(await Bun.file(project.path).text()).toBe(foreign);
		expect(await Bun.file(user.path).text()).toBe(DRAFT_THEN_EDIT_TOML);
	});

	it("never leaves a swapped mixture on disk in neither file, whichever write a crash interrupts", async () => {
		const userDoc = await loadMixtureSource(user, ctx);
		const x = userDoc.doc.mixtures[0]!;
		const y = { ...x, name: "project-only" };
		const seeded = await saveMixtureSources([{ source: project, baseHash: ABSENT, doc: { mixtures: [y] } }], ctx);

		// After every rename or unlink (the moments a kill could follow), both definitions must be on disk.
		const onDisk = async () => {
			const names = new Set<string>();
			for (const file of [user, project])
				for (const mixture of (await loadMixtureSource(file, ctx)).doc.mixtures) names.add(mixture.name);
			return names;
		};
		const seen: Set<string>[] = [];
		const rename = fs.rename;
		const unlink = fs.unlink;
		vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
			await rename(...args);
			seen.push(await onDisk());
		});
		vi.spyOn(fs, "unlink").mockImplementation(async (...args: Parameters<typeof fs.unlink>) => {
			await unlink(...args);
			seen.push(await onDisk());
		});

		await saveMixtureSources(
			[
				{ source: user, baseHash: userDoc.hash, doc: { mixtures: [y] } },
				{ source: project, baseHash: seeded[0]!.hash, doc: { mixtures: [x] } },
			],
			ctx,
		);
		expect(seen.length).toBeGreaterThanOrEqual(3);
		for (const names of seen) expect([...names].sort()).toEqual(["draft-then-edit", "project-only"]);
		expect((await loadMixtureSource(user, ctx)).doc.mixtures.map(mixture => mixture.name)).toEqual(["project-only"]);
		expect((await loadMixtureSource(project, ctx)).doc.mixtures.map(mixture => mixture.name)).toEqual([
			"draft-then-edit",
		]);
	});

	it("undoes a swap whose final phase fails, restoring both files exactly", async () => {
		const userDoc = await loadMixtureSource(user, ctx);
		const x = userDoc.doc.mixtures[0]!;
		const y = { ...x, name: "project-only" };
		const seeded = await saveMixtureSources([{ source: project, baseHash: ABSENT, doc: { mixtures: [y] } }], ctx);
		const projectText = await Bun.file(project.path).text();
		const rename = fs.rename;
		let renames = 0;
		// Phase one writes both staged files; fail the third rename (the first final write) after it lands.
		vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
			await rename(...args);
			if (++renames === 3) throw Object.assign(new Error("EIO: simulated failure after rename"), { code: "EIO" });
		});
		const error = await rejection(
			saveMixtureSources(
				[
					{ source: user, baseHash: userDoc.hash, doc: { mixtures: [y] } },
					{ source: project, baseHash: seeded[0]!.hash, doc: { mixtures: [x] } },
				],
				ctx,
			),
		);
		expect(error.details.partial).toBe(false);
		expect(error.details.outcomes?.map(outcome => outcome.state)).toEqual(["original", "original"]);
		expect(await Bun.file(user.path).text()).toBe(DRAFT_THEN_EDIT_TOML);
		expect(await Bun.file(project.path).text()).toBe(projectText);
	});

	describe("a kill at any write, including during rollback, never loses a definition", () => {
		/** Definitions are told apart by description, which survives renames. */
		async function descriptionsOnDisk(): Promise<string[]> {
			const found = new Set<string>();
			for (const file of [user, project])
				for (const mixture of (await loadMixtureSource(file, ctx)).doc.mixtures)
					if (mixture.description) found.add(mixture.description);
			return [...found].sort();
		}

		/** Record what is on disk after every rename or unlink lands, failing those listed (after they land). */
		function recordWrites(failAt: ReadonlySet<number>) {
			const states: string[][] = [];
			const rename = fs.rename;
			const unlink = fs.unlink;
			const after = async () => {
				states.push(await descriptionsOnDisk());
				if (failAt.has(states.length))
					throw Object.assign(new Error("EIO: simulated failure after the write landed"), { code: "EIO" });
			};
			vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
				await rename(...args);
				await after();
			});
			vi.spyOn(fs, "unlink").mockImplementation(async (...args: Parameters<typeof fs.unlink>) => {
				await unlink(...args);
				await after();
			});
			return states;
		}

		type Case = {
			userDoc: MixturesConfigDoc;
			projectDoc: MixturesConfigDoc;
			userFinal: MixturesConfigDoc;
			projectFinal: MixturesConfigDoc;
		};

		async function base() {
			return (await loadMixtureSource(user, ctx)).doc.mixtures[0]!;
		}

		const cases: Record<string, () => Promise<Case>> = {
			"a swap of two differently named mixtures": async () => {
				const x = { ...(await base()), description: "x" };
				const y = { ...x, name: "other", description: "y" };
				return {
					userDoc: { mixtures: [x] },
					projectDoc: { mixtures: [y] },
					userFinal: { mixtures: [y] },
					projectFinal: { mixtures: [x] },
				};
			},
			"a swap of two versions of the same name": async () => {
				const v1 = { ...(await base()), description: "v1" };
				const v2 = { ...v1, description: "v2" };
				return {
					userDoc: { mixtures: [v1] },
					projectDoc: { mixtures: [v2] },
					userFinal: { mixtures: [v2] },
					projectFinal: { mixtures: [v1] },
				};
			},
			"a move away plus another mixture renamed onto the freed name": async () => {
				const x = { ...(await base()), description: "x" };
				const w = { ...x, name: "w", description: "w" };
				return {
					userDoc: { mixtures: [x] },
					projectDoc: { mixtures: [w] },
					userFinal: { mixtures: [{ ...w, name: x.name }] },
					projectFinal: { mixtures: [x] },
				};
			},
		};

		for (const [label, make] of Object.entries(cases)) {
			it(label, async () => {
				const scenario = await make();
				const everything = [...scenario.userDoc.mixtures, ...scenario.projectDoc.mixtures]
					.map(mixture => mixture.description!)
					.sort();
				const seed = async () => {
					const userHash = (await loadMixtureSource(user, ctx)).hash;
					const projectHash = (await loadMixtureSource(project, ctx)).hash;
					return saveMixtureSources(
						[
							{ source: user, baseHash: userHash, doc: scenario.userDoc },
							{ source: project, baseHash: projectHash, doc: scenario.projectDoc },
						],
						ctx,
					);
				};
				const attempt = async (failAt: ReadonlySet<number>) => {
					const [seededUser, seededProject] = await seed();
					const states = recordWrites(failAt);
					const outcome = await saveMixtureSources(
						[
							{ source: user, baseHash: seededUser!.hash, doc: scenario.userFinal },
							{ source: project, baseHash: seededProject!.hash, doc: scenario.projectFinal },
						],
						ctx,
					).then(
						() => "saved",
						(error: unknown) => {
							expect(error).toBeInstanceOf(MixtureAuthoringError);
							return "failed";
						},
					);
					vi.restoreAllMocks();
					for (const [index, state] of states.entries())
						expect(state, `${label}: after write ${index + 1}, failing ${[...failAt]}`).toEqual(everything);
					expect(await descriptionsOnDisk()).toEqual(everything);
					return { outcome, writes: states.length };
				};

				const clean = await attempt(new Set());
				expect(clean.outcome).toBe("saved");
				expect(clean.writes).toBeGreaterThanOrEqual(3);
				// Fail each write once, then each write and the first rollback write after it.
				for (let at = 1; at <= clean.writes; at++) {
					expect((await attempt(new Set([at]))).outcome).toBe("failed");
					await attempt(new Set([at, at + 1]));
				}
			});
		}
	});

	it("keeps the gaining file when the losing file cannot be restored, so the moved mixture survives", async () => {
		const { writes } = await moveBatch();
		const recreated = '[[mixtures]]\nname = "recreated-elsewhere"\n';
		// The user file's unlink lands, its fsync fails, and an outside writer recreates it before rollback.
		failDirectorySyncOnce(await fs.realpath(fixture.agentDir), () => Bun.write(user.path, recreated).then(() => {}));

		const error = await rejection(saveMixtureSources(writes, ctx));
		expect(error.status).toBe(500);
		expect(error.details.partial).toBe(true);
		const states = Object.fromEntries(
			(error.details.outcomes ?? []).map(outcome => [outcome.sourceId, outcome.state]),
		);
		expect(states).toEqual({ [project.id]: "saved", [user.id]: "unknown" });
		expect(await Bun.file(user.path).text()).toBe(recreated);
		expect(Bun.TOML.parse(await Bun.file(project.path).text())).toMatchObject({
			mixtures: [{ name: "draft-then-edit" }],
		});
	});
	it("blocks a definition that becomes invalid in its new file but carries one that was already invalid", async () => {
		const from = await loadMixtureSource(user, ctx);
		const broken = {
			...from.doc.mixtures[0]!,
			name: "needs-preset",
			members: from.doc.mixtures[0]!.members.map(member => ({ ...member, systemPrompt: undefined, role: "house" })),
		};
		// Valid where it lives (the file defines the role preset), invalid once moved without it.
		const home = { roles: { house: "Answer well." }, mixtures: [broken] };
		await Bun.write(user.path, "");
		const seeded = await saveMixtureSources(
			[{ source: user, baseHash: (await loadMixtureSource(user, ctx)).hash, doc: home }],
			ctx,
		);
		const moved = await rejection(
			saveMixtureSources(
				[
					{ source: project, baseHash: ABSENT, doc: { mixtures: [broken] } },
					{ source: user, baseHash: seeded[0]!.hash, doc: { roles: home.roles, mixtures: [] } },
				],
				ctx,
			),
		);
		expect(moved.status).toBe(422);
		expect(moved.details.files?.map(file => [file.sourceId, file.blocked])).toEqual([[project.id, [0]]]);
		expect(await Bun.file(project.path).exists()).toBe(false);

		// An already-invalid definition (its preset is missing on disk) may move unchanged.
		await saveMixtureSources([{ source: user, baseHash: seeded[0]!.hash, doc: { mixtures: [] } }], ctx);
		const invalidOnDisk = `[[mixtures]]\nname = "needs-preset"\nentry = "writer"\n\n[[mixtures.members]]\nid = "writer"\nmodel = "fake/writer"\nrole = "house"\ntools = false\n`;
		await Bun.write(user.path, invalidOnDisk);
		const loaded = await loadMixtureSource(user, ctx);
		expect(loaded.validation[0]!.runnable).toBe(false);
		await saveMixtureSources(
			[
				{ source: project, baseHash: ABSENT, doc: { mixtures: [loaded.doc.mixtures[0]!] } },
				{ source: user, baseHash: loaded.hash, doc: { mixtures: [] } },
			],
			ctx,
		);
		expect(Bun.TOML.parse(await Bun.file(project.path).text())).toMatchObject({
			mixtures: [{ name: "needs-preset" }],
		});
	});
});
