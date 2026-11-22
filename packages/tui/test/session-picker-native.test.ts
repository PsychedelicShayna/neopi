import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getKeybindings, setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import { OverlayPanel } from "../src/chrome/overlay-box";
import { TextFormField } from "../src/components/form";
import { getMenuSearchVimMode, setMenuSearchVimMode } from "../src/components/menu-navigation";
import type { DescribeContext, NativeNode } from "../src/native/node";
import { type HistorySearchEntry, HistorySearchComponent } from "../src/overlays/history-search";
import { type SessionSelectorEntry, SessionSelectorComponent } from "../src/overlays/session-selector";
import { initTheme } from "../src/theme";

const withPicker: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};
const withoutPicker: DescribeContext = { ...withPicker, supports: kind => kind !== "picker" };

const previousKeybindings = getKeybindings();

beforeAll(async () => {
	await initTheme(false);
	// The app installs its keymap before any picker opens; `getKeybindings()` alone knows only `tui.*` actions.
	setKeybindings(KeybindingsManager.inMemory());
});

afterAll(() => setKeybindings(previousKeybindings));

const HOUR = 3_600_000;

function session(id: string, title: string, ageMs: number, cwd = "/work/app"): SessionSelectorEntry {
	return {
		path: `${cwd}/.omp/${id}.jsonl`,
		id,
		cwd,
		title,
		modified: new Date(Date.now() - ageMs),
		size: 5_600,
		firstMessage: `${title} prompt`,
		allMessagesText: `${title} prompt ${title} answer`,
		status: "complete",
	};
}

function props(root: NativeNode): TspPickerProps {
	expect(root.k).toBe("picker");
	return root.p as TspPickerProps;
}

function type(component: { handleInput(data: string): void }, text: string): void {
	for (const char of text) component.handleInput(char);
}

/** Resolves on the first render request after which the picker props satisfy `ready`. */
function renderedWhen(selector: SessionSelectorComponent, ready: (p: TspPickerProps) => boolean): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	selector.setOnRequestRender(() => {
		if (ready(props(selector.describe(withPicker)))) resolve();
	});
	return promise;
}

