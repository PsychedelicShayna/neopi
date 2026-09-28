import { describe, expect, it } from "bun:test";
import {
	CHAT_MODE_ENTRY_TYPE,
	type ChatModeResolutionInput,
	parseChatCommandArgs,
	readChatModeEntry,
	readLastActiveChatMode,
	resolveChatMode,
	resolveChatModeChange,
} from "@oh-my-pi/pi-coding-agent/chat/chat-mode";
import { buildChatSystemPrompt } from "@oh-my-pi/pi-coding-agent/chat/chat-system-prompt";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

const base: ChatModeResolutionInput = {
	flag: undefined,
	includeFlag: undefined,
	stored: undefined,
	restoring: false,
	settingsMode: "off",
	settingsInclude: [],
};

function chatEntry(data: unknown): SessionEntry {
	return {
		type: "custom",
		customType: CHAT_MODE_ENTRY_TYPE,
		data,
		id: "e",
		parentId: null,
		timestamp: "",
	} as SessionEntry;
}

describe("resolveChatMode", () => {
	it("keeps a restored session's recorded mode over the configured default, and a never-recorded one as coding", () => {
		const settings = { settingsMode: "chat" as const, settingsInclude: ["date"] };
		expect(resolveChatMode({ ...base, ...settings, restoring: true, stored: undefined })).toBeNull();
		expect(
			resolveChatMode({ ...base, ...settings, restoring: true, stored: { mode: "erp", include: ["cwd"] } }),
		).toEqual({ mode: "erp", include: ["cwd"] });
		expect(resolveChatMode({ ...base, ...settings })).toEqual({ mode: "chat", include: ["date"] });
	});

	it("lets explicit flags override a recorded mode, including switching it off", () => {
		const restored = { ...base, restoring: true, stored: { mode: "erp" as const, include: [] } };
		expect(resolveChatMode({ ...restored, flag: "raw" })).toEqual({ mode: "raw", include: [] });
		expect(resolveChatMode({ ...restored, flag: "off" })).toBeNull();
		expect(resolveChatMode({ ...restored, includeFlag: ["memory"] })).toEqual({ mode: "erp", include: ["memory"] });
	});
});

describe("readChatModeEntry", () => {
	it("returns the latest recorded state, with off as null", () => {
		expect(readChatModeEntry([])).toBeUndefined();
		expect(readChatModeEntry([chatEntry({ mode: "erp", include: ["date", "bogus"] })])).toEqual({
			mode: "erp",
			include: ["date"],
		});
		expect(
			readChatModeEntry([chatEntry({ mode: "erp", include: [] }), chatEntry({ mode: "off", include: [] })]),
		).toBeNull();
	});
});

describe("resolveChatModeChange", () => {
	const erp = { mode: "erp" as const, include: ["date" as const] };

	it("toggles off from chat mode and back into the last-used mode, defaulting to chat", () => {
		expect(resolveChatModeChange({}, erp, undefined, [])).toBeNull();
		expect(resolveChatModeChange({}, undefined, erp, [])).toEqual(erp);
		expect(resolveChatModeChange({}, undefined, undefined, ["cwd"])).toEqual({ mode: "chat", include: ["cwd"] });
	});

	it("keeps the current or last-used includes unless the request names them", () => {
		expect(resolveChatModeChange({ mode: "raw" }, erp, undefined, ["memory"])).toEqual({
			mode: "raw",
			include: ["date"],
		});
		expect(resolveChatModeChange({ mode: "chat" }, undefined, erp, ["memory"])).toEqual({
			mode: "chat",
			include: ["date"],
		});
		expect(resolveChatModeChange({ include: ["cwd"] }, erp, undefined, [])).toEqual({
			mode: "erp",
			include: ["cwd"],
		});
	});

	it("rejects includes without a chat mode and unknown categories", () => {
		expect(() => resolveChatModeChange({ mode: "off", include: ["date"] }, erp, undefined, [])).toThrow();
		expect(() => resolveChatModeChange({ mode: "chat", include: ["tools"] }, undefined, undefined, [])).toThrow();
	});
});

describe("readLastActiveChatMode", () => {
	it("skips a later off entry so a bare /chat re-enters the recorded mode", () => {
		const entries = [chatEntry({ mode: "erp", include: ["cwd"] }), chatEntry({ mode: "off", include: [] })];
		expect(readLastActiveChatMode(entries)).toEqual({ mode: "erp", include: ["cwd"] });
		expect(readLastActiveChatMode([])).toBeUndefined();
	});
});

describe("parseChatCommandArgs", () => {
	it("reads a mode and a comma-separated include list in either flag form", () => {
		expect(parseChatCommandArgs("")).toEqual({});
		expect(parseChatCommandArgs("ERP --include date,cwd")).toEqual({ mode: "erp", include: ["date", "cwd"] });
		expect(parseChatCommandArgs("--include=memory raw")).toEqual({ mode: "raw", include: ["memory"] });
	});

	it("rejects unknown modes, a second mode, and a dangling --include", () => {
		expect(() => parseChatCommandArgs("roleplay")).toThrow();
		expect(() => parseChatCommandArgs("chat erp")).toThrow();
		expect(() => parseChatCommandArgs("chat --include")).toThrow();
	});
});

describe("buildChatSystemPrompt", () => {
	const contextFiles = [{ path: "/story/AGENTS.md", content: "The Lantern Inn." }];
	const input = { contextFiles, cwd: "/story", skills: [], rules: [] };

	it("sends no system prompt at all for raw mode without prompt flags", () => {
		expect(buildChatSystemPrompt({ ...input, config: { mode: "raw", include: [] }, toolNames: ["read"] })).toEqual(
			[],
		);
	});

	it("keeps project lore in chat mode and exposes the working directory only with a filesystem tool", () => {
		const [withoutTools] = buildChatSystemPrompt({ ...input, config: { mode: "chat", include: [] }, toolNames: [] });
		expect(withoutTools).toContain("The Lantern Inn.");
		expect(withoutTools).not.toContain("/story\n");
		expect(withoutTools).not.toContain("Working directory");

		const [withRead] = buildChatSystemPrompt({
			...input,
			config: { mode: "chat", include: [] },
			toolNames: ["read"],
		});
		expect(withRead).toContain("Working directory: /story");
	});

	it("replaces the mode prompt with an explicit --system-prompt", () => {
		const [prompt] = buildChatSystemPrompt({
			...input,
			config: { mode: "erp", include: [] },
			customPrompt: "You are Mara.",
			toolNames: [],
		});
		expect(prompt?.startsWith("You are Mara.")).toBe(true);
		expect(prompt).not.toContain("erotic roleplay");
	});
});
