import type { ExtensionAPI } from "../../src/extensibility/extensions";

/** Deliberately unlike built-in read: both independent text blocks must survive remote rendering. */
export default function viewerReadExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read",
		label: "Viewer extension read",
		description: "Return two text blocks for the attached viewer regression.",
		parameters: pi.arktype({ path: "string" }),
		execute: async (_toolCallId, args) => ({
			content: [
				{ type: "text", text: `extension-read-first-block:${args.path}` },
				{ type: "text", text: "extension-read-second-block" },
			],
		}),
	});
}
