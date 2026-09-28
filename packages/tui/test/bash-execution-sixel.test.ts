import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { sanitizeWithOptionalSixelPassthrough } from "@oh-my-pi/pi-tui/render/sixel";
import { formatOutputPaneLines } from "@oh-my-pi/pi-tui/render/output-pane";
import { setInlineImagePresentation } from "@oh-my-pi/pi-tui/components/image";
import { ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import type { TUI } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";

const SIXEL = "\x1bPqabc\x1b\\";
let darkTheme: Theme;

beforeAll(async () => {
	const loaded = await getThemeByName("dark");
	expect(loaded).toBeDefined();
	darkTheme = loaded!;
});

describe("BashExecutionComponent SIXEL sanitization", () => {
	const originalForceProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	const originalAllowPassthrough = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

	beforeEach(() => {
		setThemeInstance(darkTheme);
	});
	afterEach(() => {
		if (originalForceProtocol === undefined) delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		else Bun.env.PI_FORCE_IMAGE_PROTOCOL = originalForceProtocol;
		if (originalAllowPassthrough === undefined) delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
		else Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = originalAllowPassthrough;
	});

	it("preserves SIXEL output when passthrough gates are enabled", () => {
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";

		const component = new BashExecutionComponent("echo sixel", ui, false);
		component.appendOutput(SIXEL);
		component.setComplete(0, false);

		expect(component.getOutput()).toContain(SIXEL);
	});

	it("does not truncate long SIXEL payload lines", () => {
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";

		const payload = `\x1bPq${"A".repeat(5000)}\x1b\\`;
		const component = new BashExecutionComponent("echo sixel", ui, false);
		component.appendOutput(payload);
		component.setComplete(0, false);

		const output = component.getOutput();
		expect(output).toContain("\x1bPq");
		expect(output).toContain("\x1b\\");
		expect(output).not.toContain("visible columns omitted");
	});

	it("keeps wide continuation rows of a payload split across streamed chunks", () => {
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
		vi.useFakeTimers();
		try {
			const wide = `#1${"~".repeat(5000)}-`;
			// The start row arrives in one chunk, the wide row in the next.
			const split = new BashExecutionComponent("printf sixel", ui, false);
			split.appendOutput("\x1bPq#0;2;0;0;0\n");
			vi.advanceTimersByTime(60);
			split.appendOutput(`${wide}\n#0????\x1b\\`);
			expect(split.getOutput()).toContain(wide);

			// Same after the streaming cap has dropped the start row.
			const capped = new BashExecutionComponent("printf sixel", ui, false);
			capped.appendOutput(`\x1bPq#0;2;0;0;0\n${Array.from({ length: 120 }, () => "#1~~~~-").join("\n")}\n`);
			vi.advanceTimersByTime(60);
			capped.appendOutput(`${wide}\n#0????\x1b\\`);
			expect(capped.getOutput()).not.toContain("\x1bPq");
			expect(capped.getOutput()).toContain(wide);
		} finally {
			vi.useRealTimers();
		}
	});

	it("still truncates long non-SIXEL lines", () => {
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";

		const longText = "x".repeat(5000);
		const component = new BashExecutionComponent("echo text", ui, false);
		component.appendOutput(longText);
		component.setComplete(0, false);

		const output = component.getOutput();
		expect(output).toContain("visible columns omitted");
		expect(output).not.toContain("\x1bPq");
	});

	it("strips SIXEL control escapes when passthrough gates are disabled", () => {
		delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
		delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;

		// appendOutput receives pre-sanitized chunks from OutputSink.
		// Simulate that: sanitize before passing to the component.
		const sanitized = sanitizeWithOptionalSixelPassthrough(SIXEL, sanitizeText);
		const component = new BashExecutionComponent("test sixel", ui, false);
		component.appendOutput(sanitized);
		component.setComplete(0, false);

		expect(component.getOutput()).not.toContain("\x1bPq");
		expect(component.getOutput()).toBe("");
	});
});

describe("BashExecutionComponent streaming throttle", () => {
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

	beforeEach(() => {
		setThemeInstance(darkTheme);
	});

	it("caps stored lines during streaming", () => {
		const component = new BashExecutionComponent("test", ui, false);

		// Flood with 500 lines in one chunk (exceeds STREAMING_LINE_CAP of 100)
		const lines = Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n");
		component.appendOutput(lines);

		// Internal lines should be capped (we can't read #outputLines directly,
		// but getOutput() returns the joined lines — it should have at most ~100 lines)
		const output = component.getOutput();
		const outputLineCount = output.split("\n").length;
		expect(outputLineCount).toBeLessThanOrEqual(101); // 100 cap + possible partial
		// Should retain the tail, not the head
		expect(output).toContain("line499");
		expect(output).not.toContain("line0\n");
	});

	it("gate drops rapid chunks", () => {
		vi.useFakeTimers();
		try {
			const component = new BashExecutionComponent("test", ui, false);

			// Send 100 chunks rapidly (all in same tick, before the gate fires).
			for (let i = 0; i < 100; i++) {
				component.appendOutput(`chunk${i}\n`);
			}

			const output = component.getOutput();
			expect(output).toContain("chunk0");
			expect(output).not.toContain("chunk99");

			vi.advanceTimersByTime(50);
			component.appendOutput("after_gate\n");
			expect(component.getOutput()).toContain("after_gate");
		} finally {
			vi.useRealTimers();
		}
	});

	it("setComplete replaces streaming output with final output", () => {
		const component = new BashExecutionComponent("test", ui, false);

		// Stream some partial output
		component.appendOutput("streaming_line\n");

		// Complete with different final output
		component.setComplete(0, false, { output: "final_line_1\nfinal_line_2" });

		const output = component.getOutput();
		expect(output).toContain("final_line_1");
		expect(output).toContain("final_line_2");
		// Streaming output is replaced, not appended
		expect(output).not.toContain("streaming_line");
	});
});

describe("BashExecutionComponent expand footer", () => {
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

	beforeEach(() => {
		setThemeInstance(darkTheme);
	});

	// PREVIEW_LINES is 20: 27 lines leaves 7 hidden in the collapsed preview.
	const makeComponent = () => {
		const component = new BashExecutionComponent("ls", ui, false);
		const lines = Array.from({ length: 27 }, (_, i) => `entry${i}`);
		component.setComplete(0, false, { output: lines.join("\n") });
		return component;
	};

	it("advertises hidden lines while collapsed", () => {
		const rendered = makeComponent().render(120).join("\n");
		expect(rendered).toContain("more lines");
		expect(rendered).toContain("ctrl+o to expand");
	});

	it("drops the hidden-lines footer once expanded", () => {
		const component = makeComponent();
		component.setExpanded(true);
		const rendered = component.render(120).join("\n");
		expect(rendered).not.toContain("more lines");
		expect(rendered).not.toContain("ctrl+o to expand");
		// Every line is now present, including the previously hidden prefix.
		expect(rendered).toContain("entry0");
		expect(rendered).toContain("entry26");
	});

	it("restores the footer when collapsed again", () => {
		const component = makeComponent();
		component.setExpanded(true);
		component.setExpanded(false);
		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("more lines");
		expect(rendered).toContain("ctrl+o to expand");
	});
});

describe("formatOutputPaneLines SIXEL presentation", () => {
	const terminal = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
	const originalProtocol = TERMINAL.imageProtocol;

	beforeEach(() => {
		setThemeInstance(darkTheme);
		terminal.imageProtocol = ImageProtocol.Sixel;
	});
	afterEach(() => {
		terminal.imageProtocol = originalProtocol;
		setInlineImagePresentation("graphics");
	});

	// libsixel splits one payload across rows; only the first carries the start marker.
	const payload = ["\x1bPq#0;2;0;0;0", "#1~~~~-", "#1@@@@-", "#0????\x1b\\"];
	const lines = [...payload, "between", ...payload];
	const format = () =>
		formatOutputPaneLines(
			{ lines, expanded: true, collapsedMaxLines: 100, styleLine: line => `<${line}>` },
			darkTheme,
		);

	it("keeps the omitted-image label of a payload taller than the collapsed preview", () => {
		Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
		Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
		try {
			// A 40-row payload in a collapsed bash pane (tail preview, 20 rows).
			const rows = ["\x1bPq#0;2;0;0;0", ...Array.from({ length: 38 }, () => "#1~~~~-"), "#0????\x1b\\"];
			const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;
			const block = new BashExecutionComponent("printf big-sixel", ui, false);
			block.appendOutput(rows.join("\n"));
			block.setComplete(0, false);
			setInlineImagePresentation("text");
			block.invalidate();
			const docked = block.render(80).map(line => Bun.stripANSI(line));
			expect(docked.some(line => line.includes("[image omitted while docked]"))).toBe(true);
			expect(docked.join("\n")).not.toContain("~~~~");
		} finally {
			delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
			delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
		}
	});

	it("replaces only the SIXEL bytes, labelling every span", () => {
		setInlineImagePresentation("text");
		const one = "\x1bPq#1~~~~-\x1b\\";
		const result = formatOutputPaneLines(
			{
				lines: [
					// Output around an inline payload survives.
					`before${one}after`,
					// Two payloads on consecutive lines: each gets its own label.
					one,
					one,
					// A multi-line payload whose last row continues with ordinary text.
					"\x1bPq#0;2;0;0;0",
					"#1~~~~-",
					"#0????\x1b\\tail",
				],
				expanded: true,
				collapsedMaxLines: 100,
			},
			darkTheme,
		);
		const plain = result.lines.map(line => Bun.stripANSI(line));
		expect(plain).toEqual([
			"before[image omitted while docked]after",
			"[image omitted while docked]",
			"[image omitted while docked]",
			"[image omitted while docked]",
			"",
			"tail",
		]);
	});

	it("labels a continued payload whose first retained row is blank", () => {
		setInlineImagePresentation("text");
		const label = "[image omitted while docked]";
		const format = (lines: string[]) =>
			formatOutputPaneLines(
				{ lines, expanded: true, collapsedMaxLines: 100, sixelContinuation: true },
				darkTheme,
			).lines.map(line => Bun.stripANSI(line));
		// The retention cut landed on a blank payload row: the label still leads.
		expect(format(["", "#1~~~~-", "#0????\x1b\\", "after"])).toEqual([label, "", "", "after"]);
		// Every retained row is a blank continuation row: the label still appears.
		expect(format(["", ""])).toEqual([label, ""]);
	});

	it("passes raw payload rows through as graphics", () => {
		const result = format();
		expect(result.hasSixel).toBe(true);
		expect(result.lines).toEqual([...payload, "<between>", ...payload]);
	});

	it("replaces every payload row with a label and blanks while images are text", () => {
		setInlineImagePresentation("text");
		const result = format();
		expect(result.hasSixel).toBe(false);
		expect(result.lines).toHaveLength(lines.length);
		const plain = result.lines.map(line => Bun.stripANSI(line));
		// Each span is label + 3 blanks; the row between two payloads is untouched.
		expect(plain.slice(0, 4)).toEqual(["<[image omitted while docked]>", "<>", "<>", "<>"]);
		expect(plain[4]).toBe("<between>");
		expect(plain.slice(5)).toEqual(["<[image omitted while docked]>", "<>", "<>", "<>"]);
		expect(result.lines.join("")).not.toContain("\x1bP");
		expect(result.lines.join("")).not.toContain("~~~~");
	});
});
