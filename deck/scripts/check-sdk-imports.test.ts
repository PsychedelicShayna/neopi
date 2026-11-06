import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { scanSource } from "./check-sdk-imports.ts";

const serverFile = path.resolve(import.meta.dir, "../apps/server/src/example.ts");
const browserFile = path.resolve(import.meta.dir, "../apps/web/src/example.tsx");
const runtimeSdk = "@oh-my-pi/pi-coding-agent";
const configLibraries = [
	"@oh-my-pi/pi-utils/settings-toml",
	"@oh-my-pi/pi-utils/settings-toml-codec",
	"@oh-my-pi/pi-utils/legacy-yaml-import",
	"@oh-my-pi/pi-utils/toml-frontmatter",
];

const valueForms = [
	{ form: "value import", source: (specifier: string) => `import { value } from "${specifier}";` },
	{ form: "value import", source: (specifier: string) => `import value from "${specifier}";` },
	{ form: "value import", source: (specifier: string) => `import * as value from "${specifier}";` },
	{ form: "value import", source: (specifier: string) => `import "${specifier}";` },
	{ form: "value import", source: (specifier: string) => `import { type Shape, value } from "${specifier}";` },
	{ form: "value re-export", source: (specifier: string) => `export { value } from "${specifier}";` },
	{ form: "value re-export", source: (specifier: string) => `export * from "${specifier}";` },
	{ form: "value re-export", source: (specifier: string) => `export * as value from "${specifier}";` },
	{ form: "import = require", source: (specifier: string) => `import value = require("${specifier}");` },
	{ form: "dynamic import()", source: (specifier: string) => `const value = import("${specifier}");` },
	{ form: "require()", source: (specifier: string) => `const value = require("${specifier}");` },
];

describe("SDK import guard parser", () => {
	for (const [index, { form, source }] of valueForms.entries()) {
		test(`rejects runtime SDK ${form} (${index})`, () => {
			expect(scanSource(serverFile, source(runtimeSdk))).toEqual([
				{ file: serverFile, line: 1, specifier: runtimeSdk, form },
			]);
		});
	}

	test("allows type-only imports, exports, and import queries", () => {
		expect(
			scanSource(
				serverFile,
				`
import type DefaultShape from "${runtimeSdk}";
import type * as Shapes from "${runtimeSdk}";
import { type Shape, type Other } from "${runtimeSdk}";
export type { Shape } from "${runtimeSdk}";
export { type Shape, type Other } from "${runtimeSdk}";
export type * from "${runtimeSdk}";
import type Shapes = require("${runtimeSdk}");
type Sdk = typeof import("${runtimeSdk}");
`,
			),
		).toEqual([]);
	});

	test("ignores comments, strings, unrelated imports, and lookalike scopes", () => {
		expect(
			scanSource(
				serverFile,
				`
// import { value } from "${runtimeSdk}";
const example = 'require("${runtimeSdk}")';
import { value } from "another-package";
import { lookalike } from "@oh-my-pi-extra/pi-utils";
`,
			),
		).toEqual([]);
	});

	test("parses TSX and locates nested runtime imports", () => {
		expect(
			scanSource(
				browserFile,
				`const view = <div>{() => {
  return require("${runtimeSdk}");
}}</div>;`,
			),
		).toEqual([{ file: browserFile, line: 2, specifier: runtimeSdk, form: "require()" }]);
	});

	for (const specifier of configLibraries) {
		test(`allows the exact static configuration library ${specifier}`, () => {
			for (const { source } of valueForms) {
				expect(scanSource(serverFile, source(specifier))).toEqual([]);
			}
		});
	}

	for (const specifier of [
		"@oh-my-pi/pi-utils",
		"@oh-my-pi/pi-utils/logger",
		"@oh-my-pi/pi-ai",
		"@oh-my-pi/pi-utils/settings-toml-extra",
		"@oh-my-pi/pi-utils/settings-toml/extra",
		"@oh-my-pi/pi-utils/settings-toml.ts",
		"@oh-my-pi/pi-utils/settings-toml-codec/extra",
		"@oh-my-pi/pi-utils/legacy-yaml-import/extra",
		"@oh-my-pi/pi-utils/toml-frontmatter/extra",
	]) {
		test(`does not exempt other SDK paths: ${specifier}`, () => {
			expect(scanSource(serverFile, `import { value } from "${specifier}";`)).toEqual([
				{ file: serverFile, line: 1, specifier, form: "value import" },
			]);
		});
	}

	test("allows only pure configuration codec and framing modules in browser code", () => {
		for (const { source, form } of valueForms) {
			for (const specifier of ["@oh-my-pi/pi-utils/settings-toml-codec", "@oh-my-pi/pi-utils/toml-frontmatter"]) {
				expect(scanSource(browserFile, source(specifier))).toEqual([]);
			}
			for (const specifier of ["@oh-my-pi/pi-utils/settings-toml", "@oh-my-pi/pi-utils/legacy-yaml-import"]) {
				expect(scanSource(browserFile, source(specifier))).toEqual([
					{ file: browserFile, line: 1, specifier, form },
				]);
			}
		}
	});
});
