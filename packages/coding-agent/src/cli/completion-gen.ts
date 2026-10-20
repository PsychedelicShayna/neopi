/**
 * Shell-completion generation (bash, zsh, fish).
 *
 * Single source of truth: the declarative `flags`/`args` descriptors carried by
 * each `Command` subclass plus the registered subcommand table. {@link buildSpec}
 * walks that metadata — the same data `renderCommandBody` renders for `--help` —
 * and {@link generateCompletion} emits a self-contained completion script. Adding
 * a flag to a command's static `flags` therefore propagates into completions with
 * no edits here.
 *
 * Static candidates (enum `options`, the builtin tool list) are baked into the
 * script. A small set of flags resolve dynamic candidates (the live model
 * catalog and on-disk sessions) by calling back into `<bin> __complete <kind>`
 * — see `commands/complete.ts`. The flag→source mapping below is the only manual
 * knob and is keyed by flag name so it stays stable as flags are added.
 */
import type { ArgDescriptor, CliConfig, CommandCtor, CommandMetadata, FlagDescriptor } from "@oh-my-pi/pi-utils/cli";
import { BUILTIN_TOOL_NAMES } from "../tools/builtin-names";

export type Shell = "bash" | "zsh" | "fish";

/** How a flag/positional value should be completed. */
export type ValueSource =
	| { kind: "flag" } // boolean — takes no value
	| { kind: "value" } // takes a value with no completable candidates (e.g. integer, free text)
	| { kind: "enum"; values: readonly string[] } // static single value
	| { kind: "list"; values: readonly string[] } // static comma-separated list
	| { kind: "models"; multiple: boolean } // dynamic: live model catalog
	| { kind: "sessions" } // dynamic: on-disk sessions
	| { kind: "file" }
	| { kind: "dir" };

export interface CompletionFlag {
	/** Long name without the leading `--`. */
	name: string;
	/** Short character without the leading `-`. */
	char?: string;
	description: string;
	value: ValueSource;
	/** Flag may appear multiple times (oclif `multiple`). */
	repeatable: boolean;
}

export interface CompletionArg {
	name: string;
	description: string;
	value: ValueSource;
	multiple?: boolean;
}

export interface CompletionCommand {
	name: string;
	aliases: readonly string[];
	description: string;
	flags: CompletionFlag[];
	args: CompletionArg[];
	children: CompletionCommand[];
}

export interface CompletionSpec {
	bin: string;
	/** Flags/args of the default (no-subcommand) command. */
	root: { flags: CompletionFlag[]; args: CompletionArg[] };
	commands: CompletionCommand[];
}

// --- Flag/arg value classification (the single manual mapping) ----------------

/** Single-value flags resolved against the live model catalog. */
const MODEL_FLAGS: Record<string, true> = { model: true, smol: true, slow: true, plan: true };
/** Single-value flags resolved against on-disk sessions. */
const SESSION_FLAGS: Record<string, true> = { resume: true, restore: true, fork: true, session: true };
/** Flags whose value is a directory path. */
const DIR_FLAGS: Record<string, true> = { "session-dir": true, "plugin-dir": true, dir: true };

function flagValue(name: string, desc: FlagDescriptor): ValueSource {
	if (desc.kind === "boolean") return { kind: "flag" };
	if (desc.options && desc.options.length > 0) return { kind: "enum", values: desc.options };
	if (MODEL_FLAGS[name]) return { kind: "models", multiple: false };
	if (name === "models") return { kind: "models", multiple: true };
	if (SESSION_FLAGS[name]) return { kind: "sessions" };
	if (name === "tools") return { kind: "list", values: BUILTIN_TOOL_NAMES };
	if (DIR_FLAGS[name]) return { kind: "dir" };
	if (desc.kind === "integer") return { kind: "value" };
	return { kind: "file" };
}

