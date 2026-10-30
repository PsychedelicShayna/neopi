import { Input } from "../components/input";
import { SelectList, type SelectItem } from "../components/select-list";
import { matchesKey } from "../keys";
import { node, span, text } from "../native/describe";
import type { NativeNode, NativeUiEvent } from "../native/node";
import type { SgrMouseEvent } from "../mouse";
import { sanitizeDisplayWarning } from "../render/render-utils";
import { getSelectListTheme } from "../theme/theme";
import { truncateToWidth } from "../utils";
import { ModelConfigFields, type ModelConfigFieldSchema } from "./model-config-fields";

export interface HubModelConfigEntry {
	provider: string;
	id: string;
	kind: "override" | "custom";
	/** Array index distinguishes duplicate IDs in a hand-written custom-model list. */
	index?: number;
	fields: Record<string, unknown>;
}

export interface ModelOverridesHost {
	list(): HubModelConfigEntry[];
	schema(kind: HubModelConfigEntry["kind"]): ModelConfigFieldSchema;
	save(entry: HubModelConfigEntry, original?: HubModelConfigEntry): Promise<void>;
	remove(entry: HubModelConfigEntry): Promise<void>;
	changed(): void;
	back(): void;
}

export const MODEL_OVERRIDES_DESCRIPTION =
	"Explicit model overrides beat custom definitions, discovery and the catalog. Custom entries replace matching catalog/discovered models. Unknown fields are read-only and preserved.";

function shown(value: unknown): string {
	return sanitizeDisplayWarning(String(value));
}

/** A schema-driven config editor embedded in /models, not a second serializer. */
export class ModelOverridesPanel {
	#list = new SelectList([], 12, getSelectListTheme(), { search: "always", wrapDescription: true });
	#entries: HubModelConfigEntry[] = [];
	#draft?: HubModelConfigEntry;
	#original?: HubModelConfigEntry;
	#fields?: ModelConfigFields;
	#identity?: { key: "provider" | "id"; input: Input };
	#pending = false;
	#deleting?: HubModelConfigEntry;
	#error?: string;
	#descriptionRows = 1;

	constructor(readonly host: ModelOverridesHost) {
		this.#list.onSelect = item => this.#activate(item.value);
		this.#list.onCancel = () => {
			if (this.#deleting) {
				this.#deleting = undefined;
				this.#rebuild();
			} else if (this.#fields?.back()) this.#rebuild();
			else if (this.#draft) {
				this.#draft = undefined;
				this.#original = undefined;
				this.#fields = undefined;
				this.reload();
			} else this.host.back();
		};
		this.reload();
	}

	get editing(): boolean {
		return !!this.#identity || !!this.#fields?.input || this.#list.filterFocused;
	}
	get hint(): string {
		if (this.#pending) return "Saving…";
		if (this.#identity || this.#fields?.input) return "Enter accept · Esc leave field";
		return this.#draft
			? "Enter edit · x unset/remove · t type · s save · / search · Esc back/discard · Tab pane"
			: "Enter fields · x delete · / search · Esc sidebar · Tab pane";
	}

	reload(): void {
		if (this.#draft || this.#pending) return;
		try {
			this.#entries = this.host.list();
			this.#error = undefined;
		} catch (error) {
			this.#error = shown(error instanceof Error ? error.message : error);
			this.#entries = [];
		}
		this.#rebuild();
	}

	#rebuild(): void {
		const draft = this.#draft;
		let items: SelectItem[];
		if (this.#deleting)
			items = [
				{ value: "keep", label: "Keep entry" },
				{
					value: "delete",
					label: `Delete ${this.#deleting.provider}/${this.#deleting.id}`,
					confirmation: "Enter again to delete this entry",
				},
			];
		else if (!draft) {
			items = this.#entries.map((entry, index) => ({
				value: String(index),
				label: `${entry.provider}/${entry.id}`,
				description: entry.kind,
			}));
			items.push(
				{ value: "new:override", label: "+ New override" },
				{ value: "new:custom", label: "+ New custom model" },
			);
		} else {
			items = this.#fields?.items() ?? [];
			if (this.#fields?.atRoot) {
				items.unshift(
					{
						value: "meta:provider",
						label: "Provider",
						description: `${draft.provider || "required"}${this.#original ? " · read-only" : ""}`,
					},
					{
						value: "meta:id",
						label: "Model ID",
						description: draft.id || "required",
					},
					{ value: "meta:kind", label: "Entry type", description: `${draft.kind} · read-only` },
				);
				items.push({ value: "save", label: "Save entry" });
			}
		}
		this.#list.setItems(items);
	}

