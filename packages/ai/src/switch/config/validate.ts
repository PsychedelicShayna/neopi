import * as fs from "node:fs";
import * as path from "node:path";
import type { KeyRecord } from "../internal";
import { isLoopbackHost, isExactOrigin } from "../network";
import { parseSlug } from "../slug";
import type { Issue } from "../wire";
import type { ConfigFields } from "./fields";
import type { EndpointConfig, PlanConfig, SecretRef, SwitchConfig } from "./types";

export interface ValidationContext {
	configDir: string;
	credentialCount(provider: string): number;
	keys?: ReadonlyMap<string, KeyRecord>;
}

function issue(fields: ConfigFields, code: string, location: string, message: string): void {
	fields.issue(location, message, code);
}
function executable(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
function secretExists(context: ValidationContext, reference: SecretRef): boolean {
	if (reference.kind === "file") return fs.existsSync(reference.path);
	if (reference.kind === "env") return Object.hasOwn(process.env, reference.name);
	return true;
}

function references(endpoint: EndpointConfig, provider: string): boolean {
	return endpoint.connect.some(
		entry =>
			entry.kind === "all" ||
			(entry.kind === "provider" && entry.provider === provider) ||
			(entry.kind === "provider-glob" && entry.provider === provider),
	);
}

function targetProvider(target: string, virtualIds: ReadonlySet<string>): string | undefined {
	const parsed = parseSlug(target, virtualIds);
	return parsed.provider;
}

export function validateSwitchConfig(
	config: SwitchConfig,
	fields: ConfigFields,
	warnings: Issue[],
	context: ValidationContext,
): void {
	for (const [index, provider] of config.providers.entries()) {
		if (provider.glue) {
			if (!executable(provider.glue))
				issue(fields, "E-GLUE", `provider[${index}].glue`, "Glue executable is missing or not executable");
			if (!provider.glue.startsWith(`${context.configDir}${path.sep}`))
				warnings.push({
					code: "W-UNWATCHED",
					path: `provider[${index}].glue`,
					message: "An executable outside the Config Dir is reread only on the next reload",
				});
		}
		for (const reference of provider.auth?.key ? [provider.auth.key] : (provider.keys ?? []))
			if (reference.kind === "file" && !reference.path.startsWith(`${context.configDir}${path.sep}`))
				warnings.push({
					code: "W-UNWATCHED",
					path: `provider[${index}]`,
					message: "A secret file outside the Config Dir is reread only on the next reload",
				});
		if (provider.kind === "http" && !provider.models.length && provider.discovery === "static")
			issue(
				fields,
				"E-MODEL-INCOMPLETE",
				`provider[${index}].model`,
				"Static discovery requires at least one model declaration",
			);
	}
	for (const [index, endpoint] of config.endpoints.entries()) {
		const virtualIds = new Set(config.models.map(model => model.id));
		for (const [position, entry] of endpoint.connect.entries()) {
			const mixture = entry.kind === "mixture";
			const known =
				entry.kind === "all" ||
				(entry.kind === "provider" && config.providers.some(provider => provider.id === entry.provider)) ||
				(entry.kind === "provider-glob" && config.providers.some(provider => provider.id === entry.provider)) ||
				(entry.kind === "virtual" && virtualIds.has(entry.id));
			if (!known || mixture)
				issue(
					fields,
					"E-CONNECT-REF",
					`endpoint[${index}].connect[${position}]`,
					"Connect names an unknown provider/model, or a mixture whose milestone is not built",
				);
		}
		for (const [position, entry] of endpoint.anonymousPlans.entries()) {
			const plan = config.plans.find(candidate => candidate.id === entry.plan);
			if (!plan || !references(endpoint, plan.provider))
				issue(
					fields,
					"E-ANON-PLANS",
					`endpoint[${index}].anonymous_plans[${position}]`,
					"Anonymous Plan is unknown or its provider is not connected",
				);
			for (const gate of entry.gates)
				if (
					(gate.ceiling !== undefined && (gate.ceiling <= 0 || gate.ceiling > 100)) ||
					(gate.reserve !== undefined && (gate.reserve < 0 || gate.reserve >= 100))
				)
					issue(
						fields,
						"E-ANON-PLANS",
						`endpoint[${index}].anonymous_plans[${position}]`,
						"Anonymous Gates must stay within (0, 100]",
					);
			if (plan?.meters?.some(meter => !entry.gates.some(gate => gate.meter === meter || gate.meter === "*")))
				warnings.push({
					code: "W-ANON-UNGATED",
					path: `endpoint[${index}].anonymous_plans[${position}]`,
					message: "An enabled Meter has no exact or wildcard Gate",
				});
		}
		if (
			endpoint.auth === "key" &&
			context.keys &&
			![...context.keys.values()].some(
				key =>
					key.enabled &&
					!key.revoked &&
					(endpoint.keys.includes("*") || endpoint.keys.includes(key.name)) &&
					(key.scope.endpoints.includes("*") || key.scope.endpoints.includes(endpoint.id)),
			)
		)
			warnings.push({
				code: "W-NO-KEYS",
				path: `endpoint[${index}]`,
				message: "No enabled Key is admitted by this endpoint",
			});
	}
	for (const [index, plan] of config.plans.entries()) {
		const provider = config.providers.find(candidate => candidate.id === plan.provider);
		if (!provider) issue(fields, "E-PLAN-PROVIDER", `plan[${index}].provider`, "Plan names an unknown provider");
		else if (provider.kind === "http" && plan.account)
			issue(
				fields,
				"E-PLAN-PROVIDER",
				`plan[${index}].account`,
				"HTTP Plans cover the provider's configured key pool and cannot select an account",
			);
		else if (provider.kind === "catalog" && !plan.account && context.credentialCount(provider.id) >= 2)
			issue(
				fields,
				"E-PLAN-PROVIDER",
				`plan[${index}].account`,
				"A catalog Plan must name its account when the provider has multiple credentials",
			);
		const meters = plan.meters ?? [];
		if (plan.attribution === "declared" && (!plan.size || meters.some(meter => !plan.size?.[meter])))
			issue(
				fields,
				"E-PLAN-SIZE",
				`plan[${index}].size`,
				"Declared attribution requires a positive size for every enabled Meter",
			);
		if (plan.attribution !== "declared" && plan.size)
			issue(fields, "E-PLAN-SIZE", `plan[${index}].size`, "Only declared attribution accepts size");
		if (
			plan.attribution === "tokens" &&
			(plan.overcommit === "normalize" || plan.overcommit === "deny") &&
			meters.some(meter => !plan.shareCapacity?.[meter])
		)
			issue(
				fields,
				"E-PLAN-OVERCOMMIT",
				`plan[${index}].share_capacity`,
				"Token normalization or denial requires positive sharing capacity for every enabled Meter",
			);
		if (plan.attribution !== "tokens" && plan.shareCapacity)
			issue(
				fields,
				"E-PLAN-OVERCOMMIT",
				`plan[${index}].share_capacity`,
				"Only token attribution accepts sharing capacity",
			);
		if (plan.meterGraceS <= 375)
			issue(
				fields,
				"E-PLAN-PROVIDER",
				`plan[${index}].meter_grace_s`,
				"Meter grace must exceed the credential report cache lifetime",
			);
	}
	for (const [index, model] of config.models.entries()) {
		const virtualIds = new Set(config.models.map(candidate => candidate.id));
		if (
			config.providers.some(
				provider =>
					provider.id === model.id.split("/")[0] ||
					provider.models.some(row => row.id === model.id || row.aliases.includes(model.id)),
			)
		)
			issue(
				fields,
				"E-VIRTUAL-SHADOW",
				`model[${index}].id`,
				"A virtual id must not shadow a provider or physical model id",
			);
		const active = new Set<string>();
		const completed = new Set<string>();
		const visit = (id: string): boolean => {
			if (active.has(id)) return true;
			if (completed.has(id)) return false;
			active.add(id);
			const current = config.models.find(candidate => candidate.id === id);
			const cycle =
				current?.targets.some(target => {
					const parsed = parseSlug(target.to, virtualIds);
					return parsed.virtual !== undefined && visit(parsed.virtual);
				}) ?? false;
			active.delete(id);
			completed.add(id);
			return cycle;
		};
		if (visit(model.id))
			issue(fields, "E-TARGET-CYCLE", `model[${index}]`, "Virtual models must not reference one another cyclically");
		if (model.strategy === "classify")
			issue(
				fields,
				"E-UNSUPPORTED",
				`model[${index}].strategy`,
				"Classifier routing is deferred until milestone M10",
			);
		for (const [position, target] of model.targets.entries()) {
			const parsed = parseSlug(target.to, virtualIds);
			if (target.when)
				issue(
					fields,
					"E-UNSUPPORTED",
					`model[${index}].targets[${position}].when`,
					"Conditional routing is deferred until milestone M10",
				);
			if (target.to.startsWith("mixture/"))
				issue(
					fields,
					"E-UNSUPPORTED",
					`model[${index}].targets[${position}].to`,
					"MoA member dispatch requires the M6 prerequisite",
				);
			const targetModel = parsed.virtual
				? config.models.find(candidate => candidate.id === parsed.virtual)
				: undefined;
			if (targetModel && targetModel.kind !== model.kind)
				issue(
					fields,
					"E-TARGET-KIND",
					`model[${index}].targets[${position}]`,
					"Every virtual target must have the virtual model's kind",
				);
			if (
				!parsed.virtual &&
				(!targetProvider(target.to, virtualIds) ||
					!config.providers.some(provider => provider.id === parsed.provider))
			)
				issue(
					fields,
					"E-CONNECT-REF",
					`model[${index}].targets[${position}]`,
					"Target does not name a configured provider or virtual model",
				);
		}
		if (
			!config.endpoints.some(endpoint =>
				endpoint.connect.some(entry => entry.kind === "all" || (entry.kind === "virtual" && entry.id === model.id)),
			)
		)
			warnings.push({
				code: "W-UNUSED",
				path: `model[${index}]`,
				message: "No endpoint connects this virtual model",
			});
	}
	if (config.admin?.bind && !isLoopbackHost(config.admin.bind.hostname) && !config.admin.allowRemote)
		issue(fields, "E-ADMIN-REMOTE", "admin.bind", "A non-loopback admin bind requires allow_remote");
	if (config.admin?.bind && !isLoopbackHost(config.admin.bind.hostname))
		warnings.push({ code: "W-ADMIN-REMOTE", path: "admin.bind", message: "The admin API is reachable off-host" });
	for (const origin of config.admin?.corsOrigins ?? [])
		if (!isExactOrigin(origin)) issue(fields, "E-ORIGINS", "admin.cors_origins", "Expected an exact admin origin");
	for (const [index, sink] of config.notify.entries()) {
		if (sink.kind === "exec" && sink.path && !executable(path.resolve(context.configDir, sink.path)))
			issue(fields, "E-NOTIFY", `notify[${index}].path`, "Notify executable is missing or not executable");
		if (sink.kind === "webhook" && sink.url) {
			try {
				const url = new URL(sink.url);
				if (!(url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname))))
					throw new Error();
			} catch {
				issue(fields, "E-NOTIFY", `notify[${index}].url`, "Webhook URLs must be HTTPS or loopback HTTP");
			}
		}
	}
	const removedPlans = context.keys
		? [
				...new Set(
					[...context.keys.values()].flatMap(key => [
						...key.plans.map(entry => entry.plan),
						...key.budgets.flatMap(budget => (budget.scope.plan ? [budget.scope.plan] : [])),
					]),
				),
			].filter(id => !config.plans.some(plan => plan.id === id))
		: [];
	for (const id of removedPlans) {
		const names = [...context.keys!.values()]
			.filter(
				key => key.plans.some(entry => entry.plan === id) || key.budgets.some(budget => budget.scope.plan === id),
			)
			.map(key => key.name);
		issue(
			fields,
			"E-PLAN-IN-USE",
			`plan:${id}`,
			`Plan remains referenced by ${names.join(", ")}; run npi switch allot ${names[0]} plan remove first`,
		);
	}
	if (!config.admin) warnings.push({ code: "W-ADMIN-OFF", path: "admin", message: "The admin API is disabled" });
	if (!process.env.INVOCATION_ID)
		warnings.push({ code: "W-UNSUPERVISED", path: "switch", message: "The process is not running under systemd" });
	fields.finish();
}

export function secretReadable(reference: SecretRef): boolean {
	if (reference.kind !== "file") return secretExists({ configDir: "", credentialCount: () => 0 }, reference);
	try {
		return (fs.statSync(reference.path).mode & 0o077) === 0;
	} catch {
		return false;
	}
}
