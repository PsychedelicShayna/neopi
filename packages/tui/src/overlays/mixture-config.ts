import type { Model } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import {
	type Component,
	Input,
	matchesKey,
	routeSgrMouseInput,
	type SelectItem,
	SelectList,
	type SgrMouseEvent,
	type TUI,
	truncateToWidth,
} from "../index";
import { bottomBorder, divider, dividerSplit, PanelRows, row, topBorder, topBorderSplit } from "../chrome/overlay-box";
import { isLayoutMouseRoutable } from "../components/layout/geometry";
import { SplitPane } from "../components/layout/split-pane";
import { Stack } from "../components/layout/stack";
import { sanitizeDisplayWarnings } from "../render/render-utils";
import { getSelectListTheme, theme } from "../theme";
import { sanitizeDisplayLine } from "./extensions/display-text";
import { HookEditorComponent } from "./hook-editor";
import { buildBrowserItems, ModelBrowser, type ModelBrowserSource, sortModelItems } from "./model-browser";
import {
	isFanoutEdge,
	mixtureEdgeId,
	TRANSIT_PART_NAMES,
	type MixtureConfigScope,
	type MixtureDefinition,
	type MixturesConfigDoc,
	type ModelMember,
	type SequentialEdge,
	type TransitPartName,
} from "./mixture-types";

export interface MixtureConfigDeps {
	getAvailableModels: () => Model[];
	browserSource: ModelBrowserSource;
	externalEditor?: (text: string) => Promise<string | null>;
	availableToolNames: readonly string[];
	activeName: () => string | undefined;
}

export interface MixtureConfigCallbacks {
	loadDoc: (scope: MixtureConfigScope) => Promise<MixturesConfigDoc>;
	/** Save only: do not change the running catalog. */
	save: (scope: MixtureConfigScope, doc: MixturesConfigDoc) => Promise<void>;
	/** Install the saved, discovered roster in this workspace. */
	apply: () => Promise<void>;
	activate: (name: string) => Promise<void>;
	close: () => void;
	requestRender: () => void;
	notify: (message: string) => void;
	warn: (message: string) => void;
}

function preview(text: string | undefined, width: number): string {
	const first = sanitizeDisplayLine(text?.trim().split("\n", 1)[0] ?? "");
	return first ? truncateToWidth(first, width) : "(none)";
}

