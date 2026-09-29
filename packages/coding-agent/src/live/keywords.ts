type NormalizedChar = { char: string; start: number; end: number };

/** Find a spoken keyword in finalized speech and remove its original text span.
 * With `endOnly`, punctuation after the phrase is allowed but words are not. */
export function stripLiveKeyword(
	speech: string,
	keyword: string,
	endOnly = false,
): { matched: boolean; text: string } {
	const normalize = (text: string): NormalizedChar[] => {
		const chars: NormalizedChar[] = [];
		for (let index = 0; index < text.length; ) {
			const original = String.fromCodePoint(text.codePointAt(index)!);
			const end = index + original.length;
			if (/\s/u.test(original)) {
				chars.push({ char: " ", start: index, end });
			} else if (!/[\p{P}\p{S}]/u.test(original)) {
				chars.push({ char: original.toLowerCase(), start: index, end });
			}
			index = end;
		}
		return chars;
	};
	const collapse = (chars: NormalizedChar[]): NormalizedChar[] => {
		const result: NormalizedChar[] = [];
		for (const entry of chars) {
			const previous = result[result.length - 1];
			if (entry.char === " " && previous?.char === " ") previous.end = entry.end;
			else result.push({ ...entry });
		}
		return result;
	};
	const target = collapse(normalize(keyword)).map(entry => entry.char).join("").trim();
	if (!target) return { matched: false, text: speech };
	const spaced = collapse(normalize(speech));
	const compactTarget = target.replaceAll(" ", "");
	const candidates = [
		{ chars: spaced, target },
		{ chars: spaced.filter(entry => entry.char !== " "), target: compactTarget },
	];
	let span: { begin: number; end: number } | undefined;
	for (const candidate of candidates) {
		const needle = Array.from(candidate.target);
		for (let index = 0; index + needle.length <= candidate.chars.length; index++) {
			if (needle.some((char, offset) => char !== candidate.chars[index + offset]!.char)) continue;
			const begin = candidate.chars[index]!.start;
			const end = candidate.chars[index + needle.length - 1]!.end;
			if (/[\p{L}\p{N}]$/u.test(speech.slice(0, begin))) continue;
			const remainder = speech.slice(end);
			if (/^[\p{L}\p{N}]/u.test(remainder)) continue;
			if (endOnly && /[^\p{P}\p{S}\s]/u.test(remainder)) continue;
			span = { begin, end };
			if (!endOnly) break;
		}
		if (span) break;
	}
	if (!span) return { matched: false, text: speech };
	const before = speech.slice(0, span.begin).trimEnd();
	const after = speech.slice(span.end)
		.replace(/^[ \t]*[\p{P}\p{S}]+(?=\s|$)/u, "")
		.trimStart();
	return { matched: true, text: before && after ? `${before} ${after}` : before || after };
}
