/**
 * InspectorPanel — detail pane for the selected extension.
 *
 * One inspection grammar for every kind:
 * identity → runtime/enablement → description → origin →
 * kind-specific surface → contents → boring config.
 */
import { t } from "@oh-my-pi/pi-utils/i18n";
import * as os from "node:os";
import type { TspSpan, TspText } from "@oh-my-pi/pi-wire";
import type { Component } from "../../tui";
import { code, col, compact, keyed, kv, node, span, stableKey, text } from "../../native/describe";
import type { NativeChild, NativeNode } from "../../native/node";
import { visibleWidth, wrapTextWithAnsi } from "../../utils";
import { KeyValueList } from "../../components/key-value-list";
import { Section } from "../../components/section";
import { renderTableRow } from "../../components/table";
import { theme } from "../../theme";
import { divider } from "../../chrome/overlay-box";
import { expandKeyHint, PREVIEW_LIMITS, replaceTabs, shortenPath } from "../../render/render-utils";
import {
	sanitizeDisplayField,
	sanitizeDisplayLine,
	sanitizeDisplayLineField,
	sanitizeDisplayText,
} from "./display-text";
import {
	commandInspectorData,
	type ExtensionInspectorSource,
	contextInspectorData,
	enablementLabel,
	hookInspectorData,
	instructionInspectorData,
	liveToolsForExtension,
	promptInspectorData,
	ruleInspectorData,
	skillInspectorData,
	type ToolParamView,
	type ToolRuntimeSource,
	toolInspectorData,
	toolParamsFromSchema,
} from "./inspector-model";
import { snapshotToolRuntimeSource } from "./live-tool-session";
import {
	formatMcpHealthLabel,
	isDiscoveredMcpServer,
	type MCPConnectionHealth,
	type MCPRuntimeCatalogItem,
	type MCPRuntimeSource,
	snapshotMcpRuntime,
	visibleMcpTools,
} from "./mcp-runtime";
import { type Extension, type ExtensionState, isShadowedExtension } from "./types";

export type { ToolRuntimeSource };

interface KindView {
	title?: string;
	description?: string;
	/** MCP `initialize.instructions`. Rendered under description, not as a footer. */
	guidance?: string;
	runtimeLine?: string;
	runtimeExtra?: string[];
	surface: string[];
	contents: string[];
	preview?: { heading: string; text: string };
	config: string[];
}

/** {@link KindView} as native nodes: the same grammar, semantic instead of pre-styled lines. */
interface NativeKindView {
	title?: string;
	description?: string;
	guidance?: string;
	/** Runtime facts ahead of the enablement status (MCP health, server, website, skill visibility). */
	runtime: [string, TspText | undefined][];
	/** The runtime facts carry a health line: the status shows only when not active (the ANSI `runtimeLine`). */
	health?: boolean;
	sections: NativeNode[];
	preview?: { heading: string; text: string };
	config: [string, TspText | undefined][];
}

const MCP_HEALTH_STYLE: Record<MCPConnectionHealth, string> = {
	connected: "success",
	connecting: "muted",
	disconnected: "dim",
	inactive: "warning",
};

const PREVIEW_LINE_BUDGET = PREVIEW_LIMITS.EXPANDED_LINES;
const MCP_TOOL_BUDGET = PREVIEW_LIMITS.COLLAPSED_ITEMS;
const MCP_INLINE_ARG_LIMIT = 3;
const MCP_INLINE_DESC_LINES = 3;

export interface InspectorPanelNavigation {
	expanded: boolean;
}

export class InspectorPanel implements Component {
	#extension: Extension | null = null;
	#extensionKey: string | null = null;
	#mcpSource: MCPRuntimeSource | undefined;
	#toolSource: ToolRuntimeSource | undefined;
	#toolFrame: ToolRuntimeSource | undefined;
	#expanded = false;
	#width = 72;
	#height = 0;

	readonly #source: ExtensionInspectorSource | undefined;

	constructor(source?: ExtensionInspectorSource) {
		this.#source = source;
	}

	setExtension(extension: Extension | null): void {
		const key = inspectorExtensionKey(extension);
		if (key !== this.#extensionKey) {
			this.#expanded = false;
			this.#extensionKey = key;
		}
		this.#extension = extension;
	}

	setMcpSource(source: MCPRuntimeSource | undefined): void {
		this.#mcpSource = source;
	}

	setToolSource(source: ToolRuntimeSource | undefined): void {
		this.#toolSource = source;
	}

	setHeight(height: number): void {
		this.#height = Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
	}

	isExpanded(): boolean {
		return this.#expanded;
	}

	toggleExpanded(): boolean {
		this.#expanded = !this.#expanded;
		return this.#expanded;
	}

