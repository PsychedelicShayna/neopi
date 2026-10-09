import { Effort } from "@oh-my-pi/pi-catalog/effort";

/** Draft-only toggle state: callers persist the result only after confirm succeeds. */
export class EffortToggle {
	readonly options: readonly Effort[];
	readonly selected: Set<Effort>;

	constructor(options: readonly Effort[], saved?: readonly Effort[]) {
		this.options = options;
		this.selected = new Set(saved === undefined ? options : saved.filter(level => options.includes(level)));
	}

	toggle(level: Effort): void {
		if (!this.options.includes(level)) return;
		if (this.selected.has(level)) this.selected.delete(level);
		else this.selected.add(level);
	}

	confirm(): Effort[] | undefined {
		const enabled = this.options.filter(level => this.selected.has(level));
		return enabled.length > 0 ? enabled : undefined;
	}
}
