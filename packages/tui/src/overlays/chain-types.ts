/**
 * Post-processing chains: named, ordered model passes that rewrite composer
 * text before it is sent. Each step's output is the next step's input; the
 * last step's output is what gets sent. Declared in `CHAINS.yml` at the
 * project root or the user agent dir, and edited by `/chaining configure`.
 */

/** One step of a chain: a single model pass over the previous step's text. */
export interface ChainStep {
	name: string;
	/** Model selector or `@role`, with an optional `:level` thinking suffix; omitted uses `@prose`. */
	model?: string;
	/** Built-in tool names the step may call; omitted or empty grants none. */
	tools?: string[];
	/** Feed the live session transcript to this step alongside the draft; omitted is off. */
	context?: boolean;
	/** Full system-prompt override; omitted uses the bundled chain default. `prompt` is always appended after it. */
	systemPrompt?: string;
	/** Step instructions, appended to the system prompt; the incoming text is the user message. */
	prompt: string;
}

/** A named chain of steps, run top to bottom. */
export interface ChainConfig {
	name: string;
	description?: string;
	steps: ChainStep[];
}

/** Which level a `CHAINS.yml` lives at: the project root or the user agent dir. */
export type ChainConfigScope = "project" | "user";

/** Editable raw contents of one `CHAINS.yml`, without cross-level merging, for exact round trips. */
export interface ChainsConfigDoc {
	chains: ChainConfig[];
	/** Per-entry problems found while loading (dropped entries), shown when the file becomes active in the editor. */
	warnings?: string[];
}
