import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import { IrcMessageBlock } from "../chat/irc-message";
import { replaceTabs } from "../render/render-utils";
import { Container } from "../tui";
import {
	type DefaultToolRenderInput,
	describeDefaultToolExecution,
	renderDefaultToolExecution,
} from "./default-renderer";
import type { IrcOutgoingTranscript } from "./irc";
import type { RenderResultOptions, ToolRenderer, ToolRenderResult } from "./renderer";

interface IrcResultDetails {
	outgoing?: IrcOutgoingTranscript;
}

function outgoingMessage(args: unknown, result: ToolRenderResult<IrcResultDetails>): IrcMessageBlock | undefined {
	const route = result.details?.outgoing;
	if (!route || result.isError || !isRecord(args) || typeof args.message !== "string") return undefined;
	return new IrcMessageBlock({
		kind: "outgoing",
		from: route.from,
		to: route.to.join(", "),
		body: args.message,
		replyTo: typeof args.replyTo === "string" ? args.replyTo.trim() : undefined,
		progress: args.progress === true,
	});
}

function receiptInput(
	args: unknown,
	options: RenderResultOptions,
	result: ToolRenderResult<IrcResultDetails>,
): DefaultToolRenderInput {
	return {
		label: "IRC",
		args,
		options,
		result: {
			output: result.content
				.map(block => (block.type === "text" ? replaceTabs(sanitizeText(block.text ?? "")) : ""))
				.filter(Boolean)
				.join("\n"),
			isError: result.isError,
		},
	};
}

/** The completed tool call owns the outgoing message, on both live render and replay. */
export const ircToolRenderer: ToolRenderer<unknown, IrcResultDetails> = {
	mergeCallAndResult: true,
	renderCall(args, options, theme) {
		return renderDefaultToolExecution({ label: "IRC", args, options }, theme);
	},
	renderResult(result, options, theme, args) {
		const message = outgoingMessage(args, result);
		const receipt = renderDefaultToolExecution(receiptInput(message ? undefined : args, options, result), theme);
		if (!message) return receipt;
		const output = new Container();
		output.addChild(message);
		output.addChild(receipt);
		return output;
	},
	describeCall(args, options) {
		return describeDefaultToolExecution({ label: "IRC", args, options });
	},
	describeResult(result, options, args) {
		const message = outgoingMessage(args, result);
		const receipt = describeDefaultToolExecution(receiptInput(message ? undefined : args, options, result));
		if (!message) return receipt;
		return { ...receipt, body: [message.describe(), ...(receipt.body ?? [])], open: true, preview: "none" };
	},
};
