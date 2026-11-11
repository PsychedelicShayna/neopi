import { Box } from "../components/box";
import { Text } from "../components/text";
import { card, span, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import { plainText } from "../native/spans";
import type { Theme } from "../theme";
import { colorToAnsi } from "../theme/color";
import type { ChroniclerMessageDetails, CustomMessage } from "./messages";
import { textContent } from "./transcript-entry";

/** A separate voice with a blue outline, independent of the session accent. */
export class ChroniclerMessageCard extends Box {
	readonly #native: NativeNode;

	constructor(message: CustomMessage<ChroniclerMessageDetails>, uiTheme: Theme) {
		super(1, 0, undefined, {
			chars: uiTheme.boxRound,
			color: value =>
				`${colorToAnsi(uiTheme.isLight ? "#2563eb" : "#60a5fa", uiTheme.getColorMode())}${value}\x1b[39m`,
		});
		const note = plainText(message.details?.note ?? textContent(message.content, "\n"));
		this.setIgnoreTight(true);
		this.addChild(new Text("Chronicler Luna", 0, 0).setStyleFn(value => uiTheme.bold(value)));
		this.addChild(new Text(note, 0, 0).setStyleFn(value => uiTheme.fg("customMessageText", value)));
		this.#native = card({ role: "omp.chronicler", tone: "info", head: [span("Chronicler Luna", "strong")] }, [
			text(note, { wrap: "word", role: "omp.chronicler.note" }),
		]);
	}

	override describe(): NativeNode {
		return this.#native;
	}
}
