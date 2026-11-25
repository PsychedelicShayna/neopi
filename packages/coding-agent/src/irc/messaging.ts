import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { IrcBus, ircRelayRoot } from "./bus";
import type { AgentRegistryApi } from "../registry/agent-registry";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import { canSpawnAtDepth } from "../task/types";

import { cfgTaskMaxRecursionDepth } from "../task/settings";

function coordinationErrorResult(text: string, details: CoordinationDetails): AgentToolResult<CoordinationDetails> {
	return { content: [{ type: "text", text }], details, isError: true };
}

/** Messaging is available to subagents and to top-level sessions able to spawn peers. */
export function isIrcEnabled(settings: Settings, taskDepth: number): boolean {
	if (taskDepth > 0) return true;
	const maxDepth = cfgTaskMaxRecursionDepth.get(settings);
	return canSpawnAtDepth(maxDepth, taskDepth);
}

/** Send a direct message or, from a top-level agent only, a broadcast, optionally as a reply to message `replyTo`; delivery never waits for a reply. */
export async function executeSend(
	deps: { registry: AgentRegistryApi; senderId: string; sessionFileHint?: string | null },
	params: { to: string; message: string; replyTo?: string; progress?: boolean; remote?: boolean },
): Promise<AgentToolResult<CoordinationDetails>> {
	const { registry, senderId, sessionFileHint } = deps;
	const to = params.to.trim();
	const message = params.message;
	const replyTo = params.replyTo?.trim() ? params.replyTo : undefined;
	if (!to) return coordinationErrorResult("A recipient is required.", { op: "send", from: senderId });
	if (!message.trim())
		return coordinationErrorResult("A non-empty message is required.", { op: "send", from: senderId });
	if (to === senderId)
		return coordinationErrorResult("Cannot send a message to yourself.", { op: "send", from: senderId, to });
	const isBroadcast = to === "all";
	// Restore parked recipients only when needed; never delay delivery to a live peer.
	if (!isBroadcast && sessionFileHint && !params.remote) {
		const recipient = registry.get(to);
		if (!recipient || recipient.status === "parked") await ensurePersistedRoster(registry, sessionFileHint);
	}

	const bus = IrcBus.global();
	const targets = isBroadcast
		? bus.filterBroadcastTargets(
				senderId,
				registry.listVisibleTo(senderId).map(ref => ref.id),
			)
		: [to];
	// A broadcast that reaches the sender's root is shown there directly; the
	// display-only relay to that root would duplicate it.
	const relayRootId = ircRelayRoot(registry, senderId)?.id;
	const suppressRelay = isBroadcast && relayRootId !== undefined && targets.includes(relayRootId);
	const fanoutId = isBroadcast ? Snowflake.next() : undefined;
	const receipts = await Promise.all(
		targets.map(target =>
			bus.send(
				{
					from: senderId,
					to: target,
					body: message,
					replyTo,
					localOnly: !params.remote,
					...(fanoutId ? { broadcast: true, fanoutId } : {}),
					...(params.progress === true ? { progress: true } : {}),
				},
				{ suppressRelay, broadcast: isBroadcast },
			),
		),
	);
	const delivered = receipts.filter(receipt => receipt.outcome !== "failed");
	let text: string;
	if (isBroadcast) {
		text =
			targets.length === 0
				? "No live peers to broadcast to."
				: `Broadcast delivered to ${delivered.length} of ${targets.length} peer(s).`;
		if (receipts.length) {
			text += `\n${receipts
				.map(receipt =>
					receipt.outcome === "failed"
						? `- ${receipt.to}: failed — ${receipt.error ?? "not running"}`
						: `- ${receipt.to}: ${receipt.outcome}`,
				)
				.join("\n")}`;
		}
	} else {
		const receipt = receipts[0]!;
		const recipient = registry.get(to);
		const unavailable = !recipient || recipient.status === "aborted" || !recipient.session;
		text =
			receipt.outcome === "failed"
				? `Failed: ${to} ${unavailable ? "is not running" : "could not receive the message"}. ${receipt.error ?? ""}`.trimEnd()
				: receipt.outcome === "revived"
					? `Queued for ${to} (was parked; revived).`
					: `Delivered to ${to}.`;
	}
	return {
		content: [{ type: "text", text }],
		details: { op: "send", from: senderId, to, receipts },
		isError: delivered.length === 0 && targets.length > 0,
	};
}
