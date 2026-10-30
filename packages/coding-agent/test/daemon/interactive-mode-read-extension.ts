import type { ExtensionAPI } from "../../src/extensibility/extensions";

/** Deliberately unlike built-in read: both independent text blocks must survive remote rendering. */
export default function viewerReadExtension(pi: ExtensionAPI): void {
	const parameters = pi.arktype({ path: "string" });
	pi.registerTool({
		name: "read",
		label: "Viewer extension read",
		description: "Return two text blocks for the attached viewer regression.",
		parameters,
		execute: async (_toolCallId, args) => {
			const input = parameters.assert(args);
			return {
				content: [
					{ type: "text", text: `extension-read-first-block:${input.path}` },
					{ type: "text", text: "extension-read-second-block" },
				],
			};
		},
	});
}
