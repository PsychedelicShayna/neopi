import { extractHttpStatusFromError } from "@oh-my-pi/pi-utils";
import type { AuthStorage } from "../auth-storage";
import { seedApiKeyResolver, type ApiKeyResolver, type ResolvedApiKey } from "../auth-retry";
import { fingerprintCredential } from "../auth/credential-binding";
import * as AIError from "../error";
import { isUsageLimitOutcome } from "../error/rate-limit";
import type { CredentialBinding } from "../auth/types";

/** The initial key and every in-transport refresh belong to one immutable stored row. */
export async function pinnedCredential(
	storage: AuthStorage,
	binding: CredentialBinding,
	modelId: string,
	sessionId: string,
	signal: AbortSignal,
): Promise<{ initial: string; resolver: ApiKeyResolver } | undefined> {
	const options = { expectedProvider: binding.provider, expectedFingerprint: binding.fingerprint, modelId, signal };
	const resolvePinned = async (
		attemptSignal: AbortSignal,
		forceRefresh = false,
	): Promise<ResolvedApiKey | undefined> => {
		const apiKey = await storage.keys.getPinned(binding.credentialId, sessionId, {
			...options,
			signal: attemptSignal,
			forceRefresh,
		});
		if (apiKey === undefined) return undefined;
		const row = storage.credentials.list(binding.provider).find(entry => entry.id === binding.credentialId);
		if (!row || fingerprintCredential(row, apiKey) !== binding.fingerprint) return undefined;
		return {
			apiKey,
			credentialId: binding.credentialId,
			...(row.credential.type === "api_key" && row.credential.tlsTrust !== undefined
				? { tlsTrust: row.credential.tlsTrust }
				: {}),
			...(row.credential.type === "api_key" && row.credential.requestOrigin !== undefined
				? { requestOrigin: row.credential.requestOrigin }
				: {}),
		};
	};
	const selected = await resolvePinned(signal);
	if (!selected) return undefined;
	const initial = selected.apiKey;
	const resolver: ApiKeyResolver = async ({ error, lastChance, signal: attemptSignal }) => {
		if (error === undefined) return selected;
		if (!lastChance) {
			return resolvePinned(attemptSignal ?? signal, true);
		}
		if (AIError.isUsageLimit(error) || isUsageLimitOutcome(extractHttpStatusFromError(error), String(error))) {
			await storage.limits.markReached(binding.provider, sessionId, {
				modelId,
				apiKey: initial,
				signal: attemptSignal ?? signal,
			});
		}
		return undefined;
	};
	return { initial, resolver: seedApiKeyResolver(selected, resolver) };
}
