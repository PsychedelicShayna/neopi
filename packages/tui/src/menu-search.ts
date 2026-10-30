export interface MenuRegex {
	regex?: RegExp;
	error?: string;
}

// Scalar row matchers and field rendering share one active compilation.
let cachedQuery: string | undefined;
let cachedRegex: MenuRegex | undefined;

/** Plain patterns stay fuzzy; globs use wildcards and slash/re: patterns use Vim regex. */
export function compileMenuRegex(query: string): MenuRegex | undefined {
	if (query === cachedQuery) return cachedRegex;
	cachedQuery = query;
	cachedRegex = undefined;
	let pattern: string | undefined;
	if (query.startsWith("/")) {
		let end = query.length;
		if (end > 1 && query.endsWith("/")) {
			let backslashes = 0;
			for (let index = end - 2; index >= 1 && query[index] === "\\"; index--) backslashes++;
			if (backslashes % 2 === 0) end--;
		}
		pattern = query.slice(1, end);
	} else if (query.startsWith("re:")) {
		pattern = query.slice(3);
	} else if (query.includes("*") || query.includes("?")) {
		const source = Array.from(query, character =>
			character === "*" ? ".*" : character === "?" ? "." : literal(character),
		).join("");
		cachedRegex = { regex: new RegExp(source, "iu") };
		return cachedRegex;
	}
	if (pattern === undefined) return undefined;
	try {
		cachedRegex = { regex: translateVimRegex(pattern) };
	} catch (error) {
		cachedRegex = { error: error instanceof Error ? error.message : String(error) };
	}
	return cachedRegex;
}

type MagicMode = "magic" | "nomagic" | "veryMagic" | "veryNomagic";
interface VimToken {
	kind: "atom" | "open" | "close" | "alternate" | "quantifier" | "start" | "end" | "lookaround";
	source: string;
	contextual?: boolean;
}

const CLASSES: Readonly<Record<string, string>> = {
	d: "[0-9]",
	D: "[^0-9]",
	x: "[0-9A-Fa-f]",
	X: "[^0-9A-Fa-f]",
	o: "[0-7]",
	O: "[^0-7]",
	w: "[0-9A-Za-z_]",
	W: "[^0-9A-Za-z_]",
	h: "[A-Za-z_]",
	H: "[^A-Za-z_]",
	a: "[A-Za-z]",
	A: "[^A-Za-z]",
	l: "(?-i:[a-z])",
	L: "(?-i:[^a-z])",
	u: "(?-i:[A-Z])",
	U: "(?-i:[^A-Z])",
	s: "[ \\t]",
	S: "[^ \\t]",
	p: "[ -~]",
	P: "[^ -~]",
};
const CHARACTER_ESCAPES: Readonly<Record<string, string>> = {
	n: "\\n",
	r: "\\r",
	t: "\\t",
	e: "\\x1b",
	b: "\\x08",
};
const POSIX_CLASSES: Readonly<Record<string, string>> = {
	alnum: "A-Za-z0-9",
	alpha: "A-Za-z",
	blank: " \\t",
	cntrl: "\\x00-\\x1f\\x7f",
	digit: "0-9",
	graph: "!-~",
	lower: "a-z",
	print: " -~",
	punct: "!-/:-@\\[-`{-~",
	space: "\\x09-\\x0d ",
	upper: "A-Z",
	xdigit: "0-9A-Fa-f",
	return: "\\r",
	tab: "\\t",
	escape: "\\x1b",
	backspace: "\\x08",
};

function literal(character: string): string {
	return /[\\^$.*+?()[\]{}|/]/.test(character) ? `\\${character}` : character;
}

/** Vim collections have their own escape grammar: [\d] means d, not a digit. */
function collection(pattern: string, start: number): { source: string; end: number } {
	let source = "[";
	let index = start + 1;
	let caseSensitive = false;
	if (pattern[index] === "^") source += pattern[index++];
	if (pattern[index] === "]") {
		source += "\\]";
		index++;
	}
	for (; index < pattern.length; index++) {
		const character = pattern[index]!;
		if (character === "]") {
			source += "]";
			return { source: caseSensitive ? `(?-i:${source})` : source, end: index };
		}
		if (character === "[" && pattern[index + 1] === ":") {
			const end = pattern.indexOf(":]", index + 2);
			if (end < 0) throw new Error("Unclosed POSIX character class");
			const name = pattern.slice(index + 2, end);
			const members = POSIX_CLASSES[name];
			if (!Object.hasOwn(POSIX_CLASSES, name)) throw new Error(`Unsupported POSIX character class: ${name}`);
			source += members;
			caseSensitive ||= name === "lower" || name === "upper";
			index = end + 1;
		} else if (character === "[" && (pattern[index + 1] === "." || pattern[index + 1] === "=")) {
			throw new Error("Unsupported Vim collating/equivalence collection");
		} else if (character === "\\") {
			const escaped = pattern[++index];
			if (escaped === undefined) throw new Error("Trailing backslash in collection");
			source += CHARACTER_ESCAPES[escaped] ?? ("\\]-^".includes(escaped) ? `\\${escaped}` : escaped);
		} else {
			source += character === "[" ? "\\[" : character;
		}
	}
	throw new Error("Unclosed character collection");
}

