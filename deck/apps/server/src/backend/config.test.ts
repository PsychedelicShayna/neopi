import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { readBackendDocument, registerBackend, updateBackendDocument } from "./config.ts";

const roots: string[] = [];
function home() { const dir = mkdtempSync(path.join(tmpdir(), "deck-toml-config-")); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("legacy import leaves YAML intact and preserves its mode", () => {
	const dir = home();
	const legacy = path.join(dir, "config.yml");
	const text = "# retain backend comment\nactiveBackend: old\nbackends:\n  - id: old\n    kind: source\n    path: /tree\n";
	writeFileSync(legacy, text); chmodSync(legacy, 0o640);
	expect(readBackendDocument(dir).data.activeBackend).toBe("old");
	expect(readFileSync(legacy, "utf8")).toBe(text);
	expect(statSync(path.join(dir, "config.toml")).mode & 0o777).toBe(0o640);
	expect(readFileSync(path.join(dir, "config.toml"), "utf8")).toContain("# retain backend comment");
	writeFileSync(legacy, "activeBackend: changed\n");
	expect(readBackendDocument(dir).data.activeBackend).toBe("old");
});

test("native saves preserve comments, unrelated tables, and file permissions", () => {
	const dir = home();
	const file = path.join(dir, "config.toml");
	writeFileSync(file, '# backend selection\nactiveBackend = "old" # preferred\n\n[[backends]]\nid = "old"\nkind = "source"\npath = "/old"\n\n[custom]\n# keep this comment\nvalue = "untouched"\n');
	chmodSync(file, 0o640);
	registerBackend(dir, { id: "new", kind: "source", path: "/new" });
	updateBackendDocument(dir, data => { data.activeBackend = "new"; });
	const saved = readFileSync(file, "utf8");
	expect(saved).toContain("# backend selection");
	expect(saved).toContain("# preferred");
	expect(saved).toContain('# keep this comment\nvalue = "untouched"');
	expect(readBackendDocument(dir).data.activeBackend).toBe("new");
	expect(statSync(file).mode & 0o777).toBe(0o640);
});

test("registration updates an existing backend without changing active selection", () => {
	const dir = home();
	registerBackend(dir, { id: "one", kind: "source", path: "/one" });
	registerBackend(dir, { id: "two", kind: "source", path: "/two" });
	registerBackend(dir, { id: "one", kind: "source", path: "/updated" });
	const data = readBackendDocument(dir).data;
	expect(data.activeBackend).toBe("one");
	expect(data.backends).toEqual([{ id: "one", kind: "source", path: "/updated" }, { id: "two", kind: "source", path: "/two" }]);
});
