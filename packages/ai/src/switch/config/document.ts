import { createHash } from "node:crypto";
import { MODEL_KINDS } from "@oh-my-pi/pi-catalog/types";
import { isLoopbackHost, isExactOrigin } from "../network";
import { decodeDials } from "../slug";
import { GATEWAY_ROUTE_KINDS, inferGatewayRoute } from "../routes";
import type { Gate } from "../wire";
import { validateCidr, KEY_NAME } from "../validation";
import { type DecodeContext, secretReference, warning } from "./context";
import type { ConfigFields } from "./fields";
import { decodeProvider } from "./providers";
import type { EndpointConfig, PlanConfig, SwitchConfig, VirtualModelConfig } from "./types";

const VIRTUAL_ID = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
const FAILOVER = ["429", "5xx", "connect", "timeout", "reauth", "model-missing", "plan-exhausted", "draining"] as const;

function gates(context: DecodeContext, value: unknown, location: string): Gate[] {
	const f = context.fields;
	const rows = f.array(value, location, true);
	return rows.map((item, index) => {
		const row = f.object(item, `${location}[${index}]`, ["meter", "ceiling", "reserve", "warn_at"]);
		f.string(row.meter, `${location}[${index}].meter`);
		f.number(row.ceiling, `${location}[${index}].ceiling`, { optional: true, min: 0, exclusiveMin: true, max: 100 });
		f.number(row.reserve, `${location}[${index}].reserve`, { optional: true, min: 0, max: 100 });
		if (row.ceiling === undefined && row.reserve === undefined)
			f.issue(`${location}[${index}]`, "A Gate requires a ceiling or reserve", "E-ANON-PLANS");
		f.thresholds(row.warn_at, `${location}[${index}].warn_at`, true);
		return {
			meter: String(row.meter),
			...(typeof row.ceiling === "number" ? { ceiling: row.ceiling } : {}),
			...(typeof row.reserve === "number" ? { reserve: row.reserve } : {}),
			...(row.warn_at !== undefined ? { warnAt: row.warn_at as number[] } : {}),
		};
	});
}

function endpoint(
	context: DecodeContext,
	value: unknown,
	location: string,
	providerIds: ReadonlySet<string>,
	virtualIds: ReadonlySet<string>,
): EndpointConfig {
	const f = context.fields;
	const row = f.object(value, location, [
		"id",
		"bind",
		"route",
		"protocol",
		"auth",
		"keys",
		"connect",
		"anonymous_plans",
		"trusted_proxies",
		"allowed_origins",
		"repairs",
		"cors",
		"diagnostics",
		"max_in_flight",
	]);
	const bind = f.bind(row.bind, `${location}.bind`);
	const route = f.text(row.route, `${location}.route`);
	const wildcard = route.endsWith("/*");
	if (
		!route.startsWith("/") ||
		route !== new URL(route, "http://switch.invalid").pathname ||
		(!wildcard && route.endsWith("/"))
	)
		f.issue(`${location}.route`, "Expected an absolute exact path or prefix/*", "E-ROUTE");
	const auth = f.choice(row.auth, `${location}.auth`, ["key", "none"], "key");
	if (auth === "none" && !isLoopbackHost(bind.hostname))
		f.issue(`${location}.auth`, "Unauthenticated endpoints require a loopback bind", "E-REMOTE-NO-AUTH");
	const protocol =
		row.protocol === undefined
			? "auto"
			: f.choice(row.protocol, `${location}.protocol`, ["auto", ...GATEWAY_ROUTE_KINDS], "auto");
	if (!wildcard && protocol === "auto" && !inferGatewayRoute(route))
		f.issue(`${location}.protocol`, "An exact non-well-known route requires its protocol", "E-ROUTE");
	const entries =
		row.connect === undefined
			? undefined
			: f
					.array(row.connect, `${location}.connect`)
					.map((item, index) => connect(f, item, `${location}.connect[${index}]`, providerIds, virtualIds));
	if (entries === undefined)
		f.issue(
			`${location}.connect`,
			"connect is required; use an explicit empty array to serve nothing",
			"E-CONNECT-REQUIRED",
		);
	if (!entries?.length) warning(context, "W-EMPTY-CONNECT", location, "This endpoint serves nothing");
	const plans = f.array(row.anonymous_plans, `${location}.anonymous_plans`, true).map((item, index) => {
		const configured =
			typeof item === "string"
				? { plan: item }
				: f.object(item, `${location}.anonymous_plans[${index}]`, ["plan", "gates"]);
		return {
			plan: f.text(configured.plan, `${location}.anonymous_plans[${index}].plan`),
			gates: gates(context, configured.gates, `${location}.anonymous_plans[${index}].gates`),
		};
	});
	if (auth === "key" && row.anonymous_plans !== undefined)
		f.issue(`${location}.anonymous_plans`, "Anonymous Plans belong only on auth=none endpoints", "E-ANON-PLANS");
	const origins = f.strings(row.allowed_origins, `${location}.allowed_origins`, true);
	for (const [index, origin] of origins.entries())
		if (!isExactOrigin(origin))
			f.issue(`${location}.allowed_origins[${index}]`, "Expected an exact scheme://host[:port] origin", "E-ORIGINS");
	if (auth === "key" && row.allowed_origins !== undefined)
		f.issue(`${location}.allowed_origins`, "Browser origins belong only on auth=none endpoints", "E-ORIGINS");
	const proxies = f.strings(row.trusted_proxies, `${location}.trusted_proxies`, true);
	for (const [index, cidr] of proxies.entries())
		if (!validateCidr(cidr))
			f.issue(`${location}.trusted_proxies[${index}]`, "Expected an IPv4 or IPv6 CIDR", "E-CIDR");
	const normalized = `${bind.hostname.toLowerCase()}:${bind.port}`;
	return {
		id:
			row.id === undefined
				? `ep-${createHash("sha256").update(`${normalized}\n${route}`).digest("hex").slice(0, 12)}`
				: f.id(row.id, `${location}.id`),
		explicitId: row.id !== undefined,
		bind,
		route,
		wildcard,
		protocol,
		auth,
		keys: row.keys === undefined ? ["*"] : f.strings(row.keys, `${location}.keys`),
		connect: entries ?? [],
		anonymousPlans: plans,
		trustedProxies: proxies,
		allowedOrigins: origins,
		repairs: f.choice(row.repairs, `${location}.repairs`, ["on", "log-only", "off"], "on"),
		cors: f.flag(row.cors, `${location}.cors`, false),
		diagnostics: f.choice(row.diagnostics, `${location}.diagnostics`, ["standard", "minimal"], "standard"),
		maxInFlight: f.num(row.max_in_flight, `${location}.max_in_flight`, 256, 1, true),
	};
}

