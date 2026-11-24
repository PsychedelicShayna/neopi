import { t } from "@oh-my-pi/pi-utils/i18n";
import { SelectList, type SelectItem, type SelectListNavigationState } from "../components/select-list";
import { MenuKeyReader } from "../components/menu-navigation";
import { menuHintLines } from "../components/menu-hints";
import { bottomBorder, divider, row, topBorder } from "../chrome/overlay-box";
import { matchesKey } from "../keys";
import { routeSgrMouseInput } from "../mouse";
import { getSelectListTheme, theme } from "../theme";
import { text } from "../native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { overlayCard } from "../native/overlay";
import { picker, pickerAction, pickerEvent, routeSelectListPicker, selectListPicker } from "../native/picker";
import type { Component } from "../tui";
import type { AdvisorConfig, AdvisorConfigScope } from "./advisor-config";
import { sanitizeDisplayLine } from "./extensions/display-text";
import { shortenPath } from "../render/render-utils";

/** Role settings use user/project .omp config.yml or session settings.yml, never root WATCHDOG. */
export type AdvisorActivationSetScope = "user" | "project-omp" | "session";
export interface AdvisorActivationSetEntry {
	key: string;
	advisor: AdvisorConfig;
	path: string;
	scope: AdvisorConfigScope;
	index: number;
	visible: boolean;
	fileEnabled: boolean;
	unavailableReason?: string;
}
export interface AdvisorActivationSetState {
	ids: readonly string[] | null;
	inherited: boolean;
	source: string;
	effectiveNote?: string;
	globalEnabled: boolean;
	entries: readonly AdvisorActivationSetEntry[];
}
export interface AdvisorActivationSetSelection {
	ids: readonly string[] | null;
	/** Legacy rows get persistent identities only when the operator saves. */
	legacy: readonly AdvisorActivationSetEntry[];
}
export interface AdvisorActivationIdentity {
	path: string;
	index: number;
	id: string;
	before: AdvisorConfig;
}
interface AdvisorActivationSetCallbacks {
	close: () => void;
	notify: (message: string) => void;
	requestRender: () => void;
	saved?: (assigned: readonly AdvisorActivationIdentity[]) => Promise<void>;
}
export interface AdvisorActivationSetSource {
	getRoles: () => readonly { id: string; label: string }[];
	getActiveRole: () => string | undefined;
	getActiveScope: () => AdvisorActivationSetScope;
	load: (role: string, scope: AdvisorActivationSetScope) => Promise<AdvisorActivationSetState>;
	save: (
		role: string,
		scope: AdvisorActivationSetScope,
		selection: AdvisorActivationSetSelection,
	) => Promise<readonly AdvisorActivationIdentity[]>;
	getOverrideNote: (advisor: AdvisorConfig) => string | undefined;
}
interface ActivationNavigationSnapshot {
	list: SelectListNavigationState;
	ids: string[] | null;
	legacy: string[];
	dirty: boolean;
}

/** The same editable checkbox list is used from scope rows and affected advisor rows. */
export class AdvisorActivationSetOverlayComponent implements Component {
	readonly #role: string;
	readonly #scope: AdvisorActivationSetScope;
	readonly #source: AdvisorActivationSetSource;
	readonly #cb: AdvisorActivationSetCallbacks;
	readonly #keys = new MenuKeyReader();
	#state: AdvisorActivationSetState;
	#ids: Set<string> | null;
	#legacy = new Set<string>();
	#dirty = false;
	#busy = false;
	#discardArmed = false;
	#list: SelectList;
	#listTop = 0;

	constructor(
		role: string,
		scope: AdvisorActivationSetScope,
		state: AdvisorActivationSetState,
		source: AdvisorActivationSetSource,
		callbacks: AdvisorActivationSetCallbacks,
	) {
		this.#role = role;
		this.#scope = scope;
		this.#state = state;
		this.#source = source;
		this.#cb = callbacks;
		this.#ids = state.ids === null ? null : new Set(state.ids);
		this.#list = this.#buildList();
	}

