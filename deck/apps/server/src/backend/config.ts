import * as path from "node:path";
import { readTomlConfigSync, writeTomlConfigSync } from "../settings-toml.ts";

export interface BackendConfigEntry { id: string; kind: "source" | "gateway"; path: string }
export interface BackendDocument { filePath: string; content: string; data: Record<string, unknown> }

/** Read TOML natively; the only YAML path is the one-time, no-clobber importer. */
export function readBackendDocument(home: string): BackendDocument {
	const filePath = path.join(home, "config.toml");
	return readTomlConfigSync(filePath, { legacyPaths: [path.join(home, "config.yml"), path.join(home, "config.yaml")] })
		?? { filePath, content: "", data: {} };
}

/** Shared by setup registration and the GUI backend picker. Never writes YAML. */
export function updateBackendDocument(home: string, change: (data: Record<string, unknown>) => void): BackendDocument {
	const doc = readBackendDocument(home);
	change(doc.data);
	writeTomlConfigSync(doc.filePath, doc.data, doc.content);
	return { ...doc, content: readBackendDocument(home).content };
}

export function registerBackend(home: string, entry: BackendConfigEntry): Record<string, unknown> {
	return updateBackendDocument(home, data => {
		if (data.backends !== undefined && !Array.isArray(data.backends)) throw new Error("backends must be a list");
		const backends = data.backends as BackendConfigEntry[] | undefined ?? [];
		const index = backends.findIndex(backend => backend.id === entry.id);
		if (index === -1) backends.push(entry);
		else backends[index] = { ...backends[index], ...entry };
		data.backends = backends;
		if (!data.activeBackend) data.activeBackend = entry.id;
	}).data;
}
