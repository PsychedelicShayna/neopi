import * as fs from "node:fs";
import type { IrcLogEntry } from "@oh-my-pi/pi-tui/tools/irc";
import { isEnoent, logger, parseJsonlLenient } from "@oh-my-pi/pi-utils";
import { writeFileAtomicallySync } from "../utils/atomic-file";
import { ensureIrcOperatorStateDirectory } from "./operator-storage";

interface JournalRow {
	readonly order: number;
	readonly entry: IrcLogEntry;
}

function isJournalRow(data: unknown): data is JournalRow {
	if (data === null || typeof data !== "object") return false;
	const row = data as Partial<JournalRow>;
	if (typeof row.order !== "number" || !Number.isSafeInteger(row.order) || row.order < 0) return false;
	const entry = row.entry;
	if (!entry || typeof entry !== "object" || typeof entry.broadcast !== "boolean") return false;
	if (entry.error !== undefined && typeof entry.error !== "string") return false;
	switch (entry.outcome) {
		case "injected":
		case "woken":
		case "revived":
		case "queued":
		case "failed":
			break;
		default:
			return false;
	}
	const message = entry.message;
	return (
		!!message &&
		typeof message === "object" &&
		typeof message.id === "string" &&
		typeof message.from === "string" &&
		typeof message.to === "string" &&
		typeof message.body === "string" &&
		Number.isFinite(message.ts) &&
		(message.replyTo === undefined || typeof message.replyTo === "string") &&
		(message.group === undefined || typeof message.group === "string") &&
		(message.groupText === undefined || typeof message.groupText === "string") &&
		(message.fanoutId === undefined || typeof message.fanoutId === "string") &&
		(message.sharedGroups === undefined ||
			(Array.isArray(message.sharedGroups) && message.sharedGroups.every(group => typeof group === "string")))
	);
}

/** Operator-only delivery attempts, in send-start order rather than completion/append order. */
export class IrcHistoryJournal {
	readonly #rows: JournalRow[] = [];
	#nextOrder = 0;
	#directoryReady = false;
	#storedRows = 0;

	constructor(
		readonly sessionId: string,
		readonly filePath: string | undefined,
		cap: number,
	) {
		if (!filePath) return;
		try {
			const contents = fs.readFileSync(filePath, "utf8");
			const rows = parseJsonlLenient<unknown>(contents);
			this.#storedRows = rows.length;
			for (const row of rows) {
				if (!isJournalRow(row)) continue;
				this.#rows.push(row);
				this.#nextOrder = Math.max(this.#nextOrder, row.order + 1);
			}
			this.#rows.sort((a, b) => a.order - b.order);
			this.#trim(cap);
		} catch (error) {
			if (!isEnoent(error)) logger.warn("Could not load operator IRC history", { sessionId, error: String(error) });
		}
	}

	reserveOrder(): number {
		return this.#nextOrder++;
	}

	record(order: number, entry: IrcLogEntry, cap: number): void {
		const row: JournalRow = { order, entry };
		let index = this.#rows.length;
		while (index > 0 && this.#rows[index - 1]!.order > order) index--;
		this.#rows.splice(index, 0, row);
		this.#trim(cap);
		if (!this.filePath) return;
		try {
			if (!this.#directoryReady) {
				ensureIrcOperatorStateDirectory(this.filePath);
				this.#directoryReady = true;
			}
			// Bound retained bodies without rewriting the whole recent history on each send.
			// Between compactions the file holds at most cap + min(cap, 128) delivery rows.
			if (this.#storedRows >= cap + Math.min(cap, 128)) {
				const compacted = this.#rows.map(kept => `${JSON.stringify(kept)}\n`).join("");
				writeFileAtomicallySync(this.filePath, compacted);
				this.#storedRows = this.#rows.length;
				return;
			}
			if ((this.#rows[0]?.order ?? Infinity) > order) return;
			// The leading separator prevents an interrupted append from consuming the next complete row.
			fs.appendFileSync(this.filePath, `\n${JSON.stringify(row)}\n`, { mode: 0o600 });
			this.#storedRows++;
		} catch (error) {
			this.#directoryReady = false;
			logger.warn("Could not save operator IRC history", { sessionId: this.sessionId, error: String(error) });
		}
	}

	entries(): IrcLogEntry[] {
		return this.#rows.map(row => row.entry);
	}

	#trim(cap: number): void {
		const excess = this.#rows.length - cap;
		if (excess > 0) this.#rows.splice(0, excess);
	}
}
