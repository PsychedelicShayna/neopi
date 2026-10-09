import { createHash } from "node:crypto";
import { resolveCredentialIdentityKey } from "./sqlite-credential-store";
import type { StoredAuthCredential } from "./types";

/** Stable across OAuth access/refresh rotation; static API-key replacement needs a new Generation. */
export function fingerprintCredential(row: StoredAuthCredential, resolvedApiKey?: string): string | undefined {
	const { credential } = row;
	if (row.disabledCause !== null) return undefined;
	if (credential.type === "api_key" && resolvedApiKey === undefined) return undefined;
	const identity =
		credential.type === "oauth"
			? [
					resolveCredentialIdentityKey(row.provider, credential),
					credential.email ?? null,
					credential.accountId ?? null,
					credential.projectId ?? null,
					credential.orgId ?? null,
					credential.enterpriseUrl ?? null,
					credential.apiEndpoint ?? null,
				]
			: [createHash("sha256").update(resolvedApiKey!).digest("hex")];
	return createHash("sha256")
		.update(JSON.stringify([row.provider, row.id, credential.type, identity]))
		.digest("hex");
}