function repetition(body: string): string {
	const lazy = body.startsWith("-");
	const count = lazy ? body.slice(1) : body;
	if (lazy && count === "") return "*?";
	if (!/^\d+(,\d*)?$|^,\d+$/.test(count)) throw new Error("Invalid repetition");
	return `{${count.startsWith(",") ? `0${count}` : count}}${lazy ? "?" : ""}`;
}

/** Parse Vim atoms before emitting JS, so unknown escapes never become literal letters. */
function translateVimRegex(pattern: string): RegExp {
	const tokens: VimToken[] = [];
	let mode: MagicMode = "veryMagic";
	let ignoreCase = true;
	for (let index = 0; index < pattern.length; index++) {
		let character = pattern[index]!;
		let escaped = false;
		if (character === "\\") {
			character = pattern[++index]!;
			if (character === undefined) throw new Error("Trailing backslash");
			escaped = true;
			if (character === "c" || character === "C") {
				ignoreCase = character === "c";
				continue;
			}
			if (character === "v" || character === "V" || character === "m" || character === "M") {
				mode =
					character === "v"
						? "veryMagic"
						: character === "V"
							? "veryNomagic"
							: character === "m"
								? "magic"
								: "nomagic";
				continue;
			}
			if (character === "z" && (pattern[index + 1] === "s" || pattern[index + 1] === "e")) {
				// These change the returned match span, not whether a menu row matches.
				index++;
				continue;
			}
			const atom = CLASSES[character] ?? CHARACTER_ESCAPES[character];
			if (atom !== undefined || /[1-9]/.test(character)) {
				tokens.push({ kind: "atom", source: atom ?? `\\${character}` });
				continue;
			}
			if (/[A-Za-z_]/.test(character)) throw new Error(`Unsupported Vim atom: \\${character}`);
		}
		const normallyMagic =
			mode === "veryMagic"
				? /[^\w\s]/.test(character)
				: mode === "magic"
					? ".*[]^$".includes(character)
					: mode === "nomagic"
						? "^$".includes(character)
						: false;
		const magic = escaped ? !normallyMagic : normallyMagic;
		if (magic && character === "%") {
			if (pattern[index + 1] !== "(") throw new Error("Unsupported Vim atom: %");
			index++;
			tokens.push({ kind: "open", source: "(?:" });
		} else if (magic && character === "@") {
			const operator = /^(<=|<!|=|!)/.exec(pattern.slice(index + 1))?.[0];
			if (!operator) throw new Error("Unsupported Vim lookaround atom: @");
			index += operator.length;
			tokens.push({ kind: "lookaround", source: `(?${operator}` });
		} else if (magic && (character === "&" || character === "~")) {
			throw new Error(`Unsupported Vim atom: ${character}`);
		} else if (magic && (character === "<" || character === ">")) {
			tokens.push({ kind: "atom", source: character === "<" ? "(?<!\\w)(?=\\w)" : "(?<=\\w)(?!\\w)" });
		} else if (character === "[" && magic) {
			const parsed = collection(pattern, index);
			tokens.push({ kind: "atom", source: parsed.source });
			index = parsed.end;
		} else if (character === "{" && magic) {
			const end = pattern.indexOf("}", index + 1);
			if (end < 0) throw new Error("Unclosed repetition");
			tokens.push({ kind: "quantifier", source: repetition(pattern.slice(index + 1, end).replace(/\\$/, "")) });
			index = end;
		} else if (magic && (character === "(" || character === ")")) {
			tokens.push({ kind: character === "(" ? "open" : "close", source: character });
		} else if (magic && character === "|") {
			tokens.push({ kind: "alternate", source: "|" });
		} else if (magic && "*+?=".includes(character)) {
			tokens.push({ kind: "quantifier", source: character === "=" ? "?" : character });
		} else if (magic && (character === "^" || character === "$")) {
			tokens.push({
				kind: character === "^" ? "start" : "end",
				source: character,
				contextual: mode !== "veryMagic",
			});
		} else {
			tokens.push({ kind: "atom", source: magic && character === "." ? "." : literal(character) });
		}
	}
	return new RegExp(emitTokens(tokens), ignoreCase ? "iu" : "u");
}

function emitTokens(tokens: readonly VimToken[]): string {
	let source = "";
	let lastAtom = -1;
	const groups: number[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token.kind === "open") {
			groups.push(source.length);
			source += token.source;
			lastAtom = -1;
		} else if (token.kind === "close") {
			const group = groups.pop();
			if (group === undefined) throw new Error("Unmatched closing group");
			source += ")";
			lastAtom = group;
		} else if (token.kind === "alternate") {
			source += "|";
			lastAtom = -1;
		} else if (token.kind === "quantifier" || token.kind === "lookaround") {
			if (lastAtom < 0) throw new Error("Nothing to repeat or assert");
			if (token.kind === "quantifier") source += token.source;
			else source = `${source.slice(0, lastAtom)}${token.source}${source.slice(lastAtom)})`;
		} else {
			const previous = tokens[index - 1]?.kind;
			const next = tokens[index + 1]?.kind;
			const literalAnchor =
				token.contextual &&
				(token.kind === "start"
					? index > 0 && previous !== "open" && previous !== "alternate"
					: index < tokens.length - 1 && next !== "close" && next !== "alternate");
			lastAtom = source.length;
			source += literalAnchor ? `\\${token.source}` : token.source;
			if (!literalAnchor && (token.kind === "start" || token.kind === "end")) lastAtom = -1;
		}
	}
	if (groups.length > 0) throw new Error("Unclosed group");
	return source;
}
