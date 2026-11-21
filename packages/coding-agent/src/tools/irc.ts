import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { IrcDeliveryReceipt } from "@oh-my-pi/pi-tui/tools/irc";
import { renderPromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import { IrcBus } from "../irc/bus";
import { IRC_EVERYONE, type IrcGroupRequest } from "../irc/groups";
import { executeSend } from "../irc/messaging";
import ircDescription from "../prompts/tools/irc.md" with { type: "text" };
import type { ToolSession } from ".";

const ircSchema = type({
	op: type.enumerated(
		"send",
		"broadcast",
		"create",
		"add",
		"remove",
		"leave",
		"groups",
		"members",
		"my_groups",
		"keep",
	),
	"to?": type("string | string[]").describe("Direct send: one or more peer IDs; mutually exclusive with group"),
	"group?": type("string").describe("Group name, without a leading #"),
	"message?": type("string").describe("Text for send or broadcast"),
	"members?": type("string[]").describe("Peer IDs for create, add, or remove"),
	"reason?": type("string").describe("Why to keep a singleton group longer"),
	"replyTo?": type("string").describe("Message ID for a direct reply"),
	"progress?": type("boolean").describe("Direct message is an interim progress note, not an answer"),
});

type IrcParams = typeof ircSchema.infer;

interface IrcDetails {
	op: IrcParams["op"];
	receipts?: IrcDeliveryReceipt[];
}

export class IrcTool implements AgentTool<typeof ircSchema, IrcDetails> {
	readonly name = "irc";
	readonly label = "IRC";
	readonly summary = "Message agents or manage named IRC groups";
	readonly parameters = ircSchema;
	readonly approval = "read";
	readonly loadMode = "essential";
	readonly concurrency = "exclusive";

	constructor(
		private readonly session: Pick<ToolSession, "cwd" | "agentRegistry" | "getAgentId" | "getSessionFile">,
	) {}

	get description(): string {
		return renderPromptAsset("tools/irc.md", ircDescription, {}, { cwd: this.session.cwd });
	}

	async execute(_toolCallId: string, params: IrcParams): Promise<AgentToolResult<IrcDetails>> {
		const { op, group, members, message, to, reason, replyTo, progress } = params;
		const result = (text: string, isError = false, receipts?: IrcDeliveryReceipt[]): AgentToolResult<IrcDetails> => ({
			content: [{ type: "text", text }],
			details: { op, receipts },
			isError,
		});
		const registry = this.session.agentRegistry;
		const senderId = this.session.getAgentId?.();
		if (!registry || !senderId) return result("IRC is unavailable in this session.", true);

		let request: IrcGroupRequest;
		switch (op) {
			case "send": {
				if (!message?.trim()) return result("A non-empty message is required.", true);
				if ((group === undefined) === (to === undefined))
					return result("Specify either to or group, not both.", true);
				if (group !== undefined || to === "all") {
					if (replyTo !== undefined || progress !== undefined)
						return result("replyTo and progress apply only to direct messages.", true);
					request = { op, group: group ?? IRC_EVERYONE, message };
					break;
				}
				const targets = new Set((typeof to === "string" ? [to] : (to ?? [])).map(id => id.trim()));
				if (!targets.size || targets.has("") || targets.has("all"))
					return result("Use non-empty peer IDs for direct sends, or broadcast to everyone.", true);
				const deps = { registry, senderId, sessionFileHint: this.session.getSessionFile() };
				const sends = await Promise.all(
					[...targets].map(id => executeSend(deps, { to: id, message, replyTo, progress })),
				);
				return {
					content: sends.flatMap(send => send.content),
					details: { op, receipts: sends.flatMap(send => send.details?.receipts ?? []) },
					isError: sends.every(send => send.isError === true),
				};
			}
			case "broadcast":
				if (!message?.trim()) return result("A non-empty message is required.", true);
				request = { op: "send", group: IRC_EVERYONE, message };
				break;
			case "create":
			case "add":
			case "remove":
				if (!group?.trim() || !members?.length)
					return result(`Specify a group and one or more members for ${op}.`, true);
				request = { op, group, members };
				break;
			case "leave":
			case "members":
				if (!group?.trim()) return result(`Specify a group for ${op}.`, true);
				request = { op, group };
				break;
			case "keep":
				if (!group?.trim() || !reason?.trim()) return result("Specify a group and a reason to keep it.", true);
				request = { op, group, reason };
				break;
			case "groups":
			case "my_groups":
				request = { op };
				break;
		}
		const response = await IrcBus.global().group(senderId, request);
		return result(response.text, response.isError, response.receipts);
	}
}
