import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings, resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { SessionEnvironment } from "@oh-my-pi/pi-coding-agent/session/environment";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";

function fixture(inherited: Record<string, string> = { VISUAL: "true", EDITOR: "true" }): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		environment: new SessionEnvironment(inherited),
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	};
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("env:// session environment", () => {
	it("lists names and scope without dumping values", async () => {
		const session = fixture({ VISUAL: "true", API_KEY: "never-print-this" });
		const resource = await new InternalUrlRouter().resolve("env://", { session });
		expect(resource.isDirectory).toBe(true);
		expect(resource.content).toContain("API_KEY");
		expect(resource.content).not.toContain("never-print-this");
		expect(resource.content).toContain("not persisted");
		expect(resource.content).toContain("Existing child processes");
	});

	it("routes live read/write, empty and unset through the ordinary tools", async () => {
		const session = fixture();
		const write = new WriteTool(session);
		const read = new ReadTool(session);
		await write.execute("set", { path: "env://VISUAL", content: " nvim --wait " });
		expect(text(await read.execute("read", { path: "env://VISUAL" }))).toContain('"value": " nvim --wait "');
		await write.execute("empty", { path: "env://VISUAL", content: "" });
		expect(text(await read.execute("empty-read", { path: "env://VISUAL" }))).toContain('"value": ""');
		await write.execute("unset", { path: "env://VISUAL/unset" });
		const missing = text(await read.execute("missing", { path: "env://VISUAL" }));
		expect(missing).toContain('"state": "unset"');
		expect(missing).not.toContain('"value"');
	});

	it("does not mutate another session or the host process", async () => {
		const inherited = { EDITOR: "true" };
		const first = fixture(inherited);
		const second = fixture(inherited);
		const original = Bun.env.EDITOR;
		await new InternalUrlRouter().write("env://EDITOR", "nvim", { session: first });
		expect(first.environment?.get("EDITOR")).toBe("nvim");
		expect(second.environment?.get("EDITOR")).toBe("true");
		expect(inherited.EDITOR).toBe("true");
		expect(Bun.env.EDITOR).toBe(original);
	});

	it("redacts even short credentials and does not echo write payloads", async () => {
		const session = fixture({ API_KEY: "abc" });
		const router = new InternalUrlRouter();
		const resource = await router.resolve("env://API_KEY", { session });
		expect(JSON.parse(resource.content)).toMatchObject({ state: "set", value: "<redacted>" });
		const receipt = await router.write("env://API_KEY", "another-secret", { session });
		if (!receipt) throw new Error("Missing environment write receipt.");
		expect(text(receipt)).not.toContain("another-secret");
		expect(session.environment?.get("API_KEY")).toBe("another-secret");
		await router.write("env://DATABASE_URL", "postgres://user:abc@localhost/db", { session });
		expect(JSON.parse((await router.resolve("env://DATABASE_URL", { session })).content).value).toBe("<redacted>");
	});

	it("requires exec approval and respects explicit deny", () => {
		const write = new WriteTool(fixture());
		const args = { path: "env://EDITOR", content: "nvim" };
		expect(resolveApproval(write, args, "write")).toMatchObject({ tier: "exec", policy: "prompt" });
		expect(resolveApproval(write, args, "yolo", { write: "deny" })).toMatchObject({ policy: "deny" });
	});

	it("blocks environment mutation in plan mode and device-only sessions", async () => {
		const session = fixture();
		session.getPlanModeState = () => ({ enabled: true, planFilePath: "local://PLAN.md" });
		await expect(
			new WriteTool(session).execute("plan-env", { path: "env://EDITOR", content: "nvim" }),
		).rejects.toThrow("Plan mode");
		expect(session.environment?.get("EDITOR")).toBe("true");
		session.getPlanModeState = undefined;
		session.deviceOnlyWrite = true;
		await expect(
			new WriteTool(session).execute("device-env", { path: "env://EDITOR", content: "nvim" }),
		).rejects.toThrow("limited");
		expect(session.environment?.get("EDITOR")).toBe("true");
	});

	it("rejects ambiguous unsets, malformed URLs, missing owners and NUL values", async () => {
		const router = new InternalUrlRouter();
		const context = { session: fixture() };
		await expect(router.resolve("env://EDITOR")).rejects.toThrow("owning session");
		await expect(router.write("env://EDITOR", "vim")).rejects.toThrow("owning session");
		await expect(new WriteTool(context.session).execute("missing-content", { path: "env://EDITOR" })).rejects.toThrow(
			"content is required",
		);
		await expect(router.write("env://EDITOR/unset", "unexpected", context)).rejects.toThrow("Omit content");
		await expect(router.write("env://EDITOR", "a\0b", context)).rejects.toThrow("NUL");
		for (const url of ["env://EDITOR/path", "env://EDITOR?save=true", "env://BAD-NAME", "env://EDITOR#fragment"]) {
			await expect(router.resolve(url, context)).rejects.toThrow("Use env://");
		}
	});

	it("keeps inherited prototype properties absent and snapshots empty values safely", () => {
		const environment = new SessionEnvironment({}, "linux");
		expect(environment.get("toString")).toBeUndefined();
		environment.set("__proto__", "");
		expect(Object.hasOwn(environment.snapshot(), "__proto__")).toBe(true);
		expect(environment.snapshot().__proto__).toBe("");
	});

	it("preserves Windows case-insensitive environment lookup and unsetting", () => {
		const environment = new SessionEnvironment({ Visual: "nvim" }, "win32");
		expect(environment.get("VISUAL")).toBe("nvim");
		environment.set("visual", "");
		expect(environment.snapshot().VISUAL).toBe("");
		environment.set("Visual", undefined);
		expect(environment.get("VISUAL")).toBeUndefined();
		expect(environment.names()).not.toContain("VISUAL");
	});

	it("initializes real settings with no environment feature configured", async () => {
		const settings = await Settings.init({ inMemory: true, cwd: process.cwd() });
		const session = fixture();
		session.settings = settings;
		session.environment = undefined;
		const resource = await new InternalUrlRouter().resolve("env://EDITOR", { session });
		expect(JSON.parse(resource.content).name).toBe("EDITOR");
	});

	it.skipIf(process.platform === "win32")(
		"repairs the existing composer editor without restarting or losing the draft",
		async () => {
			const root = path.join(Bun.env.HOME!, ".cache/npi-canary");
			await fs.mkdir(root, { recursive: true });
			const dir = await fs.mkdtemp(path.join(root, "env-url-editor-"));
			try {
				const script = path.join(dir, "editor");
				await Bun.write(
					script,
					'#!/bin/sh\n[ "$NPI_ENV_URL_PROBE" = live ] || exit 3\nprintf " and edited" >> "$1"\n',
				);
				await fs.chmod(script, 0o700);
				const session = fixture({ ...Bun.env, VISUAL: "true", EDITOR: "true" } as Record<string, string>);
				let draft = "unfinished draft";
				const ui = {
					getVisibleScreenRows: () => ["visible transcript"],
					stop: vi.fn(),
					start: vi.fn(),
					requestRender: vi.fn(),
				};
				const showWarning = vi.fn();
				const ctx = {
					session: { environment: session.environment },
					editor: {
						getText: () => draft,
						setText: (text: string) => {
							draft = text;
						},
					},
					ui,
					showWarning,
				} as unknown as InteractiveModeContext;
				const controller = new InputController(ctx);
				await controller.openExternalEditor();
				expect(draft).toBe("unfinished draft");
				const write = new WriteTool(session);
				await write.execute("repair", { path: "env://VISUAL", content: script });
				await write.execute("child-env", { path: "env://NPI_ENV_URL_PROBE", content: "live" });
				await controller.openExternalEditor();
				expect(draft).toBe("unfinished draft and edited");
				expect(showWarning).not.toHaveBeenCalled();
				expect(ui.stop).toHaveBeenCalledTimes(2);
				expect(ui.start).toHaveBeenCalledTimes(2);
			} finally {
				await fs.rm(dir, { recursive: true, force: true });
			}
		},
	);
});
