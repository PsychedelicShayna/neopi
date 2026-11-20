import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Input, setKeybindings } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import type { DescribeContext, NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { MCPAddWizard, type MCPAddWizardDeps } from "@oh-my-pi/pi-tui/overlays/mcp-add-wizard";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

const CX: DescribeContext = { cols: 100, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
const deps: MCPAddWizardDeps = {
	validateServerName: () => undefined,
	analyzeAuthError: () => ({ requiresAuth: false }),
	discoverOAuthEndpoints: async () => null,
	fetchResourceMetadataScopes: async () => undefined,
};
function isNode(child: NativeChild): child is NativeNode {
	return "k" in child && typeof child.k === "string";
}
function nodes(root: NativeNode): NativeNode[] {
	return [root, ...(root.c ?? []).filter(isNode).flatMap(nodes)];
}
function prop(node: NativeNode | undefined, key: string): unknown {
	return node?.p && typeof node.p === "object" ? Reflect.get(node.p, key) : undefined;
}
function byRole(wizard: MCPAddWizard, role: string): NativeNode | undefined {
	return nodes(wizard.describe(CX)).find(node => prop(node, "role") === role);
}
function title(wizard: MCPAddWizard): unknown {
	return prop(byRole(wizard, "omp.mcpAdd.title"), "text");
}
function selected(wizard: MCPAddWizard): unknown {
	return prop(byRole(wizard, "omp.mcpAdd.choices"), "selected");
}
function input(wizard: MCPAddWizard): Input {
	const field = byRole(wizard, "omp.mcpAdd.field")?.c?.[0];
	if (!(field instanceof Input)) throw new Error("Expected the mounted text field");
	return field;
}
function type(wizard: MCPAddWizard, value: string): void {
	for (const character of value) wizard.handleInput(character);
}

beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("dark theme unavailable");
	setThemeInstance(dark);
});
beforeEach(() => setKeybindings(KeybindingsManager.inMemory()));
afterEach(() => setKeybindings(KeybindingsManager.inMemory()));

describe("MCP wizard prompt navigation", () => {
	it("delegates normal motions without remounting or approving the choice", () => {
		const wizard = new MCPAddWizard(deps, vi.fn(), vi.fn(), undefined, undefined, undefined, "example");
		wizard.render(100);
		wizard.handleInput("j");
		expect(selected(wizard)).toBe("1");
		wizard.handleInput("\x04");
		expect(selected(wizard)).toBe("2");
		wizard.handleInput("\x04");
		expect(selected(wizard)).toBe("2");
		wizard.handleInput("\x15");
		expect(selected(wizard)).toBe("1");
		wizard.handleInput("\x1b[6~");
		expect(selected(wizard)).toBe("2");
		wizard.handleInput("\x1b[5~");
		expect(selected(wizard)).toBe("0");
		wizard.handleInput("G");
		expect(selected(wizard)).toBe("2");
		wizard.handleInput("g");
		wizard.handleInput("g");
		expect(selected(wizard)).toBe("0");
		wizard.handleInput("k");
		expect(selected(wizard)).toBe("2");
		wizard.handleInput("\x1b[H");
		expect(selected(wizard)).toBe("0");
		wizard.handleInput("\x1b[F");
		expect(selected(wizard)).toBe("2");
		wizard.handleInput("\x05");
		expect(selected(wizard)).toBe("2");
		expect(byRole(wizard, "omp.mcpAdd.choices")?.scroll?.by).toBe("line-down");
		wizard.handleInput("\x19");
		expect(selected(wizard)).toBe("2");
		for (const key of [" ", "h", "l", "\t", "\x1b[Z", "\x0e", "\x10", "/"]) wizard.handleInput(key);
		expect(title(wizard)).toBe("How does omp reach it?");
		expect(selected(wizard)).toBe("2");
	});

	it("keeps literal typing and non-auth draft carets across Back", () => {
		const wizard = new MCPAddWizard(deps, vi.fn(), vi.fn(), undefined, undefined, undefined, "example");
		wizard.handleInput("\r");
		type(wizard, "hjkl ggG / data");
		wizard.handleInput("\x1b[H");
		expect(input(wizard).getCursor()).toBe(0);
		wizard.handleInput("\x1b");
		expect(selected(wizard)).toBe("0");
		wizard.handleInput("\r");
		expect(input(wizard).getValue()).toBe("hjkl ggG / data");
		expect(input(wizard).getCursor()).toBe(0);
		wizard.handleInput("g");
		expect(input(wizard).getValue()).toBe("ghjkl ggG / data");
		expect("navigationSnapshot" in wizard).toBe(false);
		expect("restoreNavigation" in wizard).toBe(false);
	});

	it("requires Enter to advance scope and save the reviewed configuration", () => {
		const complete = vi.fn();
		const wizard = new MCPAddWizard(deps, complete, vi.fn(), undefined, undefined, undefined, "example");
		wizard.handleInput("\r");
		type(wizard, "server-command");
		wizard.handleInput("\r");
		wizard.handleInput("\r");
		const scopeTitle = title(wizard);
		wizard.handleInput(" ");
		expect(title(wizard)).toBe(scopeTitle);
		wizard.handleInput("\r");
		expect(title(wizard)).toBe("Review and save");
		wizard.handleInput(" ");
		expect(complete).not.toHaveBeenCalled();
		wizard.handleInput("\r");
		expect(complete).toHaveBeenCalledTimes(1);
	});

	it("keeps API-key typing literal and Space out of auth-location approval", async () => {
		const connection = Promise.withResolvers<void>();
		const apiKeyMounted = Promise.withResolvers<void>();
		const oauth = vi.fn();
		const wizard: MCPAddWizard = new MCPAddWizard(
			{ ...deps, analyzeAuthError: () => ({ requiresAuth: true, authType: "apikey" }) },
			vi.fn(),
			vi.fn(),
			oauth,
			() => connection.promise,
			() => {
				if (title(wizard) === "API key") apiKeyMounted.resolve();
			},
			"example",
		);
		wizard.handleInput("j");
		wizard.handleInput("\r");
		type(wizard, "https://example.test/mcp");
		wizard.handleInput("\r");
		connection.reject(new Error("Unauthorized"));
		await apiKeyMounted.promise;
		type(wizard, "hjkl ggG");
		expect(input(wizard).getValue()).toBe("hjkl ggG");
		wizard.handleInput("\r");
		const authTitle = title(wizard);
		wizard.handleInput(" ");
		expect(title(wizard)).toBe(authTitle);
		expect(oauth).not.toHaveBeenCalled();
		expect("navigationSnapshot" in wizard).toBe(false);
	});
});

let previousVimMode: boolean;
beforeEach(() => {
	previousVimMode = getMenuSearchVimMode();
	setMenuSearchVimMode(true);
});
afterEach(() => {
	setMenuSearchVimMode(previousVimMode);
});
