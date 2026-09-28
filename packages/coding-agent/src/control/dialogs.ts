/**
 * Dialogs currently mounted in a session (issue #171).
 *
 * The TUI registers a dialog while it is on screen. `dialog_answer` settles it
 * through the same function a keystroke would, so the human and a control
 * connection race at the settle call: the first one wins, the second sees
 * `dialog_settled`.
 */
import type { DialogFamily, DialogSummary } from "./types";

export interface OpenDialog {
	dialogId: string;
	family: DialogFamily;
	kind: string;
	title: string;
	openedBy: DialogSummary["openedBy"];
	schema?: unknown;
	openedAt: number;
	/** Apply an answer. Return false if this dialog cannot accept that shape. */
	answer: (value: unknown) => boolean;
	cancel: () => void;
}

export class DialogRegistry {
	readonly #open = new Map<string, OpenDialog>();
	#seq = 0;
	#revision = 0;
	readonly #listeners = new Set<() => void>();

	get revision(): number {
		return this.#revision;
	}

	list(): DialogSummary[] {
		return [...this.#open.values()].map(dialog => ({
			dialogId: dialog.dialogId,
			family: dialog.family,
			kind: dialog.kind,
			title: dialog.title,
			answerable: true,
			openedBy: dialog.openedBy,
			schema: dialog.schema,
			openedAt: dialog.openedAt,
		}));
	}

	open(dialog: Omit<OpenDialog, "dialogId" | "openedAt"> & { dialogId?: string }): OpenDialog {
		const opened: OpenDialog = {
			...dialog,
			dialogId: dialog.dialogId ?? `d${++this.#seq}`,
			openedAt: this.#revision,
		};
		this.#open.set(opened.dialogId, opened);
		this.#revision++;
		this.#emit();
		return opened;
	}

	close(dialogId: string): void {
		if (!this.#open.delete(dialogId)) return;
		this.#revision++;
		this.#emit();
	}

	/** First settle wins. A late answer returns undefined. */
	answer(dialogId: string, value: unknown): { settled: boolean; error?: string } {
		const dialog = this.#open.get(dialogId);
		if (!dialog) return { settled: false, error: "dialog is not open" };
		const accepted = value === null || value === undefined ? false : dialog.answer(value);
		if (!accepted && value !== null) return { settled: false, error: "dialog rejected that answer" };
		if (value === null) dialog.cancel();
		this.close(dialogId);
		return { settled: true };
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(): void {
		for (const listener of this.#listeners) listener();
	}
}

let current: DialogRegistry | undefined;

/** The registry for the interactive session in this process, if one is attached. */
export function dialogRegistry(): DialogRegistry | undefined {
	return current;
}

export function setDialogRegistry(registry: DialogRegistry | undefined): void {
	current = registry;
}
