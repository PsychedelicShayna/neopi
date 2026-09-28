import type { AuthStorage } from "../auth-storage";
import { matchesAuthAccountSelector } from "../auth/policy";
import type { StoredAuthCredential } from "../auth/types";
import type { SwitchConfig } from "./config/types";
import { SwitchError } from "./error";
import type { ResolvedPlan } from "./internal";
import type { Issue } from "./wire";

function redact(row: StoredAuthCredential): string {
	if (row.credential.type === "oauth") {
		const email = row.credential.email;
		if (email?.includes("@")) return `…@${email.split("@").at(-1)}`;
		const identity = row.credential.accountId ?? row.credential.projectId ?? row.credential.orgId;
		if (identity) return `…${identity.slice(-4)}`;
	}
	return `Stored credential #${row.id}`;
}

/** The returned Plan carries one durable row, never a preference over the account pool. */
export async function resolvePlans(config: SwitchConfig, storage: AuthStorage): Promise<{ plans: ResolvedPlan[]; issues: Issue[] }> {
	await storage.credentials.revalidate();
	const issues: Issue[] = [];
	const plans: ResolvedPlan[] = [];
	for (const [index, candidate] of config.plans.entries()) {
		const provider = config.providers.find(row => row.id === candidate.provider);
		if (!provider) throw new SwitchError(422, "validation", "Plan provider is not configured", { issues: [{ code: "E-PLAN-PROVIDER", path: `plan[${index}].provider`, message: "Provider is not configured" }] });
		if (provider.kind === "http") {
			if (candidate.meters?.length || candidate.attribution !== "proportional") throw new SwitchError(422, "validation", "HTTP Plan Meter descriptors require milestone M10", { issues: [{ code: "E-UNSUPPORTED", path: `plan[${index}].meters`, message: "HTTP usage descriptors and percentage attribution require milestone M10" }] });
			plans.push({ config: candidate, resolution: "resolved", accountLabel: provider.name });
			continue;
		}
		const canonicalProvider = provider.catalog ?? provider.id;
		const rows = storage.credentials.list(canonicalProvider).filter(row => row.disabledCause === null);
		const matches = candidate.account === undefined ? rows : rows.filter(row => row.credential.type === "oauth" && matchesAuthAccountSelector(candidate.account!, row.credential));
		if (matches.length !== 1) {
			const reason = matches.length === 0 ? "No visible stored credential matches this Plan" : "More than one stored credential matches this Plan";
			issues.push({ code: "W-PLAN-UNRESOLVED", path: `plan[${index}]`, message: reason });
			plans.push({ config: candidate, resolution: "unresolved", accountLabel: "Account unavailable", reason });
			continue;
		}
		const row = matches[0];
		const fingerprint = await storage.keys.fingerprintPinned(row.id, canonicalProvider);
		if (!fingerprint) {
			const reason = "The selected stored credential is unavailable";
			issues.push({ code: "W-PLAN-UNRESOLVED", path: `plan[${index}]`, message: reason });
			plans.push({ config: candidate, resolution: "unresolved", accountLabel: redact(row), reason });
			continue;
		}
		plans.push({
			config: candidate, binding: { provider: canonicalProvider, credentialId: row.id, fingerprint }, resolution: "resolved", accountLabel: redact(row),
			...(row.credential.type === "oauth" ? { identity: { ...(row.credential.email ? { email: row.credential.email } : {}), ...(row.credential.accountId ? { account_id: row.credential.accountId } : {}), ...(row.credential.projectId ? { project_id: row.credential.projectId } : {}), ...(row.credential.orgId ? { org_id: row.credential.orgId } : {}) } } : {}),
		});
	}
	for (let i = 0; i < plans.length; i++) for (let j = i + 1; j < plans.length; j++) {
		const left = plans[i], right = plans[j];
		if (!left.binding || !right.binding || left.binding.provider !== right.binding.provider || left.binding.credentialId !== right.binding.credentialId) continue;
		const leftMeters = left.config.meters, rightMeters = right.config.meters;
		if (!leftMeters || !rightMeters || leftMeters.some(meter => rightMeters.includes(meter))) throw new SwitchError(422, "validation", "Two Plans overlap the same stored account and Meter", { issues: [{ code: "E-PLAN-ACCOUNT-DUP", path: `plan[${i}],plan[${j}]`, message: "Distinct Plans cannot account the same credential and Meter twice" }] });
	}
	return { plans, issues };
}
