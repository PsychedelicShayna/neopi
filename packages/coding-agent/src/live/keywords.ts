/** Find a spoken keyword in finalized speech and remove its original text span.
 * With `endOnly`, punctuation after the phrase is allowed but words are not. */
export function stripLiveKeyword(
	speech: string,
	keyword: string,
	endOnly = false,
): { matched: boolean; text: string } {
	const normalize = (text: string): Array<{ char: string; start: number; end: number }> => {
		const chars: Array<{ char: string; start: number; end: number }> = [];
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
	const collapse = (chars: ReturnType<typeof normalize>) => {
		const result: typeof chars = [];
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
	let start = -1;
	let chars = spaced;
	let length = 0;
	for (const candidate of candidates) {
		const flattened = candidate.chars.map(entry => entry.char).join("");
		const index = endOnly ? flattened.lastIndexOf(candidate.target) : flattened.indexOf(candidate.target);
		if (index < 0) continue;
		const end = candidate.chars[index + candidate.target.length - 1]!.end;
		const begin = candidate.chars[index]!.start;
		if (endOnly && begin > 0 && /[\p{L}\p{N}]/u.test(speech[begin - 1]!)) continue;
		if (endOnly && /[^\p{P}\p{S}\s]/u.test(speech.slice(end))) continue;
		start = index;
		chars = candidate.chars;
		length = candidate.target.length;
		break;
	}
	if (start < 0) return { matched: false, text: speech };
	const before = speech.slice(0, chars[start]!.start);
	const after = speech.slice(chars[start + length - 1]!.end);
	const text = `${before} ${after}`
		.replace(/(?:^|\s)[\p{P}\p{S}]+(?=\s|$)/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	return { matched: true, text };
}
