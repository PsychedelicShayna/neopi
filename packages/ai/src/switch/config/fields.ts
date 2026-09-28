import { parseBind, type ParsedBind } from "../../utils/parse-bind";
import { SwitchError } from "../error";
import { Fields, KEY_NAME } from "../validation";

function distance(left: string, right: string): number {
	const row = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 1; i <= left.length; i++) {
		let previous = row[0]; row[0] = i;
		for (let j = 1; j <= right.length; j++) {
			const diagonal = previous; previous = row[j];
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
		}
	}
	return row[right.length];
}

/** Invalid values remain parser-local until finish rejects the entire document. */
export class ConfigFields extends Fields {
	override issue(path: string, message: string, code = "E-OPTION"): void { super.issue(path, message, code); }

	override object(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> {
		if (!value || typeof value !== "object" || Array.isArray(value)) { this.issue(path, "Expected a table"); return {}; }
		const row = value as Record<string, unknown>;
		for (const field of Object.keys(row).sort()) {
			if (allowed.includes(field)) continue;
			let closest: string | undefined;
			let best = Number.POSITIVE_INFINITY;
			for (const candidate of allowed) {
				const score = distance(field, candidate);
				if (score < best) { best = score; closest = candidate; }
			}
			this.issue(`${path}.${field}`, closest ? `Unknown key; closest defined key is ${closest}` : "No keys are defined for this table", "E-UNKNOWN-KEY");
		}
		return row;
	}

	text(value: unknown, path: string, fallback?: string): string {
		if (value === undefined && fallback !== undefined) return fallback;
		return this.string(value, path) ? value : "";
	}

	optionalText(value: unknown, path: string): string | undefined {
		return value === undefined ? undefined : this.text(value, path);
	}

	id(value: unknown, path: string, pattern = KEY_NAME): string {
		const result = this.text(value, path);
		if (!pattern.test(result)) this.issue(path, "Identifier does not match its declared syntax", "E-ID");
		return result;
	}

	choice<T extends string>(value: unknown, path: string, choices: readonly T[], fallback: T): T {
		if (value === undefined) return fallback;
		if (typeof value === "string" && choices.includes(value as T)) return value as T;
		this.issue(path, `Expected one of: ${choices.join(", ")}`);
		return fallback;
	}

	num(value: unknown, path: string, fallback: number, minimum = 0, integer = false): number {
		if (value === undefined) return fallback;
		return this.number(value, path, { min: minimum, integer }) ? value : fallback;
	}

	optionalNumber(value: unknown, path: string, minimum = 0, integer = false): number | undefined {
		return value === undefined ? undefined : this.num(value, path, 0, minimum, integer);
	}

	flag(value: unknown, path: string, fallback: boolean): boolean {
		if (value === undefined) return fallback;
		this.boolean(value, path);
		return typeof value === "boolean" ? value : fallback;
	}

	stringTable(value: unknown, path: string): Record<string, string> {
		if (value === undefined) return {};
		if (!value || typeof value !== "object" || Array.isArray(value)) { this.issue(path, "Expected a table of strings"); return {}; }
		const result: Record<string, string> = Object.create(null);
		for (const [name, item] of Object.entries(value)) {
			if (typeof item !== "string") this.issue(`${path}.${name}`, "Expected a string");
			else result[name] = item;
		}
		return result;
	}

	bind(value: unknown, path: string): ParsedBind {
		try { return parseBind(this.text(value, path)); }
		catch { this.issue(path, "Expected a port, host:port or [IPv6]:port", "E-BIND"); return { hostname: "127.0.0.1", port: 0 }; }
	}

	override finish(): void {
		if (this.issues.length) throw new SwitchError(422, "validation", "Switch configuration is invalid", { issues: this.issues.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code)) });
	}
}
