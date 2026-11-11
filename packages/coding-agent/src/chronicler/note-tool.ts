import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ChroniclerMessageDetails, NormalizedCustomMessagePayload } from "@oh-my-pi/pi-tui/chat/messages";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { escapeXmlText } from "@oh-my-pi/pi-utils";
import { renderPromptAsset, resolvePromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import bundledNoteDescription from "../prompts/chronicler/note-tool.md" with { type: "text" };
import bundledNoteMessage from "../prompts/chronicler/note-message.md" with { type: "text" };
import type { CaptureBatch } from "./store";

const noteSchema = type({
	note: type("string").describe("A concise message from Chronicler Luna to the primary agent."),
});

export const chroniclerNoteDefinition = {
	name: "note",
	get description(): string {
		return resolvePromptAsset("chronicler/note-tool.md", bundledNoteDescription).text;
	},
	parameters: noteSchema,
} as const;

export type NoteParams = typeof noteSchema.infer;
export type ChroniclerNoteEmitter = (
	message: NormalizedCustomMessagePayload<ChroniclerMessageDetails>,
) => boolean | Promise<boolean>;

/** Framing is model-visible; the transcript card displays the unframed details.note. */
export function formatChroniclerNoteContent(note: string): string {
	return renderPromptAsset("chronicler/note-message.md", bundledNoteMessage, { note: escapeXmlText(note) });
}

/** One instance per frozen capture pass; publication is explicitly owned by the caller. */
export class NoteTool implements AgentTool<typeof noteSchema, ChroniclerMessageDetails> {
	readonly name = chroniclerNoteDefinition.name;
	readonly label = "Note";
	readonly parameters = chroniclerNoteDefinition.parameters;
	readonly intent = "omit" as const;
	readonly #notes: string[] = [];
	#nextNote = 0;
	#publishing = false;

	get description(): string {
		return chroniclerNoteDefinition.description;
	}

	constructor(
		private readonly batch: CaptureBatch,
		private readonly emit?: ChroniclerNoteEmitter,
	) {}

	async execute(
		_id: string,
		args: NoteParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<ChroniclerMessageDetails>> {
		if (signal?.aborted || this.batch.revoked) throw new ToolError("This capture pass was revoked.");
		if (this.batch.finalized)
			throw new ToolError("This capture pass is already finalized; no further notes can be staged.");
		const note = args.note.trim();
		if (!note) throw new ToolError("A note needs nonblank text.");
		if (!this.emit) {
			return this.#result("Not delivered or staged: this capture pass has no primary note recipient.", note);
		}
		// Identical acknowledgements may cover different directives; neither text dedupe nor advisor budgets apply.
		this.#notes.push(note);
		return this.#result(
			"Staged for primary delivery after this capture pass is successfully published; not delivered yet.",
			note,
		);
	}

	/** Call only after commitBatch succeeds and the caller rechecks publication ownership.
	 * Delivery failure is separate from capture failure: a committed pass is not retried.
	 * Each callback is attempted once, even if it throws after accepting the message. */
	async publishNotes(): Promise<void> {
		if (this.batch.revoked) throw new ToolError("This capture pass was revoked; its notes cannot be delivered.");
		if (!this.batch.finalized)
			throw new ToolError("Finalize and publish this capture pass before delivering its notes.");
		if (this.#publishing) throw new ToolError("This capture pass is already publishing its notes.");
		if (!this.emit) return;
		this.#publishing = true;
		let failure: Error | undefined;
		try {
			while (this.#nextNote < this.#notes.length) {
				if (this.batch.revoked)
					throw new ToolError("This capture pass was revoked; remaining notes were not delivered.");
				const note = this.#notes[this.#nextNote++]!;
				try {
					const accepted = await this.emit({
						customType: "chronicler",
						attribution: "agent",
						display: true,
						content: formatChroniclerNoteContent(note),
						details: { note },
					});
					if (!accepted) throw new ToolError("The primary did not accept this Chronicler note.");
				} catch (error) {
					failure ??= error instanceof Error ? error : new Error(String(error));
				}
			}
			if (failure) throw failure;
		} finally {
			this.#publishing = false;
		}
	}

	#result(text: string, note: string): AgentToolResult<ChroniclerMessageDetails> {
		return { content: [{ type: "text", text }], details: { note }, useless: true };
	}
}
