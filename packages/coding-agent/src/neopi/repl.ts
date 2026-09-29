/**
 * REPL mode for the interactive composer (`/repl`, `/kernel`).
 *
 * While a kernel is the target, everything typed in the composer is code for
 * that kernel: Enter inserts a newline (in Vim Normal mode it moves down a
 * line), and `app.repl.execute` runs the whole buffer. Targets are the
 * built-in eval kernels (Python, JavaScript), the bash executor, and the main
 * agent (REPL mode off).
 */

export type ReplKernel = "py" | "js" | "bash";
export type ReplTarget = "agent" | ReplKernel;

export const REPL_TARGETS: ReadonlyArray<{ id: ReplTarget; label: string }> = [
	{ id: "agent", label: "Agent" },
	{ id: "js", label: "JavaScript" },
	{ id: "py", label: "Python" },
	{ id: "bash", label: "Bash" },
];

const TARGET_ALIASES: Readonly<Record<string, ReplTarget>> = {
	agent: "agent",
	off: "agent",
	js: "js",
	javascript: "js",
	py: "py",
	python: "py",
	bash: "bash",
	sh: "bash",
	shell: "bash",
};

export function parseReplTarget(token: string): ReplTarget | undefined {
	return TARGET_ALIASES[token.trim().toLowerCase()];
}

export function replTargetLabel(target: ReplTarget): string {
	return REPL_TARGETS.find(item => item.id === target)?.label ?? target;
}

/** Per-TUI REPL mode state. */
export class ReplMode {
	#target: ReplTarget = "agent";
	#lastKernel: ReplKernel = "js";
	readonly #pendingReset = new Set<"py" | "js">();

	get target(): ReplTarget {
		return this.#target;
	}

	get active(): boolean {
		return this.#target !== "agent";
	}

	set(target: ReplTarget): void {
		this.#target = target;
		if (target !== "agent") this.#lastKernel = target;
	}

	/** Agent ↔ the most recently used kernel (JavaScript by default). */
	toggle(): ReplTarget {
		this.set(this.#target === "agent" ? this.#lastKernel : "agent");
		return this.#target;
	}

	/** The next cell for `kernel` starts from a fresh kernel. */
	requestReset(kernel: "py" | "js"): void {
		this.#pendingReset.add(kernel);
	}

	/** Consume a pending reset for `kernel`. */
	takeReset(kernel: "py" | "js"): boolean {
		return this.#pendingReset.delete(kernel);
	}
}

/**
 * Whether an execute press should bypass the kernel and go through normal
 * submission: slash commands stay reachable from REPL mode.
 */
export function isReplBypass(text: string): boolean {
	return text.trimStart().startsWith("/");
}

export const REPL_STATUS_KEY = "neopi-repl";
