import {
	importLegacyYaml,
	parseSettingsToml,
	patchSettingsToml,
	stringifySettingsToml,
} from "@oh-my-pi/pi-utils/settings-toml";
import { preserveLegacyYamlComments } from "@oh-my-pi/pi-utils/legacy-yaml-import";
import { renderTomlFrontmatter, splitTomlFrontmatter } from "@oh-my-pi/pi-utils/toml-frontmatter";

/** Card.body is the canonical property store. Routing never comes from metadata. */
export function cardFrontmatter(body: string): {
	properties: Record<string, unknown>;
	content: string;
	header?: string;
} {
	if (/^---\r?\n/.test(body)) throw new Error("Legacy card metadata must be imported before use.");
	const parsed = splitTomlFrontmatter(body, parseSettingsToml);
	return parsed ?? { properties: {}, content: body };
}

/** One-way import only. Callers must retain the original before persisting this result. */
export function importLegacyCardBody(body: string, filePath?: string): string {
	if (!/^---\r?\n/.test(body)) return body;
	const match = /^---\r?\n((?:[\s\S]*?\r?\n)?)---(?:\r?\n|$)/.exec(body);
	if (!match) throw new Error("Close legacy card front matter with a --- line.");
	const properties = importLegacyYaml(match[1]!, filePath);
	const header = preserveLegacyYamlComments(match[1]!, stringifySettingsToml(properties));
	return renderTomlFrontmatter(header, body.slice(match[0].length));
}

/** Raw native TOML is untouched unless a property patch is supplied. */
export function withCardProperties(body: string, properties?: Record<string, unknown>): string {
	if (properties === undefined) return body;
	if (!properties || typeof properties !== "object" || Array.isArray(properties))
		throw new Error("properties must be an object");
	if (!Object.keys(properties).length) return body;
	const parsed = cardFrontmatter(body);
	const header = patchSettingsToml(parsed.header ?? "", { ...parsed.properties, ...properties });
	return renderTomlFrontmatter(header, parsed.content);
}

export function cardExecutionProperties(body: string): {
	readOnly: boolean;
	worktree?: string;
	model?: string;
	role?: string;
} {
	const { properties } = cardFrontmatter(body);
	const readonly = properties["read-only"];
	if (readonly !== undefined && typeof readonly !== "boolean") throw new Error("read-only must be a boolean");
	const strings: Record<string, string> = {};
	for (const key of ["worktree", "model", "role"]) {
		const value = properties[key];
		if (value !== undefined) {
			if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a nonempty string`);
			strings[key] = value.trim();
		}
	}
	return { readOnly: readonly === true, ...strings };
}