	navigationSnapshot(): InspectorPanelNavigation {
		return { expanded: this.#expanded };
	}

	restoreNavigation(snapshot: unknown): void {
		if (typeof snapshot !== "object" || snapshot === null) return;
		this.#expanded = (snapshot as Partial<InspectorPanelNavigation>).expanded === true;
	}

	invalidate(): void {}

	render(width: number): readonly string[] {
		if (!this.#extension) {
			return [
				theme.fg("muted", t("overlays.inspector_panel.select_extension")),
				theme.fg("dim", t("overlays.inspector_panel.view_details")),
			];
		}
		this.#width = width;
		this.#toolFrame = snapshotToolRuntimeSource(this.#toolSource);
		return this.#renderExtension(this.#extension, width);
	}

	/**
	 * The selected extension as native preview nodes, in the same order as
	 * {@link render}: identity, runtime/enablement and origin facts,
	 * description, guidance, kind sections, content preview, config. The
	 * collapsed budgets follow {@link toggleExpanded} like the ANSI view.
	 */
	describePreview(): NativeNode[] {
		const ext = this.#extension;
		if (!ext) {
			return [text([span(t("overlays.inspector_panel.select_extension_details"), "muted")], { wrap: "word" })];
		}
		this.#toolFrame = snapshotToolRuntimeSource(this.#toolSource);
		const view = this.#nativeKindView(ext);
		const name = sanitizeDisplayLine(ext.displayName);
		const title = sanitizeDisplayLineField(view.title);
		const levelLabel =
			ext.source.level === "user"
				? t("overlays.inspector_panel.source_user")
				: ext.source.level === "project"
					? t("overlays.inspector_panel.source_project")
					: t("overlays.inspector_panel.source_native");
		const filePath = sanitizeDisplayText(ext.path);
		const facts = kv([
			...view.runtime,
			[
				t("overlays.inspector_panel.status"),
				view.health && ext.state === "active" ? undefined : this.#nativeStatus(ext),
			],
			[
				t("overlays.inspector_panel.origin"),
				t("overlays.inspector_panel.origin_provider", {
					providerName: `${sanitizeDisplayLine(ext.source.providerName)}`,
					levelLabel: `${levelLabel}`,
				}),
			],
			[
				t("overlays.inspector_panel.path"),
				[
					span(
						sanitizeDisplayText(shortenPath(ext.path, os.homedir())),
						"path dim",
						filePath.startsWith("/") ? { href: `file://${filePath}` } : undefined,
					),
				],
			],
		]);
		const out: NativeNode[] = compact<NativeNode>([
			node("text", { text: name, role: "omp.picker.title" }, undefined, "title"),
			title && title !== name ? node("text", { spans: [span(title, "muted")] }, undefined, "subtitle") : undefined,
			facts && keyed(facts, "facts"),
			this.#nativeShortText(view.description, "description"),
			this.#nativeShortText(view.guidance, "guidance"),
			...view.sections,
		]);
		if (view.preview) out.push(this.#nativePreviewSection(view.preview.heading, view.preview.text));
		const config = kv(view.config);
		if (config) out.push(keyed(config, "config"));
		return out;
	}

	#nativeStatus(ext: Extension): TspSpan[] {
		switch (ext.state) {
			case "active":
				return [span(`${theme.status.enabled} ${enablementLabel(ext.state)}`, "success")];
			case "disabled":
				return [span(`${theme.status.disabled} ${enablementLabel(ext.state, ext.disabledReason)}`, "dim")];
			case "shadowed":
				return [
					span(
						`${theme.status.shadowed} ${enablementLabel(ext.state, ext.disabledReason, ext.shadowedBy)}`,
						"warning",
					),
				];
		}
	}

	/** Description/guidance prose, clamped to the inline budget until expanded. */
	#nativeShortText(value: string | undefined, key: string): NativeNode | undefined {
		const cleaned = sanitizeDisplayField(value);
		if (!cleaned) return undefined;
		return node(
			"text",
			{
				text: sanitizeDisplayText(cleaned),
				wrap: "word",
				lines: this.#expanded ? undefined : MCP_INLINE_DESC_LINES,
			},
			undefined,
			key,
		);
	}

