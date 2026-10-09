import { AdminAuthentication, type AdminActor } from "./admin-auth";
import { adminEventsStream } from "./admin-stream";
import type { LoadedSwitchConfig } from "./config/load";
import { invalid, notFound, SwitchError, unavailable } from "./error";
import type { SwitchStore } from "./store";
import type { HistoryQuery } from "./store-contracts";
import { Fields, readJsonBody } from "./validation";
import type {
	AdminCapability,
	AnnouncedModel,
	ConfigView,
	ExplainView,
	GlueListView,
	HealthView,
	Issue,
	PlanCheckResult,
	PlanRefreshResult,
	ReloadResult,
	SessionView,
} from "./wire";

export interface AdminOperations {
	/** Current committed Generation only; never the in-flight reload candidate. */
	loaded(): LoadedSwitchConfig;
	config(capabilities: readonly AdminCapability[]): ConfigView;
	health(capabilities: readonly AdminCapability[]): HealthView;
	refreshPlan?(id: string): Promise<{ refresh: PlanRefreshResult["refresh"]; issues: Issue[] }>;
	checkPlan?(id: string): Promise<PlanCheckResult>;
	reload?(etag: string): Promise<ReloadResult>;
	explain?(input: unknown): ExplainView;
	models?(endpoint: string, principal: { kind: "key"; name: string } | { kind: "anonymous" }): AnnouncedModel[];
	glue?(): GlueListView;
	restartGlue?(provider: string): Promise<GlueListView["providers"][number]>;
}

const BASE_CAPABILITIES: readonly AdminCapability[] = [
	"keys.read",
	"keys.write",
	"keys.adjust.preview",
	"keys.adjust",
	"plans.read",
	"usage.read",
	"decisions.read",
	"events.read",
	"events.stream",
	"audit.read",
	"config.read",
	"keys.export",
	"keys.import",
	"backup",
];

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
	});
}

function object(value: unknown, location: string, allowed: readonly string[]): Record<string, unknown> {
	const fields = new Fields();
	const row = fields.object(value, location, allowed);
	fields.finish();
	return row;
}

function empty(value: unknown): void {
	object(value, "body", []);
}

function segment(raw: string): string {
	try {
		const decoded = decodeURIComponent(raw);
		if (decoded && !decoded.includes("/") && !decoded.includes("\\") && !decoded.includes("\0")) return decoded;
	} catch {
		/* Invalid percent escapes are bad route names, never authentication bypasses. */
	}
	throw new SwitchError(400, "validation", "Invalid path segment");
}

function query(url: URL, allowed: readonly string[]): void {
	const issues: Issue[] = [];
	for (const [name] of url.searchParams)
		if (!allowed.includes(name))
			issues.push({ code: "validation", path: `query.${name}`, message: "Unknown query parameter" });
	for (const name of allowed)
		if (url.searchParams.getAll(name).length > 1)
			issues.push({ code: "validation", path: `query.${name}`, message: "Repeated query parameter" });
	if (issues.length) invalid(issues.sort((a, b) => a.path.localeCompare(b.path)));
}

function flag(url: URL, name: string): boolean {
	const value = url.searchParams.get(name);
	if (value !== null && value !== "1")
		invalid([{ code: "validation", path: `query.${name}`, message: "Use 1 for an enabled flag" }]);
	return value === "1";
}

function count(
	raw: string | null,
	name: string,
	minimum: number,
	maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
	if (raw === null) return undefined;
	const value = Number(raw);
	if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum)
		invalid([
			{ code: "validation", path: `query.${name}`, message: `Expected an integer from ${minimum} to ${maximum}` },
		]);
	return value;
}

