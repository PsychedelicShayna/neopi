import type { PromptContextKey } from "./types";

/** Canned session data, also used to keep the system renderer's exposed roots in sync. */
export const systemPromptContextFixture = {
	systemPromptCustomization: "Project coding conventions.",
	customPrompt: "You are a coding assistant.",
	appendPrompt: "Preserve the public API.",
	tools: ["read", "write", "bash", "task"],
	toolInfo: [{ name: "read", internalName: "read", label: "Read" }],
	toolInventory: "Read: read\nWrite: write",
	inlineToolDescriptors: false,
	toolListMode: true,
	toolRefs: Object.fromEntries(
		[
			"read",
			"write",
			"edit",
			"bash",
			"eval",
			"find",
			"grep",
			"glob",
			"lsp",
			"task",
			"wait",
			"think",
			"ast_grep",
			"ast_edit",
			"todo",
			"ask",
			"web_search",
			"yield",
			"retain",
			"recall",
			"memory_edit",
		].map(name => [name, name]),
	),
	environment: [
		{ label: "OS", value: "linux" },
		{ label: "Arch", value: "x64" },
	],
	contextFiles: [{ path: "/workspace/AGENTS.md", content: "Use the existing code style.", depth: 0 }],
	agentsMdSearch: { files: ["src/AGENTS.md"] },
	workspaceTree: {
		rootPath: "/workspace",
		rendered: "src/\n  index.ts",
		truncated: false,
		totalLines: 2,
		agentsMdFiles: ["src/AGENTS.md"],
	},
	hasSkillUriAccess: true,
	internalUrls: ["skill://<name>: installed skills"],
	skills: [
		{
			name: "review",
			description: "Review a change.",
			filePath: "/workspace/skills/review/SKILL.md",
			baseDir: "/workspace/skills/review",
			source: "project",
			hide: false,
			containRoot: "/workspace/skills",
			_source: {},
		},
	],
	rules: [
		{
			name: "typescript",
			description: "Keep types explicit.",
			globs: ["*.ts"],
			path: "/workspace/rules/typescript.md",
		},
	],
	alwaysApplyRules: [{ name: "style", content: "Follow local conventions.", path: "/workspace/rules/style.md" }],
	cwd: "/workspace",
	additionalWorkspaceRoots: ["/workspace/library"],
	model: "example/model",
	delegationBias: "balanced",
	personality: "Be clear and direct.",
	intentTracing: false,
	intentField: "i",
	eagerTasks: false,
	eagerTasksAlways: false,
	inlineFirstDelegation: true,
	taskBatch: false,
	MAX_CONCURRENCY: 8,
	scoutAvailable: true,
	taskIrcEnabled: true,
	secretsEnabled: false,
	browserEnabled: false,
	computerEnabled: false,
	includeWorkspaceTree: true,
	renderMermaid: false,
	renderSvg: false,
	autoGraph: false,
	reactions: false,
	xdevTools: [{ name: "report_issue", summary: "Report a defect.", dynamic: false }],
	hasDynamicXdevTools: false,
	xdevDocs: "Write a JSON request to xd://report_issue.",
	autoQaEnabled: false,
	writeTransportOnly: false,
	subagent: false,
};

/** Extra or missing roots fail at the real system-prompt assembly callsite. */
export function buildSystemPromptContext<T extends Record<keyof typeof systemPromptContextFixture, unknown>>(
	data: T & Record<Exclude<keyof T, keyof typeof systemPromptContextFixture>, never>,
): T {
	return data;
}

export const bashPromptContextFixture = {
	hasClientTerminal: false,
	asyncEnabled: true,
	defaultTimeoutSec: 30,
	autoBackgroundEnabled: true,
	autoBackgroundSeconds: 5,
	hasAstGrep: true,
	hasAstEdit: true,
	hasGrep: true,
	hasGlob: true,
	hasFind: true,
	hasRead: true,
	hasSkills: true,
	hasLaunch: true,
	hasEval: true,
	hasShellBuiltins: true,
	isWindows: false,
};

export function buildBashPromptContext<T extends Record<keyof typeof bashPromptContextFixture, unknown>>(
	data: T & Record<Exclude<keyof T, keyof typeof bashPromptContextFixture>, never>,
): T {
	return data;
}

export function buildLivePromptContext(username: string, firstName: string): { username: string; firstName: string } {
	return { username, firstName };
}

export const livePromptContextFixture = buildLivePromptContext("alexandra", "Alexandra");

/** Derive nested types from the same canned values used for dry rendering. */
export function describePromptContext(fixture: Record<string, unknown>): PromptContextKey[] {
	return Object.entries(fixture).map(([path, value]) => {
		const item = Array.isArray(value) ? value[0] : value;
		const type = item === null || item === undefined ? "unknown" : typeof item;
		return {
			path,
			type: Array.isArray(value) ? `${type}[]` : type,
			resolution: "session-dependent",
			...(item !== null && typeof item === "object" && !Array.isArray(item)
				? { children: describePromptContext(item as Record<string, unknown>) }
				: {}),
		};
	});
}