function connect(
	f: ConfigFields,
	value: unknown,
	location: string,
	providerIds: ReadonlySet<string>,
	virtualIds: ReadonlySet<string>,
): EndpointConfig["connect"][number] {
	if (typeof value !== "string") {
		f.issue(location, "Expected a connect entry string");
		return { kind: "virtual", id: "" };
	}
	if (value === "*") return { kind: "all" };
	if (value === "mixture/*") return { kind: "mixture", name: "*" };
	if (value.startsWith("mixture/")) return { kind: "mixture", name: value.slice(8) };
	if (virtualIds.has(value)) return { kind: "virtual", id: value };
	if (providerIds.has(value)) return { kind: "provider", provider: value };
	const slash = value.indexOf("/");
	if (slash >= 0 && providerIds.has(value.slice(0, slash)))
		return { kind: "provider-glob", provider: value.slice(0, slash), glob: value.slice(slash + 1) };
	return { kind: "virtual", id: value };
}

function virtualModel(context: DecodeContext, value: unknown, location: string): VirtualModelConfig {
	const f = context.fields;
	const row = f.object(value, location, ["id", "name", "kind", "strategy", "sticky", "failover", "targets", "dials"]);
	const targets = f.array(row.targets, `${location}.targets`).map((item, index) => {
		const target = f.object(item, `${location}.targets[${index}]`, ["to", "weight", "when"]);
		const when =
			target.when === undefined ? undefined : f.stringTable(target.when, `${location}.targets[${index}].when`);
		return {
			to: f.text(target.to, `${location}.targets[${index}].to`),
			weight: f.num(target.weight, `${location}.targets[${index}].weight`, 1, 0),
			...(when ? { when } : {}),
		};
	});
	return {
		id: f.id(row.id, `${location}.id`, VIRTUAL_ID),
		name: f.text(row.name, `${location}.name`, f.text(row.id, `${location}.id`)),
		kind: f.choice(row.kind, `${location}.kind`, MODEL_KINDS, "chat"),
		strategy: f.choice(
			row.strategy,
			`${location}.strategy`,
			["ordered", "round-robin", "least-used", "weighted", "sticky", "classify"],
			"ordered",
		),
		sticky: f.choice(row.sticky, `${location}.sticky`, ["conversation", "none"], "conversation"),
		failover: f.array(row.failover, `${location}.failover`, true).length
			? (f
					.strings(row.failover, `${location}.failover`)
					.filter(
						cause => f.choice(cause, `${location}.failover`, FAILOVER, "429") === cause,
					) as VirtualModelConfig["failover"])
			: ["429", "5xx", "connect", "timeout", "reauth", "model-missing"],
		targets,
		dials: decodeDials(f, row.dials ?? {}, `${location}.dials`, "snake"),
	};
}

