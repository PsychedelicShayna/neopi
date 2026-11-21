import { IrcBus } from "../../irc/bus";
import { IRC_EVERYONE, type IrcGroupRequest } from "../../irc/groups";
import type { ParsedSlashCommand, TuiSlashCommandRuntime } from "../types";
import { clearSubmittedText } from "./draft";
import { parseSubcommand } from "./parse";

const IRC_USAGE =
	"Usage: /irc [<peer>[,<peer>...]|#<group>|all <message>] or /irc group <list|mine|members|create|add|remove|leave|keep> …";
const IRC_GROUP_USAGE =
	"Usage: /irc group list|mine, members|leave <group>, create|add|remove <group> <peer>…, or keep <group> <reason>";

function parseGroupCommand(input: string): IrcGroupRequest | undefined {
	const { verb, rest } = parseSubcommand(input);
	if (verb === "list" || verb === "mine") return rest ? undefined : { op: verb === "list" ? "groups" : "my_groups" };
	const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(rest);
	if (!match) return undefined;
	const group = match[1]!;
	const tail = match[2];
	switch (verb) {
		case "members":
		case "leave":
			return tail ? undefined : { op: verb, group };
		case "create":
		case "add":
		case "remove":
			return tail ? { op: verb, group, members: tail.split(/\s+/) } : undefined;
		case "keep":
			return tail ? { op: "keep", group, reason: tail } : undefined;
	}
}

export async function handleIrcCommand(command: ParsedSlashCommand, runtime: TuiSlashCommandRuntime): Promise<void> {
	const args = command.args.trim();
	const { ctx } = runtime;
	clearSubmittedText(runtime);
	if (!args) {
		ctx.showIrcViewer();
		return;
	}
	const split = args.search(/\s/);
	if (split < 0) {
		ctx.showStatus(IRC_USAGE);
		return;
	}
	const target = args.slice(0, split);
	const body = args.slice(split + 1).trim();
	if (target === "group" || target === "all" || target.startsWith("#")) {
		const request =
			target === "group"
				? parseGroupCommand(body)
				: { op: "send" as const, group: target === "all" ? IRC_EVERYONE : target.slice(1), message: body };
		if (!request) {
			ctx.showWarning(IRC_GROUP_USAGE);
			return;
		}
		if (!ctx.ircOperatorId) {
			ctx.showWarning("You are not an IRC participant in this session.");
			return;
		}
		const result = await IrcBus.global().group(ctx.ircOperatorId, request);
		if (result.isError) ctx.showWarning(result.text);
		else ctx.showStatus(result.text);
		return;
	}
	const peers = new Set(target.split(","));
	if (peers.has("all") || peers.has("")) {
		ctx.showWarning(IRC_USAGE);
		return;
	}
	const results = await Promise.all([...peers].map(peer => ctx.sendAsIrcOperator(peer, body)));
	for (const result of results) {
		if (result.isError) ctx.showWarning(result.text);
		else ctx.showStatus(result.text);
	}
}