	#buildList(navigation?: SelectListNavigationState): SelectList {
		const items: SelectItem[] = [];
		const represented = new Set<string>();
		for (const entry of this.#state.entries) {
			const id = entry.advisor.id;
			const selected = id ? this.#ids?.has(id) === true : this.#legacy.has(entry.key);
			if (!entry.visible && !selected) continue;
			if (id) represented.add(id);
			const flags = [
				!entry.visible ? t("overlaysModel.advisorActivationSets.outOfScope") : undefined,
				!entry.fileEnabled ? t("overlaysModel.advisorActivationSets.fileDisabled") : undefined,
				entry.unavailableReason,
				!id ? t("overlaysModel.advisorActivationSets.legacyId") : undefined,
				this.#ids !== null
					? t("overlaysModel.advisorActivationSets.overrideFlag", {
							state:
								entry.advisor.enabled === false
									? t("overlaysModel.advisorActivationSets.flagOff")
									: t("overlaysModel.advisorActivationSets.flagOn"),
						})
					: t("overlaysModel.advisorActivationSets.ownFlag", {
							state:
								entry.advisor.enabled === false
									? t("overlaysModel.advisorActivationSets.flagOff")
									: t("overlaysModel.advisorActivationSets.flagOn"),
						}),
			]
				.filter(Boolean)
				.join(" · ");
			items.push({
				value: `entry:${entry.key}`,
				label: `[${selected ? "x" : " "}] ${sanitizeDisplayLine(entry.advisor.name)} · ${entry.scope} · ${sanitizeDisplayLine(flags)}`,
			});
		}
		for (const id of this.#ids ?? []) {
			if (!represented.has(id))
				items.push({
					value: `missing:${id}`,
					label: t("overlaysModel.advisorActivationSets.missingAdvisor", { id: sanitizeDisplayLine(id) }),
				});
		}
		items.push(
			{ value: "create", label: t("overlaysModel.advisorActivationSets.createEmpty") },
			{ value: "clear", label: t("overlaysModel.advisorActivationSets.clearActivationSet") },
			{ value: "save", label: t("overlaysModel.advisorActivationSets.saveRoleSet") },
			{ value: "back", label: t("overlaysModel.advisorActivationSets.back") },
		);
		const list = new SelectList(items, 20, getSelectListTheme(), { search: "always", activateOnSpace: false });
		if (navigation) list.restoreNavigation(navigation);
		list.onSelect = item => this.#select(item.value);
		list.onCancel = () => this.#back();
		list.onSelectionChange = () => this.#cb.requestRender();
		return list;
	}

	#select(value: string): void {
		if (value === "save") {
			void this.#save();
			return;
		}
		if (value === "back") {
			this.#back();
			return;
		}
		this.#discardArmed = false;
		if (value === "create") {
			this.#ids = new Set();
			this.#legacy.clear();
		} else if (value === "clear") {
			this.#ids = null;
			this.#legacy.clear();
		} else if (value.startsWith("missing:")) this.#ids?.delete(value.slice(8));
		else if (value.startsWith("entry:")) {
			const entry = this.#state.entries.find(candidate => candidate.key === value.slice(6));
			if (!entry) return;
			const id = entry.advisor.id;
			if (!entry.visible || entry.unavailableReason) {
				if (id) this.#ids?.delete(id);
			} else {
				this.#ids ??= new Set();
				const selected = id ? this.#ids : this.#legacy;
				const key = id ?? entry.key;
				if (!selected.delete(key)) selected.add(key);
			}
		} else return;
		this.#dirty = true;
		this.#list = this.#buildList(this.#list.navigationState());
		this.#cb.requestRender();
	}

	async #save(): Promise<void> {
		if (this.#busy || !this.#dirty) return;
		this.#busy = true;
		this.#cb.requestRender();
		try {
			const assigned = await this.#source.save(this.#role, this.#scope, {
				ids: this.#ids === null ? null : [...this.#ids],
				legacy: this.#state.entries.filter(entry => this.#legacy.has(entry.key)),
			});
			await this.#cb.saved?.(assigned);
			this.#state = await this.#source.load(this.#role, this.#scope);
			this.#ids = this.#state.ids === null ? null : new Set(this.#state.ids);
			this.#legacy.clear();
			this.#dirty = false;
			this.#discardArmed = false;
			this.#list = this.#buildList(this.#list.navigationState());
			this.#cb.notify(
				t("overlaysModel.advisorActivationSets.savedRoleSet", {
					scope: this.#scope,
					role: this.#role,
					extra: assigned.length > 0 ? t("overlaysModel.advisorActivationSets.newIdsSaved") : "",
				}),
			);
		} catch (error) {
			this.#cb.notify(t("overlaysModel.advisorActivationSets.error", { error: String(error) }));
		} finally {
			this.#busy = false;
			this.#cb.requestRender();
		}
	}

	#back(): void {
		if (this.#busy) return;
		if (this.#dirty && !this.#discardArmed) {
			this.#discardArmed = true;
			this.#cb.requestRender();
			return;
		}
		this.#cb.close();
	}

	#summary(): string[] {
		const entry = this.#state.entries.find(
			candidate => `entry:${candidate.key}` === this.#list.getSelectedItem()?.value,
		);
		return [
			t("overlaysModel.advisorActivationSets.scopeRole", {
				scope:
					this.#scope === "user"
						? t("overlaysModel.advisorActivationSets.scopeUser")
						: this.#scope === "session"
							? t("overlaysModel.advisorActivationSets.scopeSession")
							: t("overlaysModel.advisorActivationSets.scopeProjectOmp"),
				role: sanitizeDisplayLine(this.#role),
			}),
			this.#ids === null
				? t("overlaysModel.advisorActivationSets.noRoleSet")
				: t("overlaysModel.advisorActivationSets.setReplacesFlags"),
			this.#state.inherited && !this.#dirty
				? t("overlaysModel.advisorActivationSets.inherited", { source: shortenPath(this.#state.source) })
				: t("overlaysModel.advisorActivationSets.source", {
						source: this.#dirty
							? t("overlaysModel.advisorActivationSets.unsavedDraft")
							: shortenPath(this.#state.source),
					}),
			this.#state.globalEnabled
				? t("overlaysModel.advisorActivationSets.globalSwitchOn")
				: t("overlaysModel.advisorActivationSets.globalSwitchOff"),
			...(this.#state.effectiveNote ? [this.#state.effectiveNote] : []),
			...(entry
				? [
						t("overlaysModel.advisorActivationSets.stableId", {
							id: sanitizeDisplayLine(
								entry.advisor.id ?? t("overlaysModel.advisorActivationSets.assignedOnSave"),
							),
						}),
						t("overlaysModel.advisorActivationSets.advisorSource", {
							path: sanitizeDisplayLine(shortenPath(entry.path)),
						}),
					]
				: []),
			...(this.#discardArmed ? [t("overlaysModel.advisorActivationSets.discardHint")] : []),
		].map(sanitizeDisplayLine);
	}

	render(width: number): readonly string[] {
		const hints = menuHintLines(t("overlaysModel.advisorActivationSets.terminalHint"), Math.max(1, width - 4));
		const summary = this.#summary().flatMap(line =>
			Bun.wrapAnsi(line, Math.max(1, width - 4), { hard: true }).split("\n"),
		);
		this.#listTop = summary.length + 2;
		this.#list.setMaxVisible(Math.max(1, (process.stdout.rows || 40) - summary.length - hints.length - 5));
		return [
			topBorder(
				width,
				t("overlaysModel.advisorActivationSets.heading", {
					state: this.#busy
						? t("overlaysModel.advisorActivationSets.savingSuffix")
						: this.#dirty
							? t("overlaysModel.advisorActivationSets.unsavedSuffix")
							: "",
				}),
			),
			...summary.map(line => row(line, width)),
			divider(width),
			...this.#list.render(width - 4).map(line => row(line, width)),
			divider(width),
			...hints.map(line => row(theme.fg("dim", line), width)),
			bottomBorder(width),
		];
	}
	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("picker");
	}
	describe(_cx: DescribeContext): NativeNode {
		return overlayCard(
			"omp.overlay.advisor-activation-set",
			t("overlaysModel.advisorActivationSets.roleHeading", { role: sanitizeDisplayLine(this.#role) }),
			[
				...this.#summary().map(line => text(line, { wrap: "word" })),
				picker({
					...selectListPicker(this.#list, {
						title: t("overlaysModel.advisorActivationSets.roleTitle", { role: sanitizeDisplayLine(this.#role) }),
						searchable: true,
					}),
					actions: [
						pickerAction("toggle", t("overlaysModel.advisorActivationSets.toggle"), "space"),
						pickerAction("create", t("overlaysModel.advisorActivationSets.createEmptyShort"), "c"),
						pickerAction("clear", t("overlaysModel.advisorActivationSets.clearSet"), "backspace"),
						pickerAction("save", t("overlaysModel.advisorActivationSets.save"), "s"),
						pickerAction("close", t("overlaysModel.advisorActivationSets.back"), "escape"),
					],
				}),
			],
		);
	}
	handleInput(data: string): void {
		if (this.#busy) return;
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				this.#list.routeMouse(event, event.row - this.#listTop, event.col - 2);
			});
			this.#cb.requestRender();
			return;
		}
		if (this.#list.filterFocused) {
			this.#keys.reset();
			this.#list.handleInput(data);
			return;
		}
		const action = this.#keys.read(data);
		if (action === "pending") return;
		if (action?.kind === "cancel") {
			this.#list.handleNavigation(action);
			this.#cb.requestRender();
			return;
		}
		this.#discardArmed = false;
		if (data === "s") this.#select("save");
		else if (data === "c") this.#select("create");
		else if (matchesKey(data, "backspace")) this.#select("clear");
		else if (action?.kind === "toggle") {
			const value = this.#list.getSelectedItem()?.value;
			if (value?.startsWith("entry:") || value?.startsWith("missing:")) this.#select(value);
		} else if (action) this.#list.handleNavigation(action);
		else this.#list.handleInput(data);
		this.#cb.requestRender();
	}
	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#busy) return;
		const picked = pickerEvent(event);
		if (picked?.kind === "action" && picked.act === "close" && !this.#list.filterFocused && !this.#list.getFilter())
			this.#back();
		else if (picked?.kind === "action" && ["toggle", "create", "clear", "save"].includes(picked.act)) {
			if (this.#list.filterFocused) return;
			this.#select(picked.act === "toggle" ? (this.#list.getSelectedItem()?.value ?? "") : picked.act);
		} else routeSelectListPicker(this.#list, event);
		this.#cb.requestRender();
	}
	get blocksMenuHistory(): boolean {
		return this.#busy;
	}
	leaveMenu(): void {
		this.#keys.reset();
	}
	navigationSnapshot(): ActivationNavigationSnapshot {
		return {
			list: this.#list.navigationState(),
			ids: this.#ids === null ? null : [...this.#ids],
			legacy: [...this.#legacy],
			dirty: this.#dirty,
		};
	}
	restoreNavigation(snapshot: unknown): void {
		if (!snapshot || typeof snapshot !== "object" || !("ids" in snapshot)) return;
		const state = snapshot as ActivationNavigationSnapshot;
		this.#ids = state.ids === null ? null : new Set(state.ids);
		this.#legacy = new Set(state.legacy);
		this.#dirty = state.dirty;
		this.#discardArmed = false;
		this.#keys.reset();
		this.#list = this.#buildList(state.list);
	}
}
