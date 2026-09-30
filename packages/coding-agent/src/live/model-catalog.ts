import { stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { logger } from "@oh-my-pi/pi-utils";

export const LIVE_INGEST_CATALOG_STAT_MS = 5_000;

export type CatalogRecommendation = null | "recommended" | "ok" | "avoid" | "never";
export type CatalogLookup =
	| { status: "unavailable" | "missing" }
	| { status: "present"; recommendation: CatalogRecommendation };

export interface CatalogIo {
	stat(path: string): Promise<{ mtimeMs: number; size: number }>;
	readFile(path: string, encoding: "utf8"): Promise<string>;
}

interface CatalogSlot {
	recommendation: CatalogRecommendation;
}
interface CatalogModel {
	efforts: Record<string, CatalogSlot>;
}
interface ModelCatalog {
	models: Record<string, CatalogModel>;
}

export interface CatalogSnapshot {
	readonly expandedPath: string | undefined;
	readonly statKey: { mtimeMs: number; size: number } | undefined;
	readonly revision: number;
	readonly generation: number;
	readonly nextStatAt: number;
	readonly available: boolean;
}

export function expandCatalogPath(path: string): string {
	return path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

const effortLevels = ["low", "medium", "high", "xhigh", "max"];
const recommendations = new Set<CatalogRecommendation>([null, "recommended", "ok", "avoid", "never"]);
const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Validate the catalog ABI before making any part of a new policy visible. */
export function parseModelCatalog(text: string): ModelCatalog {
	const data: unknown = JSON.parse(text);
	if (!isObject(data) || data.schemaVersion !== 1 || !isObject(data.models)) {
		throw new Error("Unsupported or malformed model catalog schema version");
	}
	const levels = data.effortLevels;
	if (!Array.isArray(levels) || levels.length !== effortLevels.length ||
		!effortLevels.every((level, index) => levels[index] === level) || !isObject(data.metrics)) {
		throw new Error("Malformed model catalog metadata");
	}
	for (const metric of ["economy", "performance", "stability", "speed"]) {
		const legend = data.metrics[metric];
		if (!isObject(legend) || typeof legend.scale !== "string" || !legend.scale ||
			typeof legend.meaning !== "string" || !legend.meaning) {
			throw new Error(`Malformed model catalog metric ${metric}`);
		}
	}
	for (const [slug, model] of Object.entries(data.models)) {
		if (!/^[^/]+\/.+$/.test(slug) || !isObject(model) || typeof model.family !== "string" || !model.family ||
			typeof model.behavior !== "string" || typeof model.notes !== "string" ||
			!isObject(model.efforts) || !Object.keys(model.efforts).length) {
			throw new Error(`Malformed model catalog entry ${slug}`);
		}
		for (const [effort, slot] of Object.entries(model.efforts)) {
			if (!effortLevels.includes(effort) || !isObject(slot) ||
				!Object.hasOwn(slot, "recommendation") || !recommendations.has(slot.recommendation as CatalogRecommendation) ||
				typeof slot.reason !== "string" || slot.reason.length > 280) {
				throw new Error(`Malformed model catalog slot ${slug} at ${effort}`);
			}
			for (const metric of ["economy", "performance", "stability", "speed"]) {
				const rating = slot[metric];
				if (rating !== null && (typeof rating !== "number" || !Number.isInteger(rating) || rating < 0 || rating > 5)) {
					throw new Error(`Malformed model catalog rating ${slug} at ${effort}`);
				}
			}
		}
	}
	return data as unknown as ModelCatalog;
}

export class LiveModelCatalogLoader {
	#io: CatalogIo;
	#now: () => number;
	#onChange?: (previous: CatalogSnapshot, current: CatalogSnapshot) => void;
	#onWarning: (message: string) => void;
	#path: string | undefined;
	#statKey: { mtimeMs: number; size: number } | undefined;
	#catalog: ModelCatalog | undefined;
	#revision = 0;
	#generation = 0;
	#sequence = 0;
	#nextStatAt = 0;
	#pending: Promise<void> | undefined;
	#disposed = false;

	constructor(options: {
		io?: CatalogIo;
		now?: () => number;
		onChange?: (previous: CatalogSnapshot, current: CatalogSnapshot) => void;
		onWarning?: (message: string) => void;
	} = {}) {
		this.#io = options.io ?? { stat, readFile };
		this.#now = options.now ?? Date.now;
		this.#onChange = options.onChange;
		this.#onWarning = options.onWarning ?? (message => logger.warn(message));
	}

	get snapshot(): CatalogSnapshot {
		return {
			expandedPath: this.#path,
			statKey: this.#statKey,
			revision: this.#revision,
			generation: this.#generation,
			nextStatAt: this.#nextStatAt,
			available: this.#catalog !== undefined,
		};
	}

	/** Synchronous, cached-only lookup. No I/O is ever performed from an event handler. */
	lookup(slug: string, effort: string): CatalogLookup {
		if (!this.#catalog) return { status: "unavailable" };
		const model = Object.hasOwn(this.#catalog.models, slug) ? this.#catalog.models[slug] : undefined;
		const slot = model && Object.hasOwn(model.efforts, effort) ? model.efforts[effort] : undefined;
		return slot ? { status: "present", recommendation: slot.recommendation } : { status: "missing" };
	}

	/** Invalidate the old policy immediately; an old path's I/O may settle but cannot publish. */
	setPath(path: string): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		const expanded = expandCatalogPath(path);
		if (expanded === this.#path) return this.refresh();
		const previous = this.snapshot;
		this.#path = expanded;
		this.#generation++;
		this.#sequence++;
		this.#statKey = undefined;
		this.#catalog = undefined;
		this.#nextStatAt = 0;
		this.#pending = undefined;
		this.#revision++;
		this.#onChange?.(previous, this.snapshot);
		return this.refresh();
	}

	/** A stat at most every five seconds, with an explicit force for operator-triggered reload. */
	refresh(force = false): Promise<void> {
		if (this.#disposed || this.#path === undefined) return Promise.resolve();
		if (this.#pending) return this.#pending;
		if (!force && this.#now() < this.#nextStatAt) return Promise.resolve();
		const path = this.#path;
		const generation = this.#generation;
		const sequence = ++this.#sequence;
		const current = () => !this.#disposed && generation === this.#generation && sequence === this.#sequence;
		const work = async () => {
			try {
				const statKey = await this.#io.stat(path);
				if (!current()) return;
				if (this.#catalog && this.#statKey?.mtimeMs === statKey.mtimeMs && this.#statKey.size === statKey.size) {
					this.#nextStatAt = this.#now() + LIVE_INGEST_CATALOG_STAT_MS;
					return;
				}
				const text = await this.#io.readFile(path, "utf8");
				if (!current()) return;
				const catalog = parseModelCatalog(text);
				if (!current()) return;
				const previous = this.snapshot;
				this.#catalog = catalog;
				this.#statKey = { mtimeMs: statKey.mtimeMs, size: statKey.size };
				this.#nextStatAt = this.#now() + LIVE_INGEST_CATALOG_STAT_MS;
				this.#revision++;
				this.#onChange?.(previous, this.snapshot);
			} catch (error) {
				if (!current()) return;
				const previous = this.snapshot;
				this.#catalog = undefined;
				this.#statKey = undefined;
				this.#nextStatAt = this.#now() + LIVE_INGEST_CATALOG_STAT_MS;
				if (previous.available) {
					this.#revision++;
					this.#onChange?.(previous, this.snapshot);
				}
				this.#onWarning(`Live ingest: model catalog unavailable at ${path}: ${String(error)}`);
			}
		};
		const pending = work();
		this.#pending = pending;
		void pending.finally(() => { if (this.#pending === pending) this.#pending = undefined; });
		return pending;
	}

	/** Cancels pending commits and notifications, without mutating the operator's file. */
	dispose(): void {
		this.#disposed = true;
		this.#generation++;
		this.#sequence++;
		this.#pending = undefined;
		this.#catalog = undefined;
	}
}
