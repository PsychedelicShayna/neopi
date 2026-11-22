import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import type { Component, Focusable } from "@oh-my-pi/pi-tui";
import { matchesKey, replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { formTheme } from "@oh-my-pi/pi-tui/chrome/form-theme";
import { bottomBorder, row, topBorder } from "@oh-my-pi/pi-tui/chrome/overlay-box";
import { SelectFormField, TextFormField } from "@oh-my-pi/pi-tui/components/form";
import type { FormField } from "@oh-my-pi/pi-tui/components/form";
import { applyMenuMotion, MenuKeyReader, MenuViewport } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { MenuSelection } from "@oh-my-pi/pi-tui/components/menu-selection";
import { node } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { actionBar, actionButton, overlayCard } from "@oh-my-pi/pi-tui/native/overlay";
import { getSelectListTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import { theme } from "@oh-my-pi/pi-tui/theme/theme";
import {
	MODEL_FACT_FIELDS,
	type ModelFactConfig,
	type ModelFactField,
	type ModelFactOverride,
	type ModelFactProvenance,
	type ModelFactResolution,
	validateModelFactOverrides,
	validateModelFactSources,
} from "../../config/model-facts";

export interface ModelFactEditorProvider {
	id: string;
	models: readonly { id: string; name?: string }[];
}

/** The host owns settings persistence, catalog loading, and model construction. */
export interface ModelFactEditorOptions {
	providers: readonly ModelFactEditorProvider[];
	config: ModelFactConfig;
	provider?: string;
	modelId?: string;
	preview(
		config: ModelFactConfig,
		provider: string,
		modelId: string,
	): ModelFactResolution | Promise<ModelFactResolution>;
	onSave(config: ModelFactConfig): void | Promise<void>;
	onClose(): void;
	requestRender?(): void;
	/** Available terminal rows, including editor chrome. */
	rows?: number;
}

interface EditorRow {
	id: string;
	label: string;
	activate(): void;
}

const FIELD_LABELS: Record<ModelFactField, string> = {
	cost: "Price per million tokens",
	contextWindow: "Context window",
	maxTokens: "Output cap",
	input: "Input modalities",
	reasoning: "Reasoning",
	efforts: "Effort levels",
};

const LITERAL_HELP: Record<ModelFactField, string> = {
	cost: 'JSON rates per million tokens, e.g. {"input":1,"output":3,"cacheRead":0,"cacheWrite":0}. Other pricing fields may be included.',
	contextWindow: "Token count, or null to clear the limit.",
	maxTokens: "Token count, or null to clear the limit.",
	input: "Comma-separated modalities, e.g. text, image.",
	reasoning: "true or false.",
	efforts: "Comma-separated levels, e.g. low, medium, high, xhigh. Empty removes the ladder.",
};

function display(value: unknown): string {
	if (value === undefined) return "unknown";
	if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
	return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
}

function origin(value: ModelFactProvenance | undefined): string {
	if (!value) return "unknown source";
	if (value.kind === "override") return "literal override";
	const target = value.provider ? `${value.provider}/${value.model ?? ""}` : value.model;
	return [value.kind, value.source, target].filter(Boolean).join(" · ");
}

function safe(text: string, width: number): string {
	return truncateToWidth(replaceTabs(text).replace(/[\r\n]+/g, " "), Math.max(0, width));
}

/** Optional full-/models editor. No settings change until Save succeeds. */
export class ModelFactEditorComponent implements Component, Focusable {
	readonly #options: ModelFactEditorOptions;
	readonly #keys = new MenuKeyReader();
	readonly #viewport = new MenuViewport();
	readonly #menu = new MenuSelection<EditorRow>([], {
		getKey: item => item.id,
		getSearchText: item => item.label,
	});
	#config: ModelFactConfig;
	#provider: string;
	#modelId: string;
	#field: FormField | undefined;
	#focused = false;
	#preview: ModelFactResolution | undefined;
	#previewError: string | undefined;
	#previewPending = false;
	#previewVersion = 0;
	#saveError: string | undefined;
	#saving = false;
	#disposed = false;

	constructor(options: ModelFactEditorOptions) {
		this.#options = options;
		this.#config = structuredClone(options.config);
		this.#provider = options.provider ?? options.providers[0]?.id ?? "";
		this.#modelId = options.modelId ?? this.#modelIds(this.#provider)[0] ?? "";
		this.#rebuild();
		this.#refreshPreview();
	}

	get focused(): boolean {
		return this.#focused;
	}

	set focused(value: boolean) {
		this.#focused = value;
		if (this.#field) this.#field.focused = value;
	}

	get filterFocused(): boolean {
		return this.#field?.filterFocused ?? false;
	}

	get blocksMenuHistory(): boolean {
		return this.#saving || this.#field instanceof TextFormField;
	}

	capturesInput(data: string): boolean {
		return this.#field instanceof TextFormField && matchesKey(data, "ctrl+c");
	}

	setUseTerminalCursor(value: boolean): void {
		this.#field?.setUseTerminalCursor(value);
	}

	handleInput(data: string): void {
		if (this.#disposed) return;
		if (this.#field) {
			this.#field.handleInput(data);
			return;
		}
		const action = this.#keys.read(data);
		if (!action || action === "pending") return;
		if (action.kind === "cancel") {
			this.#close();
			return;
		}
		if (this.#saving) return;
		if (applyMenuMotion(action, this.#menu, this.#viewport).handled) return;
		if (action.kind === "confirm" || action.kind === "toggle" || action.kind === "search") {
			this.#menu.selectedItem?.activate();
		}
	}

	pasteText(text: string): void {
		this.#field?.pasteText(text);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#disposed) return;
		if (event.type === "action") {
			if (event.act === "close") this.handleInput("\x1b");
			else if (event.act === "submit-field" && this.#field instanceof TextFormField) this.#field.submit();
			else if (event.act === "discard-field" && this.#field instanceof TextFormField)
				this.#field.handleInput("\x03");
			else if (!this.#field && !this.#saving) this.#menu.items.find(item => item.id === event.act)?.activate();
			return;
		}
		if (this.#field instanceof SelectFormField) this.#field.handleNativeEvent(event);
		else if (this.#field instanceof TextFormField) this.#field.input.handleNativeEvent(event);
	}

	render(width: number): readonly string[] {
		const innerWidth = Math.max(0, width - 4);
		const lines: string[] = [topBorder(width, "Model facts")];
		const put = (text: string): void => {
			lines.push(row(safe(text, innerWidth), width));
		};
		put(`${this.#provider || "Choose provider"}/${this.#modelId || "Choose model"}`);
		if (this.#field) {
			for (const line of this.#field.render(innerWidth)) put(line);
		} else {
			const items = this.#menu.visibleItems;
			const budget = Math.max(3, (this.#options.rows ?? process.stdout.rows ?? 32) - 16);
			const window = this.#viewport.layout(
				items.map(() => 1),
				this.#menu.selectedIndex,
				budget,
			);
			for (let index = window.startIndex; index < window.endIndex; index++) {
				const label = `${index === this.#menu.selectedIndex ? "> " : "  "}${items[index]!.label}`;
				put(index === this.#menu.selectedIndex ? theme.fg("accent", label) : label);
			}
			for (const line of this.#previewLines()) put(line);
			if (this.#saveError) put(theme.fg("error", this.#saveError));
			put(this.#saving ? "Saving... · Esc close" : "↑/↓ move · Enter or / edit · Esc close without saving");
		}
		lines.push(bottomBorder(width));
		return lines;
	}

	describe(cx: DescribeContext): NativeNode {
		const children: (NativeNode | FormField)[] = [
			node("text", { text: safe(`${this.#provider}/${this.#modelId}`, 240) }),
		];
		if (this.#field) {
			children.push(this.#field);
			children.push(
				actionBar(
					this.#field instanceof TextFormField
						? [
								actionButton("Apply", "submit-field"),
								actionButton("Discard edit", "discard-field", { keys: "ctrl+c" }),
							]
						: [actionButton("Back", "close", { keys: "escape" })],
				),
			);
		} else {
			for (const item of this.#menu.items) children.push(actionButton(safe(item.label, 240), item.id));
			for (const line of this.#previewLines()) children.push(node("text", { text: safe(line, 1000) }));
			if (this.#saveError) children.push(node("text", { text: safe(this.#saveError, 1000), tone: "error" }));
			children.push(
				actionButton(this.#saving ? "Saving... Close" : "Close without saving", "close", { keys: "escape" }),
			);
		}
		void cx;
		return overlayCard("omp.overlay.model-facts", "Model facts", children);
	}

	invalidate(): void {
		this.#field?.invalidate();
	}

	dispose(): void {
		this.#disposed = true;
		this.#previewVersion++;
		this.#field?.dispose();
	}

	leaveMenu(): void {
		this.dispose();
	}

	#close(): void {
		if (this.#field) this.#back();
		else this.#options.onClose();
	}

	#back(): void {
		this.#field?.dispose();
		this.#field = undefined;
		this.#keys.reset();
		this.#options.requestRender?.();
	}

	#show(field: FormField): void {
		this.#field?.dispose();
		this.#field = field;
		field.focused = this.#focused;
		this.#keys.reset();
		this.#options.requestRender?.();
	}

	#text(label: string, initialValue: string, description: string, onSubmit: (value: string) => void): void {
		this.#show(
			new TextFormField({
				theme: formTheme,
				label,
				description,
				initialValue,
				hint: input => `Enter apply · ${input.escapeHint("back if unchanged")} · Ctrl+C discard edit`,
				onSubmit,
				onCancel: () => this.#back(),
				requestRender: this.#options.requestRender,
			}),
		);
	}

	#choose(
		label: string,
		items: readonly { value: string; label: string }[],
		currentValue: string | undefined,
		onSubmit: (value: string) => void,
	): void {
		this.#show(
			new SelectFormField({
				theme: formTheme,
				label,
				items,
				currentValue,
				maxVisible: 8,
				selectTheme: getSelectListTheme(),
				hint: "↑/↓ move · Enter choose · / search · Esc back",
				onSubmit,
				onCancel: () => this.#back(),
				requestRender: this.#options.requestRender,
			}),
		);
	}

	#modelIds(provider: string): string[] {
		const prefix = `${provider}/`;
		return [
			...new Set([
				...(this.#options.providers.find(item => item.id === provider)?.models.map(item => item.id) ?? []),
				...Object.keys(this.#config.overrides)
					.filter(key => key.startsWith(prefix))
					.map(key => key.slice(prefix.length)),
			]),
		];
	}

	#pickProvider(onSubmit: (provider: string) => void, current = this.#provider): void {
		const providers = [
			...new Set([
				...this.#options.providers.map(item => item.id),
				...Object.keys(this.#config.overrides).map(key => key.slice(0, key.indexOf("/"))),
				...(current ? [current] : []),
			]),
		];
		this.#choose(
			"Choose provider",
			[...providers.map(value => ({ value, label: value })), { value: "", label: "+ Type provider ID" }],
			current,
			value => {
				if (value) onSubmit(value);
				else
					this.#text("Provider ID", "", "A registered provider or extension provider ID.", text => {
						if (!text.trim() || text.includes("/")) throw new Error("Use a non-empty provider ID without '/'.");
						onSubmit(text.trim());
					});
			},
		);
	}

	#pickModel(provider: string, current: string, onSubmit: (model: string) => void): void {
		this.#choose(
			`Choose ${provider} model`,
			[
				...this.#modelIds(provider).map(value => ({ value, label: value })),
				{ value: "", label: "+ Add unlisted model ID" },
			],
			current || undefined,
			value => {
				if (value) onSubmit(value);
				else
					this.#text("Model ID", "", "Use the exact provider model ID. Slashes are allowed.", text => {
						if (!text.trim()) throw new Error("A model ID is required.");
						onSubmit(text.trim());
					});
			},
		);
	}

	#targetChanged(): void {
		this.#back();
		this.#saveError = undefined;
		this.#rebuild();
		this.#refreshPreview();
	}

	#rebuild(): void {
		const override = this.#config.overrides[`${this.#provider}/${this.#modelId}`] ?? {};
		const items: EditorRow[] = [
			{
				id: "enabled",
				label: `Fallback facts: ${this.#config.enabled ? "enabled" : "disabled"}`,
				activate: () => {
					this.#config.enabled = !this.#config.enabled;
					this.#targetChanged();
				},
			},
			{
				id: "sources",
				label: `Source chain: ${this.#config.sources.join(" → ") || "empty"}`,
				activate: () =>
					this.#text(
						"Source chain",
						this.#config.sources.join(", "),
						"Comma-separated source IDs in priority order. Empty disables fallback sources.",
						value => {
							const sources = value
								.split(",")
								.map(item => item.trim())
								.filter(Boolean);
							validateModelFactSources(sources);
							this.#config.sources = sources;
							this.#targetChanged();
						},
					),
			},
			{
				id: "provider",
				label: `Provider: ${this.#provider || "choose"}`,
				activate: () =>
					this.#pickProvider(provider => {
						this.#provider = provider;
						this.#modelId = this.#modelIds(provider)[0] ?? "";
						this.#targetChanged();
					}),
			},
			{
				id: "model",
				label: `Model: ${this.#modelId || "choose or add"}`,
				activate: () => {
					if (!this.#provider) {
						this.#saveError = "Choose a provider first.";
						return;
					}
					this.#pickModel(this.#provider, this.#modelId, model => {
						this.#modelId = model;
						this.#targetChanged();
					});
				},
			},
			...MODEL_FACT_FIELDS.map(field => {
				const value = override[field];
				return {
					id: field,
					label: `${FIELD_LABELS[field]}: ${value === undefined ? "automatic" : typeof value === "object" && value !== null && "from" in value ? `borrow ${value.from}` : `literal ${display(value)}`}`,
					activate: () => this.#editField(field),
				};
			}),
			{ id: "preview", label: "Refresh resolved preview", activate: () => this.#refreshPreview() },
			{
				id: "save",
				label: "Save model facts",
				activate: () => {
					void this.#save();
				},
			},
		];
		this.#menu.setItems(items);
	}

	#editField(field: ModelFactField): void {
		if (!this.#provider || !this.#modelId) {
			this.#saveError = "Choose a provider and model first.";
			return;
		}
		const current = this.#config.overrides[`${this.#provider}/${this.#modelId}`]?.[field];
		const mode =
			current === undefined
				? "automatic"
				: typeof current === "object" && current !== null && "from" in current
					? "borrow"
					: "literal";
		this.#choose(
			FIELD_LABELS[field],
			[
				{ value: "automatic", label: "Automatic, use provider then source chain" },
				{ value: "literal", label: "Set a literal value" },
				{ value: "borrow", label: "Borrow only this field from provider/model" },
			],
			mode,
			value => {
				if (value === "automatic") this.#setField(field, undefined);
				else if (value === "borrow")
					this.#pickProvider(provider =>
						this.#pickModel(provider, "", model => {
							this.#setField(field, { from: `${provider}/${model}` });
						}),
					);
				else
					this.#text(FIELD_LABELS[field], this.#literalText(field, current), LITERAL_HELP[field], text => {
						const parsed: unknown =
							field === "input" || field === "efforts"
								? text
										.split(",")
										.map(item => item.trim())
										.filter(Boolean)
								: JSON.parse(text);
						const key = `${this.#provider}/${this.#modelId}`;
						const candidate: unknown = { [key]: { [field]: parsed } };
						validateModelFactOverrides(candidate);
						this.#setField(field, candidate[key]![field]);
					});
			},
		);
	}

	#literalText(field: ModelFactField, current: unknown): string {
		const literal = current !== undefined && !(typeof current === "object" && current !== null && "from" in current);
		const model = this.#preview?.model;
		const value = literal
			? current
			: model
				? field === "efforts"
					? getSupportedEfforts(model)
					: model[field]
				: undefined;
		if (value === undefined) return "";
		if (field === "input" || field === "efforts") return Array.isArray(value) ? value.join(", ") : "";
		return JSON.stringify(value);
	}

	#setField(field: ModelFactField, value: ModelFactOverride[ModelFactField]): void {
		const key = `${this.#provider}/${this.#modelId}`;
		const next: ModelFactOverride = { ...this.#config.overrides[key] };
		if (value === undefined) delete next[field];
		else Object.assign(next, { [field]: value });
		// Keep an empty override: it also registers a model absent from discovery.
		this.#config.overrides[key] = next;
		this.#targetChanged();
	}

	#refreshPreview(): void {
		const version = ++this.#previewVersion;
		this.#preview = undefined;
		this.#previewError = undefined;
		this.#previewPending = false;
		if (!this.#provider || !this.#modelId) return;
		this.#previewPending = true;
		try {
			const result = this.#options.preview(structuredClone(this.#config), this.#provider, this.#modelId);
			void Promise.resolve(result).then(
				preview => {
					if (this.#disposed || version !== this.#previewVersion) return;
					this.#preview = preview;
					this.#previewPending = false;
					this.#options.requestRender?.();
				},
				error => this.#failPreview(version, error),
			);
		} catch (error) {
			this.#failPreview(version, error);
		}
	}

	#failPreview(version: number, error: unknown): void {
		if (this.#disposed || version !== this.#previewVersion) return;
		this.#previewPending = false;
		this.#previewError = error instanceof Error ? error.message : String(error);
		this.#options.requestRender?.();
	}

	#previewLines(): string[] {
		if (this.#previewPending) return ["Resolving preview..."];
		if (this.#previewError) return [`Preview failed: ${this.#previewError}`];
		if (!this.#preview) return ["Choose a provider and model for the resolved preview."];
		const { model, provenance, issues } = this.#preview;
		return [
			this.#config.enabled ? "Resolved preview" : "Resolved preview · disabled, provider facts remain active",
			...MODEL_FACT_FIELDS.map(
				field =>
					`${FIELD_LABELS[field]}: ${display(field === "efforts" ? getSupportedEfforts(model) : model[field])} ← ${origin(provenance[field])}`,
			),
			...issues.map(issue => `Warning: ${issue}`),
		];
	}

	async #save(): Promise<void> {
		if (this.#saving) return;
		this.#saveError = undefined;
		this.#saving = true;
		try {
			if (this.#provider && this.#modelId) this.#config.overrides[`${this.#provider}/${this.#modelId}`] ??= {};
			validateModelFactOverrides(this.#config.overrides);
			validateModelFactSources(this.#config.sources);
			await this.#options.onSave(structuredClone(this.#config));
			if (!this.#disposed) this.#options.onClose();
		} catch (error) {
			this.#saveError = error instanceof Error ? error.message : String(error);
		} finally {
			this.#saving = false;
			if (!this.#disposed) this.#options.requestRender?.();
		}
	}
}
