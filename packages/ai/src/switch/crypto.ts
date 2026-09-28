import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { timingSafeEqual } from "../auth-gateway/http";
import { SwitchError } from "./error";

export function sha256(value: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function valueHash(value: unknown): string {
	return sha256(stableStringifyJson(value));
}

export function mintToken(): string {
	return `mrn_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
}

export function tokenDigest(token: string): string {
	return `sha256:${sha256(token)}`;
}

export function digestMatches(presented: string, expected: string): boolean {
	return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
}

export interface PreviewBasis {
	schema: 1;
	bootEpoch: string;
	actor: string;
	target: string;
	operationHash: string;
	keyRevs: Record<string, number>;
	generation: string;
	dependencies: Record<string, string | number>;
	effectHash: string;
	issuedAt: number;
	expiresAt: number;
}

export interface ImportBasis {
	schema: 1;
	bootEpoch: string;
	actor: string;
	generation: string;
	policyVersion: number;
	contentHash: string;
	mode: "merge" | "replace";
	effectHash: string;
	issuedAt: number;
	expiresAt: number;
}

/** Keys are derived once, while preview and job signatures use separate domains. */
export class SwitchSignatures {
	readonly #previewKey: Uint8Array;
	readonly #importKey: Uint8Array;
	readonly #jobKey: Uint8Array;

	constructor(rootKey: string) {
		const root = Buffer.from(rootKey, "hex");
		this.#previewKey = new Bun.CryptoHasher("sha256", root).update("switch-preview-v1").digest();
		this.#importKey = new Bun.CryptoHasher("sha256", root).update("switch-import-v1").digest();
		this.#jobKey = new Bun.CryptoHasher("sha256", root).update("switch-job-v1").digest();
	}

	#signature(payload: string, key: Uint8Array): string {
		return new Bun.CryptoHasher("sha256", key).update(payload).digest("base64url");
	}

	#encode(value: PreviewBasis | ImportBasis, key: Uint8Array): string {
		const payload = Buffer.from(stableStringifyJson(value)).toString("base64url");
		return `${payload}.${this.#signature(payload, key)}`;
	}

	#decode(token: string, key: Uint8Array): unknown {
		const parts = token.split(".");
		if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) throw new SwitchError(409, "stale_preview", "Preview signature is invalid");
		if (!digestMatches(this.#signature(parts[0], key), parts[1])) throw new SwitchError(409, "stale_preview", "Preview signature is invalid");
		try {
			return JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
		} catch {
			throw new SwitchError(409, "stale_preview", "Preview encoding is invalid");
		}
	}

	preview(value: PreviewBasis): string { return this.#encode(value, this.#previewKey); }
	readPreview(token: string): PreviewBasis { return this.#decode(token, this.#previewKey) as PreviewBasis; }
	import(value: ImportBasis): string { return this.#encode(value, this.#importKey); }
	readImport(token: string): ImportBasis { return this.#decode(token, this.#importKey) as ImportBasis; }

	job(id: string): string { return `${id}.${this.#signature(id, this.#jobKey)}`; }
	readJob(token: string): string {
		const parts = token.split(".");
		if (parts.length !== 2 || !/^[a-f0-9-]{36}$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]) || !digestMatches(this.#signature(parts[0], this.#jobKey), parts[1])) throw new SwitchError(400, "invalid_job", "Job id authentication failed");
		return parts[0];
	}
}
