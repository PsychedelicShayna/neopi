import type { ToolSession } from "../tools";

/** Runtime-only environment owned by one session, never written into process.env. */
export class SessionEnvironment {
	readonly #inherited: Readonly<Record<string, string | undefined>>;
	readonly #overrides = new Map<string, string | undefined>();
	readonly #windows: boolean;

	constructor(
		inherited: Readonly<Record<string, string | undefined>> = Bun.env,
		platform: NodeJS.Platform = process.platform,
	) {
		this.#windows = platform === "win32";
		this.#inherited = this.#windows
			? Object.fromEntries(Object.entries(inherited).map(([name, value]) => [name.toUpperCase(), value]))
			: { ...inherited };
	}

	get(name: string): string | undefined {
		if (this.#windows) name = name.toUpperCase();
		return this.#overrides.has(name)
			? this.#overrides.get(name)
			: Object.hasOwn(this.#inherited, name)
				? this.#inherited[name]
				: undefined;
	}

	set(name: string, value: string | undefined): void {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Expected an environment variable name.");
		if (value?.includes("\0")) throw new Error("Environment values cannot contain NUL.");
		this.#overrides.set(this.#windows ? name.toUpperCase() : name, value);
	}

	names(): string[] {
		return [...new Set([...Object.keys(this.#inherited), ...this.#overrides.keys()])]
			.filter(name => this.get(name) !== undefined)
			.sort();
	}

	overrides(): ReadonlyMap<string, string | undefined> {
		return this.#overrides;
	}

	/** Full child environment. Omitted names remain absent, not empty strings. */
	snapshot(): Record<string, string> {
		const env: Record<string, string> = Object.create(null);
		for (const [name, value] of Object.entries(this.#inherited)) {
			if (value !== undefined) env[name] = value;
		}
		for (const [name, value] of this.#overrides) {
			if (value === undefined) delete env[name];
			else env[name] = value;
		}
		return env;
	}
}

/** Factory-created ToolSessions also receive their own owner on first access. */
export function sessionEnvironment(session: ToolSession): SessionEnvironment {
	return (session.environment ??= new SessionEnvironment());
}
