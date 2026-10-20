import { renderPromptAsset } from "@oh-my-pi/pi-utils/prompt-assets";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import launchProfileTemplate from "../prompts/launch-profile.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";

export interface LaunchProfileMemory {
	name: string;
	sources: Array<{ path: string; content: string }>;
}

const sessionProfiles = new WeakMap<AgentSession, string>();

export function setSessionLaunchProfile(session: AgentSession, rendered: string): void {
	sessionProfiles.set(session, rendered);
}

export function getSessionLaunchProfile(session: AgentSession): string | undefined {
	return sessionProfiles.get(session);
}

/** Explicit file-backed memory selection, isolated to the active named profile. */
export async function loadLaunchProfileMemory(
	name: string | undefined,
	agentDir: string,
): Promise<LaunchProfileMemory | undefined> {
	// Default launches must not even read the optional manifest.
	if (name === undefined) return undefined;
	const manifest = path.join(agentDir, "launch-memory.json");
	let value: unknown;
	try {
		value = await Bun.file(manifest).json();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw new Error(`Cannot load launch profile memory manifest ${manifest}`, { cause: error });
	}
	if (
		typeof value !== "object" ||
		value === null ||
		!("sources" in value) ||
		!Array.isArray(value.sources) ||
		!value.sources.every((source: unknown) => typeof source === "string" && source.trim().length > 0)
	) {
		throw new Error(`Invalid launch profile memory manifest ${manifest}: expected { "sources": ["path", ...] }`);
	}
	const sources: LaunchProfileMemory["sources"] = [];
	for (const source of value.sources as string[]) {
		const sourcePath = path.resolve(agentDir, source);
		try {
			const file = Bun.file(sourcePath);
			if (!(await file.stat()).isFile()) throw new Error("Memory source is not a regular file");
			sources.push({ path: sourcePath, content: await file.text() });
		} catch (error) {
			throw new Error(`Cannot preload launch profile "${name}" memory source ${sourcePath}`, { cause: error });
		}
	}
	return { name, sources };
}

export function renderLaunchProfileMemory(memory: LaunchProfileMemory | undefined): string | undefined {
	return memory === undefined
		? undefined
		: renderPromptAsset("launch-profile.md", launchProfileTemplate, { name: memory.name, sources: memory.sources });
}
