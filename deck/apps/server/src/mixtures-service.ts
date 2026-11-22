/**
 * Deck's transport adapter for NeoPi's shared mixture authoring service:
 * resolve an opaque source id within a known workspace and refresh the picker
 * after a successful save.
 */
import type {
	MixtureDefinition,
	MixtureDraftRequest,
	MixtureDraftResponse,
	MixtureGatedFeature,
	MixtureGateProbe,
	MixtureDiscovered,
	MixtureModelMember,
	MixtureSaveRequest,
	MixtureSaveResponse,
	MixturesResponse,
} from "@npi-deck/protocol";
import * as path from "node:path";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import type { FeatureExports } from "./backend/manifest.ts";
import { activeBackend, feature, formatDiagnostic, hasFeature, sdk } from "./backend/runtime.ts";
import { spawnOwnedSync } from "./owned-process.ts";

type AuthoringApi = FeatureExports<"mixture-authoring">;
type MixtureRegistrationContext = Parameters<AuthoringApi["loadMixtureSource"]>[1];

export class MixtureServiceError extends Error {
	constructor(
		readonly status: 400 | 409 | 422 | 500 | 503,
		message: string,
		readonly details: Record<string, unknown> = {},
	) {
		super(message);
	}
}

/** NeoPi's TUI edits the VCS root, falling back to cwd; discovery walks cwd up to that root. */
function projectRoot(cwd: string): string {
	const result = spawnOwnedSync(["git", "rev-parse", "--show-toplevel"], { cwd, stdout: "pipe", stderr: "ignore" });
	return result.exitCode === 0 ? result.stdout.toString().trim() || cwd : cwd;
}

function milestoneOf(gates: readonly MixtureGateProbe[]): string | undefined {
	for (const gate of gates) {
		const match = gate.message ? /this build implements (\S+)$/.exec(gate.message) : null;
		if (match) return match[1];
	}
	return undefined;
}

// One write at a time per process: each compare-and-save sees the file the
// previous one wrote, and the roster refresh follows the write it belongs to.
let writeQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(run: () => Promise<T>): Promise<T> {
	const result = writeQueue.then(run);
	writeQueue = result.catch(() => undefined);
	return result;
}

/** What the service needs from the server; the bridge alone writes NeoPi's mixture catalog. */
export interface MixturesHost {
	/** Workspaces a client may name (config + saved sessions); anything else is refused. */
	workspaces(): Promise<string[]>;
	/** The deck's shared model registry: what members resolve against. */
	registry(): Promise<ModelRegistry>;
	/** Re-register `cwd`'s mixtures in the model picker (AgentBridge.refreshMixtureRoster). */
	refreshRoster(cwd: string): Promise<void>;
	/** Mixture names the model picker lists for a chat in `cwd`. */
	pickerMixtures(cwd: string): Promise<string[]>;
}

export class MixturesService {
	constructor(private readonly host: MixturesHost) {}

	private async known(cwd: unknown): Promise<string> {
		if (typeof cwd !== "string" || !(await this.host.workspaces()).includes(cwd)) throw new MixtureServiceError(400, "unknown project workspace");
		return cwd;
	}

	private api(): AuthoringApi {
		if (!hasFeature("mixture-authoring"))
			throw new MixtureServiceError(503, "this NeoPi backend does not export the mixture authoring API", {
				diagnostics: activeBackend()?.features["mixture-authoring"].diagnostics.map(formatDiagnostic) ?? [],
			});
		return feature("mixture-authoring");
	}

	async #author<T>(api: AuthoringApi, run: () => T | Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (error) {
			if (error instanceof api.MixtureAuthoringError)
				throw new MixtureServiceError(error.status, error.message, error.details);
			throw error;
		}
	}

	/**
	 * The resolution context NeoPi's registration uses for `cwd`. The
	 * read-only settings loader never migrates or writes the user's config.
	 */
	private async context(cwd: string): Promise<MixtureRegistrationContext> {
		const agentDir = sdk().getAgentDir();
		const [registry, settings] = await Promise.all([this.host.registry(), sdk().Settings.loadReadOnly({ cwd, agentDir })]);
		return { cwd, agentDir, registry, settings };
	}

	/** NeoPi's search path for `cwd`, with the deck's editability decided per file. */
	private async sources(api: AuthoringApi, cwd: string) {
		return api.mixtureSources(cwd, { projectDir: projectRoot(cwd), agentDir: sdk().getAgentDir() });
	}

	async load(cwdInput: unknown): Promise<MixturesResponse> {
		const cwd = await this.known(cwdInput);
		const api = this.api();
		const ctx = await this.context(cwd);
		const listed = await this.sources(api, cwd);
		const [sources, picker] = await Promise.all([
			Promise.all(listed.map(source => api.loadMixtureSource(source, ctx))),
			this.host.pickerMixtures(cwd),
		]);
		const gates = probeGates(api, ctx);
		const milestone = milestoneOf(gates);
		return {
			cwd,
			capabilities: {
				drafting: true,
				validation: true,
				persistence: true,
				apply: hasFeature("mixtures"),
				...(milestone ? { milestone } : {}),
				gates,
				diagnostics: [
					"Saving rewrites MIXTURES.toml in NeoPi's canonical form: comments and formatting are not kept.",
					"Saves hold NeoPi's cross-process file lock and recheck the file just before replacing it. An editor that does not take that lock can still write between that check and the replace and be overwritten.",
					...(hasFeature("mixtures") ? [] : ["This backend holds no mixture catalog: saved mixtures cannot reach the model picker."]),
				],
			},
			sources,
			defaultSource: api.sourceId(path.resolve(projectRoot(cwd), "MIXTURES.toml")),
			picker,
		};
	}

	async draft(request: MixtureDraftRequest): Promise<MixtureDraftResponse> {
		const cwd = await this.known(request.cwd);
		const api = this.api();
		const ctx = await this.context(cwd);
		return this.#author(api, () => api.draftMixtureSource(request.input, ctx));
	}

	/** What NeoPi registers for `cwd`: the definitions a `mixture/<name>` chat there runs. */
	async discovered(cwdInput: unknown): Promise<MixtureDiscovered> {
		const cwd = await this.known(cwdInput);
		if (!hasFeature("mixture-config"))
			throw new MixtureServiceError(503, "this NeoPi backend does not export the mixture discovery API", {
				diagnostics: activeBackend()?.features["mixture-config"].diagnostics.map(formatDiagnostic) ?? [],
			});
		const registrable = await feature("mixture-config").discoverRegistrableMixtures(await this.context(cwd));
		return {
			cwd,
			mixtures: registrable.map(mixture => ({
				name: mixture.definition.name,
				revision: mixture.revision,
				definition: mixture.definition as unknown as MixtureDefinition,
			})),
		};
	}

	/** Compare-and-save one server-known source, then refresh Deck's picker. */
	async save(request: MixtureSaveRequest): Promise<MixtureSaveResponse> {
		const cwd = await this.known(request.cwd);
		if (typeof request.source !== "string") throw new MixtureServiceError(400, "source id required");
		if (typeof request.baseHash !== "string") throw new MixtureServiceError(400, "baseHash required");
		const api = this.api();
		const source = (await this.sources(api, cwd)).find(candidate => candidate.id === request.source);
		if (!source) throw new MixtureServiceError(400, "unknown mixture source for this workspace; reload");
		return serialize(async () => {
			const ctx = await this.context(cwd);
			const saved = await this.#author(api, () => api.saveMixtureSource(source, request, ctx));
			if (hasFeature("mixtures")) await this.host.refreshRoster(cwd);
			return { source: saved, picker: await this.host.pickerMixtures(cwd) };
		});
	}
}

