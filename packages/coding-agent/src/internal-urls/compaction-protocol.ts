import { render as renderPrompt } from "@oh-my-pi/pi-utils/prompt";
import { resolvePromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import compactionDoc from "../prompts/internal-urls/compaction.md" with { type: "text" };
import { runCompactionControl } from "../session/compaction-controls";
import type {
	InternalResource,
	InternalUrl,
	InternalWriteResult,
	ProtocolHandler,
	ResolveContext,
	SchemeSpec,
	WriteContext,
} from "./types";

export class CompactionProtocolHandler implements ProtocolHandler {
	readonly scheme = "compaction";
	readonly spec: SchemeSpec = {
		backing: "device",
		selectors: "none",
		immutable: true,
		write: { via: "handler", payload: "verbatim", scope: "device", tier: () => "write" },
	};

	promptDoc(): string {
		const { text } = resolvePromptAsset("internal-urls/compaction.md", compactionDoc);
		return (text === compactionDoc ? text : renderPrompt(text)).trim();
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const content = await this.#run(url, {}, context);
		return { url: url.href, content, contentType: "application/json" };
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<InternalWriteResult> {
		return { content: [{ type: "text", text: await this.#run(url, JSON.parse(content), context) }] };
	}

	#run(url: InternalUrl, input: unknown, context?: ResolveContext): Promise<string> {
		if (url.hostname || (url.pathname && url.pathname !== "/") || url.search) {
			throw new Error("Use compaction:// without a path or query.");
		}
		const session = context?.session;
		if (!session) throw new Error("Compaction controls require a calling session.");
		return runCompactionControl(session.settings, input, { agent: true, model: session.getActiveModel?.() });
	}
}
