import type { SelectItem } from "./select-list";

export interface ChecklistOptions {
	entries: readonly SelectItem[];
	selected: readonly string[];
	/** Already granted outside the editable selection; shown checked and locked. */
	fixed?: readonly string[];
	/** Show position numbers when selection order matters. */
	ordered?: boolean;
	/** Rows replacing the whole selection, including an omitted/default selection. */
	presets?: readonly (SelectItem & { apply: () => string[] | undefined })[];
}

/** Row and selection model for SelectList-backed checkboxes. */
export class Checklist {
	selected: string[] | undefined;
	readonly #entries: ReadonlyMap<string, SelectItem>;

	constructor(private readonly options: ChecklistOptions) {
		this.#entries = new Map(options.entries.map(entry => [entry.value, entry]));
		this.selected = [...options.selected];
	}

	get current(): string[] {
		return [...(this.selected ?? []), ...(this.options.fixed ?? [])].map(name => `item:${name}`);
	}

	items(): SelectItem[] {
		const names = [...this.#entries.keys(), ...(this.selected ?? []).filter(name => !this.#entries.has(name))];
		return [
			...(this.options.presets ?? []),
			...names.map(name => {
				const entry = this.#entries.get(name);
				const position = this.selected?.indexOf(name) ?? -1;
				const fixed = this.options.fixed?.includes(name) ?? false;
				const mark =
					position >= 0 && this.options.ordered ? `[${position + 1}]` : position >= 0 || fixed ? "[x]" : "[ ]";
				return {
					value: `item:${name}`,
					label: `${mark} ${entry?.label ?? name}`,
					description: entry?.description ?? (entry ? undefined : "not in catalog"),
					disabled: fixed || entry?.disabled,
				};
			}),
		];
	}

	add(names: readonly string[]): void {
		for (const name of names) if (!this.selected?.includes(name)) (this.selected ??= []).push(name);
	}

	toggle(value: string): void {
		const preset = this.options.presets?.find(candidate => candidate.value === value);
		if (preset) this.selected = preset.apply();
		else if (value.startsWith("item:")) {
			const name = value.slice("item:".length);
			if (this.#entries.get(name)?.disabled || this.options.fixed?.includes(name)) return;
			const selected = (this.selected ??= []);
			const index = selected.indexOf(name);
			if (index < 0) selected.push(name);
			else selected.splice(index, 1);
		}
	}
}