function historyQuery(url: URL, table: "decisions" | "events" | "audit"): HistoryQuery {
	query(
		url,
		table === "decisions"
			? ["since", "key", "plan", "status", "limit", "cursor"]
			: table === "events"
				? ["since", "kind", "key", "plan", "limit", "cursor"]
				: ["since", "key", "limit", "cursor"],
	);
	const since = count(url.searchParams.get("since"), "since", 0);
	const status = count(url.searchParams.get("status"), "status", 0, 599);
	const limit = count(url.searchParams.get("limit"), "limit", 1, 500);
	return {
		...(since !== undefined ? { since } : {}),
		...(url.searchParams.has("key") ? { key: url.searchParams.get("key")! } : {}),
		...(url.searchParams.has("plan") ? { plan: url.searchParams.get("plan")! } : {}),
		...(url.searchParams.has("kind") ? { kind: url.searchParams.get("kind")! } : {}),
		...(status !== undefined ? { status } : {}),
		...(limit !== undefined ? { limit } : {}),
		...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
	};
}

function strong(etag: string | null, type: "generation" | "plan", current: string, snapshot: unknown): void {
	if (etag === null) throw new SwitchError(428, "precondition_required", "If-Match is required");
	if (!new RegExp(`^"${type}:[^"]+"$`).test(etag))
		throw new SwitchError(400, "invalid_precondition", "If-Match must be a copied strong ETag");
	if (etag !== current) throw new SwitchError(409, "stale_resource", "The resource changed", { current: snapshot });
}

export class SwitchAdminController {
	readonly #store: SwitchStore;
	readonly #operations: AdminOperations;
	#authFor?: LoadedSwitchConfig;
	#auth?: AdminAuthentication;
	constructor(store: SwitchStore, operations: AdminOperations) {
		this.#store = store;
		this.#operations = operations;
	}