describe("session selector picker", () => {
	const today = session("a", "Alpha", 0);
	const todayToo = session("b", "Beta", 1);
	const old = session("c", "Gamma", 40 * 24 * HOUR);
	const others = session("d", "Delta", 3 * 24 * HOUR, "/work/other");

	function make(opts: { deleted?: string[]; resumed?: string[]; standalone?: boolean } = {}) {
		return new SessionSelectorComponent(
			[today, todayToo, old],
			s => opts.resumed?.push(s.id),
			() => {},
			{
				onDelete: async s => {
					opts.deleted?.push(s.id);
					return true;
				},
				loadAllSessions: async () => ({ sessions: [today, todayToo, others, old] }),
				currentSessionPath: todayToo.path,
				standalone: opts.standalone,
			},
		);
	}

	it("describes a grouped cards picker with a preview when the terminal has the kind, else the card", () => {
		const selector = make();
		expect(selector.nativeSheet(withPicker)).toBe(true);
		const root = selector.describe(withPicker);
		const p = props(root);
		expect(p.size).toBe("lg");
		expect(p.layout).toBe("cards");
		expect(p.actions?.find(a => a.id === "scope")?.label).toBe("All projects");
		expect(p.placeholder).toMatch(/^Search sessions in .+…$/);
		expect(p.order).toEqual([
			{ group: "today-0", label: "Today", count: 2 },
			today.path,
			todayToo.path,
			{ group: "earlier-2", label: "Earlier", count: 1 },
			old.path,
		]);
		expect(p.selected).toBe(todayToo.path);
		expect(p.current).toEqual([todayToo.path]);
		const beta = p.items?.find(item => item.id === todayToo.path);
		expect(beta?.badges?.map(b => b.text)).toEqual(["current"]);
		expect(beta?.dot).toBe("success");
		const preview = root.c as NativeNode[];
		expect(preview[0]).toMatchObject({ k: "text", p: { text: "Beta", role: "omp.picker.title" } });
		expect(preview.find(child => child.k === "section")?.p).toEqual({ head: "Conversation" });

		expect(selector.nativeSheet(withoutPicker)).toBe(false);
		expect(selector.describe(withoutPicker).k).toBe("card");
	});

	it("fills the screen surface in the standalone app", () => {
		const selector = make({ standalone: true });
		expect(selector.nativeSheet(withPicker)).toBe(false);
		expect(props(selector.describe(withPicker)).size).toBe("screen");
	});

	it("previews session search live and confirms without resuming a result", () => {
		const resumed: string[] = [];
		const selector = make({ resumed });
		selector.handleInput("/");
		type(selector, "gam");
		const drafting = props(selector.describe(withPicker));
		expect(drafting.query).toBe("gam");
		expect(drafting.order).toEqual([old.path]);
		expect(drafting.hits).toEqual({ [old.path]: [[0, 3]] });
		selector.handleInput("\r");
		const after = props(selector.describe(withPicker));
		expect(after.query).toBe("gam");
		expect(after.order).toEqual([old.path]);
		expect(after.hits).toEqual({ [old.path]: [[0, 3]] });
		expect(after.selected).toBe(old.path);
		expect(resumed).toEqual([]);
	});

	it.each([false, true])("offers only search actions and keeps a Backed-out draft (Vim %s)", vim => {
		const previous = getMenuSearchVimMode();
		setMenuSearchVimMode(vim);
		try {
			const resumed: string[] = [];
			const selector = make({ resumed });
			const picker = () => props(selector.describe(withPicker));
			const act = (action: string) => selector.handleNativeEvent({ type: "action", key: "", act: action, mods: [] });
			selector.handleInput("/");
			type(selector, "gam");
			expect(picker().actions?.map(action => action.id)).toEqual(["search", "clear", "close"]);
			expect(picker().actions?.find(action => action.id === "close")?.keys).toEqual(vim ? undefined : ["esc"]);
			act("close");
			expect(picker().query).toBe("");
			selector.handleInput("/");
			expect(picker().query).toBe("gam");
			act("search");
			expect(picker().query).toBe("gam");
			expect(picker().actions?.map(action => action.id)).toContain("resume");
			expect(resumed).toEqual([]);
		} finally {
			setMenuSearchVimMode(previous);
		}
	});

	it("runs pointer events down the keys' paths", async () => {
		const resumed: string[] = [];
		const deleted: string[] = [];
		const selector = make({ resumed, deleted });
		expect(props(selector.describe(withPicker)).actions?.find(action => action.id === "delete")?.keys).toEqual([
			"delete",
		]);

		selector.handleNativeEvent({ type: "select", key: "", item: old.path });
		expect(props(selector.describe(withPicker)).selected).toBe(old.path);
		selector.handleNativeEvent({ type: "action", key: "", act: "resume", mods: [] });
		expect(resumed).toEqual(["c"]);

		selector.handleNativeEvent({ type: "action", key: "", act: "delete", mods: [] });
		expect(props(selector.describe(withPicker)).confirm?.act).toBe("delete-confirm");
		selector.handleNativeEvent({ type: "action", key: "", act: "cancel", mods: [] });
		expect(props(selector.describe(withPicker)).confirm).toBeNull();

		// Backspace edits the filter only; the picker Delete action still opens confirmation.
		selector.handleInput("\x7f");
		expect(props(selector.describe(withPicker)).confirm).toBeNull();
		selector.handleNativeEvent({ type: "action", key: "", act: "delete", mods: [] });
		expect(props(selector.describe(withPicker)).confirm?.text).toBe("Delete “Gamma”? This removes the session file.");
		const closed = renderedWhen(selector, p => p.confirm === null);
		selector.handleNativeEvent({ type: "action", key: "", act: "delete-confirm", mods: [] });
		await closed;
		expect(deleted).toEqual(["c"]);
		expect(props(selector.describe(withPicker)).order).not.toContain(old.path);

		const loaded = renderedWhen(
			selector,
			p => p.state === "ready" && p.actions?.find(a => a.id === "scope")?.label === "This folder",
		);
		selector.handleNativeEvent({ type: "action", key: "", act: "scope", mods: [] });
		expect(props(selector.describe(withPicker)).state).toBe("loading");
		await loaded;
		const all = props(selector.describe(withPicker));
		expect(all.placeholder).toBe("Search all sessions…");
		expect(all.items?.find(item => item.id === others.path)?.detail).toEqual([
			{ t: "/work/", s: "path dim" },
			{ t: "other", s: "path" },
		]);
	});
});

