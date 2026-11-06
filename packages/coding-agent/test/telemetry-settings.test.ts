import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import {
	cfgTelemetryAgentContext,
	cfgTelemetryThresholdEvents,
	cfgTelemetryToolResults,
	cfgUsageNoticesContextPercent,
	cfgUsageNoticesEnabled,
	cfgUsageNoticesQuotaPercent,
	cfgUsageNoticesRemainingPercent,
} from "@oh-my-pi/pi-coding-agent/telemetry-settings";
import { TempDir, stringifySettingsToml } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState } from "./helpers/settings-test-state";

describe("local agent telemetry settings", () => {
	it("keeps all automatic telemetry disabled by default", () => {
		const settings = Settings.isolated();
		expect(cfgTelemetryAgentContext.get(settings)).toBe("off");
		expect(cfgTelemetryToolResults.get(settings)).toBe("off");
		expect(cfgTelemetryThresholdEvents.get(settings)).toBe(false);
	});

	it.each(["off", "minimal", "full"] as const)("accepts context mode %s without enabling result injection", mode => {
		const settings = Settings.isolated({ "telemetry.agent_context": mode });
		expect(cfgTelemetryAgentContext.get(settings)).toBe(mode);
		expect(cfgTelemetryToolResults.get(settings)).toBe("off");
		expect(cfgTelemetryThresholdEvents.get(settings)).toBe(false);
	});

	it.each(["off", "summary", "full"] as const)(
		"accepts tool-result mode %s independently of context injection",
		mode => {
			const settings = Settings.isolated({ "telemetry.tool_results": mode });
			expect(cfgTelemetryToolResults.get(settings)).toBe(mode);
			expect(cfgTelemetryAgentContext.get(settings)).toBe("off");
		},
	);

	it("enables threshold notices without changing either detail mode", () => {
		const settings = Settings.isolated({ "telemetry.threshold_events": true });
		expect(cfgTelemetryThresholdEvents.get(settings)).toBe(true);
		expect(cfgTelemetryAgentContext.get(settings)).toBe("off");
		expect(cfgTelemetryToolResults.get(settings)).toBe("off");
	});
});

describe("usage notice settings through production initialization", () => {
	// Same nested sections as an existing operator configuration, without personal
	// paths, endpoints, model selections, provider credentials, or speech text.
	const existingConfiguration = {
		providers: { maxInFlightRequests: {}, anthropic: { serverSideFallback: false } },
		modelRoles: { default: "test/model" },
		roleEffortSelections: { default: { mode: "fixed", level: "medium" } },
		task: { maxConcurrency: 4, maxRecursionDepth: 2 },
		compaction: { enabled: true, thresholdPercent: 85, modelThresholds: {} },
		live: { holdMode: false, quietFloorMs: 300, submitSilenceMs: 500 },
		telemetry: { otlpExportEnabled: false, threshold_events: true },
	};

	for (const [name, configuration] of [
		["empty configuration", {}],
		["existing operator-shaped configuration", existingConfiguration],
	] as const) {
		it(`loads ${name} without usageNotices keys and applies defaults`, async () => {
			const state = beginSettingsTest();
			const temp = await TempDir.create("@usage-notices-init-");
			try {
				const agentDir = path.join(temp.path(), "agent");
				const cwd = path.join(temp.path(), "project");
				await Bun.write(path.join(agentDir, "config.toml"), stringifySettingsToml(configuration));
				const settings = await Settings.init({ agentDir, cwd });
				expect(cfgUsageNoticesEnabled.get(settings)).toBe(false);
				expect(cfgUsageNoticesQuotaPercent.get(settings)).toBe(80);
				expect(cfgUsageNoticesRemainingPercent.get(settings)).toBe(10);
				expect(cfgUsageNoticesContextPercent.get(settings)).toBe(80);
				await settings.reloadFromDisk();
				expect(cfgUsageNoticesEnabled.get(settings)).toBe(false);
			} finally {
				AgentStorage.close();
				restoreSettingsTestState(state);
				await temp.remove();
			}
		});
	}

	it("still rejects an explicitly invalid threshold through the disk load path", async () => {
		const state = beginSettingsTest();
		const temp = await TempDir.create("@usage-notices-invalid-");
		try {
			const agentDir = path.join(temp.path(), "agent");
			await Bun.write(
				path.join(agentDir, "config.toml"),
				stringifySettingsToml({ usageNotices: { enabled: false, quotaPercent: 101 } }),
			);
			await expect(Settings.init({ agentDir, cwd: temp.path() })).rejects.toThrow(
				"Notice thresholds must be between 0 and 100 percent",
			);
		} finally {
			AgentStorage.close();
			restoreSettingsTestState(state);
			await temp.remove();
		}
	});
});
