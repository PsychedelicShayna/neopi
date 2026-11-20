import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { render as renderPrompt } from "@oh-my-pi/pi-utils/prompt";
import { resolvePromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import envDoc from "../prompts/internal-urls/env.md" with { type: "text" };
import { isSecretEnvValue } from "../secrets";
import { sessionEnvironment } from "../session/environment";
import type {
	InternalResource,
	InternalUrl,
	InternalWriteResult,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	WriteContext,
} from "./types";

function target(url: InternalUrl): { name: string; unset: boolean } {
	const name = url.rawHost;
	const pathname = url.rawPathname ?? url.pathname;
	if (
		(name && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ||
		url.search ||
		url.hash ||
		!["", "/", "/unset"].includes(pathname) ||
		(!name && pathname === "/unset")
	) {
		throw new ToolError('Use env://, env://NAME, or write env://NAME/unset with empty content ("").');
	}
	return { name, unset: pathname === "/unset" };
}

/** Session-owned environment control, using the normal read/write approval gates. */
export class EnvProtocolHandler implements ProtocolHandler {
	readonly scheme = "env";
	readonly spec: SchemeSpec = {
		backing: "device",
		selectors: "none",
		immutable: false,
		write: {
			via: "handler",
			payload: "verbatim",
			scope: "workspace",
			tier: () => "exec",
		},
	};

	promptDoc(): string {
		const { text } = resolvePromptAsset("internal-urls/env.md", envDoc);
		return (text === envDoc ? text : renderPrompt(text)).trim();
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		if (!context?.session) throw new ToolError("env:// requires an owning session.");
		const { name, unset } = target(url);
		if (unset) throw new ToolError("/unset is write-only; read env://NAME to inspect the value.");
		const environment = sessionEnvironment(context.session);
		const value = name ? environment.get(name) : undefined;
		// Names only at the root. Credential values are never included, even when secrets.enabled is off.
		const content = name
			? JSON.stringify(
					{
						name,
						state: value === undefined ? "unset" : "set",
						...(value === undefined ? {} : { value: isSecretEnvValue(name, value) ? "<redacted>" : value }),
					},
					null,
					2,
				)
			: `${envDoc.trim()}\n\n## Variable names\n${environment.names().join("\n")}\n`;
		return {
			url: url.href,
			content,
			contentType: name ? "application/json" : "text/markdown",
			size: Buffer.byteLength(content),
			isDirectory: !name,
		};
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<InternalWriteResult> {
		if (!context?.session) throw new ToolError("env:// requires an owning session.");
		const { name, unset } = target(url);
		if (!name)
			throw new ToolError('Write env://NAME with the exact value, or env://NAME/unset with empty content ("").');
		// The write schema requires content, so /unset takes an empty payload.
		// The explicit /unset action, not the payload, distinguishes deletion from an empty value.
		if (unset && content !== "")
			throw new ToolError('Unset takes empty content (""); set values at env://NAME instead.');
		sessionEnvironment(context.session).set(name, unset ? undefined : content);
		return {
			content: [
				{
					type: "text",
					text: `${name} ${unset ? "unset" : "set"} for this session only. Values are not echoed. Already-running children are unchanged.`,
				},
			],
		};
	}
}