describe("session selector rename", () => {
	interface RenameCall {
		id: string;
		title: string;
	}

	function makeRename(renamed?: { calls: RenameCall[]; result?: string | null }) {
		// Fresh entries per test: rename mutates the shared entry in place.
		const entries = [session("a", "Alpha", 0), session("b", "Beta", 1), session("c", "Gamma", 40 * 24 * HOUR)];
		const selector = new SessionSelectorComponent(
			entries,
			() => {},
			() => {},
			{
				...(renamed
					? {
							onRename: async (s, title) => {
								renamed.calls.push({ id: s.id, title });
								return renamed.result === undefined ? title : renamed.result;
							},
						}
					: {}),
				currentSessionPath: entries[1]!.path,
			},
		);
		return { selector, beta: entries[1]! };
	}

	/** The open rename dialog and its field, via the ANSI card (the native picker props have no text-input affordance). */
	function renameDialogOf(selector: SessionSelectorComponent) {
		const card = selector.describe(withoutPicker);
		const dialog = (card.c ?? []).find(
			(child): child is OverlayPanel => child instanceof OverlayPanel && child.title === "Rename Session",
		);
		if (!dialog) return undefined;
		const field = dialog.children.find((child): child is TextFormField => child instanceof TextFormField);
		if (!field) return undefined;
		return { dialog, field };
	}

	it("shows the rename action only when onRename is set", () => {
		const withHook = makeRename({ calls: [] });
		expect(props(withHook.selector.describe(withPicker)).actions?.find(a => a.id === "rename")?.label).toBe("Rename");
		const withoutHook = makeRename();
		expect(props(withoutHook.selector.describe(withPicker)).actions?.some(a => a.id === "rename")).toBe(false);
	});

	it("opens the rename dialog prefilled with the current title on Ctrl+R", () => {
		const { selector, beta } = makeRename({ calls: [] });
		selector.handleInput("\x12");
		const opened = renameDialogOf(selector);
		expect(opened).toBeDefined();
		expect(opened!.field.getValue()).toBe(beta.title ?? "");
	});
	it("opens the rename dialog on a Kitty Ctrl+R press instead of forwarding it to search", () => {
		const { selector, beta } = makeRename({ calls: [] });
		selector.handleInput("\x1b[114;5u");
		const opened = renameDialogOf(selector);
		expect(opened?.field.getValue()).toBe(beta.title);
	});

	it("commits on Enter via onRename and updates the row in place", async () => {
		const renamed = { calls: [] as RenameCall[] };
		const { selector, beta } = makeRename(renamed);
		selector.handleInput("\x12");
		type(selector, " Prime");
		const updated = renderedWhen(selector, p => p.items?.find(item => item.id === beta.path)?.label === "Beta Prime");
		selector.handleInput("\r");
		await updated;
		expect(renamed.calls).toEqual([{ id: "b", title: "Beta Prime" }]);
		const after = props(selector.describe(withPicker));
		expect(after.selected).toBe(beta.path);
		expect(renameDialogOf(selector)).toBeUndefined();
	});

	it("keeps a rename draft through Escape and discards it only on Ctrl+C", () => {
		const previous = getMenuSearchVimMode();
		setMenuSearchVimMode(true);
		try {
			const renamed = { calls: [] as RenameCall[] };
			const { selector, beta } = makeRename(renamed);
			selector.handleInput("\x12");
			expect(renameDialogOf(selector)).toBeDefined();
			type(selector, " Prime");
			selector.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
			expect(renameDialogOf(selector)?.field.input.vimMode).toBe("normal");
			selector.handleInput("\x1b");
			expect(renameDialogOf(selector)?.field.getValue()).toBe("Beta Prime");
			selector.handleInput("\x03");
			expect(renameDialogOf(selector)).toBeUndefined();
			expect(renamed.calls).toEqual([]);
			const after = props(selector.describe(withPicker));
			expect(after.items?.find(item => item.id === beta.path)?.label).toBe("Beta");
			expect(after.selected).toBe(beta.path);
		} finally {
			setMenuSearchVimMode(previous);
		}
	});

	it("renders the rename editor instead of the picker while it is open", () => {
		const { selector } = makeRename({ calls: [] });
		// The picker kind has no text-input affordance: while renaming, the
		// component must describe the card path so the field is visible.
		expect(selector.describe(withPicker).k).toBe("picker");
		selector.handleInput("\x12");
		expect(selector.describe(withPicker).k).toBe("card");
		expect(selector.nativeSheet(withPicker)).toBe(false);
		expect(renameDialogOf(selector)).toBeDefined();
	});

	it("searches the new title after a rename", async () => {
		const renamed = { calls: [] as RenameCall[] };
		const { selector, beta } = makeRename(renamed);
		// Search first, so the entry caches its haystack with the old title.
		selector.handleInput("Beta");
		expect(props(selector.describe(withPicker)).items?.some(item => item.id === beta.path)).toBe(true);
		selector.handleInput("\x12");
		type(selector, " Prime");
		const updated = renderedWhen(selector, p => p.items?.find(item => item.id === beta.path)?.label === "Beta Prime");
		selector.handleInput("\r");
		await updated;
		// The cached search text must follow the rename: the new title matches,
		// the old one no longer does.
		selector.handleInput("Prime");
		const found = props(selector.describe(withPicker)).items?.find(item => item.id === beta.path);
		expect(found?.label).toBe("Beta Prime");
		selector.handleInput("Beta");
		const stale = props(selector.describe(withPicker)).items?.find(item => item.id === beta.path);
		expect(stale?.label).toBe("Beta Prime");
	});
});

