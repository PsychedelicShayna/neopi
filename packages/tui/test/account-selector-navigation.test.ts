import { getMenuSearchVimMode, setMenuSearchVimMode } from "@oh-my-pi/pi-tui/components/menu-navigation";
import { beforeAll, expect, it, beforeEach, afterEach } from "bun:test";
import { initTheme } from "../src/theme/theme";
import { LogoutAccountSelectorComponent } from "../src/overlays/logout-account-selector";
import { ResetUsageSelectorComponent, type ResetUsageAccount } from "../src/overlays/reset-usage-selector";
import { OAuthSelectorComponent } from "../src/overlays/oauth-selector";
import { PICKER_KEY } from "../src/native/picker";

beforeAll(async () => {
	await initTheme();
});

it("logout searches literally and restores bounds without Space logging out", () => {
	const picked: number[] = [];
	let cancelled = false;
	const accounts = Array.from({ length: 20 }, (_, credentialId) => ({
		credentialId,
		provider: "test",
		label: `account ${credentialId}`,
		detail: "",
		type: "oauth" as const,
		active: credentialId === 0,
	}));
	const make = () =>
		new LogoutAccountSelectorComponent(
			"Test",
			accounts,
			account => picked.push(account.credentialId),
			() => {
				cancelled = true;
			},
		);
	const selector = make();
	selector.handleInput("G");
	selector.handleInput("\x05");
	selector.handleInput(" ");
	expect(picked).toEqual([]);
	selector.handleInput("\r");
	expect(picked).toEqual([19]);
	selector.handleInput("/");
	selector.handleInput("account 1");
	selector.handleInput("\x1b");
	expect(cancelled).toBe(false);
	const snapshot = selector.navigationSnapshot();
	const restored = make();
	restored.restoreNavigation(snapshot);
	expect(restored.navigationSnapshot()).toEqual(snapshot);
});

it("reset requires explicit double Enter even after history restoration", () => {
	const picked: ResetUsageAccount[] = [];
	const accounts: ResetUsageAccount[] = Array.from({ length: 20 }, (_, credentialId) => ({
		label: `account ${credentialId}`,
		provider: "test",
		providerLabel: "Test",
		availableCount: 1,
		redeemableCount: 1,
		target: { provider: "test", credentialId },
		active: credentialId === 0,
	}));
	const make = () =>
		new ResetUsageSelectorComponent(
			accounts,
			account => picked.push(account),
			() => {},
		);
	const selector = make();
	selector.handleInput("G");
	selector.handleInput(" ");
	expect(picked).toEqual([]);
	selector.handleInput("\r");
	const snapshot = selector.navigationSnapshot();
	const restored = make();
	restored.restoreNavigation(snapshot);
	restored.handleInput("\r");
	expect(picked).toEqual([]);
	restored.handleInput("\r");
	expect(picked[0]?.target.credentialId).toBe(19);
});

it.each([
	[
		"provider",
		(cancel: () => void) =>
			new OAuthSelectorComponent(
				"login",
				{ credentials: { has: () => false }, keys: { source: () => undefined } as never },
				() => {},
				cancel,
			),
	],
	[
		"logout",
		(cancel: () => void) =>
			new LogoutAccountSelectorComponent(
				"Test",
				[{ credentialId: 1, provider: "test", label: "account", detail: "", type: "oauth", active: false }],
				() => {},
				cancel,
			),
	],
	[
		"reset",
		(cancel: () => void) =>
			new ResetUsageSelectorComponent(
				[
					{
						label: "account",
						provider: "test",
						providerLabel: "Test",
						availableCount: 1,
						redeemableCount: 1,
						target: { provider: "test", credentialId: 1 },
						active: false,
					},
				],
				() => {},
				cancel,
			),
	],
] as const)("%s native close first leaves its search field, then closes", (_name, make) => {
	let closed = 0;
	const selector = make(() => {
		closed++;
	});
	selector.handleInput("/");
	selector.handleInput("hjkl/ g");
	const close = { type: "action", key: PICKER_KEY, act: "close", mods: [] } as const;
	selector.handleNativeEvent(close);
	expect(closed).toBe(0);
	expect(selector.navigationSnapshot()).toMatchObject({ search: { value: "", query: "", focused: false } });
	selector.handleNativeEvent(close);
	expect(closed).toBe(1);
});

let previousVimMode: boolean;
beforeEach(() => {
	previousVimMode = getMenuSearchVimMode();
	setMenuSearchVimMode(true);
});
afterEach(() => {
	setMenuSearchVimMode(previousVimMode);
});