export function decodePlan(context: DecodeContext, value: unknown, location: string): PlanConfig {
	const f = context.fields;
	const row = f.object(value, location, [
		"id",
		"provider",
		"account",
		"name",
		"meters",
		"attribution",
		"size",
		"share_capacity",
		"overcommit",
		"meter_grace_s",
		"stale_max_s",
		"stale_burn_floor",
		"warn_at",
	]);
	const account =
		row.account === undefined
			? undefined
			: f.object(row.account, `${location}.account`, ["email", "account_id", "project_id", "org_id"]);
	if (account && !["email", "account_id", "project_id", "org_id"].some(field => account[field] !== undefined))
		f.issue(`${location}.account`, "An account selector needs at least one identity field", "E-PLAN-PROVIDER");
	const sizeRaw =
		row.size === undefined
			? undefined
			: f.object(row.size, `${location}.size`, Object.keys((row.size as Record<string, unknown>) ?? {}));
	const size: PlanConfig["size"] = {};
	for (const [meter, configured] of Object.entries(sizeRaw ?? {})) {
		const amount = f.object(configured, `${location}.size.${meter}`, ["usd", "tokens", "requests"]);
		const selected = ["usd", "tokens", "requests"].filter(unit => amount[unit] !== undefined);
		if (selected.length !== 1)
			f.issue(`${location}.size.${meter}`, "Declared capacity requires exactly one unit", "E-PLAN-SIZE");
		const unit = selected[0] ?? "requests";
		f.number(amount[unit], `${location}.size.${meter}.${unit}`, {
			min: 0,
			exclusiveMin: true,
			integer: unit !== "usd",
		});
		size[meter] = { [unit]: amount[unit] } as NonNullable<PlanConfig["size"]>[string];
	}
	const capacityRaw =
		row.share_capacity === undefined
			? undefined
			: f.object(
					row.share_capacity,
					`${location}.share_capacity`,
					Object.keys((row.share_capacity as Record<string, unknown>) ?? {}),
				);
	const shareCapacity: Record<string, number> = {};
	for (const [meter, amount] of Object.entries(capacityRaw ?? {}))
		shareCapacity[meter] = f.num(amount, `${location}.share_capacity.${meter}`, 0, 1, true);
	return {
		id: f.id(row.id, `${location}.id`),
		provider: f.text(row.provider, `${location}.provider`),
		...(account
			? {
					account: {
						...(typeof account.email === "string" ? { email: account.email } : {}),
						...(typeof account.account_id === "string" ? { accountId: account.account_id } : {}),
						...(typeof account.project_id === "string" ? { projectId: account.project_id } : {}),
						...(typeof account.org_id === "string" ? { orgId: account.org_id } : {}),
					},
				}
			: {}),
		name: f.text(row.name, `${location}.name`, f.text(row.id, `${location}.id`)),
		...(row.meters !== undefined ? { meters: f.strings(row.meters, `${location}.meters`) } : {}),
		attribution: f.choice(
			row.attribution,
			`${location}.attribution`,
			["proportional", "declared", "tokens"],
			"proportional",
		),
		...(sizeRaw ? { size } : {}),
		...(capacityRaw ? { shareCapacity } : {}),
		overcommit: f.choice(row.overcommit, `${location}.overcommit`, ["allow", "normalize", "deny"], "allow"),
		meterGraceS: f.num(row.meter_grace_s, `${location}.meter_grace_s`, 600, 0, true),
		staleMaxS: f.num(row.stale_max_s, `${location}.stale_max_s`, 3600, 0, true),
		staleBurnFloor: f.num(row.stale_burn_floor, `${location}.stale_burn_floor`, 4, 0),
		warnAt:
			row.warn_at === undefined
				? []
				: f
						.array(row.warn_at, `${location}.warn_at`)
						.map((item, index) => f.num(item, `${location}.warn_at[${index}]`, 0, 0)),
	};
}

