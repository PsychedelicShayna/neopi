import { createSettingsTomlCodec } from "@oh-my-pi/pi-utils/settings-toml-codec";
import { parse } from "smol-toml";
import { renderTomlFrontmatter, splitTomlFrontmatter } from "@oh-my-pi/pi-utils/toml-frontmatter";

const { parseSettingsToml, patchSettingsToml } = createSettingsTomlCodec(parse);

export interface CardBodyParts {
	header: string;
	content: string;
}
export interface CardPropertyDocument extends CardBodyParts {
	properties: Record<string, unknown>;
}

/** Owned card metadata is TOML. Legacy YAML is imported by the server, never the browser. */
export function cardBodyParts(body: string): CardBodyParts {
	const { header, content } = cardPropertyDocument(body);
	return { header, content };
}

export function cardPropertyDocument(body: string): CardPropertyDocument {
	if (/^---\r?\n/.test(body)) throw new Error("Legacy card metadata must be imported by the server before editing.");
	return splitTomlFrontmatter(body, parseSettingsToml) ?? { header: "", content: body, properties: {} };
}

export function setCardBodyContent(body: string, content: string): string {
	const previous = cardBodyParts(body).content;
	return body.slice(0, body.length - previous.length) + content;
}

export function setCardBodyProperty(body: string, key: string, value: string | boolean | undefined): string {
	const { header, content, properties } = cardPropertyDocument(body);
	if (
		(Object.hasOwn(properties, key) && properties[key] === value) ||
		(value === undefined && !Object.hasOwn(properties, key))
	)
		return body;
	const next = { ...properties };
	if (value === undefined) delete next[key];
	else Object.defineProperty(next, key, { value, enumerable: true, writable: true, configurable: true });
	const patched = patchSettingsToml(header, next);
	return renderTomlFrontmatter(patched, content);
}
