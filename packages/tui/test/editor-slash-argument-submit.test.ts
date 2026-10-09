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
					description: "Pick things",
					allowArgs: true,
					getArgumentCompletions(prefix: string) {
						if (prefix.startsWith("set ")) {
							return [{ value: "set alpha", label: "alpha", submitsCommand: true }];
						}
						return [
							{ value: "run ", label: "run", submitsCommand: true },
							{ value: "set ", label: "set", hint: "<name>" },
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
});
