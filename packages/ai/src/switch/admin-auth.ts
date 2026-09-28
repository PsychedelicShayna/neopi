import { digestMatches, tokenDigest } from "./crypto";
import { SwitchError } from "./error";
import type { AdminConfig, SecretRef } from "./config/types";
import type { AdminRole } from "./wire";

export interface AdminActor { name: string; role: AdminRole }

/** A Generation owns these digests; no configured plaintext is retained here. */
export class AdminAuthentication {
	readonly #tokens: readonly { name: string; role: AdminRole; digest: string }[];

	constructor(config: AdminConfig, secrets: ReadonlyMap<SecretRef, string>) {
		const rows = config.tokens.map(token => {
			const digest = token.secret.kind === "sealed" ? `sha256:${token.secret.sha256}` : (() => {
				const secret = secrets.get(token.secret);
				if (!secret) throw new SwitchError(422, "validation", `Admin token ${token.name} has no configured secret`);
				return tokenDigest(secret);
			})();
			return { name: token.name, role: token.role, digest };
		});
		if (new Set(rows.map(row => row.digest)).size !== rows.length) throw new SwitchError(422, "validation", "Two admin actors share a bearer token");
		this.#tokens = rows;
	}

	authenticate(header: string | null): AdminActor {
		if (!header || !/^Bearer\s+\S+$/i.test(header)) throw new SwitchError(401, "authentication_error", "An operator bearer token is required");
		const presented = tokenDigest(header.replace(/^Bearer\s+/i, ""));
		let actor: AdminActor | undefined;
		// Walk all configured digests, even after a match; derive actor only from the selected row.
		for (const row of this.#tokens) if (digestMatches(presented, row.digest)) actor = { name: row.name, role: row.role };
		if (!actor) throw new SwitchError(401, "authentication_error", "Operator bearer token is invalid");
		return actor;
	}

	authorize(header: string | null, role: AdminRole): AdminActor {
		const actor = this.authenticate(header);
		if (role === "write" && actor.role !== "write") throw new SwitchError(403, "permission_error", "Operator write authority is required");
		return actor;
	}
}
