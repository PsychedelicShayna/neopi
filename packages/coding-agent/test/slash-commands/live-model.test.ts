import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import { DEFAULT_LIVE_MODEL } from "../../src/live/protocol";
import { cfgLiveModel } from "../../src/live/settings";
import type { InteractiveModeContext } from "../../src/modes/types";
import { executeBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";

afterEach(() => vi.restoreAllMocks());

function harness() {
	const settings = Settings.isolated();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const handleLiveCommand = vi.fn(async () => {});
	const ctx = {
		settings,
		editor: { setText: vi.fn() },
		showStatus,
		showError,
		handleLiveCommand,
	} as unknown as InteractiveModeContext;
	return { runtime: { ctx }, settings, showStatus, showError, handleLiveCommand };
}

describe("/live model", () => {
	it("shows the default without starting a call", async () => {
		const h = harness();
		expect(await executeBuiltinSlashCommand("/live model", h.runtime)).toBe(true);
		expect(h.showStatus).toHaveBeenCalledWith(expect.stringContaining(DEFAULT_LIVE_MODEL));
		expect(h.handleLiveCommand).not.toHaveBeenCalled();
	});

	it("sets a slug and reports it on the next query without toggling a call", async () => {
		const h = harness();
		await executeBuiltinSlashCommand("/live model custom-live-model", h.runtime);
		expect(cfgLiveModel.get(h.settings)).toBe("custom-live-model");
		expect(h.showStatus).toHaveBeenLastCalledWith(expect.stringContaining("custom-live-model"));
		await executeBuiltinSlashCommand("/live model", h.runtime);
		expect(h.showStatus).toHaveBeenLastCalledWith(expect.stringContaining("custom-live-model"));
		expect(h.handleLiveCommand).not.toHaveBeenCalled();
	});

	it("rejects extra words without changing the configured model", async () => {
		const h = harness();
		await executeBuiltinSlashCommand("/live model bad slug", h.runtime);
		expect(h.showError).toHaveBeenCalled();
		expect(cfgLiveModel.get(h.settings)).toBe(DEFAULT_LIVE_MODEL);
		expect(h.handleLiveCommand).not.toHaveBeenCalled();
	});

	it("keeps bare /live as the existing toggle and rejects unknown subcommands", async () => {
		const h = harness();
		await executeBuiltinSlashCommand("/live", h.runtime);
		expect(h.handleLiveCommand).toHaveBeenCalledTimes(1);
		await executeBuiltinSlashCommand("/live invalid", h.runtime);
		expect(h.showError).toHaveBeenCalledWith("Usage: /live [model [slug]]");
		expect(h.handleLiveCommand).toHaveBeenCalledTimes(1);
	});
});
