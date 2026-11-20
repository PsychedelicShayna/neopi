import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { beforeAll, describe, expect, it, beforeEach, afterEach } from "bun:test";
import { getKeybindings, setKeybindings, type TUI } from "@oh-my-pi/pi-tui";
import { LoginDialogComponent } from "@oh-my-pi/pi-tui/overlays/login-dialog";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { KeybindingsManager } from "../src/app-keybindings";

/** Minimal TUI stub — the dialog only calls requestRender/setFocus. */
function makeDialog(): LoginDialogComponent {
	const tui = { requestRender() {}, setFocus() {} } as unknown as TUI;
	return new LoginDialogComponent(
		tui,
		"openai-codex",
		() => {},
		() => {},
	);
}

describe("LoginDialogComponent manual code input", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("captures a pasted fallback redirect URL and resolves on submit", async () => {
		// Regression for #5339: paste-code providers (Codex) route the fallback
		// URL through the focused dialog. Without a mounted input, the paste is
		// dropped and login never completes.
		const dialog = makeDialog();
		dialog.showProgress("Waiting for callback");

		const pending = dialog.showManualInput("Paste the authorization code:");
		expect(dialog.render(80).join("\n")).toContain("Paste the authorization code");

		const url = "http://localhost:1455/auth/callback?code=THECODE&state=abc";
		dialog.pasteText(url);
		dialog.handleInput("\r");

		expect(await pending).toBe(url);
	});

	it("rejects the pending input when another callback path wins", async () => {
		const dialog = makeDialog();
		const settled = new AbortController();
		const error = new Error("native callback received");
		const pending = dialog.showManualInput("Paste the authorization code:", settled.signal);

		settled.abort(error);

		await expect(pending).rejects.toBe(error);
	});

	it("reuses the mounted input across re-prompts instead of stacking duplicates", async () => {
		// The OAuth callback loop re-invokes onManualCodeInput after an invalid
		// paste; the second prompt must not append a duplicate input/hint block.
		const dialog = makeDialog();
		dialog.showProgress("Waiting for callback");

		const first = dialog.showManualInput("Paste the code:");
		dialog.handleInput("garbage");
		dialog.handleInput("\r");
		expect(await first).toBe("garbage");

		const second = dialog.showManualInput("Paste the code:");
		const rendered = dialog.render(80).join("\n");
		expect(rendered.split("Paste the code:").length - 1).toBe(1);
		// A stale value from the first attempt must not leak into the retry; the field says why it is back.
		expect(rendered).not.toContain("garbage");
		expect(rendered).toContain("Couldn't read a code from that");

		const url = "http://localhost:1455/auth/callback?code=OK&state=abc";
		dialog.pasteText(url);
		dialog.handleInput("\r");
		expect(await second).toBe(url);
	});

	it("keeps printable menu bindings and Kitty text literal until explicit CR or LF", async () => {
		const previous = getKeybindings();
		setKeybindings(
			KeybindingsManager.inMemory({
				"tui.select.cancel": "j",
				"tui.input.submit": "s",
			}),
		);
		try {
			for (const enter of ["\r", "\n"]) {
				const dialog = makeDialog();
				const outcome = dialog.showManualInput("Paste the code:").catch((error: unknown) => error);
				const value = "j/k h l gg G /code s";
				for (const char of value) dialog.handleInput(char);
				dialog.handleInput("\x1b[106u");
				expect(dialog.signal.aborted).toBe(false);
				dialog.handleInput(enter);
				expect(await outcome).toBe(`${value}j`);
			}
		} finally {
			setKeybindings(previous);
		}
	});

	it("retains explicit Escape when the configured cancel binding is printable", async () => {
		const previous = getKeybindings();
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "j" }));
		try {
			const dialog = makeDialog();
			// Capture the settlement: `expect(pending).rejects` spins Bun's loop while the promise is pending.
			const outcome = dialog.showManualInput("Paste the code:").catch((error: unknown) => error);
			dialog.handleInput("j");
			expect(dialog.signal.aborted).toBe(false);
			dialog.handleInput("\x1b");
			expect(await outcome).toBeInstanceOf(Error);
			expect(((await outcome) as Error).message).toContain("Login cancelled");
			expect(dialog.signal.aborted).toBe(true);
		} finally {
			setKeybindings(previous);
		}
	});

	it("keeps typed words in one undo unit", async () => {
		const previous = getKeybindings();
		setKeybindings(KeybindingsManager.inMemory({ "tui.editor.undo": "ctrl+z" }));
		try {
			const dialog = makeDialog();
			const pending = dialog.showManualInput("Paste the code:");
			for (const char of "draft") dialog.handleInput(char);
			dialog.handleInput("\x1a");
			dialog.handleInput("\r");
			expect(await pending).toBe("");
		} finally {
			setKeybindings(previous);
		}
	});

	it("preserves native secret submission and starts the next prompt with fresh undo state", async () => {
		const previous = getKeybindings();
		setKeybindings(
			KeybindingsManager.inMemory({
				"tui.select.cancel": "j",
				"tui.input.submit": "s",
				"tui.editor.undo": "ctrl+z",
			}),
		);
		try {
			const dialog = makeDialog();
			const first = dialog.showPrompt({ message: "Secret:", secret: true }).catch((error: unknown) => error);
			const secret = "j-secret-s";
			for (const char of secret) dialog.handleInput(char);
			expect(dialog.signal.aborted).toBe(false);
			expect(dialog.isSecretPrompt()).toBe(true);
			dialog.handleNativeEvent({ type: "action", key: "actions/submit", act: "submit", mods: [] });
			expect(await first).toBe(secret);

			const second = dialog.showPrompt({ message: "Next code:" });
			expect(dialog.isSecretPrompt()).toBe(false);
			expect(dialog.render(80).join("\n")).not.toContain(secret);
			dialog.handleInput("\x1a");
			dialog.handleInput("\r");
			expect(await second).toBe("");
		} finally {
			setKeybindings(previous);
		}
	});

	it("retains configured nonprintable submit and cancel bindings", async () => {
		const previous = getKeybindings();
		setKeybindings(
			KeybindingsManager.inMemory({
				"tui.select.cancel": "alt+q",
				"tui.input.submit": "alt+s",
			}),
		);
		try {
			const first = makeDialog();
			const submitted = first.showManualInput("Paste the code:");
			first.handleInput("code");
			first.handleInput("\x1bs");
			expect(await submitted).toBe("code");

			const second = makeDialog();
			const cancelled = second.showManualInput("Paste the code:").catch((error: unknown) => error);
			second.handleInput("\x1bq");
			expect(((await cancelled) as Error).message).toContain("Login cancelled");
			expect(second.signal.aborted).toBe(true);
		} finally {
			setKeybindings(previous);
		}
	});

	it("lets the provider callback abort a pending prompt after literal remapped input", async () => {
		const previous = getKeybindings();
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "j" }));
		try {
			const dialog = makeDialog();
			const settled = new AbortController();
			const error = new Error("native callback received");
			const pending = dialog.showManualInput("Paste the code:", settled.signal).catch((reason: unknown) => reason);
			dialog.handleInput("j");
			expect(dialog.signal.aborted).toBe(false);
			settled.abort(error);
			expect(await pending).toBe(error);
			expect(dialog.signal.aborted).toBe(false);
		} finally {
			setKeybindings(previous);
		}
	});
});

let previousVimMode: boolean;
beforeEach(() => {
	previousVimMode = getMenuSearchVimMode();
	setMenuSearchVimMode(true);
});
afterEach(() => {
	setMenuSearchVimMode(previousVimMode);
});
