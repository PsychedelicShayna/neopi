/** Levenshtein distance, or `limit + 1` once it provably exceeds `limit`. */
export function boundedEditDistance(a: string, b: string, limit: number): number {
	if (limit < 0 || Math.abs(a.length - b.length) > limit) return limit + 1;
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		let rowMin = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
			current.push(value);
			if (value < rowMin) rowMin = value;
		}
		if (rowMin > limit) return limit + 1;
		previous = current;
	}
	return previous[b.length]!;
}
