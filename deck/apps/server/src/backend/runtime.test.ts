import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listBackends, resolveBackendSelection, writeActiveBackend } from "./runtime.ts";

const roots: string[] = [];
function home(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "npi-deck-backend-test-"));
	roots.push(dir);
	return dir;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("backend selection", () => {
	test("backendless boot, registered source selection and persisted switching", () => {
		const dir = home();
		const env = { NPI_DECK_HOME: dir };
		expect(resolveBackendSelection(env)).toBeUndefined();
		writeFileSync(
			path.join(dir, "config.yml"),
			"backends:\n  - id: first\n    kind: source\n    path: /tmp/tree-a\n  - id: second\n    kind: source\n    path: /tmp/tree-b\nactiveBackend: first\n",
		);
		chmodSync(path.join(dir, "config.yml"), 0o640);
		const legacy = readFileSync(path.join(dir, "config.yml"), "utf8");
		expect(resolveBackendSelection(env)?.path).toBe(path.resolve("/tmp/tree-a"));
		expect(readFileSync(path.join(dir, "config.yml"), "utf8")).toBe(legacy);
		expect(statSync(path.join(dir, "config.toml")).mode & 0o777).toBe(0o640);
		writeActiveBackend("second", dir);
		expect(resolveBackendSelection(env)?.path).toBe(path.resolve("/tmp/tree-b"));
		writeActiveBackend(null, dir);
		expect(resolveBackendSelection(env)).toBeUndefined();
		expect(listBackends(dir)).toHaveLength(2);
	});
	test("env pin overrides config and reserved gateways cannot load", () => {
		const dir = home();
		writeFileSync(
			path.join(dir, "config.toml"),
			'activeBackend = "future"\n[[backends]]\nid = "future"\nkind = "gateway"\npath = "https://example.invalid"\n',
		);
		expect(() => resolveBackendSelection({ NPI_DECK_HOME: dir })).toThrow(/reserved kind gateway/);
		expect(resolveBackendSelection({ NPI_DECK_HOME: dir, NPI_DECK_BACKEND: "/tmp/pinned" })).toEqual({
			id: null,
			path: "/tmp/pinned",
			source: "env",
		});
	});
	test("canonical TOML wins and picker saves preserve unrelated nested comments and permissions", () => {
		const dir = home();
		const legacy = "activeBackend: absent\n";
		writeFileSync(path.join(dir, "config.yaml"), legacy);
		writeFileSync(
			path.join(dir, "config.toml"),
			'# operator note\nactiveBackend = "first" # current choice\n\n[[backends]]\n# tree note\nid = "first"\nkind = "source"\npath = "/tmp/tree-a" # local path\n\n[[backends]]\nid = "second"\nkind = "source"\npath = "/tmp/tree-b"\n',
		);
		chmodSync(path.join(dir, "config.toml"), 0o640);
		expect(resolveBackendSelection({ NPI_DECK_HOME: dir })?.path).toBe("/tmp/tree-a");
		writeActiveBackend("second", dir);
		const saved = readFileSync(path.join(dir, "config.toml"), "utf8");
		expect(saved).toContain("# operator note");
		expect(saved).toContain("# tree note");
		expect(saved).toContain("# local path");
		expect(statSync(path.join(dir, "config.toml")).mode & 0o777).toBe(0o640);
		expect(readFileSync(path.join(dir, "config.yaml"), "utf8")).toBe(legacy);
	});
});
