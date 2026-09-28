/**
 * Issue #110: an extension that awaits a host dialog during `session_start`
 * deadlocked RPC startup, because stdin was only read after extension
 * initialization finished. The host's `extension_ui_response` must be
 * dispatched during startup, and commands sent meanwhile must be answered once
 * startup completes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { RpcChild } from "./helpers/rpc-child";

const children: RpcChild[] = [];

afterEach(async () => {
	await Promise.all(children.splice(0).map(child => child.dispose()));
});

describe("RPC startup extension UI", () => {
	test("answers a startup confirm dialog, then serves commands queued behind startup", async () => {
		const child = await RpcChild.spawn({
			args: ["--extension", path.join(import.meta.dir, "fixtures", "startup-confirm-extension.ts")],
		});
		children.push(child);

		await child.waitFor(frame => frame.type === "ready", 30_000);
		// Sent while the extension still waits on its dialog: must queue, not be lost.
		const stateResponse = child.request({ type: "get_state" }, 30_000);

		const dialog = await child.waitFor(
			frame => frame.type === "extension_ui_request" && frame.method === "confirm",
			30_000,
		);
		expect(dialog.title).toBe("Startup check");
		// Version negotiation is transport-level: answered while the dialog is still open.
		const negotiated = await child.request({ type: "negotiate_protocol", protocolVersion: 2 }, 30_000);
		expect(negotiated).toMatchObject({ success: true, data: { protocolVersion: 2 } });
		child.send({ type: "extension_ui_response", id: dialog.id, confirmed: true });

		const notice = await child.waitFor(frame => frame.type === "extension_ui_request" && frame.method === "notify");
		expect(notice.message).toBe("startup-confirm:true");

		const state = await stateResponse;
		expect(state.success).toBe(true);
		// The queued command is answered only after session_start completed.
		expect(child.frames.indexOf(state)).toBeGreaterThan(child.frames.indexOf(notice));
	}, 60_000);
});