	get capabilities(): AdminCapability[] {
		const enabled = [...BASE_CAPABILITIES];
		if (this.#operations.refreshPlan) enabled.push("plans.refresh");
		if (this.#operations.checkPlan) enabled.push("plans.check");
		if (this.#operations.reload) enabled.push("config.reload");
		if (this.#operations.explain) enabled.push("explain");
		if (this.#operations.models) enabled.push("models.read");
		if (this.#operations.glue) enabled.push("glue.read");
		if (this.#operations.restartGlue) enabled.push("glue.restart");
		return enabled;
	}

	#authentication(): AdminAuthentication {
		const loaded = this.#operations.loaded();
		if (!loaded.config.admin) throw new SwitchError(503, "unavailable", "The admin API is disabled");
		if (this.#authFor !== loaded) {
			this.#authFor = loaded;
			this.#auth = new AdminAuthentication(loaded.config.admin, loaded.secrets);
		}
		return this.#auth!;
	}

	#actor(request: Request, role: "read" | "write"): AdminActor {
		return this.#authentication().authorize(request.headers.get("authorization"), role);
	}
	#read<T>(reader: () => T): Response {
		return json(this.#store.envelope(reader));
	}
	#write<T>(writer: () => T): Response {
		return this.#read(writer);
	}

	async handle(request: Request): Promise<Response> {
		let allowedOrigin: string | undefined;
		try {
			const url = new URL(request.url);
			const origin = request.headers.get("origin");
			const allowedOrigins = this.#operations.loaded().config.admin?.corsOrigins ?? [];
			if (origin && !allowedOrigins.includes(origin))
				throw new SwitchError(403, "origin_forbidden", "Browser origin is not allow-listed");
			if (origin) allowedOrigin = origin;
			if (request.method === "OPTIONS") {
				if (!origin)
					throw new SwitchError(403, "origin_forbidden", "An Origin header is required for admin preflight");
				return new Response(null, {
					status: 204,
					headers: {
						"Access-Control-Allow-Origin": origin,
						"Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
						"Access-Control-Allow-Headers": "authorization, content-type, if-match, if-none-match, last-event-id",
						Vary: "Origin",
						"Cache-Control": "no-store",
					},
				});
			}
			const result = await this.#route(request, url);
			if (allowedOrigin) {
				result.headers.set("Access-Control-Allow-Origin", allowedOrigin);
				result.headers.set("Vary", "Origin");
			}
			return result;
		} catch (error) {
			const failure =
				error instanceof SwitchError
					? error
					: new SwitchError(500, "internal_error", "The switch could not complete the admin request");
			const result = json(failure.toJSON(), failure.status);
			if (allowedOrigin) {
				result.headers.set("Access-Control-Allow-Origin", allowedOrigin);
				result.headers.set("Vary", "Origin");
			}
			return result;
		}
	}

	async #route(request: Request, url: URL): Promise<Response> {
		const path = url.pathname;
		const method = request.method.toUpperCase();
		const store = this.#store;
		if (!path.startsWith("/admin/v1/") && path !== "/admin/v1") notFound("Admin route");
		this.#actor(request, "read");
		if (method === "GET" && path === "/admin/v1/session") {
			query(url, []);
			const actor = this.#actor(request, "read");
			return this.#read((): SessionView => ({
				actor: actor.name,
				role: actor.role,
				capabilities: this.capabilities,
				serviceLabel: this.#operations.loaded().config.switch.name,
				metersTtlS: this.#operations.loaded().config.switch.metersTtlS,
			}));
		}
		if (method === "GET" && path === "/admin/v1/snapshot") {
			query(url, []);
			this.#actor(request, "read");
			return this.#read(() =>
				store.snapshot(this.#operations.config(this.capabilities), this.#operations.health(this.capabilities)),
			);
		}
		if (method === "GET" && path === "/admin/v1/overview") {
			query(url, []);
			this.#actor(request, "read");
			return this.#read(() =>
				store.overview(this.#operations.config(this.capabilities), this.#operations.health(this.capabilities)),
			);
		}
		if (method === "GET" && path === "/admin/v1/health") {
			query(url, []);
			this.#actor(request, "read");
			return this.#read(() => this.#operations.health(this.capabilities));
		}
		if (method === "GET" && path === "/admin/v1/config") {
			query(url, []);
			this.#actor(request, "read");
			return this.#read(() => this.#operations.config(this.capabilities));
		}
		if (method === "POST" && path === "/admin/v1/config/reload") {
			this.#actor(request, "write");
			const before = this.#operations.config(this.capabilities);
			strong(request.headers.get("if-match"), "generation", before.etag, before);
			empty(await readJsonBody(request));
			this.#actor(request, "write");
			if (!this.#operations.reload) unavailable("M8", "config.reload");
			const result = await this.#operations.reload(before.etag);
			return this.#read(() => result);
		}
		if (method === "GET" && path === "/admin/v1/keys") {
			query(url, ["usage"]);
			flag(url, "usage");
			this.#actor(request, "read");
			return this.#read(() => store.keys());
		}
		if (method === "POST" && path === "/admin/v1/keys") {
			this.#actor(request, "write");
			const body = await readJsonBody(request);
			const actor = this.#actor(request, "write");
			return this.#write(() =>
				store.mint(actor.name, body as Parameters<SwitchStore["mint"]>[1], request.headers.get("if-none-match")),
			);
		}
		if (method === "GET" && path === "/admin/v1/keys/export") {
			query(url, ["tokens"]);
			const includeTokens = flag(url, "tokens");
			const actor = this.#actor(request, includeTokens ? "write" : "read");
			return this.#read(() => store.exportKeys(actor.name, includeTokens));
		}
		if (method === "POST" && path === "/admin/v1/keys/import/preview") {
			this.#actor(request, "write");
			const body = await readJsonBody(request);
			const actor = this.#actor(request, "write");
			return this.#read(() => store.importPreview(actor.name, body as Parameters<SwitchStore["importPreview"]>[1]));
		}
		if (method === "POST" && path === "/admin/v1/keys/import") {
			this.#actor(request, "write");
			const body = await readJsonBody(request);
			const actor = this.#actor(request, "write");
			return this.#write(() =>
				store.importKeys(
					actor.name,
					body as Parameters<SwitchStore["importKeys"]>[1],
					request.headers.get("if-match"),
				),
			);
		}
		const nameMatch = /^\/admin\/v1\/keys\/([^/]+)(?:\/(.*))?$/.exec(path);
		if (nameMatch) {
			const name = segment(nameMatch[1]);
			const action = nameMatch[2] ?? "";
			if (method === "GET" && !action) {
				query(url, ["usage"]);
				flag(url, "usage");
				this.#actor(request, "read");
				return this.#read(() => store.key(name));
			}
			if (method === "GET" && action === "usage") {
				query(url, ["window"]);
				this.#actor(request, "read");
				return this.#read(() => store.usage(name, url.searchParams.get("window") ?? "24h"));
			}
			if (method === "PATCH" && !action) {
				this.#actor(request, "write");
				const body = await readJsonBody(request);
				const actor = this.#actor(request, "write");
				return this.#write(() =>
					store.patch(
						actor.name,
						name,
						body as Parameters<SwitchStore["patch"]>[2],
						request.headers.get("if-match"),
					),
				);
			}
			if (method === "DELETE" && !action) {
				query(url, []);
				const actor = this.#actor(request, "write");
				return this.#write(() => store.revoke(actor.name, name, request.headers.get("if-match")));
			}
			if (method === "POST" && action === "rotate") {
				this.#actor(request, "write");
				const body = await readJsonBody(request);
				const actor = this.#actor(request, "write");
				const row = object(body, "body", ["grace_s"]);
				const fields = new Fields();
				fields.number(row.grace_s, "body.grace_s", { optional: true, min: 0, max: 3600, integer: true });
				fields.finish();
				return this.#write(() =>
					store.rotate(actor.name, name, (row.grace_s as number) ?? 0, request.headers.get("if-match")),
				);
			}
			if (method === "POST" && action === "reveal") {
				this.#actor(request, "write");
				empty(await readJsonBody(request));
				const actor = this.#actor(request, "write");
				return this.#write(() => store.reveal(actor.name, name, request.headers.get("if-match")));
			}
			if (method === "POST" && action === "adjust/preview") {
				this.#actor(request, "read");
				const body = await readJsonBody(request);
				const actor = this.#actor(request, "read");
				return this.#read(() => store.preview(actor.name, name, body as Parameters<SwitchStore["preview"]>[2]));
			}
			if (method === "POST" && action === "adjust") {
				this.#actor(request, "write");
				const body = await readJsonBody(request);
				const actor = this.#actor(request, "write");
				return this.#write(() =>
					store.adjust(
						actor.name,
						name,
						body as Parameters<SwitchStore["adjust"]>[2],
						request.headers.get("if-match"),
					),
				);
			}
		}
		if (method === "GET" && path === "/admin/v1/plans") {
			query(url, ["identity"]);
			const identity = flag(url, "identity");
			this.#actor(request, identity ? "write" : "read");
			return this.#read(() => store.plans(identity));
		}
		const planMatch = /^\/admin\/v1\/plans\/([^/]+)(?:\/(refresh|check))?$/.exec(path);
		if (planMatch) {
			const id = segment(planMatch[1]);
			const action = planMatch[2];
			if (method === "GET" && !action) {
				query(url, ["identity"]);
				const identity = flag(url, "identity");
				this.#actor(request, identity ? "write" : "read");
				return this.#read(() => store.plan(id, identity));
			}
			if (method === "POST" && action) {
				this.#actor(request, "write");
				const current = store.plan(id);
				strong(request.headers.get("if-match"), "plan", current.etag, current);
				empty(await readJsonBody(request));
				this.#actor(request, "write");
				if (action === "refresh") {
					if (!this.#operations.refreshPlan) unavailable("M4", "plans.refresh");
					const refresh = await this.#operations.refreshPlan(id);
					const after = store.plan(id);
					strong(current.etag, "plan", after.etag, after);
					return this.#read((): PlanRefreshResult => ({ plan: store.plan(id), ...refresh }));
				}
				if (!this.#operations.checkPlan) unavailable("M4", "plans.check");
				const result = await this.#operations.checkPlan(id);
				const after = store.plan(id);
				strong(current.etag, "plan", after.etag, after);
				return this.#read(() => result);
			}
		}
		if (method === "GET" && path === "/admin/v1/decisions") {
			this.#actor(request, "read");
			const filters = historyQuery(url, "decisions");
			return this.#read(() => store.history("decisions", filters));
		}
		if (method === "GET" && path === "/admin/v1/events") {
			this.#actor(request, "read");
			const filters = historyQuery(url, "events");
			return this.#read(() => store.history("events", filters));
		}
		if (method === "GET" && path === "/admin/v1/audit") {
			this.#actor(request, "read");
			const filters = historyQuery(url, "audit");
			return this.#read(() => store.history("audit", filters));
		}
		if (method === "GET" && path === "/admin/v1/events/stream") {
			query(url, ["after"]);
			const actor = this.#actor(request, "read");
			const after = url.searchParams.get("after");
			const last = request.headers.get("last-event-id");
			if (after && last && after !== last)
				throw new SwitchError(400, "invalid_cursor", "after and Last-Event-ID disagree");
			if (!after && !last) throw new SwitchError(400, "invalid_cursor", "An initial snapshot cursor is required");
			return adminEventsStream(store, after ?? last!, actor, request.headers.get("authorization"), () =>
				this.#authentication(),
			);
		}
		if (method === "POST" && path === "/admin/v1/explain") {
			this.#actor(request, "read");
			const body = await readJsonBody(request);
			this.#actor(request, "read");
			if (!this.#operations.explain) unavailable("M5", "explain");
			return this.#read(() => this.#operations.explain!(body));
		}
		if (method === "GET" && path === "/admin/v1/models") {
			query(url, ["endpoint", "key", "anonymous"]);
			this.#actor(request, "read");
			const endpoint = url.searchParams.get("endpoint");
			const key = url.searchParams.get("key");
			const anonymous = flag(url, "anonymous");
			if (!endpoint || (key && anonymous) || (!key && !anonymous))
				invalid([
					{ code: "validation", path: "query", message: "Supply endpoint and exactly one of key or anonymous=1" },
				]);
			if (!this.#operations.models) unavailable("M3", "models.read");
			return this.#read(() =>
				this.#operations.models!(endpoint, key ? { kind: "key", name: key } : { kind: "anonymous" }),
			);
		}
		if (method === "POST" && path === "/admin/v1/backup") {
			this.#actor(request, "write");
			const body = await readJsonBody(request);
			const actor = this.#actor(request, "write");
			const row = object(body, "body", ["path"]);
			const fields = new Fields();
			fields.string(row.path, "body.path");
			fields.finish();
			return json(
				await store.backup(actor.name, row.path as string, request.headers.get("if-match"), () => {
					this.#actor(request, "write");
				}),
			);
		}
		if (method === "GET" && path === "/admin/v1/glue") {
			query(url, []);
			this.#actor(request, "read");
			if (!this.#operations.glue) unavailable("M8", "glue.read");
			return this.#read(() => this.#operations.glue!());
		}
		const restart = /^\/admin\/v1\/glue\/([^/]+)\/restart$/.exec(path);
		if (method === "POST" && restart) {
			const id = segment(restart[1]);
			this.#actor(request, "write");
			const before = this.#operations.config(this.capabilities);
			strong(request.headers.get("if-match"), "generation", before.etag, before);
			empty(await readJsonBody(request));
			this.#actor(request, "write");
			if (!this.#operations.restartGlue) unavailable("M8", "glue.restart");
			const result = await this.#operations.restartGlue(id);
			strong(
				before.etag,
				"generation",
				this.#operations.config(this.capabilities).etag,
				this.#operations.config(this.capabilities),
			);
			return this.#read(() => result);
		}
		notFound("Admin route");
	}
}
