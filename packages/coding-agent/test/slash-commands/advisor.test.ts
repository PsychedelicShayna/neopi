import { describe, expect, it } from "bun:test";
import { provenanceSuffix } from "@oh-my-pi/pi-tui/theme/provenance";
import { initTheme } from "@oh-my-pi/pi-tui/theme/theme";
import type { InteractiveModeContext } from "../../src/modes/types";
import type { AgentSession } from "../../src/session/agent-session";
import { executeAcpBuiltinSlashCommand } from "../../src/slash-commands/acp-builtins";
import {
	buildTuiBuiltinSlashCommands,
	executeBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
} from "../../src/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";

const advisorCommand = lookupBuiltinSlashCommand("advisor")!;

function session(): AgentSession {
	return {
		setAdvisorEnabled: () => true,
		toggleAdvisorEnabled: () => true,
		isAdvisorEnabled: () => true,
		getAdvisorStatusOverview: () => ({
			configured: true,
			advisors: [
				{ name: "Velvet", status: "running" },
				{ name: "Architecture", status: "running" },
				{ name: "Paused", status: "paused" },
				{ name: "Unresolved", status: "no_model" },
			],
		}),
	} as unknown as AgentSession;
}

describe("advisor activation announcements", () => {
	for (const verb of ["on", "toggle"]) {
		it(`names the started advisors for ${verb} in text hosts`, async () => {
			const messages: string[] = [];
			await advisorCommand.handle?.({ name: "advisor", args: verb, text: `/advisor ${verb}` }, {
				session: session(),
				output: text => {
					messages.push(text);
				},
			} as SlashCommandRuntime);
			expect(messages).toEqual(["Advisor enabled: Velvet, Architecture."]);
		});

		it(`names the started advisors for ${verb} in the TUI`, async () => {
			const messages: string[] = [];
			const ctx = {
				session: session(),
				showStatus: (text: string) => {
					messages.push(text);
				},
				statusLine: { invalidate: () => {} },
				ui: { requestRender: () => {} },
				editor: { setText: () => {} },
			} as unknown as InteractiveModeContext;
			await advisorCommand.handleTui?.({ name: "advisor", args: verb, text: `/advisor ${verb}` }, { ctx });
			expect(messages).toEqual(["Advisor enabled: Velvet, Architecture."]);
		});
	}
});

const crew = [
	{ slug: "", name: "Advisor" },
	{ slug: "review-2", name: "Code Review" },
	{ slug: "velvet", name: "Velvet" },
];

function restartHarness(advisors: readonly { slug: string; name: string }[], restartSucceeds = true) {
	const messages: string[] = [];
	const restarted: string[] = [];
	const activeSession = {
		liveAdvisors: () => advisors,
		restartAdvisor: (slug: string) => {
			restarted.push(slug);
			return restartSucceeds;
		},
	} as unknown as AgentSession;
	const ctx = {
		session: activeSession,
		showStatus: (text: string) => messages.push(text),
		statusLine: { invalidate: () => {} },
		ui: { requestRender: () => {} },
		editor: { setText: () => {} },
	} as unknown as InteractiveModeContext;
	const textRuntime = {
		session: activeSession,
		output: (text: string) => messages.push(text),
	} as unknown as SlashCommandRuntime;
	return { ctx, textRuntime, messages, restarted };
}

describe.each(["TUI", "text"])("/advisor restart in %s hosts", host => {
	function run(text: string, harness: { ctx: InteractiveModeContext; textRuntime: SlashCommandRuntime }) {
		return host === "TUI"
			? executeBuiltinSlashCommand(text, { ctx: harness.ctx })
			: executeAcpBuiltinSlashCommand(text, harness.textRuntime);
	}

	it.each([
		["", [crew[0]], "", "Advisor"],
		[" Advisor", crew, "", "Advisor"],
		[" review-2", crew, "review-2", "Code Review"],
		[" code review", crew, "review-2", "Code Review"],
	] as const)("restarts only the selected advisor for %j", async (tail, advisors, slug, name) => {
		const h = restartHarness(advisors);
		expect(await run(`/advisor restart${tail}`, h)).toEqual(host === "TUI" ? true : { consumed: true });
		expect(h.restarted).toEqual([slug]);
		expect(h.messages).toEqual([`Restarted advisor ${name}.`]);
	});

	it.each([
		["", [], "No live advisors"],
		["", crew, "Specify a live advisor"],
		[" Code", crew, "No live advisor matches"],
		[" Code Review", [...crew, { slug: "review-3", name: "Code Review" }], "More than one live advisor matches"],
		[" review-2", [...crew, { slug: "second-opinion", name: "review-2" }], "More than one live advisor matches"],
	] as const)("does not pick a target for %j when resolution fails", async (tail, advisors, message) => {
		const h = restartHarness(advisors);
		expect(await run(`/advisor restart${tail}`, h)).toEqual(host === "TUI" ? true : { consumed: true, failed: true });
		expect(h.restarted).toEqual([]);
		expect(h.messages).toHaveLength(1);
		expect(h.messages[0]).toContain(message);
	});

	it("reports refusal from the session instead of claiming a restart", async () => {
		const h = restartHarness(crew, false);
		expect(await run("/advisor restart velvet", h)).toEqual(host === "TUI" ? true : { consumed: true, failed: true });
		expect(h.restarted).toEqual(["velvet"]);
		expect(h.messages).toEqual(["Could not restart advisor Velvet."]);
	});
});

it("completes the marked restart verb and live advisor targets without guessing on Enter", async () => {
	await initTheme();
	const { ctx } = restartHarness(crew);
	const command = buildTuiBuiltinSlashCommands({ ctx }).find(item => item.name === "advisor")!;
	const complete = command.getArgumentCompletions!;
	expect(await complete("rest")).toEqual([
		expect.objectContaining({
			label: `restart${provenanceSuffix("nightly")}`,
			value: "restart ",
			hint: "art [slug|name]",
			submitsCommand: false,
		}),
	]);
	expect((await complete("restart "))?.map(item => [item.value, item.preserveInputOnSubmit])).toEqual([
		["restart Advisor ", true],
		["restart review-2 ", true],
		["restart velvet ", true],
	]);
	expect(await complete("restart code re")).toEqual([
		expect.objectContaining({ value: "restart review-2 ", description: "Code Review", submitsCommand: true }),
	]);
});