	#activate(value: string): void {
		if (this.#pending) return;
		if (this.#deleting) {
			const entry = this.#deleting;
			this.#deleting = undefined;
			if (value === "delete") void this.#persist(entry);
			else this.#rebuild();
			return;
		}
		if (!this.#draft) {
			this.#original = value.startsWith("new:") ? undefined : this.#entries[Number(value)];
			this.#draft = this.#original
				? structuredClone(this.#original)
				: { provider: "", id: "", kind: value === "new:custom" ? "custom" : "override", fields: {} };
			this.#fields = new ModelConfigFields(this.#draft.fields, this.host.schema(this.#draft.kind));
			this.#error = undefined;
			this.#rebuild();
			this.#list.setSelectedValue(this.#original ? "field:name" : "meta:provider");
			return;
		}
		if (value === "save") {
			void this.#persist();
			return;
		}
		if (value.startsWith("meta:")) {
			if ((this.#original && value === "meta:provider") || value === "meta:kind") return;
			const key = value === "meta:id" ? "id" : "provider";
			const input = new Input();
			input.setValue(this.#draft[key]);
			input.focused = true;
			this.#identity = { key, input };
		} else {
			this.#fields?.activate(value);
			this.#rebuild();
		}
	}

	async #persist(remove?: HubModelConfigEntry): Promise<void> {
		if (this.#pending) return;
		this.#pending = true;
		this.#error = undefined;
		try {
			if (remove) await this.host.remove(remove);
			else if (this.#draft) await this.host.save(this.#draft, this.#original);
			this.#draft = undefined;
			this.#original = undefined;
			this.#fields = undefined;
		} catch (error) {
			this.#error = shown(error instanceof Error ? error.message : error);
		} finally {
			this.#pending = false;
			const error = this.#error;
			if (!this.#draft) this.reload();
			this.#error = error;
			this.host.changed();
		}
	}

	handleInput(data: string): void {
		if (this.#pending) return;
		const input = this.#identity?.input ?? this.#fields?.input?.input;
		if (input) {
			if (matchesKey(data, "escape")) {
				this.#identity = undefined;
				if (this.#fields) this.#fields.input = undefined;
				return;
			}
			if (matchesKey(data, "enter") || data === "\n") {
				try {
					if (this.#identity && this.#draft) {
						this.#draft[this.#identity.key] = input.getValue().trim();
						this.#identity = undefined;
					} else this.#fields?.acceptInput();
					this.#error = undefined;
					this.#rebuild();
				} catch (error) {
					this.#error = shown(error instanceof Error ? error.message : error);
				}
			} else input.handleInput(data);
			return;
		}
		if (!this.#list.filterFocused && !this.#deleting) {
			const value = this.#list.getSelectedItem()?.value ?? "";
			if (data === "s" && this.#draft) {
				void this.#persist();
				return;
			}
			if (data === "t" && this.#draft) {
				this.#fields?.changeType(value);
				this.#rebuild();
				return;
			}
			if (data === "x") {
				if (this.#draft) this.#fields?.remove(value);
				else this.#deleting = this.#entries[Number(value)];
				this.#rebuild();
				if (this.#deleting) this.#list.setSelectedValue("keep");
				return;
			}
		}
		this.#list.handleInput(data);
	}

	render(width: number, rows: number): string[] {
		const description = Bun.wrapAnsi(MODEL_OVERRIDES_DESCRIPTION, width).split("\n");
		this.#descriptionRows = description.length + (this.#error ? 1 : 0) + 1;
		const input = this.#identity?.input ?? this.#fields?.input?.input;
		this.#list.setMaxVisible(Math.max(1, rows - this.#descriptionRows - (input ? 2 : 0)));
		return [
			...description,
			...(this.#error ? [truncateToWidth(this.#error, width)] : []),
			truncateToWidth(this.#fields?.heading ?? "Model overrides and custom models", width),
			...this.#list.render(width),
			...(input
				? [truncateToWidth(this.#identity?.key ?? this.#fields?.input?.label ?? "", width), ...input.render(width)]
				: []),
		].slice(0, rows);
	}

	describe(): NativeNode {
		const input = this.#identity?.input ?? this.#fields?.input?.input;
		return node(
			"col",
			{ gap: "sm", grow: 1 },
			[
				text([span(MODEL_OVERRIDES_DESCRIPTION)], { wrap: "word" }),
				...(this.#error ? [text([span(this.#error, "error")])] : []),
				text([span(this.#fields?.heading ?? "Model overrides and custom models")]),
				this.#list,
				...(input ? [text([span(this.#identity?.key ?? this.#fields?.input?.label ?? "")]), input] : []),
			],
			"modelOverrides",
		);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (!this.#pending) this.#list.handleNativeEvent(event);
	}
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (!this.#pending) this.#list.routeMouse(event, line - this.#descriptionRows, col);
	}
}