	#nativeSection(head: string, children: readonly NativeChild[]): NativeNode {
		return node("section", { head: [span(head, "muted")] }, children, stableKey(`section:${head}`));
	}

	/** File content as markdown source, cut to the preview budget until expanded. */
	#nativePreviewSection(heading: string, raw: string): NativeNode {
		if (!raw) return this.#nativeSection(heading, [text([span("(empty)", "dim")])]);
		const lines = sanitizeDisplayText(raw).split("\n");
		const cut = !this.#expanded && lines.length > PREVIEW_LINE_BUDGET;
		const shown = cut ? lines.slice(0, PREVIEW_LINE_BUDGET - 1) : lines;
		const children: NativeChild[] = [code(shown.join("\n"), { lang: "md", wrap: true })];
		if (cut) children.push(this.#nativeMore(lines.length - shown.length, "lines"));
		return this.#nativeSection(heading, children);
	}

	#nativeMore(hidden: number, noun: string): NativeNode {
		return text([
			span(
				t("overlays.inspector_panel.more_items_expand", {
					hidden: `${hidden}`,
					noun: `${noun}`,
					expandKeyHint: `${expandKeyHint()}`,
				}),
				"dim",
			),
		]);
	}

	/** Tool/argument rows: name, type and required flag, then the description. */
	#nativeParams(params: ToolParamView[]): NativeNode {
		if (params.length === 0) return text([span(t("overlays.inspector_panel.no_arguments"), "dim")]);
		return node("kv", {
			items: params.map(param => ({
				k: [span(param.name, "accent mono")],
				v: compact<TspSpan>([
					span(param.type, "muted"),
					span(`  ${param.flag}`, param.required ? "warning" : "dim"),
					param.description ? span(`  ${sanitizeDisplayLine(param.description)}`) : undefined,
				]),
			})),
		});
	}

	/** One catalog entry (MCP tool or factory tool): name, title, description, arguments. */
	#nativeCatalogEntry(
		name: string,
		title: string | undefined,
		description: string | undefined,
		parameters: unknown,
	): NativeNode {
		const params = toolParamsFromSchema(parameters);
		const inline = this.#expanded || params.length <= MCP_INLINE_ARG_LIMIT;
		return col(
			compact<NativeChild>([
				text(
					compact<TspSpan>([
						span(sanitizeDisplayLine(name), "accent mono"),
						title && title !== name ? span(`  ${sanitizeDisplayLine(title)}`, "muted") : undefined,
					]),
				),
				description ? text(sanitizeDisplayText(description), { wrap: "word" }) : undefined,
				inline
					? this.#nativeParams(params)
					: text([
							span(
								t("overlays.inspector_panel.args_expand", {
									length: `${params.length}`,
									expandKeyHint: `${expandKeyHint()}`,
								}),
								"dim",
							),
						]),
			]),
			{ gap: "xs" },
		);
	}

	/** A name-only catalog (MCP resources/prompts) under its budget until expanded. */
	#nativeNameList(head: string, entries: MCPRuntimeCatalogItem[]): NativeNode {
		const { shown, hidden } = visibleMcpTools(entries, this.#expanded ? entries.length : MCP_TOOL_BUDGET);
		const children: NativeChild[] = shown.map(entry => text([span(entry.name, "accent mono")]));
		if (hidden > 0) children.push(this.#nativeMore(hidden, ""));
		return this.#nativeSection(head, children);
	}

	#nativeKindView(ext: Extension): NativeKindView {
		const base: NativeKindView = { runtime: [], sections: [], config: [] };
		switch (ext.kind) {
			case "mcp":
				return this.#nativeMcpKind(ext);
			case "tool": {
				const lives = liveToolsForExtension(ext, this.#toolFrame);
				const data = toolInspectorData(ext, lives, this.#source);
				if (data.factory.length > 1) {
					return {
						...base,
						description: data.description,
						sections: [
							this.#nativeSection(
								t("settings.tab.tools.label"),
								data.factory.map(tool =>
									this.#nativeCatalogEntry(tool.name, tool.label, tool.description, tool.parameters),
								),
							),
						],
					};
				}
				if (lives.length === 0 && data.params.length === 0) return { ...base, description: data.description };
				return {
					...base,
					title: data.label,
					description: data.description,
					sections: [
						this.#nativeSection(t("overlays.inspector_panel.arguments"), [this.#nativeParams(data.params)]),
					],
				};
			}
			case "rule": {
				const data = ruleInspectorData(ext, this.#source);
				const applies = kv([
					["always", data.alwaysApply ? [span(t("overlays.inspector_panel.always"), "accent")] : undefined],
					["globs", data.globs?.join(", ")],
					["condition", this.#nativeList(data.condition)],
					["ast", this.#nativeList(data.astCondition)],
					["scope", this.#nativeList(data.scope)],
					[t("tools.count.agent.many"), this.#nativeList(data.agents)],
					["interrupt", data.interruptMode ? [span(data.interruptMode, "dim")] : undefined],
				]);
				return {
					...base,
					description: data.description,
					sections: [
						this.#nativeSection(t("overlays.inspector_panel.applies"), [
							applies ?? text([span(t("overlays.inspector_panel.no_apply_conditions"), "dim")]),
						]),
					],
					preview: { heading: t("overlays.inspector_panel.rule"), text: data.content },
				};
			}
			case "skill": {
				const data = skillInspectorData(ext);
				const surface = kv([
					["apply", data.alwaysApply ? [span(t("overlays.inspector_panel.always_apply"), "accent")] : undefined],
					["globs", data.globs?.join(", ")],
				]);
				return {
					...base,
					description: data.description,
					runtime: data.hidden
						? [
								[
									t("overlays.inspector_panel.visibility"),
									[span("hidden", "warning"), span(t("overlays.inspector_panel.omitted_skill_list"))],
								],
							]
						: [],
					sections: surface ? [keyed(surface, "surface")] : [],
					preview: { heading: t("overlays.inspector_panel.instruction"), text: data.content },
				};
			}
			case "slash-command": {
				const data = commandInspectorData(ext);
				const invocation: NativeChild[] = [text([span(`/${sanitizeDisplayText(ext.name)}`, "accent mono")])];
				const facts = kv([
					["hint", data.argumentHint ? [span(sanitizeDisplayText(data.argumentHint), "dim")] : undefined],
				]);
				if (facts) invocation.push(facts);
				if (data.usesArguments)
					invocation.push(text([span(t("overlays.inspector_panel.accepts_arguments"), "dim")]));
				return {
					...base,
					description: data.description,
					sections: [this.#nativeSection(t("overlays.inspector_panel.invocation"), invocation)],
					preview: { heading: t("overlays.inspector_panel.template"), text: data.body },
				};
			}
			case "hook": {
				const data = hookInspectorData(ext);
				const facts = kv([
					["when", data.hookType],
					["tool", data.tool],
				]);
				return {
					...base,
					description: ext.description,
					sections: [this.#nativeSection(t("overlays.inspector_panel.hook"), facts ? [facts] : [])],
				};
			}
			case "prompt":
				return {
					...base,
					description: ext.description,
					preview: {
						heading: t("settings.option.loop.mode.prompt.label"),
						text: promptInspectorData(ext).content,
					},
				};
			case "context-file":
				return {
					...base,
					description: ext.description,
					preview: { heading: t("overlays.inspector_panel.preview"), text: contextInspectorData(ext).content },
				};
			case "instruction": {
				const data = instructionInspectorData(ext);
				const files = data.applyTo ? kv([["files", data.applyTo]]) : undefined;
				return {
					...base,
					description: ext.description,
					sections: files ? [this.#nativeSection(t("overlays.inspector_panel.applies"), [files])] : [],
					preview: { heading: t("overlays.inspector_panel.instruction"), text: data.content },
				};
			}
			default:
				return {
					...base,
					description: ext.description,
					sections: ext.trigger
						? [
								this.#nativeSection(t("overlays.inspector_panel.trigger"), [
									text([span(sanitizeDisplayText(ext.trigger), "accent mono")]),
								]),
							]
						: [],
				};
		}
	}

	/** A pattern list for a `kv` value, capped until expanded. */
	#nativeList(items: string[] | undefined): TspSpan[] | undefined {
		if (!items || items.length === 0) return undefined;
		const cap = this.#expanded ? items.length : PREVIEW_LIMITS.COLLAPSED_LINES;
		const shown = items.slice(0, cap).map(item => sanitizeDisplayText(item));
		const hidden = items.length - shown.length;
		const spans: TspSpan[] = [span(shown.join("\n"), "accent")];
		if (hidden > 0)
			spans.push(
				span(
					t("overlays.inspector_panel.more_expand_newline", {
						hidden: `${hidden}`,
						expandKeyHint: `${expandKeyHint()}`,
					}),
					"dim",
				),
			);
		return spans;
	}

	#nativeMcpKind(ext: Extension): NativeKindView {
		const shadowed = isShadowedExtension(ext);
		if (shadowed) {
			const command =
				isDiscoveredMcpServer(ext.raw) && ext.raw.command
					? shortenPath(sanitizeDisplayText(ext.raw.command), os.homedir())
					: undefined;
			return {
				runtime: [],
				sections: [],
				config: [[t("overlays.inspector_panel.command"), command ? [span(command, "mono")] : undefined]],
			};
		}
		const snap = isDiscoveredMcpServer(ext.raw)
			? snapshotMcpRuntime(ext.raw, this.#mcpSource, { enabled: ext.state !== "disabled" })
			: undefined;
		const health: MCPConnectionHealth = snap?.health ?? "disconnected";
		const runtime: [string, TspText | undefined][] = [
			[
				t("overlays.inspector_panel.health"),
				[
					span(`${MCP_HEALTH_GLYPH[health]()} ${formatMcpHealthLabel(health)}`, MCP_HEALTH_STYLE[health]),
					span(`  ${snap?.transport ?? "stdio"}`, "muted"),
				],
			],
		];
		if (snap?.implementationName) {
			const version = snap.implementationVersion ? ` ${snap.implementationVersion}` : "";
			runtime.push([t("overlays.inspector_panel.server"), [span(`${snap.implementationName}${version}`, "dim")]]);
			if (snap.websiteUrl)
				runtime.push([
					t("overlays.inspector_panel.website"),
					[span(snap.websiteUrl, "dim", { href: snap.websiteUrl })],
				]);
		}
		const sections: NativeNode[] = [];
		if (snap && snap.tools.length > 0) {
			const { shown, hidden } = visibleMcpTools(snap.tools, this.#expanded ? snap.tools.length : MCP_TOOL_BUDGET);
			const entries: NativeChild[] = shown.map(tool =>
				this.#nativeCatalogEntry(tool.name, tool.title, tool.description, tool.parameters),
			);
			if (hidden > 0) entries.push(this.#nativeMore(hidden, "tools"));
			sections.push(this.#nativeSection(t("settings.tab.tools.label"), entries));
		}
		if (snap && snap.resources.length > 0)
			sections.push(this.#nativeNameList(t("overlays.inspector_panel.resources"), snap.resources));
		if (snap && snap.prompts.length > 0)
			sections.push(this.#nativeNameList(t("overlays.inspector_panel.prompts"), snap.prompts));
		return {
			title: snap?.title,
			description: snap?.description,
			guidance: snap?.instructions,
			runtime,
			health: true,
			sections,
			config: [
				[
					t("overlays.inspector_panel.command"),
					snap?.command ? [span(shortenPath(snap.command, os.homedir()), "mono")] : undefined,
				],
				["URL", snap?.url ? [span(snap.url, "mono", { href: snap.url })] : undefined],
				[
					t("tools.common.args"),
					snap?.args && snap.args.length > 0 ? [span(snap.args.join(" "), "mono dim")] : undefined,
				],
				[
					t("overlays.inspector_panel.env_vars"),
					snap && snap.envCount > 0
						? [span(t("overlays.inspector_panel.defined_count", { envCount: `${snap.envCount}` }), "dim")]
						: undefined,
				],
			],
		};
	}

	#renderExtension(ext: Extension, width: number): string[] {
		const lines: string[] = [];
		const kind = this.#kindView(ext);

		this.#pushIdentity(lines, ext, kind.title);
		this.#pushRuntime(lines, ext, kind);
		this.#pushDescription(lines, kind.description, width);
		this.#pushGuidance(lines, kind.guidance, width);
		this.#pushOrigin(lines, ext, width);
		if (kind.surface.length > 0) lines.push(...kind.surface);
		if (kind.contents.length > 0) lines.push(...kind.contents);
		if (kind.preview) {
			const reserved = kind.config.length + 1;
			// +2 preserves the heading/rule budget the section composes around the body.
			const remaining =
				this.#height > 0 ? Math.max(4, this.#height - (lines.length + 2) - reserved) : PREVIEW_LINE_BUDGET;
			const previewBody: string[] = [];
			this.#pushPreview(previewBody, kind.preview.text, width, remaining);
			lines.push(...this.#section(kind.preview.heading, previewBody, width));
		}
		if (kind.config.length > 0) lines.push(...kind.config);
		return lines;
	}

	#kindView(ext: Extension): KindView {
		switch (ext.kind) {
			case "mcp":
				return this.#mcpKind(ext);
			case "tool":
				return this.#toolKind(ext);
			case "rule":
				return this.#ruleKind(ext);
			case "skill":
				return this.#skillKind(ext);
			case "slash-command":
				return this.#commandKind(ext);
			case "hook":
				return this.#hookKind(ext);
			case "prompt":
				return this.#promptKind(ext);
			case "context-file":
				return this.#contextKind(ext);
			case "instruction":
				return this.#instructionKind(ext);
			default:
				return this.#fallbackKind(ext);
		}
	}

	#mcpKind(ext: Extension): KindView {
		const width = this.#width;
		const shadowed = isShadowedExtension(ext);
		const snap =
			isDiscoveredMcpServer(ext.raw) && !shadowed
				? snapshotMcpRuntime(ext.raw, this.#mcpSource, { enabled: ext.state !== "disabled" })
				: undefined;
		if (shadowed) {
			const config: string[] = [];
			if (isDiscoveredMcpServer(ext.raw) && ext.raw.command) {
				this.#pushLabeled(
					config,
					t("overlays.inspector_panel.command"),
					shortenPath(ext.raw.command, os.homedir()),
					width,
					"success",
				);
			}
			if (config.length > 0) config.push("");
			return { description: undefined, surface: [], contents: [], config };
		}
		const health: MCPConnectionHealth = snap?.health ?? "disconnected";
		const transport = snap?.transport ?? "stdio";
		const runtimeLine = `${this.#mcpHealthGlyph(health)} ${formatMcpHealthLabel(health)}     ${theme.fg("muted", transport)}`;
		const runtimeExtra: string[] = [];
		if (snap?.implementationName) {
			const version = snap.implementationVersion ? ` ${snap.implementationVersion}` : "";
			runtimeExtra.push(theme.fg("dim", `${snap.implementationName}${version}`));
			if (snap.websiteUrl) runtimeExtra.push(theme.fg("dim", snap.websiteUrl));
		}
		const surface: string[] = [];
		const contents: string[] = [];
		const config: string[] = [];

		if (snap && snap.tools.length > 0) {
			const toolsBody: string[] = [];
			const { shown, hidden } = visibleMcpTools(snap.tools, this.#expanded ? snap.tools.length : MCP_TOOL_BUDGET);
			let collapsedArgs = false;
			for (const tool of shown) {
				toolsBody.push(`  ${theme.fg("accent", tool.name)}`);
				if (tool.title && tool.title !== tool.name) {
					toolsBody.push(`    ${theme.fg("muted", tool.title)}`);
				}
				if (tool.description) this.#pushWrapped(toolsBody, tool.description, width, "    ");
				const params = toolParamsFromSchema(tool.parameters);
				const inline = this.#expanded || params.length <= MCP_INLINE_ARG_LIMIT;
				if (inline) {
					this.#pushParams(toolsBody, params, width, "    ");
				} else if (params.length > 0) {
					collapsedArgs = true;
					toolsBody.push(
						`    ${theme.fg("dim", t("overlays.inspector_panel.args_count", { length: `${params.length}` }))}`,
					);
				}
				toolsBody.push("");
			}
			if (hidden > 0) {
				toolsBody.push(
					theme.fg(
						"dim",
						t("overlays.inspector_panel.more_expand_indented", {
							hidden: `${hidden}`,
							expandKeyHint: `${expandKeyHint()}`,
						}),
					),
				);
				toolsBody.push("");
			} else if (collapsedArgs) {
				toolsBody.push(
					theme.fg(
						"dim",
						t("overlays.inspector_panel.args_expand_indented", { expandKeyHint: `${expandKeyHint()}` }),
					),
				);
				toolsBody.push("");
			}
			contents.push(...this.#section(t("settings.tab.tools.label"), toolsBody, width));
		}

		if (snap && snap.resources.length > 0) {
			const resourcesBody: string[] = [];
			const { shown, hidden } = visibleMcpTools(
				snap.resources,
				this.#expanded ? snap.resources.length : MCP_TOOL_BUDGET,
			);
			for (const resource of shown) {
				resourcesBody.push(`  ${theme.fg("accent", resource.name)}`);
			}
			if (hidden > 0) {
				resourcesBody.push(
					theme.fg(
						"dim",
						t("overlays.inspector_panel.more_expand_indented", {
							hidden: `${hidden}`,
							expandKeyHint: `${expandKeyHint()}`,
						}),
					),
				);
			}
			resourcesBody.push("");
			contents.push(...this.#section(t("overlays.inspector_panel.resources"), resourcesBody, width));
		}

		if (snap && snap.prompts.length > 0) {
			const promptsBody: string[] = [];
			const { shown, hidden } = visibleMcpTools(
				snap.prompts,
				this.#expanded ? snap.prompts.length : MCP_TOOL_BUDGET,
			);
			for (const prompt of shown) {
				promptsBody.push(`  ${theme.fg("accent", prompt.name)}`);
			}
			if (hidden > 0) {
				promptsBody.push(
					theme.fg(
						"dim",
						t("overlays.inspector_panel.more_expand_indented", {
							hidden: `${hidden}`,
							expandKeyHint: `${expandKeyHint()}`,
						}),
					),
				);
			}
			promptsBody.push("");
			contents.push(...this.#section(t("overlays.inspector_panel.prompts"), promptsBody, width));
		}

		if (snap?.command)
			this.#pushLabeled(
				config,
				t("overlays.inspector_panel.command"),
				shortenPath(snap.command, os.homedir()),
				width,
				"success",
			);
		if (snap?.url) this.#pushLabeled(config, "URL", snap.url, width, "success");
		if (snap?.args && snap.args.length > 0)
			this.#pushLabeled(config, t("tools.common.args"), snap.args.join(" "), width, "dim");
		if (snap && snap.envCount > 0) {
			this.#pushLabeled(
				config,
				t("overlays.inspector_panel.env_vars"),
				t("overlays.inspector_panel.defined_count", { envCount: `${snap.envCount}` }),
				width,
				"dim",
			);
		}
		if (config.length > 0) config.push("");

		return {
			title: snap?.title,
			description: snap?.description,
			guidance: snap?.instructions,
			runtimeLine,
			runtimeExtra,
			surface,
			contents,
			config,
		};
	}

	#toolKind(ext: Extension): KindView {
		const width = this.#width;
		const lives = liveToolsForExtension(ext, this.#toolFrame);
		const data = toolInspectorData(ext, lives, this.#source);
		const surface: string[] = [];
		if (data.factory.length > 1) {
			const factoryBody: string[] = [];
			let collapsedArgs = false;
			for (const tool of data.factory) {
				factoryBody.push(`  ${theme.fg("accent", tool.name)}`);
				if (tool.label && tool.label !== tool.name) {
					factoryBody.push(`    ${theme.fg("muted", tool.label)}`);
				}
				if (tool.description) this.#pushWrapped(factoryBody, tool.description, width, "    ");
				const params = toolParamsFromSchema(tool.parameters);
				const inline = this.#expanded || params.length <= MCP_INLINE_ARG_LIMIT;
				if (inline) {
					this.#pushParams(factoryBody, params, width, "    ");
				} else if (params.length > 0) {
					collapsedArgs = true;
					factoryBody.push(
						`    ${theme.fg("dim", t("overlays.inspector_panel.args_count", { length: `${params.length}` }))}`,
					);
				}
				factoryBody.push("");
			}
			if (collapsedArgs) {
				factoryBody.push(
					theme.fg(
						"dim",
						t("overlays.inspector_panel.args_expand_indented", { expandKeyHint: `${expandKeyHint()}` }),
					),
				);
				factoryBody.push("");
			}
			surface.push(...this.#section(t("settings.tab.tools.label"), factoryBody, width));
			return { description: data.description, surface, contents: [], config: [] };
		}
		if (lives.length === 0 && data.params.length === 0) {
			return { description: data.description, surface: [], contents: [], config: [] };
		}
		const argsBody: string[] = [];
		this.#pushParams(argsBody, data.params, width, "  ");
		surface.push(...this.#section(t("overlays.inspector_panel.arguments"), argsBody, width));
		return {
			title: data.label,
			description: data.description,
			surface,
			contents: [],
			config: [],
		};
	}

	#ruleKind(ext: Extension): KindView {
		const width = this.#width;
		const data = ruleInspectorData(ext, this.#source);
		const surface: string[] = [];
		const appliesBody: string[] = [];
		if (data.alwaysApply) appliesBody.push(`  ${theme.fg("accent", t("overlays.inspector_panel.always"))}`);
		if (data.globs) this.#pushLabeled(appliesBody, "globs", data.globs.join(", "), width);
		if (data.condition) this.#pushLabeledList(appliesBody, "condition", data.condition, width);
		if (data.astCondition) this.#pushLabeledList(appliesBody, "ast", data.astCondition, width);
		if (data.scope) this.#pushLabeledList(appliesBody, "scope", data.scope, width);
		if (data.agents) this.#pushLabeledList(appliesBody, t("tools.count.agent.many"), data.agents, width);
		if (data.interruptMode) this.#pushLabeled(appliesBody, "interrupt", data.interruptMode, width, "dim");
		if (!data.alwaysApply && !data.globs && !data.condition && !data.astCondition && !data.agents) {
			appliesBody.push(theme.fg("dim", t("overlays.inspector_panel.no_apply_conditions_indented")));
		}
		appliesBody.push("");
		surface.push(...this.#section(t("overlays.inspector_panel.applies"), appliesBody, width));
		return {
			description: data.description,
			surface,
			contents: [],
			preview: { heading: t("overlays.inspector_panel.rule"), text: data.content },
			config: [],
		};
	}

	#skillKind(ext: Extension): KindView {
		const width = this.#width;
		const data = skillInspectorData(ext);
		const runtimeExtra: string[] = [];
		if (data.hidden) {
			this.#pushWrapped(
				runtimeExtra,
				t("overlays.inspector_panel.hidden_omitted_skill_list", { fg: `${theme.fg("warning", "hidden")}` }),
				width,
				"  ",
			);
			runtimeExtra.push(divider(width));
		}
		const surface: string[] = [];
		if (data.alwaysApply) surface.push(`  ${theme.fg("accent", t("overlays.inspector_panel.always_apply"))}`);
		if (data.globs) this.#pushLabeled(surface, "globs", data.globs.join(", "), width);
		if (surface.length > 0) surface.push("");
		return {
			description: data.description,
			runtimeExtra: runtimeExtra.length > 0 ? runtimeExtra : undefined,
			surface,
			contents: [],
			preview: { heading: t("overlays.inspector_panel.instruction"), text: data.content },
			config: [],
		};
	}

	#commandKind(ext: Extension): KindView {
		const data = commandInspectorData(ext);
		const surface: string[] = [];
		const invocationBody: string[] = [];
		invocationBody.push(`  ${theme.fg("accent", `/${sanitizeDisplayText(ext.name)}`)}`);
		if (data.argumentHint) this.#pushLabeled(invocationBody, "hint", data.argumentHint, this.#width, "dim");
		if (data.usesArguments)
			invocationBody.push(`  ${theme.fg("dim", t("overlays.inspector_panel.accepts_arguments"))}`);
		invocationBody.push("");
		surface.push(...this.#section(t("overlays.inspector_panel.invocation"), invocationBody, this.#width));
		return {
			description: data.description,
			surface,
			contents: [],
			preview: { heading: t("overlays.inspector_panel.template"), text: data.body },
			config: [],
		};
	}

	#hookKind(ext: Extension): KindView {
		const data = hookInspectorData(ext);
		const surface: string[] = [];
		const hookBody: string[] = [];
		if (data.hookType) this.#pushLabeled(hookBody, "when", data.hookType, this.#width);
		if (data.tool) this.#pushLabeled(hookBody, "tool", data.tool, this.#width);
		hookBody.push("");
		surface.push(...this.#section(t("overlays.inspector_panel.hook"), hookBody, this.#width));
		return { description: ext.description, surface, contents: [], config: [] };
	}

	#promptKind(ext: Extension): KindView {
		const data = promptInspectorData(ext);
		return {
			description: ext.description,
			surface: [],
			contents: [],
			preview: { heading: t("settings.option.loop.mode.prompt.label"), text: data.content },
			config: [],
		};
	}

	#contextKind(ext: Extension): KindView {
		const data = contextInspectorData(ext);
		return {
			description: ext.description,
			surface: [],
			contents: [],
			preview: { heading: t("overlays.inspector_panel.preview"), text: data.content },
			config: [],
		};
	}

	#instructionKind(ext: Extension): KindView {
		const data = instructionInspectorData(ext);
		const surface: string[] = [];
		if (data.applyTo) {
			const filesBody: string[] = [];
			this.#pushLabeled(filesBody, "files", data.applyTo, this.#width);
			filesBody.push("");
			surface.push(...this.#section(t("overlays.inspector_panel.applies"), filesBody, this.#width));
		}
		return {
			description: ext.description,
			surface,
			contents: [],
			preview: { heading: t("overlays.inspector_panel.instruction"), text: data.content },
			config: [],
		};
	}

	#fallbackKind(ext: Extension): KindView {
		const surface: string[] = [];
		if (ext.trigger) {
			const triggerBody: string[] = [`  ${theme.fg("accent", ext.trigger)}`, ""];
			surface.push(...this.#section(t("overlays.inspector_panel.trigger"), triggerBody, this.#width));
		}
		return { description: ext.description, surface, contents: [], config: [] };
	}

	#pushIdentity(lines: string[], ext: Extension, title: string | undefined): void {
		const name = sanitizeDisplayLine(ext.displayName);
		lines.push(theme.bold(theme.fg("accent", name)));
		const cleanTitle = sanitizeDisplayLineField(title);
		if (cleanTitle && cleanTitle !== name) lines.push(theme.fg("muted", cleanTitle));
		lines.push("");
	}
	#pushRuntime(lines: string[], ext: Extension, kind: KindView): void {
		if (kind.runtimeLine) {
			lines.push(kind.runtimeLine);
			if (kind.runtimeExtra) lines.push(...kind.runtimeExtra);
			if (ext.state !== "active") {
				lines.push(`  ${this.#getStatusBadge(ext.state, ext.disabledReason, ext.shadowedBy)}`);
			}
			lines.push("");
			return;
		}
		lines.push(this.#getStatusBadge(ext.state, ext.disabledReason, ext.shadowedBy));
		if (kind.runtimeExtra) lines.push(...kind.runtimeExtra);
		lines.push("");
	}

	#pushDescription(lines: string[], description: string | undefined, width: number): void {
		this.#pushShortText(lines, description, width);
	}

	#pushGuidance(lines: string[], guidance: string | undefined, width: number): void {
		this.#pushShortText(lines, guidance, width);
	}

	#pushShortText(lines: string[], value: string | undefined, width: number): void {
		const text = sanitizeDisplayField(value);
		if (!text) return;
		const wrapped: string[] = [];
		for (const raw of sanitizeDisplayText(text).split("\n")) {
			const folded = wrapTextWithAnsi(replaceTabs(raw), Math.max(8, width));
			if (folded.length === 0) wrapped.push("");
			else wrapped.push(...folded);
		}
		if (this.#expanded || wrapped.length <= MCP_INLINE_DESC_LINES) {
			lines.push(...wrapped);
		} else {
			lines.push(...wrapped.slice(0, MCP_INLINE_DESC_LINES));
			lines.push(
				theme.fg(
					"dim",
					t("overlays.inspector_panel.more_expand_indented_2", {
						value: `${wrapped.length - MCP_INLINE_DESC_LINES}`,
						expandKeyHint: `${expandKeyHint()}`,
					}),
				),
			);
		}
		lines.push("");
	}

	#pushOrigin(lines: string[], ext: Extension, width: number): void {
		lines.push(theme.fg("muted", t("overlays.inspector_panel.origin_label")));
		const levelLabel =
			ext.source.level === "user"
				? t("overlays.inspector_panel.source_user")
				: ext.source.level === "project"
					? t("overlays.inspector_panel.source_project")
					: t("overlays.inspector_panel.source_native");
		this.#pushWrapped(
			lines,
			theme.italic(
				t("overlays.inspector_panel.origin_provider", {
					providerName: `${sanitizeDisplayText(ext.source.providerName)}`,
					levelLabel: `${levelLabel}`,
				}),
			),
			width,
			"  ",
		);
		this.#pushWrapped(lines, theme.fg("dim", sanitizeDisplayText(shortenPath(ext.path, os.homedir()))), width, "  ");
		lines.push("");
	}

	#pushLabeled(
		lines: string[],
		label: string,
		value: string,
		width: number,
		valueColor: "accent" | "dim" | "success" = "accent",
	): void {
		const list = new KeyValueList(
			[{ label, value: sanitizeDisplayText(value), valueStyle: text => theme.fg(valueColor, text) }],
			{ indent: "  ", labelWidth: 10, gap: " ", minValueWidth: 8, labelOverflow: "allow" },
		);
		lines.push(...list.render(width));
	}

	#pushLabeledList(lines: string[], label: string, items: string[], width: number): void {
		if (items.length === 1) {
			this.#pushLabeled(lines, label, items[0], width);
			return;
		}
		const cap = this.#expanded ? items.length : PREVIEW_LIMITS.COLLAPSED_LINES;
		const shown = items.slice(0, cap);
		const hidden = items.length - shown.length;
		const indent = "             ";
		if (hidden > 0) {
			this.#pushLabeled(
				lines,
				label,
				t("overlays.inspector_panel.pattern_count", { length: `${items.length}` }),
				width,
				"dim",
			);
			for (const item of shown) this.#pushWrapped(lines, item, width, indent);
			lines.push(
				theme.fg(
					"dim",
					t("overlays.inspector_panel.more_expand_indent", {
						indent: `${indent}`,
						hidden: `${hidden}`,
						expandKeyHint: `${expandKeyHint()}`,
					}),
				),
			);
			return;
		}
		this.#pushLabeled(lines, label, shown[0] ?? "", width);
		for (const item of shown.slice(1)) this.#pushWrapped(lines, item, width, indent);
	}

	#pushParams(lines: string[], params: ToolParamView[], width: number, indent: string): void {
		if (params.length === 0) {
			lines.push(`${indent}${theme.fg("dim", t("overlays.inspector_panel.no_arguments"))}`);
			return;
		}
		for (const param of params) {
			const required = param.required;
			lines.push(
				renderTableRow(
					[
						{ text: param.name },
						{ text: param.type },
						{ text: param.flag, style: flag => theme.fg(required ? "warning" : "dim", flag) },
					],
					[
						{ width: 12, align: "left", overflow: "allow", style: name => theme.fg("accent", name) },
						{ width: 10, align: "left", overflow: "allow", style: type => theme.fg("muted", type) },
						{ width: visibleWidth(param.flag), align: "left", overflow: "allow" },
					],
					undefined,
					{ gap: " ", indent, fit: false },
				),
			);
			if (param.description) this.#pushWrapped(lines, param.description, width, `${indent}  `);
		}
	}

	#pushPreview(lines: string[], text: string, width: number, budget: number): void {
		if (!text) {
			lines.push(theme.fg("dim", t("overlays.inspector_panel.empty_indented")));
			return;
		}
		const wrapped: string[] = [];
		for (const raw of sanitizeDisplayText(text).split("\n")) {
			const highlighted = this.#highlightMarkdown(raw);
			const folded = wrapTextWithAnsi(highlighted, Math.max(8, width - 1));
			if (folded.length === 0) wrapped.push("");
			else wrapped.push(...folded);
		}
		if (this.#expanded || wrapped.length <= budget) {
			lines.push(...wrapped);
			return;
		}
		const shownBudget = Math.max(1, budget - 1);
		lines.push(...wrapped.slice(0, shownBudget));
		lines.push(
			theme.fg(
				"dim",
				t("overlays.inspector_panel.more_expand_indented_2", {
					value: `${wrapped.length - shownBudget}`,
					expandKeyHint: `${expandKeyHint()}`,
				}),
			),
		);
	}

	#highlightMarkdown(line: string): string {
		if (/^#{1,6}\s/.test(line)) return theme.bold(theme.fg("accent", line));
		if (line.startsWith("```")) return theme.fg("dim", line);
		if (/^[\s]*[-*+]\s/.test(line)) return line.replace(/^([\s]*[-*+]\s)/, theme.fg("accent", "$1"));
		if (/^[\s]*\d+\.\s/.test(line)) return line.replace(/^([\s]*\d+\.\s)/, theme.fg("accent", "$1"));
		return line;
	}

	#pushWrapped(lines: string[], text: string, width: number, indent = ""): void {
		const budget = Math.max(1, width - indent.length);
		const wrapped = wrapTextWithAnsi(replaceTabs(text), budget);
		for (const line of wrapped.length > 0 ? wrapped : [""]) {
			lines.push(`${indent}${line}`);
		}
	}

	#section(title: string, body: string[], width: number): string[] {
		// Section owns the one trailing spacer; callers retain interior blank
		// rows between repeated entries without doubling the section boundary.
		const sectionBody = body.at(-1) === "" ? body.slice(0, -1) : body;
		return [
			...new Section({
				title,
				body: sectionBody,
				titleStyle: heading => theme.fg("muted", heading),
				ruleStyle: rule => theme.fg("dim", rule),
				ruleGlyph: "─",
				ruleWidth: 40,
				blankAfter: true,
			}).render(width),
		];
	}

	#mcpHealthGlyph(health: MCPConnectionHealth): string {
		switch (health) {
			case "connected":
				return theme.fg("success", theme.status.enabled);
			case "connecting":
				return theme.fg("muted", theme.status.running);
			case "disconnected":
				return theme.fg("dim", theme.status.shadowed);
			case "inactive":
				return theme.fg("warning", theme.status.disabled);
		}
	}

	#getStatusBadge(state: ExtensionState, reason?: string, shadowedBy?: string): string {
		switch (state) {
			case "active":
				return theme.fg("success", `${theme.status.enabled} ${enablementLabel(state)}`);
			case "disabled":
				return theme.fg("dim", `${theme.status.disabled} ${enablementLabel(state, reason)}`);
			case "shadowed":
				return theme.fg("warning", `${theme.status.shadowed} ${enablementLabel(state, reason, shadowedBy)}`);
		}
	}
}

/** Glyph of each MCP health, read at call time so glyph presets apply. */
const MCP_HEALTH_GLYPH: Record<MCPConnectionHealth, () => string> = {
	connected: () => theme.status.enabled,
	connecting: () => theme.status.running,
	disconnected: () => theme.status.shadowed,
	inactive: () => theme.status.disabled,
};

function inspectorExtensionKey(extension: Extension | null): string | null {
	if (!extension) return null;
	return `${extension.kind}:${extension.id}:${extension.path}`;
}
