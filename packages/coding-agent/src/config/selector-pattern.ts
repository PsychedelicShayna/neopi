/** Explicit regular-expression selector patterns; unprefixed selectors retain their existing meaning. */
export function isRegexSelectorPattern(pattern: string): boolean {
	return pattern.startsWith("re:");
}

export function isGlobSelectorPattern(pattern: string): boolean {
	return !isRegexSelectorPattern(pattern) && /[*?[\]{}]/.test(pattern);
}

// Cache compiled expressions across settings validation and fallback turns. Invalid patterns
// are cached too, so a bad config cannot repeatedly throw during resolution.
const regexCache = new Map<string, RegExp | null>();

/** Compile an opt-in selector regex, returning undefined for an invalid expression. */
export function compileSelectorRegex(pattern: string): RegExp | undefined {
	const cached = regexCache.get(pattern);
	if (cached !== undefined) return cached ?? undefined;
	try {
		const regex = new RegExp(pattern.slice(3));
		regexCache.set(pattern, regex);
		return regex;
	} catch {
		regexCache.set(pattern, null);
		return undefined;
	}
}

/** Match a selector without changing the existing literal and Bun glob behavior. */
export function matchesSelectorPattern(pattern: string, selector: string): boolean {
	if (isRegexSelectorPattern(pattern)) return compileSelectorRegex(pattern)?.test(selector) ?? false;
	if (isGlobSelectorPattern(pattern)) return new Bun.Glob(pattern).match(selector);
	return pattern === selector;
}