/** Fullscreen, keyboard- and mouse-driven editor for the project or user MIXTURES.toml. */
export class MixtureConfigOverlayComponent implements Component {
	readonly #tui: TUI;
	readonly #deps: MixtureConfigDeps;
	readonly #cb: MixtureConfigCallbacks;
	#scope: MixtureConfigScope;
	#doc: MixturesConfigDoc;
	#dirty = false;
	#pendingApply = false;
	#pendingDelete: number | null = null;
	#screen = "list";
	#active: Component = new SelectList([], 1, getSelectListTheme());
	#footer = "";
	#previewScroll = 0;
	#bodyRows = 3;
	readonly #split = new SplitPane({
		left: (width, height) => {
			const lines = [...this.#active.render(width)];
			const rows = Math.max(0, Math.floor(height ?? this.#bodyRows));
			while (lines.length < rows) lines.push("");
			return lines.slice(0, rows);
		},
		right: (width, height) => {
			const rows = Math.max(0, Math.floor(height ?? this.#bodyRows));
			const lines = this.#previewLines(width);
			const start = Math.min(this.#previewScroll, Math.max(0, lines.length - rows));
			const visible = lines.slice(start, start + rows);
			while (visible.length < rows) visible.push("");
			return visible;
		},
		leftSize: { ratio: 0.34, min: 22, max: 42 },
		prefix: () => `${theme.fg("border", theme.boxRound.vertical)} `,
		divider: () => ` ${theme.fg("border", theme.boxRound.vertical)} `,
		suffix: () => ` ${theme.fg("border", theme.boxRound.vertical)}`,
	});
	readonly #top = new PanelRows();
	readonly #divider = new PanelRows();
	readonly #footerRow = new PanelRows();
	readonly #bottom = new PanelRows();
	readonly #frame = new Stack({
		children: [
			{ content: this.#top, height: 1 },
			{ content: this.#split, grow: 1 },
			{ content: this.#divider, height: 1 },
			{ content: this.#footerRow, height: 1 },
			{ content: this.#bottom, height: 1 },
		],
	});

	constructor(
		tui: TUI,
		deps: MixtureConfigDeps,
		scope: MixtureConfigScope,
		doc: MixturesConfigDoc,
		callbacks: MixtureConfigCallbacks,
		selectedName?: string,
	) {
		this.#tui = tui;
		this.#deps = deps;
		this.#scope = scope;
		this.#doc = doc;
		this.#cb = callbacks;
		this.#showList(
			selectedName ? `mixture:${this.#doc.mixtures.findIndex(item => item.name === selectedName)}` : undefined,
		);
	}

	render(width: number): readonly string[] {
		const height = Math.max(14, process.stdout.rows || 40);
		this.#bodyRows = Math.max(3, height - 4);
		const title = `Mixture configuration · ${this.#scope}${this.#dirty ? "  ● unsaved" : this.#pendingApply ? "  ◐ saved, not applied" : ""}`;
		this.#split.setNarrowPane(this.#screen === "list" ? undefined : "left");
		this.#split.setSplitAt(this.#screen === "list" ? 0 : Number.MAX_SAFE_INTEGER);
		this.#split.setHeight(this.#bodyRows);
		const geometry = this.#split.measure(width);
		const left = geometry.left?.width ?? 0;
		this.#top.setLines([geometry.mode === "split" ? topBorderSplit(width, title, left) : topBorder(width, title)]);
		this.#divider.setLines([geometry.mode === "split" ? dividerSplit(width, left) : divider(width)]);
		const status = this.#dirty ? "● unsaved · " : this.#pendingApply ? "◐ saved, not applied · " : "";
		this.#footerRow.setLines([row(theme.fg("dim", status + sanitizeDisplayLine(this.#footer)), width)]);
		this.#bottom.setLines([bottomBorder(width)]);
		this.#frame.setHeight(this.#bodyRows + 4);
		return this.#frame.render(width);
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouse(event));
			return;
		}
		this.#active.handleInput?.(data);
	}

	pasteText(text: string): void {
		if (this.#active instanceof HookEditorComponent) this.#active.pasteText(text);
	}

	#routeMouse(event: SgrMouseEvent): boolean {
		const hit = this.#frame.locate(event.row, event.col);
		if (!hit || hit.index !== 1) return false;
		const pane = this.#split.locate(hit.line, hit.col);
		if (pane?.pane === "right") {
			if (event.wheel !== null) {
				this.#previewScroll = Math.max(0, this.#previewScroll + event.wheel);
				this.#cb.requestRender();
			}
			return true;
		}
		if (pane?.pane === "left" && isLayoutMouseRoutable(this.#active))
			this.#active.routeMouse(event, pane.line, pane.col);
		return true;
	}

	#previewLines(width: number): string[] {
		const warnings = (this.#doc.warnings?.length ? sanitizeDisplayWarnings(this.#doc.warnings) : []).map(warning =>
			theme.fg("warning", truncateToWidth(warning, width)),
		);
		const value = this.#active instanceof SelectList ? (this.#active.getSelectedItem()?.value ?? "") : "";
		const index = /^mixture:(\d+)$/.exec(value);
		const mixture = index ? this.#doc.mixtures[Number(index[1])] : undefined;
		if (!mixture) return [...warnings, theme.fg("muted", "Choose a mixture to see its members and graph.")];
		const lines = [
			theme.bold(sanitizeDisplayLine(mixture.name)),
			preview(mixture.description, width),
			"",
			`Entry: ${sanitizeDisplayLine(mixture.entry)}`,
			"",
			"Members:",
		];
		for (const member of mixture.members) {
			lines.push(
				`  ${sanitizeDisplayLine(member.id)} · ${member.kind === "verdict" ? "verdict" : sanitizeDisplayLine(member.model || "(choose model)")}`,
			);
		}
		lines.push("", "Edges:");
		for (const edge of mixture.edges)
			lines.push(`  ${sanitizeDisplayLine(mixtureEdgeId(edge))} · ${Object.keys(edge.x).join(", ")}`);
		if (mixture.edges.length === 0) lines.push("  (no edges — the entry member ends the run)");
		return [...warnings, ...lines.map(line => truncateToWidth(line, width))];
	}

	#setScreen(screen: string, active: Component, footer: string): void {
		this.#screen = screen;
		this.#active = active;
		this.#footer = footer;
		this.#previewScroll = 0;
		this.#cb.requestRender();
	}

	#menu(
		screen: string,
		items: SelectItem[],
		selected: string | undefined,
		footer: string,
		onSelect: (value: string) => void | Promise<void>,
		onCancel: () => void,
		onKey?: (data: string, list: SelectList) => boolean,
	): void {
		const safeItems = items.map(item => ({
			...item,
			label: sanitizeDisplayLine(item.label),
			description: item.description === undefined ? undefined : sanitizeDisplayLine(item.description),
		}));
		const list = new SelectList(safeItems, Math.max(1, items.length), getSelectListTheme());
		if (selected && items.some(item => item.value === selected)) list.setSelectedValue(selected);
		const handle = list.handleInput.bind(list);
		list.handleInput = data => {
			if (!onKey?.(data, list)) handle(data);
		};
		list.onSelect = item => {
			void Promise.resolve(onSelect(item.value)).catch(error =>
				this.#cb.notify(error instanceof Error ? error.message : String(error)),
			);
		};
		list.onCancel = onCancel;
		list.onSelectionChange = () => this.#cb.requestRender();
		this.#setScreen(screen, list, footer);
	}

	#touch(): void {
		this.#dirty = true;
		this.#cb.requestRender();
	}

	#otherScope(): MixtureConfigScope {
		return this.#scope === "project" ? "user" : "project";
	}

	#showList(selected?: string): void {
		const active = this.#deps.activeName();
		const items: SelectItem[] = this.#doc.mixtures.map((mixture, index) => ({
			value: `mixture:${index}`,
			label:
				this.#pendingDelete === index
					? `⚠ Delete ${mixture.name}?`
					: `${active === mixture.name ? "●" : "○"} ${mixture.name}`,
			description:
				this.#pendingDelete === index
					? "Delete again to confirm"
					: `${mixture.members.length} members · ${mixture.edges.length} edges`,
		}));
		items.push(
			{ value: "new", label: "+ Create mixture" },
			{ value: "scope", label: `Scope: ${this.#scope}`, description: `→ ${this.#otherScope()}` },
			{ value: "save", label: "Save only" },
			{ value: "apply", label: "Save & apply" },
			{ value: "close", label: "Close" },
		);
		this.#menu(
			"list",
			items,
			selected,
			this.#pendingDelete !== null
				? "Delete again to confirm · any other key cancels"
				: "↑↓ move · Enter edit · Space activate · Delete remove · s save · a apply · Esc close",
			value => this.#onListSelect(value),
			() => this.#cb.close(),
			(data, list) => {
				const value = list.getSelectedItem()?.value ?? "";
				const match = /^mixture:(\d+)$/.exec(value);
				if (match && (matchesKey(data, "delete") || matchesKey(data, "backspace"))) {
					this.#deleteMixture(Number(match[1]));
					return true;
				}
				if (this.#pendingDelete !== null) {
					this.#pendingDelete = null;
					this.#showList(value);
					return true;
				}
				if (matchesKey(data, "space")) {
					void this.#onListSelect(match ? `activate:${match[1]}` : value).catch(error =>
						this.#cb.notify(String(error)),
					);
					return true;
				}
				if (matchesKey(data, "s") || matchesKey(data, "a")) {
					void this.#onListSelect(matchesKey(data, "s") ? "save" : "apply", value).catch(error =>
						this.#cb.notify(String(error)),
					);
					return true;
				}
				return false;
			},
		);
	}

	#deleteMixture(index: number): void {
		if (this.#pendingDelete !== index) {
			this.#pendingDelete = index;
			this.#showList(`mixture:${index}`);
			return;
		}
		this.#doc.mixtures.splice(index, 1);
		this.#pendingDelete = null;
		this.#touch();
		this.#showList();
	}

	async #save(): Promise<void> {
		await this.#cb.save(this.#scope, this.#doc);
		this.#doc.warnings = undefined;
		this.#dirty = false;
		this.#pendingApply = true;
	}

	async #apply(): Promise<void> {
		if (this.#dirty) await this.#save();
		if (!this.#pendingApply) {
			this.#cb.notify("Nothing new to apply.");
			return;
		}
		await this.#cb.apply();
		this.#pendingApply = false;
	}

	async #onListSelect(value: string, selected?: string): Promise<void> {
		if (value === "new") {
			this.#newMixture();
			return;
		}
		if (value === "scope") {
			if (this.#dirty) {
				this.#cb.notify("Unsaved changes — save or close before switching scope.");
				return;
			}
			const scope = this.#otherScope();
			const doc = await this.#cb.loadDoc(scope);
			this.#scope = scope;
			this.#doc = doc;
			this.#pendingApply = false;
			if (doc.warnings?.length) this.#cb.warn(`MIXTURES.toml: ${sanitizeDisplayWarnings(doc.warnings).join("; ")}`);
			this.#showList();
			return;
		}
		if (value === "save") {
			await this.#save();
			this.#showList(selected);
			return;
		}
		if (value === "apply") {
			await this.#apply();
			this.#showList(selected);
			return;
		}
		if (value === "close") {
			this.#cb.close();
			return;
		}
		const activate = /^activate:(\d+)$/.exec(value);
		if (activate) {
			const mixture = this.#doc.mixtures[Number(activate[1])];
			if (!mixture) return;
			if (this.#dirty || this.#pendingApply) await this.#apply();
			await this.#cb.activate(mixture.name);
			this.#showList(`mixture:${activate[1]}`);
			return;
		}
		const match = /^mixture:(\d+)$/.exec(value);
		if (match) this.#showMixture(Number(match[1]));
	}

	#newMixture(): void {
		this.#editText(
			"New mixture name",
			"",
			value => {
				const name = value.trim();
				if (!name) return;
				this.#doc.mixtures.push({
					name,
					entry: "writer",
					members: [{ id: "writer", model: "", tools: false }],
					edges: [],
				});
				this.#touch();
				this.#showMember(this.#doc.mixtures.length - 1, 0);
			},
			() => this.#showList(),
		);
	}

	#editText(label: string, current: string, save: (value: string) => void, cancel: () => void): void {
		const input = new Input();
		input.setValue(current);
		input.onSubmit = value => {
			save(value);
			if (this.#active === input) cancel();
		};
		input.onEscape = cancel;
		this.#setScreen("input", input, `${label} · Enter save · Esc cancel`);
	}

	#editLong(label: string, current: string, save: (value: string) => void, back: () => void): void {
		const editor = new HookEditorComponent(
			this.#tui,
			label,
			current,
			value => {
				save(value);
				back();
			},
			back,
			{ externalEditor: this.#deps.externalEditor },
		);
		this.#setScreen("editor", editor, "Ctrl+Q save · Ctrl+G external editor · Esc cancel");
	}

	#choose(
		label: string,
		values: SelectItem[],
		selected: string | undefined,
		save: (value: string) => void,
		back: () => void,
	): void {
		this.#menu(
			"choice",
			values,
			selected,
			`${label} · Enter choose · Esc cancel`,
			value => {
				save(value);
				back();
			},
			back,
		);
	}

	#mixture(index: number): MixtureDefinition | undefined {
		return this.#doc.mixtures[index];
	}

	#showMixture(index: number, selected?: string): void {
		const mixture = this.#mixture(index);
		if (!mixture) return this.#showList();
		const items: SelectItem[] = [
			{ value: "name", label: "Name", description: mixture.name },
			{ value: "description", label: "Description", description: preview(mixture.description, 55) },
			{ value: "entry", label: "Entry member", description: mixture.entry },
			{
				value: "members",
				label: `Members (${mixture.members.length})`,
				description: mixture.members.map(member => member.id).join(" → "),
			},
			{
				value: "edges",
				label: `Edges (${mixture.edges.length})`,
				description: mixture.edges.map(mixtureEdgeId).join(", "),
			},
			{
				value: "limits",
				label: "Limits",
				description: mixture.limits ? `${mixture.limits.maxHops ?? "default"} hops` : "defaults",
			},
			{ value: "roles", label: "Role presets", description: `${Object.keys(mixture.roles ?? {}).length} local` },
			{
				value: "envelopes",
				label: "Envelope presets",
				description: `${Object.keys(mixture.envelopes ?? {}).length} local`,
			},
			{ value: "back", label: "Back to mixtures" },
		];
		this.#menu(
			"mixture",
			items,
			selected,
			`Editing ${mixture.name} · Enter select · Esc back`,
			value => {
				switch (value) {
					case "name":
						this.#editText(
							"Mixture name",
							mixture.name,
							text => {
								if (text.trim()) {
									mixture.name = text.trim();
									this.#touch();
								}
							},
							() => this.#showMixture(index, value),
						);
						break;
					case "description":
						this.#editText(
							"Description",
							mixture.description ?? "",
							text => {
								mixture.description = text.trim() || undefined;
								this.#touch();
							},
							() => this.#showMixture(index, value),
						);
						break;
					case "entry":
						this.#choose(
							"Entry member",
							mixture.members
								.filter(member => member.kind !== "verdict")
								.map(member => ({ value: member.id, label: member.id })),
							mixture.entry,
							id => {
								mixture.entry = id;
								this.#touch();
							},
							() => this.#showMixture(index, value),
						);
						break;
					case "members":
						this.#showMembers(index);
						break;
					case "edges":
						this.#showEdges(index);
						break;
					case "limits":
						this.#showLimits(index);
						break;
					case "roles":
					case "envelopes":
						this.#showPresets(index, value);
						break;
					default:
						this.#showList(`mixture:${index}`);
				}
			},
			() => this.#showList(`mixture:${index}`),
		);
	}

	#showMembers(index: number, selected?: string): void {
		const mixture = this.#mixture(index);
		if (!mixture) return this.#showList();
		const items: SelectItem[] = mixture.members.map((member, position) => ({
			value: `member:${position}`,
			label: `${mixture.entry === member.id ? "◆" : "○"} ${member.id}`,
			description: member.kind === "verdict" ? "verdict" : member.model || "select a model",
		}));
		items.push({ value: "add", label: "+ Add member" }, { value: "back", label: "Back to mixture" });
		this.#menu(
			"members",
			items,
			selected,
			"Enter edit · Delete remove member and its edges · Alt+↑↓ reorder · Esc back",
			value => {
				const match = /^member:(\d+)$/.exec(value);
				if (match) this.#showMember(index, Number(match[1]));
				else if (value === "add")
					this.#editText(
						"Member id",
						"",
						text => {
							const id = text.trim();
							if (!id) return;
							mixture.members.push({ id, model: "", tools: false });
							this.#touch();
							this.#showMember(index, mixture.members.length - 1);
						},
						() => this.#showMembers(index),
					);
				else this.#showMixture(index, "members");
			},
			() => this.#showMixture(index, "members"),
			(data, list) => {
				const match = /^member:(\d+)$/.exec(list.getSelectedItem()?.value ?? "");
				if (!match) return false;
				const position = Number(match[1]);
				if (matchesKey(data, "delete") || matchesKey(data, "backspace")) {
					const member = mixture.members[position];
					if (!member) return true;
					mixture.members.splice(position, 1);
					mixture.edges = mixture.edges.filter(
						edge =>
							edge.from !== member.id &&
							(isFanoutEdge(edge)
								? edge.join !== member.id && !edge.to.includes(member.id)
								: edge.to !== member.id),
					);
					if (mixture.entry === member.id)
						mixture.entry = mixture.members.find(next => next.kind !== "verdict")?.id ?? "";
					this.#touch();
					this.#showMembers(index);
					return true;
				}
				const delta =
					matchesKey(data, "alt+up") || data === "[" ? -1 : matchesKey(data, "alt+down") || data === "]" ? 1 : 0;
				if (!delta || position + delta < 0 || position + delta >= mixture.members.length) return false;
				const [member] = mixture.members.splice(position, 1);
				if (member) mixture.members.splice(position + delta, 0, member);
				this.#touch();
				this.#showMembers(index, `member:${position + delta}`);
				return true;
			},
		);
	}

	#modelMember(index: number, position: number): ModelMember | undefined {
		const member = this.#mixture(index)?.members[position];
		return member && member.kind !== "verdict" ? member : undefined;
	}

	#showMember(index: number, position: number, selected?: string): void {
		const member = this.#modelMember(index, position);
		if (!member) return this.#showMembers(index);
		const items: SelectItem[] = [
			{ value: "id", label: "Member id", description: member.id },
			{ value: "model", label: "Model", description: member.model || "(select model)" },
			{ value: "description", label: "Description", description: preview(member.description, 50) },
			{ value: "role", label: "Role prompt", description: preview(member.systemPrompt ?? member.role, 50) },
			{
				value: "tools",
				label: "Tools",
				description: member.tools === true ? "all" : Array.isArray(member.tools) ? member.tools.join(", ") : "off",
			},
			{ value: "show", label: "Show", description: member.show ?? "default" },
			{
				value: "maxTokens",
				label: "Maximum output tokens",
				description: String(member.maxTokens ?? "model default"),
			},
			{ value: "route", label: "Route instructions", description: preview(member.route?.instructions, 50) },
			{
				value: "terminate",
				label: "Termination instructions",
				description: preview(member.terminate?.instructions, 50),
			},
			{ value: "back", label: "Back to members" },
		];
		this.#menu(
			"member",
			items,
			selected,
			`Member ${member.id} · Enter edit · Esc back`,
			value => {
				const back = () => this.#showMember(index, position, value);
				switch (value) {
					case "id":
						this.#editText(
							"Member id",
							member.id,
							text => {
								const id = text.trim();
								if (!id || id === member.id) return;
								const mixture = this.#mixture(index)!;
								if (mixture.entry === member.id) mixture.entry = id;
								for (const edge of mixture.edges) {
									if (edge.from === member.id) edge.from = id;
									if (isFanoutEdge(edge)) {
										edge.to = edge.to.map(target => (target === member.id ? id : target));
										if (edge.join === member.id) edge.join = id;
									} else if (edge.to === member.id) edge.to = id;
								}
								member.id = id;
								this.#touch();
							},
							back,
						);
						break;
					case "model":
						this.#showModelPicker(index, position);
						break;
					case "description":
						this.#editText(
							"Member description",
							member.description ?? "",
							text => {
								member.description = text.trim() || undefined;
								this.#touch();
							},
							back,
						);
						break;
					case "role":
						this.#editLong(
							"Role prompt",
							member.systemPrompt ?? "",
							text => {
								member.systemPrompt = text || undefined;
								this.#touch();
							},
							back,
						);
						break;
					case "tools":
						this.#showTools(index, position);
						break;
					case "show":
						this.#choose(
							"Show hop",
							["default", "always", "never", "final"].map(choice => ({ value: choice, label: choice })),
							member.show ?? "default",
							choice => {
								member.show = choice === "default" ? undefined : (choice as "always" | "never" | "final");
								this.#touch();
							},
							back,
						);
						break;
					case "maxTokens":
						this.#editNumber(
							"Maximum output tokens",
							member.maxTokens,
							number => {
								member.maxTokens = number;
								this.#touch();
							},
							back,
						);
						break;
					case "route":
						this.#editLong(
							"Route instructions",
							member.route?.instructions ?? "",
							text => {
								member.route = text.trim() ? { instructions: text } : undefined;
								this.#touch();
							},
							back,
						);
						break;
					case "terminate":
						this.#editLong(
							"Termination instructions",
							member.terminate?.instructions ?? "",
							text => {
								member.terminate = text.trim() ? { instructions: text } : undefined;
								this.#touch();
							},
							back,
						);
						break;
					default:
						this.#showMembers(index, `member:${position}`);
				}
			},
			() => this.#showMembers(index, `member:${position}`),
		);
	}

	#editNumber(
		label: string,
		current: number | undefined,
		save: (value: number | undefined) => void,
		back: () => void,
	): void {
		this.#editText(
			label,
			current === undefined ? "" : String(current),
			text => {
				const value = text.trim();
				if (!value) return save(undefined);
				const number = Number(value);
				if (!Number.isFinite(number) || number < 0) {
					this.#cb.notify(`${label}: enter a non-negative number`);
					return;
				}
				save(number);
			},
			back,
		);
	}

	#showModelPicker(index: number, position: number): void {
		const source = this.#deps.browserSource;
		const models = this.#deps.getAvailableModels().filter(model => model.api !== "mixture");
		const items = buildBrowserItems(models);
		sortModelItems(items, { mruOrder: source.mruOrder });
		const browser = new ModelBrowser(source, {});
		browser.setMruOrder(source.mruOrder);
		browser.setPerfStats(source.modelPerf);
		browser.setItems(items);
		browser.onActivate = item => {
			const efforts = getSupportedEfforts(item.model);
			const assign = (effort: string) => {
				const member = this.#modelMember(index, position);
				if (member) {
					member.model = effort ? `${item.selector}:${effort}` : item.selector;
					this.#touch();
				}
				this.#showMember(index, position, "model");
			};
			if (efforts.length)
				this.#choose(
					"Thinking effort",
					[{ value: "", label: "Model default" }, ...efforts.map(effort => ({ value: effort, label: effort }))],
					"",
					assign,
					() => this.#showModelPicker(index, position),
				);
			else assign("");
		};
		browser.onCancel = () => this.#showMember(index, position, "model");
		this.#setScreen("model", browser, "Type to search · Enter choose · Esc back");
	}

	#showTools(index: number, position: number, cursor = 0): void {
		const member = this.#modelMember(index, position);
		if (!member) return this.#showMembers(index);
		const all = this.#deps.availableToolNames;
		const selected = new Set(member.tools === true ? all : Array.isArray(member.tools) ? member.tools : []);
		const items: SelectItem[] = [
			{ value: "off", label: `${member.tools === false ? "[x]" : "[ ]"} Off` },
			{ value: "all", label: `${member.tools === true ? "[x]" : "[ ]"} All` },
			...all.map(name => ({
				value: name,
				label: `${selected.has(name) && member.tools !== false ? "[x]" : "[ ]"} ${name}`,
			})),
			{ value: "done", label: "Done" },
		];
		this.#menu(
			"tools",
			items,
			items[Math.min(cursor, items.length - 1)]?.value,
			"Space / Enter toggle · Done or Esc return",
			value => {
				if (value === "done") return this.#showMember(index, position, "tools");
				if (value === "off") member.tools = false;
				else if (value === "all") member.tools = true;
				else {
					if (selected.has(value)) selected.delete(value);
					else selected.add(value);
					member.tools = all.filter(name => selected.has(name));
				}
				this.#touch();
				this.#showTools(
					index,
					position,
					items.findIndex(item => item.value === value),
				);
			},
			() => this.#showMember(index, position, "tools"),
			(data, list) => {
				if (!matchesKey(data, "space")) return false;
				const value = list.getSelectedItem()?.value;
				if (value) list.onSelect?.({ value, label: value });
				return true;
			},
		);
	}

	#showEdges(index: number, selected?: string): void {
		const mixture = this.#mixture(index);
		if (!mixture) return this.#showList();
		const items: SelectItem[] = mixture.edges.map((edge, position) => ({
			value: `edge:${position}`,
			label: mixtureEdgeId(edge),
			description: Object.keys(edge.x).join(", "),
		}));
		items.push({ value: "add", label: "+ Add edge" }, { value: "back", label: "Back to mixture" });
		this.#menu(
			"edges",
			items,
			selected,
			"Enter edit · Delete remove · Alt+↑↓ reorder · Esc back",
			value => {
				const match = /^edge:(\d+)$/.exec(value);
				if (match) this.#showEdge(index, Number(match[1]));
				else if (value === "add") {
					const from = mixture.members[0]?.id;
					const to = mixture.members[1]?.id;
					if (!from || !to) return this.#cb.notify("Add at least two members before connecting them.");
					mixture.edges.push({ from, to, x: { output: true } });
					this.#touch();
					this.#showEdge(index, mixture.edges.length - 1);
				} else this.#showMixture(index, "edges");
			},
			() => this.#showMixture(index, "edges"),
			(data, list) => {
				const match = /^edge:(\d+)$/.exec(list.getSelectedItem()?.value ?? "");
				if (!match) return false;
				const position = Number(match[1]);
				if (matchesKey(data, "delete") || matchesKey(data, "backspace")) {
					mixture.edges.splice(position, 1);
					this.#touch();
					this.#showEdges(index);
					return true;
				}
				const delta =
					matchesKey(data, "alt+up") || data === "[" ? -1 : matchesKey(data, "alt+down") || data === "]" ? 1 : 0;
				if (!delta || position + delta < 0 || position + delta >= mixture.edges.length) return false;
				const [edge] = mixture.edges.splice(position, 1);
				if (edge) mixture.edges.splice(position + delta, 0, edge);
				this.#touch();
				this.#showEdges(index, `edge:${position + delta}`);
				return true;
			},
		);
	}

	#edge(index: number, position: number): SequentialEdge | undefined {
		const edge = this.#mixture(index)?.edges[position];
		return edge && !isFanoutEdge(edge) ? edge : undefined;
	}

	#showEdge(index: number, position: number, selected?: string): void {
		const edge = this.#edge(index, position);
		const mixture = this.#mixture(index);
		if (!edge || !mixture) return this.#showEdges(index);
		const items: SelectItem[] = [
			{ value: "from", label: "From", description: edge.from },
			{ value: "to", label: "To", description: edge.to },
			{ value: "x", label: "Transit parts", description: Object.keys(edge.x).join(", ") },
			{ value: "envelope", label: "Envelope", description: preview(edge.envelope, 50) },
			{ value: "when", label: "When", description: preview(edge.when, 50) },
			{ value: "show", label: "Show source hop", description: edge.show ?? "member default" },
			{ value: "maxTraversals", label: "Maximum traversals", description: String(edge.maxTraversals ?? "default") },
			{ value: "back", label: "Back to edges" },
		];
		this.#menu(
			"edge",
			items,
			selected,
			`Edge ${mixtureEdgeId(edge)} · Enter edit · Esc back`,
			value => {
				const back = () => this.#showEdge(index, position, value);
				switch (value) {
					case "from":
					case "to":
						this.#choose(
							`${value} member`,
							mixture.members.map(member => ({ value: member.id, label: member.id })),
							edge[value],
							id => {
								edge[value] = id;
								this.#touch();
							},
							back,
						);
						break;
					case "x":
						this.#showTransit(index, position);
						break;
					case "envelope":
						this.#editLong(
							"Envelope template or preset name",
							edge.envelope ?? "",
							text => {
								edge.envelope = text.trim() || undefined;
								this.#touch();
							},
							back,
						);
						break;
					case "when":
						this.#editLong(
							"Edge condition",
							edge.when ?? "",
							text => {
								edge.when = text.trim() || undefined;
								this.#touch();
							},
							back,
						);
						break;
					case "show":
						this.#choose(
							"Show source hop",
							["default", "always", "never"].map(choice => ({ value: choice, label: choice })),
							edge.show ?? "default",
							choice => {
								edge.show = choice === "default" ? undefined : (choice as "always" | "never");
								this.#touch();
							},
							back,
						);
						break;
					case "maxTraversals":
						this.#editNumber(
							"Maximum traversals",
							edge.maxTraversals,
							number => {
								edge.maxTraversals = number;
								this.#touch();
							},
							back,
						);
						break;
					default:
						this.#showEdges(index, `edge:${position}`);
				}
			},
			() => this.#showEdges(index, `edge:${position}`),
		);
	}

	#showTransit(index: number, position: number, selected?: string): void {
		const edge = this.#edge(index, position);
		if (!edge) return this.#showEdges(index);
		const items: SelectItem[] = TRANSIT_PART_NAMES.map(part => ({
			value: part,
			label: `${edge.x[part] ? "[x]" : "[ ]"} ${part}`,
		}));
		items.push({ value: "back", label: "Done" });
		this.#menu(
			"transit",
			items,
			selected,
			"Space / Enter toggle x parts · Esc back",
			value => {
				if (value === "back") return this.#showEdge(index, position, "x");
				const part = value as TransitPartName;
				if (edge.x[part]) delete edge.x[part];
				else edge.x[part] = true;
				this.#touch();
				this.#showTransit(index, position, value);
			},
			() => this.#showEdge(index, position, "x"),
			(data, list) => {
				if (!matchesKey(data, "space")) return false;
				const value = list.getSelectedItem()?.value;
				if (value) list.onSelect?.({ value, label: value });
				return true;
			},
		);
	}

	#showLimits(index: number, selected?: string): void {
		const mixture = this.#mixture(index);
		if (!mixture) return this.#showList();
		const limits = (mixture.limits ??= {});
		const items: SelectItem[] = [
			{ value: "maxHops", label: "Maximum hops", description: String(limits.maxHops ?? "default") },
			{ value: "budgetUsd", label: "Budget (USD)", description: String(limits.budgetUsd ?? "none") },
			{
				value: "wallClockMinutes",
				label: "Wall clock (minutes)",
				description: String(limits.wallClockMinutes ?? "none"),
			},
			{ value: "onLimit", label: "On limit", description: limits.onLimit ?? "stop" },
			{ value: "limitTarget", label: "Limit judge member", description: limits.limitTarget ?? "none" },
			{ value: "back", label: "Back to mixture" },
		];
		this.#menu(
			"limits",
			items,
			selected,
			"Enter edit · Esc back",
			value => {
				if (value === "back") return this.#showMixture(index, "limits");
				const back = () => this.#showLimits(index, value);
				if (value === "onLimit")
					this.#choose(
						"On limit",
						["stop", "pause", "judge"].map(choice => ({ value: choice, label: choice })),
						limits.onLimit ?? "stop",
						choice => {
							limits.onLimit = choice as "stop" | "pause" | "judge";
							this.#touch();
						},
						back,
					);
				else if (value === "limitTarget")
					this.#choose(
						"Limit target",
						[
							{ value: "", label: "None" },
							...mixture.members.map(member => ({ value: member.id, label: member.id })),
						],
						limits.limitTarget,
						id => {
							limits.limitTarget = id || undefined;
							this.#touch();
						},
						back,
					);
				else if (value === "maxHops" || value === "budgetUsd" || value === "wallClockMinutes")
					this.#editNumber(
						value,
						limits[value],
						number => {
							limits[value] = number;
							this.#touch();
						},
						back,
					);
			},
			() => this.#showMixture(index, "limits"),
		);
	}

	#showPresets(index: number, kind: "roles" | "envelopes", selected?: string): void {
		const mixture = this.#mixture(index);
		if (!mixture) return this.#showList();
		const presets = (mixture[kind] ??= {});
		const names = Object.keys(presets);
		const items: SelectItem[] = names.map(name => ({
			value: name,
			label: name,
			description: preview(presets[name], 50),
		}));
		items.push({ value: "__add", label: "+ Add preset" }, { value: "__back", label: "Back" });
		this.#menu(
			"presets",
			items,
			selected,
			"Enter edit text · Delete remove · Esc back",
			value => {
				if (value === "__back") return this.#showMixture(index, kind);
				if (value === "__add")
					this.#editText(
						"Preset name",
						"",
						text => {
							const name = text.trim();
							if (!name) return;
							presets[name] = "";
							this.#touch();
							this.#editLong(
								`${kind} / ${name}`,
								"",
								content => {
									presets[name] = content;
									this.#touch();
								},
								() => this.#showPresets(index, kind, name),
							);
						},
						() => this.#showPresets(index, kind),
					);
				else
					this.#editLong(
						`${kind} / ${value}`,
						presets[value] ?? "",
						content => {
							presets[value] = content;
							this.#touch();
						},
						() => this.#showPresets(index, kind, value),
					);
			},
			() => this.#showMixture(index, kind),
			(data, list) => {
				const value = list.getSelectedItem()?.value;
				if (!value || value.startsWith("__") || (!matchesKey(data, "delete") && !matchesKey(data, "backspace")))
					return false;
				delete presets[value];
				this.#touch();
				this.#showPresets(index, kind);
				return true;
			},
		);
	}
}