describe("history search picker", () => {
	const now = Math.floor(Date.now() / 1000);
	const entries: HistorySearchEntry[] = [
		{ id: 1, prompt: "deploy the release\nwith notes", created_at: now - 60, cwd: "/work/app" },
		{ id: 2, prompt: "routine status", created_at: now - 7200 },
	];
	const source = {
		getRecent: (limit: number) => entries.slice(0, limit),
		search: (query: string) => entries.filter(e => e.prompt.includes(query)),
		delete: (id: number) => {
			const index = entries.findIndex(entry => entry.id === id);
			if (index >= 0) entries.splice(index, 1);
		},
	};

	it("hoists a keyed md picker from the dock and inserts on activate", () => {
		const inserted: string[] = [];
		const search = new HistorySearchComponent(
			source,
			prompt => inserted.push(prompt),
			() => {},
		);
		type(search, "deploy");
		expect(props((search.describe(withPicker).c as NativeNode[])[0]!).items).toHaveLength(1);
		expect(inserted).toEqual([]);
		search.handleInput("\r");
		const root = search.describe(withPicker);
		expect(root.k).toBe("col");
		const sheet = (root.c as NativeNode[])[0]!;
		expect(sheet.key).toBe("picker");
		const p = props(sheet);
		expect(p.size).toBe("md");
		expect(p.items).toHaveLength(1);
		expect(p.items?.[0]).toMatchObject({ label: "deploy the release", hits: [[0, 6]], detail: "/work/app" });

		search.handleNativeEvent({ type: "activate", key: "^picker", item: p.items![0]!.id });
		expect(inserted).toEqual(["deploy the release\nwith notes"]);
		expect(search.describe(withoutPicker).k).toBe("card");
	});

	it("routes the native close action through query focus before closing the history picker", () => {
		let cancelled = 0;
		const search = new HistorySearchComponent(
			source,
			() => {},
			() => cancelled++,
		);
		type(search, "deploy");
		const sheet = () => (search.describe(withPicker).c as NativeNode[])[0]!;
		expect(props(sheet()).actions?.find(action => action.id === "close")?.label).toBe("Back to list");
		search.handleNativeEvent({ type: "action", key: "^picker", act: "close", mods: [] });
		expect(cancelled).toBe(0);
		expect(search.navigationSnapshot()).toMatchObject({ search: { value: "", query: "", focused: false } });
		expect(props(sheet()).actions?.find(action => action.id === "close")?.label).toBe("Close");
		search.handleNativeEvent({ type: "action", key: "^picker", act: "close", mods: [] });
		expect(cancelled).toBe(1);
		search.dispose();
	});
});