export function decodeSwitchDocument(context: DecodeContext, value: unknown): Omit<SwitchConfig, "sources" | "digest"> {
	const f = context.fields;
	const row = f.object(value, "switch.toml", ["switch", "admin", "notify", "provider", "plan", "endpoint", "model"]);
	const settings = f.object(row.switch ?? {}, "switch", [
		"name",
		"state_dir",
		"drain_ms",
		"meters_ttl_s",
		"meters_min_s",
		"repairs",
		"timezone",
		"max_attempts",
		"warn_at",
		"decision_days",
	]);
	const timezone = f.text(settings.timezone, "switch.timezone", "UTC");
	try {
		Intl.DateTimeFormat(undefined, { timeZone: timezone });
	} catch {
		f.issue("switch.timezone", "Expected an IANA timezone");
	}
	const adminRaw =
		row.admin === undefined
			? undefined
			: f.object(row.admin, "admin", ["bind", "socket", "cors_origins", "allow_remote", "backup_dir", "token"]);
	const tokens = adminRaw
		? f.array(adminRaw.token, "admin.token", true).map((item, index) => {
				const token = f.object(item, `admin.token[${index}]`, ["name", "secret", "role"]);
				return {
					name: f.id(token.name, `admin.token[${index}].name`),
					secret: secretReference(context, token.secret, `admin.token[${index}].secret`, true),
					role: f.choice(token.role, `admin.token[${index}].role`, ["read", "write"], "read"),
				};
			})
		: [];
	if (adminRaw && !tokens.length)
		f.issue("admin.token", "Admin access requires at least one token", "E-SECRET-MISSING");
	const notify = f.array(row.notify, "notify", true).map((item, index) => {
		const sink = f.object(item, `notify[${index}]`, ["kind", "path", "url", "events", "min_interval_s"]);
		const kind = f.choice(sink.kind, `notify[${index}].kind`, ["exec", "webhook"], "exec");
		if (kind === "exec") f.string(sink.path, `notify[${index}].path`);
		else f.string(sink.url, `notify[${index}].url`);
		return {
			kind,
			...(sink.path !== undefined ? { path: f.text(sink.path, `notify[${index}].path`) } : {}),
			...(sink.url !== undefined ? { url: f.text(sink.url, `notify[${index}].url`) } : {}),
			events: f.strings(sink.events, `notify[${index}].events`, true) as SwitchConfig["notify"][number]["events"],
			minIntervalS: f.num(sink.min_interval_s, `notify[${index}].min_interval_s`, 60, 0, true),
		};
	});
	const providers = f
		.array(row.provider, "provider")
		.map((item, index) => decodeProvider(context, item, `provider[${index}]`));
	const plans = f.array(row.plan, "plan", true).map((item, index) => decodePlan(context, item, `plan[${index}]`));
	const models = f
		.array(row.model, "model", true)
		.map((item, index) => virtualModel(context, item, `model[${index}]`));
	const providerIds = new Set(providers.map(provider => provider.id));
	const virtualIds = new Set(models.map(model => model.id));
	return {
		switch: {
			name: f.text(settings.name, "switch.name", "npi-switch"),
			stateDir: f.text(
				settings.state_dir,
				"switch.state_dir",
				process.env.STATE_DIRECTORY || `${context.configDir}/state`,
			),
			drainMs: f.num(settings.drain_ms, "switch.drain_ms", 20_000, 0, true),
			metersTtlS: f.num(settings.meters_ttl_s, "switch.meters_ttl_s", 60, 0, true),
			metersMinS: f.num(settings.meters_min_s, "switch.meters_min_s", 10, 0, true),
			repairs: f.choice(settings.repairs, "switch.repairs", ["on", "log-only", "off"], "on"),
			timezone,
			maxAttempts: f.num(settings.max_attempts, "switch.max_attempts", 4, 1, true),
			warnAt:
				settings.warn_at === undefined
					? [80, 95]
					: f
							.array(settings.warn_at, "switch.warn_at")
							.map((item, index) => f.num(item, `switch.warn_at[${index}]`, 0, 0)),
			decisionDays: f.num(settings.decision_days, "switch.decision_days", 30, 1, true),
		},
		...(adminRaw
			? {
					admin: {
						...(adminRaw.bind !== undefined ? { bind: f.bind(adminRaw.bind, "admin.bind") } : {}),
						socket: f.flag(adminRaw.socket, "admin.socket", true),
						corsOrigins: f.strings(adminRaw.cors_origins, "admin.cors_origins", true),
						allowRemote: f.flag(adminRaw.allow_remote, "admin.allow_remote", false),
						backupDir: f.text(adminRaw.backup_dir, "admin.backup_dir", "backups"),
						tokens,
					},
				}
			: {}),
		notify,
		providers,
		plans,
		models,
		endpoints: f
			.array(row.endpoint, "endpoint", true)
			.map((item, index) => endpoint(context, item, `endpoint[${index}]`, providerIds, virtualIds)),
	};
}

export function unique(fields: ConfigFields, values: readonly string[], location: string, code: string): void {
	if (new Set(values).size !== values.length) fields.issue(location, "Duplicate identifier", code);
	for (const value of values)
		if (value !== "*" && !KEY_NAME.test(value)) fields.issue(location, "Invalid identifier", "E-ID");
}
