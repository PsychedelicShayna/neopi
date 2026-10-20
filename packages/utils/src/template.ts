/** Behavior-compatible reimplementation of handlebars' used surface. */

/** Values accepted as registered partial templates. */
export type Template = string | TemplateDelegate;

/** A compiled template function. */
export type TemplateDelegate<T = unknown> = (context?: T, options?: RuntimeOptions) => string;

/** Runtime options accepted by compiled templates. */
export interface RuntimeOptions {
	data?: Record<string, unknown>;
	helpers?: Record<string, HelperDelegate>;
	partials?: Record<string, Template>;
}

/** Options passed as the final argument to helpers. */
export interface HelperOptions {
	name: string;
	hash: Record<string, unknown>;
	data: Record<string, unknown>;
	fn: (context?: unknown, options?: { data?: Record<string, unknown> }) => string;
	inverse: (context?: unknown, options?: { data?: Record<string, unknown> }) => string;
	lookupProperty: (parent: unknown, propertyName: string) => unknown;
}

/** A template helper function. */
export type HelperDelegate = { bivarianceHack(this: unknown, ...args: unknown[]): unknown }["bivarianceHack"];

/** Template compilation behavior. */
export interface CompileOptions {
	noEscape?: boolean;
	strict?: boolean;
}

/** A string that bypasses HTML escaping when interpolated. */
export class SafeString {
	readonly #value: string;

	constructor(value: unknown) {
		this.#value = String(value);
	}

	/** Return the unescaped string value. */
	toString(): string {
		return this.#value;
	}

	/** Return the unescaped primitive value. */
	toHTML(): string {
		return this.#value;
	}
}

/** Original template coordinates. Lines and columns are one-based; offsets are UTF-16 indexes. */
export interface SourcePosition {
	line: number;
	column: number;
	offset: number;
}

export interface SourceLocation {
	start: SourcePosition;
	end: SourcePosition;
}

export type PathExpression = { kind: "path"; value: string; loc: SourceLocation };
export type LiteralExpression = { kind: "literal"; value: unknown; loc: SourceLocation };
export type CallExpression = {
	kind: "call";
	name: string;
	args: Expression[];
	hash: Record<string, Expression>;
	loc: SourceLocation;
};
export type Expression = PathExpression | LiteralExpression | CallExpression;
export type TextNode = { kind: "text"; value: string; loc: SourceLocation };
export type OutputNode = { kind: "output"; expression: CallExpression; escaped: boolean; loc: SourceLocation };
export type BlockNode = {
	kind: "block";
	expression: CallExpression;
	body: Node[];
	inverse: Node[];
	inverted: boolean;
	loc: SourceLocation;
};
export type PartialNode = { kind: "partial"; expression: CallExpression; loc: SourceLocation };
export type Node = TextNode | OutputNode | BlockNode | PartialNode;

/** A parse failure with coordinates in the unmodified template source. */
export class TemplateSyntaxError extends SyntaxError {
	readonly line: number;
	readonly column: number;
	readonly endLine: number;
	readonly endColumn: number;

	constructor(
		message: string,
		readonly loc: SourceLocation,
		readonly expression: string,
	) {
		super(`Parse error: ${message}`);
		this.name = "TemplateSyntaxError";
		this.line = loc.start.line;
		this.column = loc.start.column;
		this.endLine = loc.end.line;
		this.endColumn = loc.end.column;
	}
}

type Frame = {
	context: unknown;
	parents: Frame[];
	root: unknown;
	data: Record<string, unknown>;
};

type Evaluation = {
	helpers: Map<string, HelperDelegate>;
	partials: Map<string, Template>;
	options: CompileOptions;
	runtime: RuntimeOptions;
};

