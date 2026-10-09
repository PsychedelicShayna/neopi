import { extractHttpStatusFromError } from "@oh-my-pi/pi-utils";
import type { AuthStorage } from "../auth-storage";
import { seedApiKeyResolver, type ApiKeyResolver } from "../auth-retry";
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
	const initial = await storage.keys.getPinned(binding.credentialId, sessionId, options);
	if (!initial) return undefined;
	const resolver: ApiKeyResolver = async ({ error, lastChance, signal: attemptSignal }) => {
		if (error === undefined) return { apiKey: initial, credentialId: binding.credentialId };
		if (!lastChance) {
			const refreshed = await storage.keys.getPinned(binding.credentialId, sessionId, {
				...options,
				signal: attemptSignal ?? signal,
				forceRefresh: true,
			});
			return refreshed === undefined ? undefined : { apiKey: refreshed, credentialId: binding.credentialId };
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
	return { initial, resolver: seedApiKeyResolver({ apiKey: initial, credentialId: binding.credentialId }, resolver) };
}
