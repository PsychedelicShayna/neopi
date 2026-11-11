import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { writeArtifact } from "../session/artifacts";

/** Entry-order boundaries, never timestamps or main-transcript messages. */
export interface ChroniclerBlindSpan {
	/** Last entry already present when blind was requested; null means before the first entry. */
	readonly startAfter: string | null;
	/** Last entry present at unblind, inclusive; null keeps the blind open across restarts. */
	readonly endAt: string | null;
}

export interface ChroniclerBlindMetadata {
	readonly version: 1;
	readonly spans: readonly ChroniclerBlindSpan[];
}

export const CHRONICLER_BLIND_FILENAME = "blind.json";

/** Permanent privacy-state damage, distinct from retryable filesystem IO. */
export class ChroniclerBlindMetadataError extends Error {}

export function hasOpenBlind(metadata: ChroniclerBlindMetadata): boolean {
	return metadata.spans.some(span => span.endAt === null);
}

/** Invalid or unreadable metadata throws: callers must stop capture, not ignore privacy state. */
export async function readChroniclerBlindMetadata(root: string): Promise<ChroniclerBlindMetadata> {
	let text: string;
	try {
		text = await Bun.file(path.join(root, CHRONICLER_BLIND_FILENAME)).text();
	} catch (error) {
		if (isEnoent(error)) return { version: 1, spans: [] };
		// Preserve errno and diagnostic text so ordinary store IO can recover.
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		// Do not include parse errors: they can quote private metadata contents.
		throw new ChroniclerBlindMetadataError("Invalid Chronicler blind metadata; capture is blocked");
	}
	if (
		typeof value !== "object" ||
		value === null ||
		!("version" in value) ||
		value.version !== 1 ||
		!("spans" in value) ||
		!Array.isArray(value.spans)
	) {
		throw new ChroniclerBlindMetadataError("Invalid Chronicler blind metadata; capture is blocked");
	}
	const spans: ChroniclerBlindSpan[] = [];
	for (const span of value.spans) {
		if (
			typeof span !== "object" ||
			span === null ||
			!("startAfter" in span) ||
			!("endAt" in span) ||
			!(span.startAfter === null || (typeof span.startAfter === "string" && span.startAfter.length > 0)) ||
			!(span.endAt === null || (typeof span.endAt === "string" && span.endAt.length > 0)) ||
			spans.some(previous => previous.endAt === null)
		) {
			throw new ChroniclerBlindMetadataError("Invalid Chronicler blind metadata; capture is blocked");
		}
		spans.push({ startAfter: span.startAfter, endAt: span.endAt });
	}
	return { version: 1, spans };
}

/** Uses the existing verified temp-write/atomic-rename artifact primitive. */
export async function writeChroniclerBlindMetadata(root: string, metadata: ChroniclerBlindMetadata): Promise<void> {
	await writeArtifact(path.join(root, CHRONICLER_BLIND_FILENAME), `${JSON.stringify(metadata, null, "\t")}\n`);
}

/**
 * Filter against the complete persisted entry order, including non-message markers.
 * Forks can omit either boundary. Missing starts withhold everything; missing ends
 * keep the remaining tail blinded. Neither case silently lifts an inherited span.
 */
export function chroniclerVisibleEntryIds(
	entries: readonly { readonly id: string }[],
	metadata: ChroniclerBlindMetadata,
): ReadonlySet<string> {
	const positions = new Map<string, number>();
	for (let index = 0; index < entries.length; index++) {
		const id = entries[index]!.id;
		if (positions.has(id))
			throw new ChroniclerBlindMetadataError("Duplicate session entry IDs; Chronicler capture is blocked");
		positions.set(id, index);
	}
	const hidden = new Set<string>();
	for (const span of metadata.spans) {
		const start = span.startAfter === null ? -1 : positions.get(span.startAfter);
		const end = span.endAt === null ? entries.length - 1 : positions.get(span.endAt);
		if (start === undefined || (end !== undefined && end < start)) return new Set();
		for (let index = start + 1; index <= (end ?? entries.length - 1); index++) hidden.add(entries[index]!.id);
	}
	return new Set(entries.filter(entry => !hidden.has(entry.id)).map(entry => entry.id));
}