function argValue(desc: ArgDescriptor): ValueSource {
	if (desc.options && desc.options.length > 0) return { kind: "enum", values: desc.options };
	if (desc.suggestions?.length) return { kind: "enum", values: desc.suggestions };
	return { kind: "file" };
}

function buildFlags(command: CommandMetadata): CompletionFlag[] {
	const out: CompletionFlag[] = [];
	const flags = command.flags ?? {};
	for (const name in flags) {
		const desc = flags[name];
		out.push({
			name,
			char: desc.char,
			description: desc.description ?? "",
			value: flagValue(name, desc),
			repeatable: Boolean(desc.multiple),
		});
	}
	return out;
}

function buildArgs(command: CommandMetadata): CompletionArg[] {
	const out: CompletionArg[] = [];
	const args = command.args ?? {};
	for (const name in args) {
		const desc = args[name];
		out.push({ name, description: desc.description ?? "", value: argValue(desc), multiple: desc.multiple });
	}
	return out;
}

/**
 * Build a {@link CompletionSpec} from loaded command classes.
 *
 * @param rootName  Entry name of the default command (its flags become top-level
 *                  flags; it is excluded from the subcommand list).
 * @param aliasMap  Canonical-name → aliases (merged from the registration table
 *                  and the command class's static `aliases`).
 */
export async function buildSpec(
	config: CliConfig,
	rootName: string,
	aliasMap: Map<string, readonly string[]>,
): Promise<CompletionSpec> {
	const commands: CompletionCommand[] = [];
	let root: CompletionSpec["root"] = { flags: [], args: [] };
	for (const [name, Cmd] of config.commands) {
		if (name === rootName) {
			root = { flags: buildFlags(Cmd), args: buildArgs(Cmd) };
			continue;
		}
		if (Cmd.hidden) continue;
		commands.push(await buildCommand(name, Cmd, aliasMap.get(name) ?? []));
	}
	commands.sort((a, b) => a.name.localeCompare(b.name));
	return { bin: config.bin, root, commands };
}

async function buildCommand(
	name: string,
	command: CommandCtor,
	aliases: readonly string[],
): Promise<CompletionCommand> {
	const children: CompletionCommand[] = [];
	for (const [childName, load] of Object.entries(command.subcommands ?? {})) {
		const child = await load();
		if (!child.hidden) children.push(await buildCommand(childName, child, child.aliases ?? []));
	}
	children.sort((a, b) => a.name.localeCompare(b.name));
	return {
		name,
		aliases,
		description: command.description ?? "",
		flags: buildFlags(command),
		args: buildArgs(command),
		children,
	};
}

// --- Shared helpers -----------------------------------------------------------

/** Every value source except a bare boolean flag consumes the following token. */
function takesValue(v: ValueSource): boolean {
	return v.kind !== "flag";
}

/** All token forms (`name` + aliases) under which a subcommand can be invoked. */
function commandTokens(c: CompletionCommand): string[] {
	return [c.name, ...c.aliases];
}

interface CompletionScope {
	id: string;
	flags: CompletionFlag[];
	args: CompletionArg[];
	children: { command: CompletionCommand; id: string }[];
}

/** Flatten the registration tree once, retaining each child's exact parent. */
function completionScopes(spec: CompletionSpec): CompletionScope[] {
	const scopes: CompletionScope[] = [];
	function visit(flags: CompletionFlag[], args: CompletionArg[], children: CompletionCommand[]): string {
		const id = String(scopes.length);
		const help: CompletionFlag = {
			name: "help",
			char: "h",
			description: "Show help",
			value: { kind: "flag" },
			repeatable: false,
		};
		const implicit = [help];
		if (id === "0") {
			implicit.push({
				name: "version",
				char: "v",
				description: "Show version",
				value: { kind: "flag" },
				repeatable: false,
			});
		}
		const scope: CompletionScope = {
			id,
			flags: [...flags, ...implicit.filter(flag => !flags.some(f => f.name === flag.name))],
			args,
			children: [],
		};
		scopes.push(scope);
		scope.children = children.map(command => ({
			command,
			id: visit(command.flags, command.args, command.children),
		}));
		return id;
	}
	visit(spec.root.flags, spec.root.args, spec.commands);
	return scopes;
}

