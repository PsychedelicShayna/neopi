export interface TomlFrontmatter {
	header: string;
	properties: Record<string, unknown>;
	content: string;
}

/** A +++ line inside a valid TOML multiline string is data, not a delimiter. */
export function splitTomlFrontmatter(
	source: string,
	parseToml: (source: string) => Record<string, unknown>,
): TomlFrontmatter | undefined {
	const opening = /^\+\+\+(?:\r?\n|$)/.exec(source);
	if (!opening) return undefined;
	const rest = source.slice(opening[0].length);
	let parseError: unknown;
	for (const closing of rest.matchAll(/^\+\+\+\r?$/gm)) {
		const header = rest.slice(0, closing.index);
		let properties: Record<string, unknown>;
		try {
			properties = parseToml(header);
		} catch (error) {
			parseError = error;
			continue;
		}
		let contentStart = closing.index + closing[0].length;
		if (rest[contentStart] === "\n") contentStart++;
		return { header, properties, content: rest.slice(contentStart) };
	}
	if (parseError) throw parseError;
	throw new Error("Close TOML frontmatter with a +++ line: missing closing delimiter.");
}

/** Keep authored header bytes intact, adding only a missing line break before the fence. */
export function renderTomlFrontmatter(header: string, content: string): string {
	return `+++\n${header}${header.endsWith("\n") ? "" : "\n"}+++\n${content}`;
}
