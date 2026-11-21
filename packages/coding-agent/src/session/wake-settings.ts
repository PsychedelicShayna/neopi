import { register, type ScopeLike } from "../config/registry";

const WAKE_EVENTS = [
	["asyncJobs", "Background Job Results"],
	["subagents", "Subagent Results"],
	["advisors", "Advisor Messages"],
	["irc", "IRC Messages"],
	["launches", "Launch Completions"],
	["notices", "Other Background Notices"],
] as const;

export type AgentWakeEvent = (typeof WAKE_EVENTS)[number][0];
type AgentWakeChoice = AgentWakeEvent | `afterInterrupt.${AgentWakeEvent}`;

const wakeChoices: { value: AgentWakeChoice; label: string }[] = WAKE_EVENTS.flatMap(([event, label]) => [
	{ value: event, label },
	{ value: `afterInterrupt.${event}`, label: `${label} After Ctrl+C` },
]);

export const cfgAgentWake = register({
	id: "notifyAgent.when",
	type: "array",
	default: [...WAKE_EVENTS.map(([event]) => event), "afterInterrupt.irc"] as AgentWakeChoice[],
	items: { values: wakeChoices.map(({ value }) => value), label: "agent wake event" },
	ui: {
		tab: "interaction",
		group: "Notifications",
		label: "Notify Agent When...",
		description:
			"Choose which events can start a turn for the idle primary agent, and separately after Ctrl+C stops a run. Unchecked events still reach context without starting a turn. Advisor timing and severity rules still apply.",
		options: wakeChoices,
	},
});

/** Wake eligibility is separate from the event's normal delivery, including into an active turn. */
export function canWakeAgent(settings: ScopeLike | undefined, event: AgentWakeEvent, afterInterrupt: boolean): boolean {
	const choices = settings ? cfgAgentWake.get(settings) : cfgAgentWake.default;
	return choices.includes(afterInterrupt ? `afterInterrupt.${event}` : event);
}
