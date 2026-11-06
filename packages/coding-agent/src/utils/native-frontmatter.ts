import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import {
	importLegacyYaml,
	parseSettingsToml,
	patchSettingsToml,
	publishTomlImport,
	stringifySettingsToml,
} from "@oh-my-pi/pi-utils/settings-toml";
import { preserveLegacyYamlComments } from "@oh-my-pi/pi-utils/legacy-yaml-import";

export interface NativeMarkdownDocument {
	frontmatter: Record<string, unknown>;
	body: string;
}

/** Owned Markdown uses TOML; interoperable skills and foreign agents use their own YAML parser. */
export function parseNativeMarkdown(content: string, filePath?: string): NativeMarkdownDocument {
	const { frontmatter, body } = parseNativeParts(content, filePath);
	return { frontmatter, body };
}

export function renderNativeMarkdown(frontmatter: Record<string, unknown>, body: string, source?: string): string {
	return `+++\n${(source === undefined ? stringifySettingsToml(frontmatter) : patchSettingsToml(parseNativeParts(source).metadata, frontmatter)).trimEnd()}\n+++\n${body}`;
}

/** A delimiter inside a TOML multiline string is data, not the closing fence. */
function parseNativeParts(content: string, filePath?: string): NativeMarkdownDocument & { metadata: string } {
	const opening = /^\+\+\+\r?\n/.exec(content);
	if (!opening) throw new Error("Missing +++ native Markdown frontmatter boundary");
	const rest = content.slice(opening[0].length);
	let parseError: unknown;
	for (const closing of rest.matchAll(/^\+\+\+\r?$/gm)) {
		const metadata = rest.slice(0, closing.index);
		try {
			const frontmatter = parseSettingsToml(metadata, filePath);
			return { metadata, frontmatter, body: rest.slice(closing.index + closing[0].length).replace(/^\r?\n/, "") };
		} catch (error) {
			parseError = error;
		}
	}
	if (parseError) throw parseError;
	throw new Error("Unclosed +++ native Markdown frontmatter");
}

function splitFrontmatter(content: string, boundary: "---"): { metadata: string; body: string } {
	const opening = /^---\r?\n/;
	const start = opening.exec(content);
	if (!start) throw new Error(`Missing ${boundary} native Markdown frontmatter boundary`);
	const closing = /^---\r?$/m;
	const rest = content.slice(start[0].length);
	const end = closing.exec(rest);
	if (!end) throw new Error(`Unclosed ${boundary} native Markdown frontmatter`);
	return {
		metadata: rest.slice(0, end.index),
		body: rest.slice(end.index + end[0].length).replace(/^\r?\n/, ""),
	};
}

/** YAML parsing is confined to this non-destructive, one-time legacy import. */
export function importLegacyMarkdown(content: string, filePath?: string): string {
	const { metadata, body } = splitFrontmatter(content, "---");
	const frontmatter = importLegacyYaml(metadata, filePath);
	const toml = preserveLegacyYamlComments(metadata, stringifySettingsToml(frontmatter));
	return `+++\n${toml.trimEnd()}\n+++\n${body}`;
}

/** Prefer an existing canonical sibling; import legacy owned documents without changing their source. */
export async function readNativeMarkdown(
	filePath: string,
	options: { readOnly?: boolean } = {},
): Promise<NativeMarkdownDocument & { filePath: string }> {
	const sibling = nativeMarkdownPath(filePath);
	if (sibling !== filePath) {
		try {
			const content = await Bun.file(sibling).text();
			try {
				await Bun.file(filePath).stat();
				logger.warn("Native TOML document takes precedence over legacy document", {
					filePath: sibling,
					legacyPath: filePath,
				});
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			return { ...parseNativeMarkdown(content, sibling), filePath: sibling };
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	const content = await Bun.file(filePath).text();
	if (/^\+\+\+\r?\n/.test(content)) return { ...parseNativeMarkdown(content, filePath), filePath };
	const importedRaw = importLegacyMarkdown(content, filePath);
	const imported = parseNativeMarkdown(importedRaw, filePath);
	if (options.readOnly) return { ...imported, filePath };
	if (sibling === filePath) throw new Error("Legacy Markdown document cannot use a TOML sibling path");
	await publishTomlImport(sibling, importedRaw, filePath);
	logger.warn("Imported legacy native Markdown document into TOML", { filePath: sibling, legacyPath: filePath });
	return { ...parseNativeMarkdown(await Bun.file(sibling).text(), sibling), filePath: sibling };
}

export function nativeMarkdownPath(filePath: string): string {
	return filePath.endsWith(".toml.md") ? filePath : filePath.replace(/\.md$/, ".toml.md");
}
