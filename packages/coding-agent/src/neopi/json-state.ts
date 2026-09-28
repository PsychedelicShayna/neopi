/**
 * Schema-validated JSON state files for NeoPi operator features (personas,
 * live personas, loadouts, REPL profiles).
 *
 * Writes are atomic: the previous file is copied to `<path>.bak`, the new
 * state goes to a temp file that is fsynced, renamed over the target, and the
 * directory is fsynced. Reads fall back to the pre-rename `omomp-*` file when
 * the `neopi-*` file does not exist yet; a missing file yields the empty state,
 * while an invalid one throws so user state is never silently replaced.
 */
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { readJsonWithLegacyFile } from "@oh-my-pi/pi-utils/dirs";

export class JsonStateStore<T> {
	readonly #path: string | (() => string);
	readonly #legacyFileName: string;
	readonly #validate: (value: unknown) => T;
	readonly #empty: () => T;

	/**
	 * `path` may be a resolver so the default stores follow the active profile's
	 * agent dir, which can change after startup.
	 */
	constructor(path: string | (() => string), legacyFileName: string, validate: (value: unknown) => T, empty: () => T) {
		this.#path = path;
		this.#legacyFileName = legacyFileName;
		this.#validate = validate;
		this.#empty = empty;
	}

	get path(): string {
		return typeof this.#path === "function" ? this.#path() : this.#path;
	}

	get backupPath(): string {
		return `${this.path}.bak`;
	}

	async read(): Promise<T> {
		try {
			const target = this.path;
			const legacy = nodePath.join(nodePath.dirname(target), this.#legacyFileName);
			return this.#validate(await readJsonWithLegacyFile(target, legacy));
		} catch (error) {
			if (isEnoent(error)) return this.#empty();
			throw error;
		}
	}

	async write(state: T): Promise<void> {
		this.#validate(state);
		const target = this.path;
		const dir = nodePath.dirname(target);
		await fs.mkdir(dir, { recursive: true });
		const temp = nodePath.join(dir, `.${Bun.randomUUIDv7()}.tmp`);
		try {
			await fs.copyFile(target, `${target}.bak`);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		const file = await fs.open(temp, "wx", 0o600);
		try {
			await file.writeFile(`${JSON.stringify(state, null, 2)}\n`);
			await file.sync();
		} finally {
			await file.close();
		}
		await fs.rename(temp, target);
		const handle = await fs.open(dir, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

export const isStringRecord = (v: unknown): v is Record<string, string> =>
	isRecord(v) && Object.values(v).every(x => typeof x === "string");
