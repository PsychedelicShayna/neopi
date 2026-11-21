import { describe, expect, it } from "bun:test";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { defaultEditorTheme } from "./test-themes";

const ENTER = "\r";

/** `/pick` completes `run` (complete on its own) and `set <name>` (needs a name). */
function pickEditor(): { editor: Editor; submitted: string[] } {
	const editor = new Editor(defaultEditorTheme);
	editor.setAutocompleteProvider(
		new CombinedAutocompleteProvider(
			[
				{
					name: "pick",
					aliases: ["pick:"],
					description: "Pick things",
					allowArgs: true,
					getArgumentCompletions(prefix: string) {
						if (prefix.startsWith("set ")) {
							return [{ value: "set alpha", label: "alpha", submitsCommand: true }];
						}
						return [
							{ value: "run ", label: "run", submitsCommand: true },
							{ value: "set ", label: "set", hint: "<name>", submitsCommand: false },
						].filter(item => item.label.startsWith(prefix));
					},
				},
			],
			"/tmp",
		),
	);
	const submitted: string[] = [];
	editor.onSubmit = text => {
		submitted.push(text);
	};
	return { editor, submitted };
}

async function typeAndSettle(editor: Editor, text: string): Promise<void> {
	for (const ch of text) editor.handleInput(ch);
	await Bun.sleep(150);
}

async function waitForAutocomplete(editor: Editor): Promise<void> {
	while (!editor.isShowingAutocomplete()) {
		const update = Promise.withResolvers<void>();
		editor.onAutocompleteUpdate = update.resolve;
		await update.promise;
		editor.onAutocompleteUpdate = undefined;
	}
}

describe("Editor slash-command argument completion on Enter", () => {
	it("runs the command when the accepted completion needs no further argument", async () => {
		const { editor, submitted } = pickEditor();
		await typeAndSettle(editor, "/pick r");
		expect(editor.isShowingAutocomplete()).toBe(true);
		editor.handleInput(ENTER);
		expect(submitted).toEqual(["/pick run"]);
	});

	it("applies a completion that needs an argument and reopens the popup for it", async () => {
		const { editor, submitted } = pickEditor();
		await typeAndSettle(editor, "/pick s");
		editor.handleInput(ENTER);
		await Bun.sleep(150);
		expect(submitted).toEqual([]);
		expect(editor.getText()).toBe("/pick set ");
		expect(editor.isShowingAutocomplete()).toBe(true);
		editor.handleInput(ENTER);
		expect(submitted).toEqual(["/pick set alpha"]);
	});

	it("reopens command argument completion with Tab after Escape and chains to the next slot", async () => {
		const { editor, submitted } = pickEditor();
		for (const char of "/pick ") editor.handleInput(char);
		await waitForAutocomplete(editor);
		editor.handleInput("\u001b");
		expect(editor.isShowingAutocomplete()).toBe(false);

		editor.handleInput("\t");
		await waitForAutocomplete(editor);
		expect(editor.isShowingAutocomplete()).toBe(true);
		editor.handleInput("\u001b[B");
		editor.handleInput("\t");
		expect(editor.getText()).toBe("/pick set ");
		await waitForAutocomplete(editor);
		expect(editor.render(80).join("\n")).toContain("alpha");
		expect(submitted).toEqual([]);
	});

	it("supports an attached argument only for explicit colon aliases", async () => {
		const { editor } = pickEditor();
		for (const char of "/pick:r") editor.handleInput(char);
		await waitForAutocomplete(editor);
		editor.handleInput("\t");
		expect(editor.getText()).toBe("/pick:run ");
	});

	it("does not accept a stale empty-prefix argument after typing a filter", async () => {
		const { editor } = pickEditor();
		for (const char of "/pick ") editor.handleInput(char);
		await waitForAutocomplete(editor);
		editor.handleInput("s");
		editor.handleInput("\t");
		expect(editor.getText()).toBe("/pick s");
	});
});
