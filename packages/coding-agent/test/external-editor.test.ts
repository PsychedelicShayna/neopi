import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { InputController } from "../src/modes/controllers/input-controller";
import type { InteractiveModeContext } from "../src/modes/types";
import {
	extractExternalEditorMessage,
	formatExternalEditorDraft,
	getEditorCommand,
	openInEditor,
	resolveEditorSpawnCommand,
} from "../src/utils/external-editor";

interface MutableProcess {
	platform: NodeJS.Platform;
}

function setPlatform(value: NodeJS.Platform): void {
	(process as unknown as MutableProcess).platform = value;
}

describe("getEditorCommand", () => {
	const originalPlatform = process.platform;
	const originalVisual = Bun.env.VISUAL;
	const originalEditor = Bun.env.EDITOR;

	afterEach(() => {
		setPlatform(originalPlatform);
		if (originalVisual === undefined) delete Bun.env.VISUAL;
		else Bun.env.VISUAL = originalVisual;
		if (originalEditor === undefined) delete Bun.env.EDITOR;
		else Bun.env.EDITOR = originalEditor;
	});

	it("prefers $VISUAL over $EDITOR and the platform default", () => {
		Bun.env.VISUAL = "nvim";
		Bun.env.EDITOR = "nano";
		setPlatform("win32");
		expect(getEditorCommand()).toBe("nvim");
	});

	it("falls back to $EDITOR when $VISUAL is unset", () => {
		delete Bun.env.VISUAL;
		Bun.env.EDITOR = "nano";
		expect(getEditorCommand()).toBe("nano");
	});

	it("trims whitespace so an accidentally padded value still works", () => {
		Bun.env.VISUAL = "  code --wait  ";
		delete Bun.env.EDITOR;
		expect(getEditorCommand()).toBe("code --wait");
	});

	it("treats a whitespace-only $VISUAL as unset and consults $EDITOR", () => {
		Bun.env.VISUAL = "   ";
		Bun.env.EDITOR = "vim";
		expect(getEditorCommand()).toBe("vim");
	});

	it("defaults to notepad on Windows when neither variable is set", () => {
		delete Bun.env.VISUAL;
		delete Bun.env.EDITOR;
		setPlatform("win32");
		expect(getEditorCommand()).toBe("notepad");
	});

	it("returns undefined on POSIX when neither variable is set", () => {
		delete Bun.env.VISUAL;
		delete Bun.env.EDITOR;
		setPlatform("linux");
		expect(getEditorCommand()).toBeUndefined();
	});
});

describe("openInEditor", () => {
	it("always inherits the pane stdio", async () => {
		const spawn = spyOn(Bun, "spawn").mockReturnValue({
			exited: Promise.resolve(1),
		} as never);
		try {
			await openInEditor("editor", "original", {
				extension: ".md",
				stdio: [0, 1, 2],
			} as never);

			expect(spawn).toHaveBeenCalledTimes(1);
			expect(spawn.mock.calls[0]?.[1]).toMatchObject({
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			});
		} finally {
			spawn.mockRestore();
		}
	});

	it("passes the cmd.exe command line verbatim on Windows", () => {
		const tmpFile = String.raw`C:\Users\Example User\AppData\Local\Temp\omp-editor-123.omp.md`;

		expect(resolveEditorSpawnCommand('"C:\\Program Files\\Code.exe" --wait', tmpFile, "win32")).toEqual({
			cmd: [
				"cmd.exe",
				"/d",
				"/s",
				"/c",
				String.raw`""C:\Program Files\Code.exe" --wait "C:\Users\Example User\AppData\Local\Temp\omp-editor-123.omp.md""`,
			],
			windowsVerbatimArguments: true,
		});
	});

	it.skipIf(process.platform === "win32")("supports quoted editor paths containing spaces", async () => {
		const tempDir = TempDir.createSync("@external-editor-");
		try {
			const editorPath = path.join(tempDir.path(), "My Editor", "edit");
			fs.mkdirSync(path.dirname(editorPath), { recursive: true });
			await Bun.write(editorPath, '#!/bin/sh\nprintf "edited" > "$1"\n');
			fs.chmodSync(editorPath, 0o755);

			const result = await openInEditor(`"${editorPath}"`, "original");

			expect(result).toBe("edited");
		} finally {
			await tempDir.remove();
		}
	});

	it.skipIf(process.platform === "win32")("shows only painted rows and returns only the edited message", async () => {
		const tempDir = TempDir.createSync("@external-editor-context-");
		try {
			const editorPath = path.join(tempDir.path(), "edit");
			await Bun.write(editorPath, '#!/bin/sh\nprintf " and added" >> "$1"\n');
			fs.chmodSync(editorPath, 0o755);
			const draft = formatExternalEditorDraft(
				["\x1b[31mQuestion: why?\x1b[0m", "Visible status", "-->\n<!-- omp:message starts here -->"],
				"My answer",
			);
			expect(draft).toContain("Question: why?");
			expect(draft).not.toContain("\x1b");
			const returned = await openInEditor(editorPath, draft, { extension: ".omp.md" });
			expect(returned).not.toBeNull();
			expect(extractExternalEditorMessage(returned!)).toBe("My answer and added");
			expect(extractExternalEditorMessage(draft.replace("<!-- omp:message starts here -->", ""))).toBeNull();
		} finally {
			await tempDir.remove();
		}
	});
});

describe("Ctrl-G external editor", () => {
	it.skipIf(process.platform === "win32")(
		"shows the painted conversation but returns only the edited draft",
		async () => {
			const tempDir = TempDir.createSync("@ctrl-g-context-");
			const oldVisual = Bun.env.VISUAL;
			const oldEditor = Bun.env.EDITOR;
			try {
				const editorPath = path.join(tempDir.path(), "edit");
				const capturePath = path.join(tempDir.path(), "captured");
				await Bun.write(editorPath, `#!/bin/sh\ncp "$1" "${capturePath}"\nprintf " revised" >> "$1"\n`);
				fs.chmodSync(editorPath, 0o755);
				Bun.env.VISUAL = editorPath;
				delete Bun.env.EDITOR;
				const editor = {
					getExpandedText: () => "My response",
					setText: vi.fn(),
				};
				const ui = {
					getVisibleScreenRows: () => ["Visible question", "Running status"],
					stop: vi.fn(),
					start: vi.fn(),
					requestRender: vi.fn(),
				};
				const showWarning = vi.fn();
				const ctx = { editor, ui, showWarning } as unknown as InteractiveModeContext;
				await new InputController(ctx).openExternalEditor();

				const captured = await Bun.file(capturePath).text();
				expect(captured).toContain("Visible question\nRunning status");
				expect(captured).toContain("<!-- omp:message starts here -->\nMy response");
				expect(editor.setText).toHaveBeenCalledWith("My response revised");
				expect(showWarning).not.toHaveBeenCalled();
			} finally {
				if (oldVisual === undefined) delete Bun.env.VISUAL;
				else Bun.env.VISUAL = oldVisual;
				if (oldEditor === undefined) delete Bun.env.EDITOR;
				else Bun.env.EDITOR = oldEditor;
				await tempDir.remove();
			}
		},
	);
});
