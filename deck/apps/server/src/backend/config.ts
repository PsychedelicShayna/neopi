import * as path from "node:path";
import { readTomlConfigSync, writeTomlConfigSync } from "@oh-my-pi/pi-utils/settings-toml";

export interface BackendDocument {
	filePath: string;
	content: string;
	data: Record<string, unknown>;
}

/** Read TOML natively; the only YAML path is the one-time, no-clobber importer. */
export function readBackendDocument(home: string): BackendDocument {
	const filePath = path.join(home, "config.toml");
	return (
		readTomlConfigSync(filePath, {
			legacyPaths: [path.join(home, "config.yml"), path.join(home, "config.yaml")],
		}) ?? { filePath, content: "", data: {} }
	);
}

/** Backend-picker saves patch existing comments and atomically keep file permissions. */
export function updateBackendDocument(home: string, change: (data: Record<string, unknown>) => void): void {
	const doc = readBackendDocument(home);
	change(doc.data);
	writeTomlConfigSync(doc.filePath, doc.data, doc.content);
}