/**
 * Probe NeoPi's capability gate one feature at a time: a two-member linear
 * chain plus exactly that feature, validated by NeoPi. The editor labels a
 * control "not runnable on this backend" from this, before the user enables
 * it; the gate itself stays the authority at validation and save.
 */
export function probeGates(api: AuthoringApi, ctx: MixtureRegistrationContext): MixtureGateProbe[] {
	// The tools gate reads the resolved member, so members need a model that resolves.
	const available = ctx.registry.getAvailable().find(model => model.api !== "mixture");
	const model = available ? `${available.provider}/${available.id}` : "deck-probe/none";
	const base = (): MixtureDefinition => ({
		name: "deck-gate-probe",
		entry: "a",
		members: [
			{ id: "a", model, systemPrompt: "probe", tools: false },
			{ id: "b", model, systemPrompt: "probe", tools: false },
		],
		edges: [{ from: "a", to: "b", x: { output: true } }],
	});
	const with_ = (change: (definition: MixtureDefinition) => void) => {
		const definition = base();
		change(definition);
		return definition;
	};
	const a = (definition: MixtureDefinition) => definition.members[0] as MixtureModelMember;
	const edge = (definition: MixtureDefinition) => definition.edges[0]!;
	const probes: Array<[MixtureGatedFeature, string, MixtureDefinition | undefined]> = [
		["verdict", "members[2]", with_(d => { d.members.push({ kind: "verdict", id: "v", question: { type: "noul", instructions: "probe" } }); })],
		["route", "members[0].route", with_(d => { a(d).route = { instructions: "probe" }; })],
		["terminate", "members[0].terminate", with_(d => { a(d).terminate = { instructions: "probe" }; })],
		["tools", "members[1].tools", available ? with_(d => { (d.members[1] as MixtureModelMember).tools = true; }) : undefined],
		["routing", "members[0]", with_(d => { d.members.push({ id: "c", model, systemPrompt: "probe", tools: false }); d.edges.push({ from: "a", to: "c", x: { output: true } }); })],
		["fanout", "edges[0]", with_(d => { d.members.push({ id: "c", model, systemPrompt: "probe", tools: false }); d.edges = [{ from: "a", to: ["b", "c"], join: "b", x: { output: true } }]; })],
		["transcript", "edges[0].x.transcript", with_(d => { edge(d).x = { output: true, transcript: true }; })],
		["toolTrace", "edges[0].x.tool_trace", with_(d => { edge(d).x = { output: true, toolTrace: true }; })],
		["maxTraversals", "edges[0].max_traversals", with_(d => { edge(d).maxTraversals = 2; })],
		["cycles", "edges", with_(d => { d.edges.push({ from: "b", to: "a", x: { output: true } }); })],
		["steering", "steering", with_(d => { d.steering = { target: "active" }; })],
		["budgetUsd", "limits.budget_usd", with_(d => { d.limits = { budgetUsd: 1 }; })],
		["wallClockMinutes", "limits.wall_clock_minutes", with_(d => { d.limits = { wallClockMinutes: 1 }; })],
		["onLimit", "limits.on_limit", with_(d => { d.limits = { onLimit: "stop" }; })],
		["limitTarget", "limits.limit_target", with_(d => { d.limits = { limitTarget: "a" }; })],
		["serve", "serve", with_(d => { d.serve = true; })],
	];
	return probes.flatMap(([feature, path, definition]) => {
		if (!definition) return [];
		const [report] = api.validateMixtureDraft({ mixtures: [definition] }, ctx);
		const gate = report?.unsupported.find(issue => issue.path === path);
		return [gate ? { feature, gated: true, message: gate.message } : { feature, gated: false }];
	});
}
