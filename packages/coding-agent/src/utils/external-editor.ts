/**
 * Utilities for launching an external text editor ($VISUAL / $EDITOR).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { stripVTControlCharacters } from "node:util";
import * as path from "node:path";
import { $env, $which, Snowflake } from "@oh-my-pi/pi-utils";
import { normalizeStreamRow } from "../stream/paint-encoder";

const MESSAGE_DELIMITER = "\n-->\n<!-- omp:message starts here -->\n";

/** Snapshot only the rows painted on the operator's screen, not unrendered session/tool payloads. */
export function formatExternalEditorDraft(visibleRows: readonly string[], message: string): string {
	const context = visibleRows
		.map(row => stripVTControlCharacters(normalizeStreamRow(row)).replaceAll("-->", "--&gt;"))
		.join("\n");
	return `<!-- omp:context\n${context}${MESSAGE_DELIMITER}${message}`;
}

/** A removed delimiter cannot safely become a user message containing the reference transcript. */
export function extractExternalEditorMessage(content: string): string | null {
	const marker = content.indexOf(MESSAGE_DELIMITER);
	return marker < 0 ? null : content.slice(marker + MESSAGE_DELIMITER.length);
}

/**
 * Returns the user's preferred editor command, or a platform default.
 *
 * Resolution order:
 *   1. `$VISUAL`
 *   2. `$EDITOR`
 *   3. `notepad` on Windows (always present in `%SystemRoot%\System32`)
 *
 * POSIX returns `undefined` when neither variable is set so the caller can
 * surface a warning that nudges the user to configure one.
 */
export function getEditorCommand(env: Readonly<Record<string, string | undefined>> = $env): string | undefined {
	const configured = env.VISUAL?.trim() || env.EDITOR?.trim();
	if (configured) return configured;
	if (process.platform === "win32") return "notepad";
	return undefined;
}

/**
 * Names the editor {@link getEditorCommand} launches for UI labels ("Edit in
 * Notepad", "Edit in nvim"): the command's program without its directory,
 * quotes or Windows executable extension. `undefined` when none is resolved.
 */
export function getEditorName(command = getEditorCommand()): string | undefined {
	if (!command) return undefined;
	const quote = command[0] === '"' || command[0] === "'" ? command[0] : undefined;
	const program = quote ? command.slice(1).split(quote)[0] : command.split(/\s+/)[0];
	const name = path.win32
		.basename(program ?? "")
		.replace(/\.(exe|cmd|bat|com)$/i, "")
		.trim();
	if (!name) return undefined;
	return name.toLowerCase() === "notepad" ? "Notepad" : name;
}

export interface OpenInEditorOptions {
	/** File extension for the temp file (default: ".md"). */
	extension?: string;
	/** Keep the file's trailing newline instead of trimming it from the returned text. */
	trimTrailingNewline?: boolean;
	/** Owning session's environment, including removed variables. */
	env?: Record<string, string>;
}

/** Subprocess argv and Windows quoting mode used to launch an external editor. */
export interface EditorSpawnCommand {
	cmd: string[];
	windowsVerbatimArguments: boolean;
}

/** Resolves shell argv without letting the host runtime re-quote the editor command. */
export function resolveEditorSpawnCommand(
	editorCmd: string,
	tmpFile: string,
	platform: NodeJS.Platform = process.platform,
): EditorSpawnCommand {
	const windows = platform === "win32";
	// cmd.exe strips the outer /s /c quote pair; Bun must pass the embedded
	// editor/path quotes verbatim instead of applying argv escaping to them.
	const cmd = windows
		? ["cmd.exe", "/d", "/s", "/c", `"${editorCmd} "${tmpFile}""`]
		: [$which("sh") ?? "sh", "-c", `${editorCmd} "$1"`, "sh", tmpFile];
	return { cmd, windowsVerbatimArguments: windows };
}

/**
 * Opens `content` in the user's external editor and returns the edited text.
 * Returns `null` if the editor exits with a non-zero code.
 *
 * The caller is responsible for stopping/starting the TUI around this call.
 */
export async function openInEditor(
	editorCmd: string,
	content: string,
	options?: OpenInEditorOptions,
): Promise<string | null> {
	const ext = options?.extension ?? ".md";
	const tmpFile = path.join(os.tmpdir(), `omp-editor-${Snowflake.next()}${ext}`);

	try {
		await Bun.write(tmpFile, content);
		const exitCode = await openEditorOnPath(editorCmd, tmpFile, options?.env);
		if (exitCode === 0) {
			const text = await Bun.file(tmpFile).text();
			if (options?.trimTrailingNewline === false) {
				return text;
			}
			return text.replace(/\n$/, "");
		}
		return null;
	} finally {
		try {
			await fs.rm(tmpFile, { force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}

/**
 * Opens an existing file in the user's editor, which writes it in place, and
 * returns the editor's exit code. The file may have been saved even when the
 * code is non-zero, so callers that care re-read it.
 *
 * The caller is responsible for stopping/starting the TUI around this call.
 */
export async function openEditorOnPath(
	editorCmd: string,
	filePath: string,
	env?: Record<string, string>,
): Promise<number> {
	const spawnCommand = resolveEditorSpawnCommand(editorCmd, filePath);
	// Inherit the real pane pty so terminal editors (including emacsclient,
	// which resolves the device via ttyname) render into the visible pane.
	const child = Bun.spawn(spawnCommand.cmd, {
		env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		windowsVerbatimArguments: spawnCommand.windowsVerbatimArguments,
	});
	return child.exited;
}

export interface ExternalEditorHost {
	ui: {
		stop(): void;
		start(): void;
		requestRender(force?: boolean): void;
	};
	showWarning(message: string): void;
}

/** Shared composer/config editor lifecycle, including restoration after launch failures. */
export async function withExternalEditor(
	host: ExternalEditorHost,
	edit: (command: string) => Promise<void>,
	env?: Record<string, string>,
): Promise<void> {
	const command = getEditorCommand(env);
	if (!command) {
		host.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
		return;
	}
	try {
		host.ui.stop();
		await edit(command);
	} catch (error) {
		host.showWarning(`Failed to open external editor: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		host.ui.start();
		host.ui.requestRender(true);
	}
}
