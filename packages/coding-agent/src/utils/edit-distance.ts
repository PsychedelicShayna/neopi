/** Iterative two-row Levenshtein distance for nearest-name suggestions. */
export function editDistance(a: string, b: string): number {
	if (a === b) return 0;
	const prev: number[] = Array.from({ length: b.length + 1 });
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		let diag = prev[0]!;
		prev[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = prev[j]!;
			prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
			diag = tmp;
		}
	}
	return prev[b.length]!;
}