const helpers = new Map<string, HelperDelegate>();
const partials = new Map<string, Template>();
// Parser and evaluator use this registry as well as the public helper inventory.
const builtinHelpers = {
	if: "if",
	unless: "unless",
	each: "each",
	with: "with",
	else: "else",
	lookup: "lookup",
} as const;
const BLOCK_TAG = /^\s*\{\{(?:#|\/|\^|else\b|!)/;

interface TemplateSource {
	source: string;
	loc(start: number, end: number): SourceLocation;
	error(message: string, start: number, end: number): TemplateSyntaxError;
}

function stripStandalone(original: string): TemplateSource {
	const lines = original.split(/(?<=\n)/);
	const offsets: number[] = [];
	let offset = 0;
	for (const line of lines) {
		offsets.push(offset);
		offset += line.length;
	}
	const starts = [...offsets];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const body = line.endsWith("\n") ? line.slice(0, -1).replace(/\r$/, "") : line;
		if (/^\s*\{\{!--/.test(body) && !body.includes("--}}")) {
			for (let end = index + 1; end < lines.length; end++) {
				const endLine = lines[end].endsWith("\n") ? lines[end].slice(0, -1).replace(/\r$/, "") : lines[end];
				const close = endLine.indexOf("--}}");
				if (close < 0) continue;
				if (/^\s*$/.test(endLine.slice(close + 4))) {
					for (let commentLine = index; commentLine <= end; commentLine++) lines[commentLine] = "";
					index = end;
				}
				break;
			}
			continue;
		}
		if (BLOCK_TAG.test(body) && /^\s*\{\{(?:#|\/|\^|else\b|!)[^{}]*\}\}\s*$/.test(body)) {
			starts[index] += body.length - body.trimStart().length;
			lines[index] = body.trim();
		}
	}
	// Map retained line segments instead of allocating a mapping for every character.
	const segments: { start: number; original: number }[] = [];
	let length = 0;
	for (let index = 0; index < lines.length; index++) {
		if (!lines[index].length) continue;
		segments.push({ start: length, original: starts[index] });
		length += lines[index].length;
	}
	const originalOffset = (index: number): number => {
		if (index === length) return original.length;
		let low = 0;
		let high = segments.length;
		while (low + 1 < high) {
			const middle = (low + high) >>> 1;
			if (segments[middle].start <= index) low = middle;
			else high = middle;
		}
		return segments[low].original + index - segments[low].start;
	};
	const lineOffsets = offsets;
	if (original.endsWith("\n")) lineOffsets.push(original.length);
	const position = (index: number): SourcePosition => {
		let low = 0;
		let high = lineOffsets.length;
		while (low + 1 < high) {
			const middle = (low + high) >>> 1;
			if (lineOffsets[middle] <= index) low = middle;
			else high = middle;
		}
		return { line: low + 1, column: index - lineOffsets[low] + 1, offset: index };
	};
	const loc = (start: number, end: number): SourceLocation => ({
		start: position(originalOffset(start)),
		end: position(end > start ? originalOffset(end - 1) + 1 : originalOffset(start)),
	});
	return {
		source: lines.join(""),
		loc,
		error(message, start, end) {
			const location = loc(start, end);
			return new TemplateSyntaxError(message, location, original.slice(location.start.offset, location.end.offset));
		},
	};
}

interface ExpressionToken {
	value: string;
	start: number;
	end: number;
}

function tokenizeExpression(source: string, offset: number, template: TemplateSource): ExpressionToken[] {
	const tokens: ExpressionToken[] = [];
	let start = -1;
	let quote = "";
	let depth = 0;
	let bracketDepth = 0;
	const push = (end: number) => {
		tokens.push({ value: source.slice(start, end), start: offset + start, end: offset + end });
	};
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (quote) {
			if (char === "\\" && index + 1 < source.length) index++;
			else if (char === quote) quote = "";
			continue;
		}
		if (char === '"' || char === "'") {
			if (start < 0) start = index;
			quote = char;
			continue;
		}
		if (char === "(") {
			if (start < 0) start = index;
			depth++;
			continue;
		}
		if (char === ")") {
			if (--depth < 0) throw template.error("unexpected closing parenthesis", offset + index, offset + index + 1);
			continue;
		}
		if (char === "[") {
			if (start < 0) start = index;
			bracketDepth++;
			continue;
		}
		if (char === "]") {
			if (--bracketDepth < 0) throw template.error("unexpected closing bracket", offset + index, offset + index + 1);
			continue;
		}
		if (/\s/.test(char) && depth === 0 && bracketDepth === 0) {
			if (start >= 0) push(index);
			start = -1;
		} else if (start < 0) start = index;
	}
	if (quote || depth || bracketDepth)
		throw template.error("unclosed expression token", offset + Math.max(start, 0), offset + source.length);
	if (start >= 0) push(source.length);
	return tokens;
}

function parseString(token: string): string {
	const quote = token[0];
	let result = "";
	for (let index = 1; index < token.length - 1; index++) {
		const char = token[index];
		if (char === "\\" && index + 1 < token.length - 1) {
			const next = token[++index];
			result += next === quote || next === "\\" ? next : `\\${next}`;
		} else result += char;
	}
	return result;
}

function parseAtom(token: ExpressionToken, template: TemplateSource): Expression {
	const { value, start, end } = token;
	const loc = template.loc(start, end);
	if (value.startsWith("(") && value.endsWith(")"))
		return { ...parseCall(value.slice(1, -1), start + 1, template), loc };
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return { kind: "literal", value: parseString(value), loc };
	}
	if (value === "true" || value === "false") return { kind: "literal", value: value === "true", loc };
	if (value === "null") return { kind: "literal", value: null, loc };
	if (value === "undefined") return { kind: "literal", value: undefined, loc };
	if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return { kind: "literal", value: Number(value), loc };
	return { kind: "path", value, loc };
}

function hashSeparator(token: string): number {
	let quote = "";
	let depth = 0;
	for (let index = 0; index < token.length; index++) {
		const char = token[index];
		if (quote) {
			if (char === "\\") index++;
			else if (char === quote) quote = "";
		} else if (char === '"' || char === "'") quote = char;
		else if (char === "(") depth++;
		else if (char === ")") depth--;
		else if (char === "=" && depth === 0) return index;
	}
	return -1;
}

function parseCall(source: string, offset: number, template: TemplateSource): CallExpression {
	const tokens = tokenizeExpression(source, offset, template);
	const name = tokens.shift();
	if (!name) throw template.error("empty expression", offset, offset + source.length);
	if (/[()="'{}]/.test(name.value)) throw template.error("invalid helper or path", name.start, name.end);
	const args: Expression[] = [];
	const hash: Record<string, Expression> = {};
	for (const token of tokens) {
		const separator = hashSeparator(token.value);
		if (separator > 0) {
			if (separator === token.value.length - 1) throw template.error("missing hash value", token.start, token.end);
			hash[token.value.slice(0, separator)] = parseAtom(
				{ value: token.value.slice(separator + 1), start: token.start + separator + 1, end: token.end },
				template,
			);
		} else args.push(parseAtom(token, template));
	}
	return {
		kind: "call",
		name: name.value,
		args,
		hash,
		loc: template.loc(name.start, offset + source.trimEnd().length),
	};
}

function findTagEnd(source: string, start: number, triple: boolean, template: TemplateSource, open: number): number {
	const close = triple ? "}}}" : "}}";
	let quote = "";
	let depth = 0;
	for (let index = start; index <= source.length - close.length; index++) {
		const char = source[index];
		if (quote) {
			if (char === "\\") index++;
			else if (char === quote) quote = "";
			continue;
		}
		if (char === '"' || char === "'") quote = char;
		else if (char === "(") depth++;
		else if (char === ")") depth--;
		else if (depth === 0 && source.startsWith(close, index)) return index;
	}
	throw template.error("unclosed template expression", open, source.length);
}

/** Parse a template while retaining original-source spans and standalone rendering behavior. */
export function parseTemplate(original: string): Node[] {
	const template = stripStandalone(original);
	const { source } = template;
	const root: Node[] = [];
	// `chained` marks a block opened by `{{else name …}}`: it has no closing tag of
	// its own and closes with the block it chains from, as in Handlebars.
	const stack: { node: BlockNode; target: Node[]; inverted: boolean; chained: boolean }[] = [];
	let target = root;
	let cursor = 0;
	while (cursor < source.length) {
		const open = source.indexOf("{{", cursor);
		if (open < 0) {
			if (cursor < source.length)
				target.push({ kind: "text", value: source.slice(cursor), loc: template.loc(cursor, source.length) });
			break;
		}
		if (open > cursor)
			target.push({ kind: "text", value: source.slice(cursor, open), loc: template.loc(cursor, open) });
		if (source.startsWith("{{!--", open)) {
			const end = source.indexOf("--}}", open + 6);
			if (end < 0) throw template.error("unclosed comment", open, source.length);
			cursor = end + 4;
			continue;
		}
		const triple = source.startsWith("{{{", open);
		const contentStart = open + (triple ? 3 : 2);
		const end = findTagEnd(source, contentStart, triple, template, open);
		const content = source.slice(contentStart, end);
		const raw = content.trim();
		const rawStart = contentStart + content.length - content.trimStart().length;
		cursor = end + (triple ? 3 : 2);
		if (!raw || raw.startsWith("!")) continue;
		if (raw === builtinHelpers.else || raw.startsWith(`${builtinHelpers.else} `)) {
			const current = stack[stack.length - 1];
			if (!current) throw template.error("unexpected else", open, cursor);
			target = current.node.inverse;
			if (raw.length > 4) {
				const parentTarget = target;
				const nested: BlockNode = {
					kind: "block",
					expression: parseCall(raw.slice(5), rawStart + 5, template),
					body: [],
					inverse: [],
					inverted: false,
					loc: template.loc(open, cursor),
				};
				target.push(nested);
				target = nested.body;
				stack.push({ node: nested, target: parentTarget, inverted: false, chained: true });
			}
			continue;
		}
		if (raw.startsWith("#") || raw.startsWith("^")) {
			const inverted = raw.startsWith("^");
			const node: BlockNode = {
				kind: "block",
				expression: parseCall(raw.slice(1), rawStart + 1, template),
				body: [],
				inverse: [],
				inverted,
				loc: template.loc(open, cursor),
			};
			target.push(node);
			stack.push({ node, target, inverted, chained: false });
			target = node.body;
			continue;
		}
		if (raw.startsWith("/")) {
			let current = stack.pop();
			while (current?.chained) {
				current.node.loc.end = template.loc(open, cursor).end;
				current = stack.pop();
			}
			if (!current || current.node.expression.name !== raw.slice(1).trim())
				throw template.error(`mismatched ${raw}`, open, cursor);
			current.node.loc.end = template.loc(open, cursor).end;
			if (current.inverted) [current.node.body, current.node.inverse] = [current.node.inverse, current.node.body];
			target = current.target;
			continue;
		}
		if (raw.startsWith(">"))
			target.push({
				kind: "partial",
				expression: parseCall(raw.slice(1), rawStart + 1, template),
				loc: template.loc(open, cursor),
			});
		else
			target.push({
				kind: "output",
				expression: parseCall(
					raw.startsWith("&") ? raw.slice(1) : raw,
					rawStart + (raw.startsWith("&") ? 1 : 0),
					template,
				),
				escaped: !triple && !raw.startsWith("&"),
				loc: template.loc(open, cursor),
			});
	}
	if (stack.length) {
		const node = stack[stack.length - 1].node;
		throw new TemplateSyntaxError(
			`unclosed block ${node.expression.name}`,
			node.loc,
			original.slice(node.loc.start.offset, node.loc.end.offset),
		);
	}
	return root;
}

function pathParts(path: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let bracketStart = -1;
	for (let index = 0; index <= path.length; index++) {
		const char = path[index];
		if (char === "[" && bracketStart < 0) {
			if (index > start) parts.push(path.slice(start, index).replace(/[./]+$/, ""));
			bracketStart = index + 1;
		} else if (char === "]" && bracketStart >= 0) {
			parts.push(path.slice(bracketStart, index));
			start = index + 1;
			bracketStart = -1;
		} else if ((char === "." || char === "/" || char === undefined) && bracketStart < 0) {
			if (index > start) parts.push(path.slice(start, index));
			start = index + 1;
		}
	}
	return parts.filter(Boolean);
}

function property(parent: unknown, key: string): unknown {
	if (parent == null) return undefined;
	if (key === "length" && (typeof parent === "string" || Array.isArray(parent))) return parent.length;
	if (typeof parent !== "object" && typeof parent !== "function") return undefined;
	if (key === "__proto__" || key === "prototype" || key === "constructor") return undefined;
	const record = parent as Record<string, unknown>;
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

function resolvePath(path: string, frame: Frame): unknown {
	if (path === "this" || path === ".") return frame.context;
	let current = frame;
	while (path.startsWith("../")) {
		current = current.parents[0] ?? current;
		path = path.slice(3);
	}
	if (path === "this" || path === ".") return current.context;
	if (path.startsWith("this.")) path = path.slice(5);
	if (path === "@root") return current.root;
	if (path.startsWith("@root.")) {
		let value: unknown = current.root;
		for (const part of pathParts(path.slice(6))) value = property(value, part);
		return value;
	}
	if (path.startsWith("@")) {
		const parts = pathParts(path.slice(1));
		let value: unknown = current.data[parts.shift() ?? ""];
		for (const part of parts) value = property(value, part);
		return value;
	}
	let value: unknown = current.context;
	for (const part of pathParts(path)) value = property(value, part);
	return typeof value === "function" ? value.call(current.context) : value;
}

function childFrame(frame: Frame, context: unknown, data = frame.data): Frame {
	return { context, parents: [frame, ...frame.parents], root: frame.root, data };
}

function evaluateExpression(expression: Expression, frame: Frame, evaluation: Evaluation): unknown {
	if (expression.kind === "literal") return expression.value;
	if (expression.kind === "path") return resolvePath(expression.value, frame);
	return evaluateCall(expression, frame, evaluation, false);
}

function isConditionalTruthy(value: unknown, includeZero = false): boolean {
	return value === 0 ? includeZero : Boolean(value) && !(Array.isArray(value) && value.length === 0);
}

function renderNodes(nodes: Node[], frame: Frame, evaluation: Evaluation): string {
	let result = "";
	for (const node of nodes) {
		if (node.kind === "text") result += node.value;
		else if (node.kind === "output") {
			const value = evaluateCall(node.expression, frame, evaluation, false);
			result += stringify(value, node.escaped && !evaluation.options.noEscape);
		} else if (node.kind === "partial") result += renderPartial(node, frame, evaluation);
		else result += evaluateBlock(node, frame, evaluation);
	}
	return result;
}

function helperOptions(
	name: string,
	hash: Record<string, unknown>,
	frame: Frame,
	evaluation: Evaluation,
	body: Node[] = [],
	inverse: Node[] = [],
): HelperOptions {
	return {
		name,
		hash,
		data: frame.data,
		fn: (context = frame.context, options) =>
			renderNodes(body, childFrame(frame, context, options?.data ?? frame.data), evaluation),
		inverse: (context = frame.context, options) =>
			renderNodes(inverse, childFrame(frame, context, options?.data ?? frame.data), evaluation),
		lookupProperty: property,
	};
}

function evaluateHash(hash: Record<string, Expression>, frame: Frame, evaluation: Evaluation): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key in hash) result[key] = evaluateExpression(hash[key], frame, evaluation);
	return result;
}
function findHelper(name: string, evaluation: Evaluation): HelperDelegate | undefined {
	return evaluation.runtime.helpers?.[name] ?? evaluation.helpers.get(name);
}

function evaluateCall(
	call: CallExpression,
	frame: Frame,
	evaluation: Evaluation,
	forceHelper: boolean,
	body: Node[] = [],
	inverse: Node[] = [],
): unknown {
	const helper = findHelper(call.name, evaluation);
	const args = call.args.map(argument => evaluateExpression(argument, frame, evaluation));
	const hash = evaluateHash(call.hash, frame, evaluation);
	if (helper)
		return helper.call(frame.context, ...args, helperOptions(call.name, hash, frame, evaluation, body, inverse));
	// Handlebars built-in: `{{lookup obj key}}` → proto-safe `obj[key]`.
	// Resolved after user helpers so a registered `lookup` override wins.
	if (call.name === builtinHelpers.lookup && args.length >= 2) return property(args[0], String(args[1]));
	if (forceHelper || args.length) throw new Error(`Missing helper: "${call.name}"`);
	for (const _key in hash) throw new Error(`Missing helper: "${call.name}"`);
	return resolvePath(call.name, frame);
}

function evaluateBlock(node: BlockNode, frame: Frame, evaluation: Evaluation): string {
	const { name } = node.expression;
	const helper = findHelper(name, evaluation);
	if (helper) return stringify(evaluateCall(node.expression, frame, evaluation, true, node.body, node.inverse), false);
	const args = node.expression.args.map(argument => evaluateExpression(argument, frame, evaluation));
	const value = args.length ? args[0] : resolvePath(name, frame);
	const hash = evaluateHash(node.expression.hash, frame, evaluation);
	if (name === builtinHelpers.if || name === builtinHelpers.unless) {
		const truthy = isConditionalTruthy(value, hash.includeZero === true);
		const branch = name === builtinHelpers.if ? truthy : !truthy;
		return renderNodes(branch ? node.body : node.inverse, frame, evaluation);
	}
	if (name === builtinHelpers.each) {
		if (Array.isArray(value)) {
			if (!value.length) return renderNodes(node.inverse, frame, evaluation);
			return value
				.map((item, index) =>
					renderNodes(
						node.body,
						childFrame(frame, item, {
							...frame.data,
							index,
							key: index,
							first: index === 0,
							last: index === value.length - 1,
						}),
						evaluation,
					),
				)
				.join("");
		}
		if (value && typeof value === "object") {
			const entries = Object.entries(value);
			if (!entries.length) return renderNodes(node.inverse, frame, evaluation);
			return entries
				.map(([key, item], index) =>
					renderNodes(
						node.body,
						childFrame(frame, item, {
							...frame.data,
							index,
							key,
							first: index === 0,
							last: index === entries.length - 1,
						}),
						evaluation,
					),
				)
				.join("");
		}
		return renderNodes(node.inverse, frame, evaluation);
	}
	if (name === builtinHelpers.with)
		return isConditionalTruthy(value)
			? renderNodes(node.body, childFrame(frame, value), evaluation)
			: renderNodes(node.inverse, frame, evaluation);
	const resolved = resolvePath(name, frame);
	if (Array.isArray(resolved))
		return (
			resolved.map(item => renderNodes(node.body, childFrame(frame, item), evaluation)).join("") ||
			renderNodes(node.inverse, frame, evaluation)
		);
	return resolved === false || resolved == null
		? renderNodes(node.inverse, frame, evaluation)
		: renderNodes(node.body, childFrame(frame, resolved), evaluation);
}

function renderPartial(node: PartialNode, frame: Frame, evaluation: Evaluation): string {
	const partial = evaluation.runtime.partials?.[node.expression.name] ?? evaluation.partials.get(node.expression.name);
	if (partial === undefined) throw new Error(`The partial ${node.expression.name} could not be found`);
	const context = node.expression.args.length
		? evaluateExpression(node.expression.args[0], frame, evaluation)
		: frame.context;
	const hash = evaluateHash(node.expression.hash, frame, evaluation);
	const merged =
		hash && context && typeof context === "object" ? { ...(context as Record<string, unknown>), ...hash } : context;
	return typeof partial === "function"
		? partial(merged, evaluation.runtime)
		: compile(partial, evaluation.options)(merged, evaluation.runtime);
}

function stringify(value: unknown, shouldEscape: boolean): string {
	if (value == null) return "";
	if (value instanceof SafeString) return value.toString();
	const text = String(value);
	return shouldEscape ? escapeExpression(text) : text;
}

/** Escape a value with Handlebars' HTML entity set. */
export function escapeExpression(value: unknown): string {
	const text = value == null ? "" : String(value);
	return text.replace(
		/[&<>"'`=]/g,
		char =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;", "`": "&#x60;", "=": "&#x3D;" })[
				char
			] ?? char,
	);
}

/** Register a helper for subsequently compiled templates. */
export function registerHelper(name: string, helper: HelperDelegate): void {
	helpers.set(name, helper);
}

/** Register a partial for subsequently rendered templates. */
export function registerPartial(name: string, partial: Template): void {
	partials.set(name, partial);
}

/** Compile a template into a reusable rendering function. */
export function compile<T = unknown>(source: string, options: CompileOptions = {}): TemplateDelegate<T> {
	const nodes = parseTemplate(source);
	return (context, runtime = {}) => {
		const root = context ?? {};
		const frame: Frame = { context: root, parents: [], root, data: { root, ...runtime.data } };
		return renderNodes(nodes, frame, { helpers, partials, options, runtime });
	};
}

/** Create an isolated template engine with its own helper and partial registries. */
export function create(): TemplateEngine {
	return new TemplateEngine();
}

/** Isolated template compiler and registry. */
export class TemplateEngine {
	readonly #helpers = new Map<string, HelperDelegate>();
	readonly #partials = new Map<string, Template>();

	/** Register a helper in this engine. */
	registerHelper(name: string, helper: HelperDelegate): void {
		this.#helpers.set(name, helper);
	}

	/** Names accepted by this engine, including implemented block syntax. */
	listHelpers(): string[] {
		return [...new Set([...Object.keys(builtinHelpers), ...this.#helpers.keys()])].sort();
	}

	/** Register a partial in this engine. */
	registerPartial(name: string, partial: Template): void {
		this.#partials.set(name, partial);
	}

	/** Compile a template using this engine's registries. */
	compile<T = unknown>(source: string, options: CompileOptions = {}): TemplateDelegate<T> {
		const nodes = parseTemplate(source);
		return (context, runtime = {}) => {
			const root = context ?? {};
			const frame: Frame = { context: root, parents: [], root, data: { root, ...runtime.data } };
			return renderNodes(nodes, frame, { helpers: this.#helpers, partials: this.#partials, options, runtime });
		};
	}
}
