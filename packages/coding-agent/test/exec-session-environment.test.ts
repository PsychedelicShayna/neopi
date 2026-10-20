import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings, resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { applySessionEnvironment } from "@oh-my-pi/pi-coding-agent/exec/session-environment";
import { SessionEnvironment } from "@oh-my-pi/pi-coding-agent/session/environment";
import * as shellSnapshot from "@oh-my-pi/pi-coding-agent/utils/shell-snapshot";

// Spies are per test so unrelated files never inherit a changed shell/settings environment.
afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("session environment child inheritance", () => {
	it("applies overrides after direnv, preserves explicit command env and does not weaken unattended policy", () => {
		const environment = new SessionEnvironment({});
		environment.set("CUSTOM", "live");
		environment.set("REMOVED", undefined);
		environment.set("EXPLICIT", "session");
		for (const name of ["EDITOR", "VISUAL", "GIT_EDITOR"]) environment.set(name, "nvim");
		const result = applySessionEnvironment(
			"echo ok",
			{ CUSTOM: "direnv", REMOVED: "old", EXPLICIT: "command" },
			environment,
			{ EXPLICIT: "command" },
		);
		expect(result).toEqual({ command: "unset -v REMOVED; echo ok", env: { CUSTOM: "live", EXPLICIT: "command" } });
	});

	it("keeps an absent overlay byte-identical", () => {
		const env = { EXAMPLE: "old" };
		const result = applySessionEnvironment("echo unchanged", env, new SessionEnvironment({}));
		expect(result.command).toBe("echo unchanged");
		expect(result.env).toBe(env);
	});

	it.skipIf(process.platform === "win32")(
		"subsequent local commands observe set, empty and unset but retain non-interactive editors",
		async () => {
			await Settings.init({ inMemory: true, cwd: process.cwd() });
			vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
				shell: "/bin/bash",
				args: ["-c"],
				env: { PATH: Bun.env.PATH ?? "", HOME: Bun.env.HOME ?? "", NPI_ENV_URL_REMOVED: "inherited" },
				prefix: undefined,
			});
			vi.spyOn(shellSnapshot, "getOrCreateSnapshot").mockResolvedValue(null);
			const environment = new SessionEnvironment({});
			environment.set("NPI_ENV_URL_PROBE", "live");
			environment.set("NPI_ENV_URL_REMOVED", undefined);
			for (const name of ["EDITOR", "VISUAL", "GIT_EDITOR"]) environment.set(name, "nvim");
			const command =
				'printf "%s|%s|%s|%s|%s" "$NPI_ENV_URL_PROBE" "${NPI_ENV_URL_REMOVED-unset}" "$VISUAL" "$EDITOR" "$GIT_EDITOR"';
			const options = { environment, sessionKey: "env-url-test", timeout: 10000 };
			const first = await executeBash(command, options);
			expect(first.exitCode).toBe(0);
			expect(first.output).toBe("live|unset|true|true|true");
			environment.set("NPI_ENV_URL_PROBE", "");
			expect((await executeBash('printf "[%s]" "${NPI_ENV_URL_PROBE-missing}"', options)).output).toBe("[]");
			environment.set("NPI_ENV_URL_PROBE", undefined);
			expect((await executeBash('printf "[%s]" "${NPI_ENV_URL_PROBE-missing}"', options)).output).toBe("[missing]");
		},
	);
});
