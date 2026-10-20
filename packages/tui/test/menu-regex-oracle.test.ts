import { describe, expect, it } from "bun:test";
import { compileMenuRegex } from "@oh-my-pi/pi-tui/menu-search";

interface RegexFixture {
	pattern: string;
	texts: string[];
	matches: boolean[];
}

// Hunter fixtures were recorded with Neovim's default magic and ignorecase.
// Explicit \m preserves that dialect under the menu's very-magic default.
const fixtures: RegexFixture[] = [
	{ pattern: String.raw`\a\+`, texts: ["abc", "123", "foo-bar"], matches: [true, false, true] },
	{ pattern: String.raw`\l\+`, texts: ["abc", "123", "ABC"], matches: [true, false, false] },
	{ pattern: String.raw`\u\+`, texts: ["ABC", "abc", "123"], matches: [true, false, false] },
	{ pattern: String.raw`\x\+`, texts: ["12af", "xyz", "---"], matches: [true, false, false] },
	{ pattern: String.raw`\h\w*`, texts: ["hello", "123", "_name"], matches: [true, false, true] },
	{ pattern: String.raw`foo\zsbar`, texts: ["foobar", "foobaz", "bar"], matches: [true, false, false] },
	{ pattern: String.raw`foo\zebar`, texts: ["foobar", "foobaz", "foo"], matches: [true, false, false] },
	{ pattern: String.raw`foo\@!`, texts: ["food", "foo", "foa"], matches: [false, false, true] },
	{ pattern: String.raw`foo\@=`, texts: ["foo", "foa", "food"], matches: [true, false, true] },
	{ pattern: String.raw`\%(foo\|bar\)baz`, texts: ["foobaz", "barbaz", "quxbaz"], matches: [true, true, false] },
	{ pattern: String.raw`a.\{-}b`, texts: ["ab", "axxb", "axbxxb"], matches: [true, true, true] },
	{ pattern: String.raw`[[:alpha:]]\+`, texts: ["abc", "123", "é"], matches: [true, false, false] },
	{ pattern: String.raw`a\=b`, texts: ["b", "ab", "aab"], matches: [true, true, true] },
	{ pattern: String.raw`a^b`, texts: ["a^b", "ab", "a\nb"], matches: [true, false, false] },
	{ pattern: String.raw`a$b`, texts: ["a$b", "ab", "a\nb"], matches: [true, false, false] },
	{ pattern: String.raw`\v<foo>`, texts: ["foo", "food", "xfoo"], matches: [true, false, false] },
	{ pattern: String.raw`\Mfoo\.bar`, texts: ["fooXbar", "foo.bar", "foobar"], matches: [true, true, false] },
	{ pattern: String.raw`\Vfoo\m.*bar`, texts: ["fooXbar", "foo.bar", "foobar"], matches: [true, true, true] },
	{ pattern: String.raw`\C^\(ab\)\1$`, texts: ["abab", "ABAB", "ab"], matches: [true, false, false] },
	{ pattern: String.raw`\C[^A-Z]\+`, texts: ["abc", "ABC", "123"], matches: [true, false, true] },
	{ pattern: String.raw`[\d]\+`, texts: ["123", "ddd", "abc"], matches: [false, true, false] },
	{ pattern: String.raw`\C\v^(a|b){2,3}$`, texts: ["ab", "aba", "abab"], matches: [true, true, false] },
];

const veryMagicFixtures: RegexFixture[] = [
	{ pattern: "(live|voice)", texts: ["live", "voice", "other"], matches: [true, true, false] },
	{ pattern: "<live>", texts: ["live", "delivery", "lively"], matches: [true, false, false] },
	{ pattern: "live|voice", texts: ["live", "voice", "other"], matches: [true, true, false] },
	{ pattern: "a+b?", texts: ["a", "aaab", "bbb"], matches: [true, true, false] },
	{ pattern: String.raw`\d{2,}`, texts: ["12", "123", "1"], matches: [true, true, false] },
	{ pattern: "(foo|bar)baz", texts: ["foobaz", "barbaz", "quxbaz"], matches: [true, true, false] },
	{ pattern: "<foo>", texts: ["foo", "afoo", "fooa"], matches: [true, false, false] },
	{ pattern: String.raw`\vfoo@!`, texts: ["food", "foo", "foa"], matches: [false, false, true] },
	{ pattern: String.raw`\v%(foo|bar)baz`, texts: ["foobaz", "barbaz", "quxbaz"], matches: [true, true, false] },
	{ pattern: String.raw`\va.{-}b`, texts: ["ab", "axxb", "axbxxb"], matches: [true, true, true] },
	{ pattern: String.raw`\v[[:alpha:]]+`, texts: ["abc", "123", "é"], matches: [true, false, false] },
	{ pattern: String.raw`\v[\d]+`, texts: ["123", "ddd", "abc"], matches: [false, true, false] },
];

function expectNeovimAgreement(fixtures: readonly RegexFixture[], mode: string): void {
	const cases = fixtures.map(({ pattern, texts }) => ({ pattern: `\\v${mode}${pattern}`, texts }));
	const lua = `lua vim.o.ignorecase=true; local cases=vim.json.decode([==[${JSON.stringify(cases)}]==]); local out={}; for _,c in ipairs(cases) do local values={}; for _,s in ipairs(c.texts) do table.insert(values,vim.fn.match(s,c.pattern)>=0) end; table.insert(out,values) end; io.stdout:write(vim.json.encode(out))`;
	const process = Bun.spawnSync(["nvim", "--headless", "-u", "NONE", "-i", "NONE", "-c", lua, "-c", "qa!"], { stdout: "pipe", stderr: "pipe" });
	expect(process.exitCode).toBe(0);
	const expected = JSON.parse(process.stdout.toString()) as boolean[][];
	const actual = fixtures.map(({ pattern, texts }) => texts.map(text => compileMenuRegex(`/${mode}${pattern}`)?.regex?.test(text)));
	expect(actual).toEqual(expected);
}

describe("Vim regex differential fixtures", () => {
	it.each(fixtures)("matches recorded Neovim semantics for $pattern", ({ pattern, texts, matches }) => {
		const compiled = compileMenuRegex(`/\\m${pattern}`);
		expect(compiled?.error).toBeUndefined();
		expect(texts.map(text => compiled?.regex?.test(text))).toEqual(matches);
	});

	it.skipIf(Bun.which("nvim") === null)("agrees with a clean installed Neovim on all hunter fixtures", () => {
		expectNeovimAgreement(fixtures, "\\m");
	});

	it.each(veryMagicFixtures)("matches very-magic default semantics for $pattern", ({ pattern, texts, matches }) => {
		const compiled = compileMenuRegex(`/${pattern}`);
		expect(compiled?.error).toBeUndefined();
		expect(texts.map(text => compiled?.regex?.test(text))).toEqual(matches);
	});

	it.skipIf(Bun.which("nvim") === null)("agrees with very-magic-prefixed Neovim without a default-magic override", () => {
		expectNeovimAgreement(veryMagicFixtures, "");
	});

	it.each([String.raw`/\q`, "/%d65", "/@>", "/[[:unknown:]]", "/[[:__proto__:]]"])("rejects unsupported atoms rather than silently literalizing %s", pattern => {
		expect(compileMenuRegex(pattern)?.error).toContain("Unsupported");
	});
});
