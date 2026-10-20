export type PromptAssetGroup = "core" | "feature" | "compaction" | "dialects";
export type PromptResolution = "static-fixture" | "runtime-only" | "session-dependent";

export interface PromptContextKey {
	path: string;
	type: string;
	required?: boolean;
	resolution?: PromptResolution;
	children?: PromptContextKey[];
}

export interface PromptAsset {
	id: string;
	relPath: string;
	bundled: string;
	scope: string;
	group: PromptAssetGroup;
	keys: PromptContextKey[];
	fixture: Record<string, unknown>;
	localHelpers?: string[];
	consumerHints: string[];
	inspectionOnly?: boolean;
}

export interface PromptDiagnostic {
	code: string;
	severity: "error" | "warning" | "note";
	file: string;
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	expression: string;
	scope: string;
	message: string;
	expectedType?: string;
	candidates: string[];
	hint?: string;
}
