import { expect, test } from "bun:test";
import { parseSettingsToml } from "@oh-my-pi/pi-utils/settings-toml";
import { maskModelsToml, PlaceholderError, restoreModelsToml } from "./models-config-secrets.ts";

const SECRET = "sk-native-regression-12345";

function masked(source: string) {
	const result = maskModelsToml(source);
	if (!result.ok) throw new Error("Fixture must be maskable");
	return result;
}

test("dotted and quoted keys, multiline strings and array-table headers mask without YAML", () => {
	const source = `# retired token never shown
[providers."quoted.provider"]
baseUrl = 'https://example.test/v1'
apiKey = '''${SECRET}'''
headers = { "X-Custom" = "header-secret-54321" } # preserve spacing
[[providers."quoted.provider".models]]
id = "first"
[providers."quoted.provider".models.headers]
X-First = "model-secret-12345"
[[providers."quoted.provider".models]]
id = "second"
headers.X-Second = "second-secret-12345"
[providers."quoted.provider".modelOverrides."model.with.dots".headers]
X-Override = "override-secret-12345"
`;
	const result = masked(source);
	for (const secret of [
		SECRET,
		"header-secret-54321",
		"model-secret-12345",
		"second-secret-12345",
		"override-secret-12345",
		"retired token",
		"preserve spacing",
	]) {
		expect(result.masked).not.toContain(secret);
	}
	const restored = restoreModelsToml(result.masked, result.secrets, result.comments);
	expect(parseSettingsToml(restored)).toEqual(parseSettingsToml(source));
	expect(restored).toContain("# retired token never shown");
	expect(restored).toContain("# preserve spacing");
});

test("comments inside multiline arrays are hidden and restored as exact comment spans", () => {
	const source = `[providers.local]
apiKey = "${SECRET}" # inline retired password
models = [
  # historical credential
  { id = "one", headers = { X-Token = "header-secret-54321" } },
]
`;
	const result = masked(source);
	expect(result.masked).not.toContain("retired password");
	expect(result.masked).not.toContain("historical credential");
	const restored = restoreModelsToml(result.masked, result.secrets, result.comments);
	expect(restored).toBe(source);
});

test("credential-like ancestor keys are sensitive even in dotted declarations", () => {
	const source = `custom.token.inner = "${SECRET}"\n`;
	const result = masked(source);
	expect(result.masked).not.toContain(SECRET);
	// Unknown-schema sensitive fields are masked but cannot receive restored secrets.
	expect(() => restoreModelsToml(result.masked, result.secrets, result.comments)).toThrow(PlaceholderError);
});

test("escaped repeated credentials are caught in decoded scalars and quoted keys", () => {
	const escaped = SECRET.replace("native", "na\\u0074ive");
	for (const extra of [`name = "${escaped}"`, `"${escaped}" = 1`]) {
		const result = maskModelsToml(`[providers.local]\napiKey = "${SECRET}"\n${extra}\n`);
		if (result.ok) {
			expect(result.masked).not.toContain(SECRET);
			expect(JSON.stringify(parseSettingsToml(result.masked))).not.toContain(SECRET);
			expect(() => restoreModelsToml(result.masked, result.secrets, result.comments)).toThrow(PlaceholderError);
		} else expect(result.known).toContain(SECRET);
	}
});

test("short credentials, malformed TOML and forged placeholders fail closed", () => {
	expect(maskModelsToml('[providers.local]\napiKey = "z9"\nmodels = [{ id = "z9-model" }]\n').ok).toBe(false);
	expect(maskModelsToml(`[providers.local]\napiKey = "${SECRET}\n`).ok).toBe(false);
	const result = masked(`[providers.local]\napiKey = "${SECRET}"\n`);
	const forged = result.masked.replace(/<npi-deck-masked:[0-9a-f]{16}>/, "<npi-deck-masked:0000000000000000>");
	try {
		restoreModelsToml(forged, result.secrets, result.comments);
		throw new Error("Expected stale placeholder");
	} catch (error) {
		expect(error).toBeInstanceOf(PlaceholderError);
		expect((error as PlaceholderError).status).toBe(409);
	}
});
