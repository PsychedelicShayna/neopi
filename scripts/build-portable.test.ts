import { describe, expect, test } from "bun:test";
import { assertBaselineNativeFiles, resolvePortableNativeBuild } from "./build-portable";

describe("portable native build selection", () => {
	test("prefers bazelisk, then bazel, otherwise cargo", () => {
		expect(resolvePortableNativeBuild(name => (name === "bazelisk" ? "/bin/bazelisk" : null))).toBe("bazel");
		expect(resolvePortableNativeBuild(name => (name === "bazel" ? "/bin/bazel" : null))).toBe("bazel");
		expect(resolvePortableNativeBuild(() => null)).toBe("cargo");
	});

	test("rejects missing or modern addons from a baseline-only portable build", () => {
		const baseline = "pi_natives.linux-x64-baseline.node";
		const modern = "pi_natives.linux-x64-modern.node";
		expect(() => assertBaselineNativeFiles([baseline])).not.toThrow();
		expect(() => assertBaselineNativeFiles([modern])).toThrow("exactly one baseline native");
		expect(() => assertBaselineNativeFiles([baseline, modern])).toThrow("exactly one baseline native");
		expect(() => assertBaselineNativeFiles([])).toThrow("exactly one baseline native");
	});
});
