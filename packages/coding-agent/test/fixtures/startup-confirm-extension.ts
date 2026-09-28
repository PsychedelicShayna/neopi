import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

/** Asks the host a question while RPC startup is still initializing extensions (issue #110). */
export default function startupConfirmExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const confirmed = await ctx.ui.confirm("Startup check", "Continue startup?");
		ctx.ui.notify(`startup-confirm:${confirmed}`);
	});
}
