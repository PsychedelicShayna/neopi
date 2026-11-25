import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import { IrcMessageBlock } from "../chat/irc-message";
import { sanitizeDisplaySingleLine } from "../overlays/extensions/display-text";
import { replaceTabs } from "../render/render-utils";
import { Container } from "../tui";
import { truncateToWidth } from "../utils";
import {
	type DefaultToolRenderInput,
	describeDefaultToolExecution,
	renderDefaultToolExecution,
} from "./default-renderer";
import type { IrcDeliveryReceipt, IrcOutgoingTranscript } from "./irc";
import type { RenderResultOptions, ToolRenderer, ToolRenderResult } from "./renderer";

interface IrcResultDetails {
	outgoing?: IrcOutgoingTranscript;
	receipts?: IrcDeliveryReceipt[];
}

function outgoingMessage(args: unknown, result: ToolRenderResult<IrcResultDetails>): IrcMessageBlock | undefined {
	const route = result.details?.outgoing;
	if (!route || result.isError || !isRecord(args) || typeof args.message !== "string") return undefined;
	return new IrcMessageBlock({
		kind: "outgoing",
		from: route.from,
		to: route.group ? undefined : route.to,
		group: route.group,
		sentToGroup: route.group !== undefined,
		timestamp: route.timestamp,
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

function failedDeliveryNote(details: IrcResultDetails | undefined): string | undefined {
	const failed = details?.receipts?.filter(receipt => receipt.outcome === "failed");
	if (!failed?.length) return undefined;
	return `Not delivered to: ${failed.map(receipt => sanitizeDisplaySingleLine(receipt.to)).join(", ")}`;
}

/** The completed tool call owns the outgoing message, on both live render and replay. */
export const ircToolRenderer: ToolRenderer<unknown, IrcResultDetails> = {
	mergeCallAndResult: true,
	renderCall(args, options, theme) {
		return renderDefaultToolExecution({ label: "IRC", args, options }, theme);
	},
	renderResult(result, options, theme, args) {
		const message = outgoingMessage(args, result);
		if (!message) return renderDefaultToolExecution(receiptInput(args, options, result), theme);
		const note = failedDeliveryNote(result.details);
		if (!note) return message;
		const output = new Container();
		output.addChild(message);
		output.addChild({ render: width => [truncateToWidth(theme.fg("warning", note), width)], invalidate() {} });
		return output;
	},
	describeCall(args, options) {
		return describeDefaultToolExecution({ label: "IRC", args, options });
	},
	describeResult(result, options, args) {
		const message = outgoingMessage(args, result);
		if (!message) return describeDefaultToolExecution(receiptInput(args, options, result));
		const note = failedDeliveryNote(result.details);
		return {
			head: note ? `IRC · ${note}` : "IRC delivered",
			body: [message.describe()],
			inline: true,
			open: true,
			preview: "none",
		};
	},
};