function flagTokens(flag: CompletionFlag): string[] {
	return [`--${flag.name}`, ...(flag.char ? [`-${flag.char}`] : [])];
}

export function generateCompletion(shell: Shell, spec: CompletionSpec): string {
	switch (shell) {
		case "bash":
			return generateBash(spec);
		case "zsh":
			return generateZsh(spec);
		case "fish":
			return generateFish(spec);
	}
}

// --- bash ---------------------------------------------------------------------

/** Escape for use inside a bash double-quoted `compgen -W "…"` word list. */
function bashWords(values: readonly string[]): string {
	return values.join(" ").replace(/"/g, '\\"');
}

/** bash snippet that fills COMPREPLY for a flag value, then `return 0`. */
function bashValueBranch(bin: string, v: ValueSource): string {
	switch (v.kind) {
		case "flag":
		case "value":
			return "return 0";
		case "enum":
			return `COMPREPLY=( $(compgen -W "${bashWords(v.values)}" -- "$cur") ); return 0`;
		case "list":
			return `_npi_comma "${bashWords(v.values)}"; return 0`;
		case "models":
			return v.multiple
				? `_npi_comma "$(command ${bin} __complete models 2>/dev/null | cut -f1)"; return 0`
				: `COMPREPLY=( $(compgen -W "$(command ${bin} __complete models -- "$cur" 2>/dev/null | cut -f1)" -- "$cur") ); return 0`;
		case "sessions":
			return `COMPREPLY=( $(compgen -W "$(command ${bin} __complete sessions -- "$cur" 2>/dev/null | cut -f1)" -- "$cur") ); return 0`;
		case "file":
			return `COMPREPLY=( $(compgen -f -- "$cur") ); compopt -o filenames; return 0`;
		case "dir":
			return `COMPREPLY=( $(compgen -d -- "$cur") ); compopt -o filenames; return 0`;
	}
}

/** Build the `case "$prev" in …` arms for every value-taking flag in scope. */
function bashFlagCase(bin: string, flags: CompletionFlag[]): string {
	const lines: string[] = [];
	for (const f of flags) {
		if (!takesValue(f.value)) continue;
		const labels = [`--${f.name}`, ...(f.char ? [`-${f.char}`] : [])];
		lines.push(`\t\t${labels.join("|")})\n\t\t\t${bashValueBranch(bin, f.value)}\n\t\t\t;;`);
	}
	return lines.join("\n");
}

function bashFlagWords(flags: CompletionFlag[]): string {
	const words: string[] = [];
	for (const f of flags) {
		words.push(`--${f.name}`);
		if (f.char) words.push(`-${f.char}`);
	}
	return words.join(" ");
}

function generateBash(spec: CompletionSpec): string {
	const { bin } = spec;
	const parts: string[] = [];
	parts.push(`# bash completion for ${bin} — generated by \`${bin} completions bash\``);
	parts.push("");

	// Comma-aware static/dynamic list completion helper.
	parts.push(`_npi_comma() {
	local words="$1" realcur prefix
	realcur="\${cur##*,}"
	prefix="\${cur%"$realcur"}"
	local -a matches
	matches=( $(compgen -W "$words" -- "$realcur") )
	local i
	for (( i=0; i < \${#matches[@]}; i++ )); do matches[i]="$prefix\${matches[i]}"; done
	COMPREPLY=( "\${matches[@]}" )
	compopt -o nospace 2>/dev/null
}`);
	parts.push("");

	const scopes = completionScopes(spec);
	for (const scope of scopes) {
		const childWords = scope.children.flatMap(child => commandTokens(child.command));
		const firstValue = scope.args[0]?.value;
		const positionalWords = [...new Set([...childWords, ...(firstValue?.kind === "enum" ? firstValue.values : [])])];
		const argCases = scope.args.map(
			(arg, index) => `\t\t${arg.multiple ? `${index}|*` : index}) ${bashValueBranch(bin, arg.value)} ;;`,
		);
		parts.push(`_npi_scope_${scope.id}() {
	case "$pending" in
${bashFlagCase(bin, scope.flags)}
	esac
	if [[ "$cur" == -* && "$endopts" == 0 ]]; then
		COMPREPLY=( $(compgen -W "${bashFlagWords(scope.flags)}" -- "$cur") )
		return
	fi
	if [[ "$position" == 0 && "$endopts" == 0 && -n "${bashWords(childWords)}" ]]; then
		COMPREPLY=( $(compgen -W "${bashWords(positionalWords)}" -- "$cur") )
		return
	fi
	case "$position" in
${argCases.join("\n")}
	esac
}`);
	}
	const shortCases = scopes.flatMap(scope =>
		scope.flags
			.filter(f => f.char)
			.map(
				f =>
					`\t\t${scope.id}:${f.char}) ${
						takesValue(f.value)
							? `pending="-${f.char}"; attached="\${token:j+1}"; short_prefix="\${token:0:j+1}"; return`
							: ":"
					} ;;`,
			),
	);
	parts.push(`_npi_short_value() {
	local token="$1" j char
	pending=""; attached=""; short_prefix=""
	for (( j=1; j < \${#token}; j++ )); do
		char="\${token:j:1}"
		case "$scope:$char" in
${shortCases.join("\n")}
			*) return ;;
		esac
	done
}`);
	const valueCases = scopes.flatMap(scope =>
		scope.flags
			.filter(f => takesValue(f.value))
			.map(
				f =>
					`\t\t${flagTokens(f)
						.map(token => `${scope.id}:${token}`)
						.join("|")}) pending="$token"; continue ;;`,
			),
	);
	const childCases = scopes.flatMap(scope =>
		scope.children.map(
			child =>
				`\t\t${commandTokens(child.command)
					.map(token => `${scope.id}:${token}`)
					.join("|")}) scope=${child.id}; position=0; continue ;;`,
		),
	);
	parts.push(`_npi() {
	local cur pending="" scope=0 position=0 endopts=0 token i prefix=""
	local fragment previous="" remaining gap joined offset=0 cword attached="" short_prefix="" replacement=""
	local -a words=()
	COMPREPLY=()
	# Readline splits = and : into COMP_WORDS fragments. Rejoin adjacent
	# fragments, but retain where Readline's current replacement word begins.
	remaining="\${COMP_LINE:0:\${COMP_POINT:-\${#COMP_LINE}}}"
	for (( i=0; i <= COMP_CWORD; i++ )); do
		fragment="\${COMP_WORDS[i]}"; gap=""
		if [[ -n "$COMP_LINE" && -n "$fragment" ]]; then
			gap="\${remaining%%"$fragment"*}"
			remaining="\${remaining#*"$fragment"}"
		fi
		joined=0
		if (( \${#words[@]} )) && [[ -n "$fragment" && -z "$gap" ]]; then
			if [[ "$fragment" == =* || "$fragment" == :* || "$previous" == *= || "$previous" == *: ]]; then
				joined=1
			fi
		fi
		if (( joined )); then
			offset="\${#words[\${#words[@]}-1]}"
			words[\${#words[@]}-1]+="$fragment"
			# Readline inserts after an equals-only current fragment, retaining =.
			if (( i == COMP_CWORD )) && [[ "$fragment" == = ]]; then offset=$((offset + 1)); fi
		else
			offset=0
			words+=( "$fragment" )
		fi
		previous="$fragment"
	done
	cword=$((\${#words[@]} - 1))
	cur="\${words[cword]}"
	replacement="\${cur:0:offset}"
	for (( i=1; i < cword; i++ )); do
		token="\${words[i]}"
		if [[ -n "$pending" ]]; then pending=""; continue; fi
		if [[ "$endopts" == 0 ]]; then
			if [[ "$token" == -- ]]; then endopts=1; continue; fi
			case "$scope:$token" in
${valueCases.join("\n")}
			esac
			if [[ "$token" == -?* && "$token" != --* ]]; then
				_npi_short_value "$token"
				if [[ -n "$attached" ]]; then pending=""; fi
				continue
			fi
			if [[ "$token" == -* ]]; then continue; fi
			if [[ "$position" == 0 ]]; then
				case "$scope:$token" in
${childCases.join("\n")}
				esac
			fi
		fi
		position=$((position + 1))
	done
	if [[ "$endopts" == 0 && -z "$pending" ]]; then
		if [[ "$cur" == --*=* ]]; then
			pending="\${cur%%=*}"; prefix="$pending="; cur="\${cur#*=}"
		elif [[ "$cur" == -?* && "$cur" != --* ]]; then
			_npi_short_value "$cur"
			if [[ -n "$pending" ]]; then prefix="$short_prefix"; cur="$attached"; fi
		fi
	fi
	_npi_scope_$scope
	for (( i=0; i < \${#COMPREPLY[@]}; i++ )); do
		COMPREPLY[i]="$prefix\${COMPREPLY[i]}"
		if [[ -n "$replacement" && "\${COMPREPLY[i]}" == "$replacement"* ]]; then
			COMPREPLY[i]="\${COMPREPLY[i]#"$replacement"}"
		fi
	done
}
complete -F _npi ${bin}`);
	parts.push("");
	return `${parts.join("\n")}\n`;
}

// --- zsh ----------------------------------------------------------------------

/** Sanitize a description for embedding in a single-quoted zsh `_arguments` spec. */
function zshDesc(s: string): string {
	return s
		.replace(/'/g, "’")
		.replace(/\[/g, "(")
		.replace(/\]/g, ")")
		.replace(/[\r\n]+/g, " ")
		.replace(/:/g, " ")
		.trim();
}

function zshAction(v: ValueSource): string {
	switch (v.kind) {
		case "flag":
			return "";
		case "value":
			return ":value:";
		case "enum":
			return `:value:(${v.values.join(" ")})`;
		case "list":
			return ":value:_npi_tools";
		case "models":
			return v.multiple ? ":models:_npi_models_list" : ":model:_npi_call models";
		case "sessions":
			return ":session:_npi_call sessions";
		case "file":
			return ":file:_files";
		case "dir":
			return ":dir:_files -/";
	}
}

function zshFlagSpec(f: CompletionFlag): string {
	const body = `[${zshDesc(f.description)}]${zshAction(f.value)}`;
	const prefix = f.repeatable ? "*" : f.char ? `(-${f.char} --${f.name})` : "";
	const long = `'${prefix}--${f.name}${takesValue(f.value) ? "=" : ""}${body}'`;
	if (!f.char) return long;
	const short = `'${prefix}-${f.char}${takesValue(f.value) ? "+" : ""}${body}'`;
	return `${short} ${long}`;
}

function zshArgSpec(f: CompletionArg): string {
	const action = zshAction(f.value).replace(/^:[^:]*:/, "");
	return `'${f.multiple ? "*" : ""}:${f.name}:${action}'`;
}

function generateZsh(spec: CompletionSpec): string {
	const { bin } = spec;
	// The `:value:_npi_tools` action references this helper; bake its candidates
	// from the spec's `list` flag so the generator stays a pure function of its
	// input (bash/fish read `v.values` inline for the same reason).
	const scopes = completionScopes(spec);
	const listFlag = scopes.flatMap(scope => scope.flags).find(f => f.value.kind === "list");
	const toolNames = listFlag?.value.kind === "list" ? listFlag.value.values.join(" ") : "";
	const parts: string[] = [];
	parts.push(`#compdef ${bin}`);
	parts.push(`# zsh completion for ${bin} — generated by \`${bin} completions zsh\``);
	parts.push("");

	// Dynamic helpers (single source: `<bin> __complete <kind>` → value<TAB>desc).
	parts.push(`_npi_call() {
	# zsh's _arguments invokes an action function with the compadd options it
	# computed prepended ($subopts, then $expl — _arguments:465), so $1 is
	# "-J" in a stock setup and the kind arrives last. Read it from the end:
	# the prepended options can be either flags or option/value pairs.
	local kind=\${argv[-1]}
	local -a items
	local line
	for line in "\${(@f)$(command ${bin} __complete $kind -- "$PREFIX" 2>/dev/null)}"; do
		[[ -z $line ]] && continue
		items+=( "\${line//$'\\t'/:}" )
	done
	_describe -t "$kind" "$kind" items
}
_npi_models_list() {
	local -a items
	local line
	for line in "\${(@f)$(command ${bin} __complete models 2>/dev/null)}"; do
		[[ -z $line ]] && continue
		items+=( "\${line%%$'\\t'*}" )
	done
	_values -s , 'models' $items
}
_npi_tools() { _values -s , 'tools' ${toolNames} }`);
	parts.push("");
	const pendingCases = scopes.flatMap(scope =>
		scope.flags
			.filter(f => takesValue(f.value))
			.map(
				f =>
					`\t\t\t${flagTokens(f)
						.map(token => `${scope.id}:${token}`)
						.join("|")}) pending=1; continue ;;`,
			),
	);
	const shortCases = scopes.flatMap(scope =>
		scope.flags
			.filter(f => f.char)
			.map(
				f =>
					`\t\t\t\t${scope.id}:${f.char}) ${takesValue(f.value) ? `(( j == \${#token} )) && pending=1; break` : ":"} ;;`,
			),
	);
	parts.push(`_npi_terminated() {
	local scope="$1" token char pending=0 i j
	for ((i=2; i<CURRENT; i++)); do
		token="$words[i]"
		if (( pending )); then pending=0; continue; fi
		[[ "$token" == -- ]] && return 0
		case "$scope:$token" in
${pendingCases.join("\n")}
		esac
		[[ "$token" == --* ]] && continue
		if [[ "$token" == -?* ]]; then
			for ((j=2; j<=\${#token}; j++)); do
				char="$token[j]"
				case "$scope:$char" in
${shortCases.join("\n")}
					*) break ;;
				esac
			done
			continue
		fi
		return 1
	done
	return 1
}`);
	parts.push("");

	for (const scope of scopes) {
		const rows = scope.children.flatMap(({ command }) =>
			commandTokens(command).map(token => `\t\t'${token}:${zshDesc(command.description)}'`),
		);
		if (scope.children.length && scope.args[0]?.value.kind === "enum") {
			const registered = new Set(scope.children.flatMap(child => commandTokens(child.command)));
			for (const value of scope.args[0].value.values) {
				if (!registered.has(value)) rows.push(`\t\t'${value}:${zshDesc(scope.args[0].description)}'`);
			}
		}
		if (rows.length) {
			parts.push(`_npi_children_${scope.id}() {
	local -a commands
	commands=(
${rows.join("\n")}
	)
	_describe -t commands 'command' commands
}`);
		}
		const specs = [
			...scope.flags.map(zshFlagSpec),
			...(scope.children.length
				? [`'1:command:_npi_children_${scope.id}'`, "'*::arg:->args'"]
				: scope.args.map(zshArgSpec)),
		];
		const arms = scope.children.map(
			child => `\t\t${commandTokens(child.command).join("|")}) _npi_scope_${child.id} ;;`,
		);
		parts.push(`_npi_scope_${scope.id}() {
	local curcontext="$curcontext" state line
	typeset -A opt_args
	${
		scope.children.length
			? `if _npi_terminated ${scope.id}; then
		${scope.args.length ? `_arguments -s -S ${scope.args.map(zshArgSpec).join(" ")}\n\t\t` : ""}return
	fi`
			: ""
	}
	_arguments -C -s -S \\
		${specs.join(" \\\n\t\t")}
	${
		scope.children.length
			? `if [[ "$state" == args ]]; then
		case "$line[1]" in
${arms.join("\n")}
		${scope.args.length > 1 ? `*) _arguments -s -S ${scope.args.slice(1).map(zshArgSpec).join(" ")} ;;` : ""}
		esac
	fi`
			: ""
	}
}`);
	}
	parts.push(`_npi() { _npi_scope_0 "$@"; }
# Works both ways: autoloaded from $fpath (file named _npi) or eval'd from a
# startup file. When autoloaded, funcstack[1] is _npi and we invoke it; when
# sourced/eval'd we register it with compdef instead.
if [ "$funcstack[1]" = "_npi" ]; then
	_npi "$@"
else
	compdef _npi ${bin}
fi`);
	parts.push("");
	return `${parts.join("\n")}\n`;
}

// --- fish ---------------------------------------------------------------------

function fishDesc(s: string): string {
	return s
		.replace(/'/g, "’")
		.replace(/[\r\n]+/g, " ")
		.trim();
}

function fishValue(bin: string, v: ValueSource): string {
	switch (v.kind) {
		case "flag":
			return "";
		case "value":
			return "-x";
		case "enum":
		case "list":
			return `-x -a '${v.values.join(" ")}'`;
		case "models":
			return `-x -a '(command ${bin} __complete models -- (commandline -ct))'`;
		case "sessions":
			return `-x -a '(command ${bin} __complete sessions -- (commandline -ct))'`;
		case "file":
			return "-r -F";
		case "dir":
			return "-x -a '(__fish_complete_directories (commandline -ct))'";
	}
}

function fishFlagLine(bin: string, cond: string, f: CompletionFlag): string {
	const segs = [`complete -c ${bin}`, `-n '${cond}'`];
	if (f.char) segs.push(`-s ${f.char}`);
	segs.push(`-l ${f.name}`);
	if (f.description) segs.push(`-d '${fishDesc(f.description)}'`);
	const val = fishValue(bin, f.value);
	if (val) segs.push(val);
	return segs.join(" ");
}

function generateFish(spec: CompletionSpec): string {
	const { bin } = spec;
	const lines: string[] = [];
	lines.push(`# fish completion for ${bin} — generated by \`${bin} completions fish\``);
	lines.push("");

	const scopes = completionScopes(spec);
	const shortCases = scopes.flatMap(scope =>
		scope.flags
			.filter(f => f.char)
			.map(
				f =>
					`\t\t\tcase ${scope.id}:${f.char}\n\t\t\t\t${
						takesValue(f.value)
							? `printf '%s\\n' -${f.char} (string sub -s 1 -l $index -- $token) (string sub -s (math $index + 1) -- $token)\n\t\t\t\treturn`
							: "true"
					}`,
			),
	);
	lines.push(`function __fish_npi_short_value
	set -l scope $argv[1]
	set -l token $argv[2]
	string match -q -- '-*' "$token"; and test (string length -- "$token") -gt 1; or return
	string match -q -- '--*' "$token"; and return
	set -l index 2
	while test $index -le (string length -- $token)
		set -l char (string sub -s $index -l 1 -- $token)
		switch "$scope:$char"
${shortCases.join("\n")}
			case '*'
				return
		end
		set index (math $index + 1)
	end
end`);
	const values = scopes.flatMap(scope =>
		scope.flags
			.filter(f => takesValue(f.value))
			.map(
				f =>
					`\t\t\t\tcase ${flagTokens(f)
						.map(token => `${scope.id}:${token}`)
						.join(" ")}
\t\t\t\t\tset pending $token
\t\t\t\t\tcontinue`,
			),
	);
	const children = scopes.flatMap(scope =>
		scope.children.map(
			child =>
				`\t\t\t\t\tcase ${commandTokens(child.command)
					.map(token => `${scope.id}:${token}`)
					.join(" ")}
\t\t\t\t\t\tset scope ${child.id}
\t\t\t\t\t\tset position 0
\t\t\t\t\t\tcontinue`,
		),
	);
	lines.push(`function __fish_npi_context
	set -l scope 0
	set -l position 0
	set -l pending none
	set -l endopts 0
	set -l tokens (commandline -opc)
	for token in $tokens[2..-1]
		if test "$pending" != none
			set pending none
			continue
		end
		if test $endopts = 0
			if test "$token" = --
				set endopts 1
				continue
			end
			switch "$scope:$token"
${values.join("\n")}
			end
			if string match -q -- '-*' "$token"; and test (string length -- "$token") -gt 1; and not string match -q -- '--*' "$token"
				set -l short (__fish_npi_short_value $scope "$token")
				if test (count $short) -ge 2; and test "$short[2]" = "$token"
					set pending $short[1]
				end
				continue
			end
			if string match -q -- '-*' "$token"
				continue
			end
			if test $position = 0
				switch "$scope:$token"
${children.join("\n")}
				end
			end
		end
		set position (math $position + 1)
	end
	printf '%s\\n' $scope $position "$pending" $endopts
end
function __fish_npi_scope
	set -l context (__fish_npi_context)
	test "$context[1]" = "$argv[1]"; and test "$context[4]" = 0
end
function __fish_npi_arg
	set -l context (__fish_npi_context)
	test "$context[1]" = "$argv[1]"; or return 1
	test "$context[3]" = none; or return 1
	string match -q -- '-*' (commandline -ct); and test "$context[4]" = 0; and return 1
	if test "$argv[3]" = multiple
		test "$context[2]" -ge "$argv[2]"
	else
		test "$context[2]" = "$argv[2]"
	end
end`);
	lines.push(`function __fish_npi_attached
	set -l context (__fish_npi_context)
	test "$context[1]" = "$argv[1]"; and test "$context[3]" = none; and test "$context[4]" = 0; or return 1
	set -l short (__fish_npi_short_value $context[1] (commandline -ct))
	test (count $short) -ge 2; and test "$short[1]" = "$argv[2]"
end
function __fish_npi_attached_values
	set -l context (__fish_npi_context)
	set -l short (__fish_npi_short_value $context[1] (commandline -ct))
	set -l partial ""
	if test (count $short) -ge 3
		set partial $short[3]
	end
	for value in $argv
		if string match -q -- "$partial*" "$value"
			printf '%s\\n' "$short[2]$value"
		end
	end
end`);
	lines.push(`complete -c ${bin} -f`);
	for (const scope of scopes) {
		const cond = `__fish_npi_scope ${scope.id}`;
		for (const flag of scope.flags) {
			lines.push(fishFlagLine(bin, cond, flag));
			if (flag.char && flag.value.kind === "enum") {
				lines.push(
					`complete -c ${bin} -f -n '__fish_npi_attached ${scope.id} -${flag.char}' -a '(__fish_npi_attached_values ${flag.value.values.join(" ")})'`,
				);
			}
		}
		for (const child of scope.children) {
			for (const token of commandTokens(child.command)) {
				lines.push(
					`complete -c ${bin} -f -n '__fish_npi_arg ${scope.id} 0 single; and ${cond}' -a '${token}' -d '${fishDesc(child.command.description)}'`,
				);
			}
		}
		for (const [index, arg] of scope.args.entries()) {
			const argCond = `__fish_npi_arg ${scope.id} ${index} ${arg.multiple ? "multiple" : "single"}`;
			if (arg.value.kind === "enum") {
				lines.push(
					`complete -c ${bin} -f -n '${argCond}' -a '${arg.value.values.join(" ")}' -d '${fishDesc(arg.description)}'`,
				);
			} else if (arg.value.kind === "file") {
				lines.push(`complete -c ${bin} -F -n '${argCond}'`);
			}
		}
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}
