/**
 * Encode a canonical key id (`ctrl+shift+o`) as terminal bytes (#171).
 *
 * Modified keys use CSI-u, which `parseKey` decodes whether or not the kitty
 * protocol is active. Unmodified keys use legacy bytes.
 */
const SPECIAL: Record<string, { code: number; legacy: string }> = {
	escape: { code: 27, legacy: "\x1b" },
	esc: { code: 27, legacy: "\x1b" },
	enter: { code: 13, legacy: "\r" },
	return: { code: 13, legacy: "\r" },
	tab: { code: 9, legacy: "\t" },
	space: { code: 32, legacy: " " },
	backspace: { code: 127, legacy: "\x7f" },
	delete: { code: 127, legacy: "\x1b[3~" },
	up: { code: 0, legacy: "\x1b[A" },
	down: { code: 0, legacy: "\x1b[B" },
	right: { code: 0, legacy: "\x1b[C" },
	left: { code: 0, legacy: "\x1b[D" },
};

const MOD_BITS: Record<string, number> = { shift: 1, alt: 2, ctrl: 4, super: 8 };

/** Encode one key id, or undefined when it has no representation. */
export function encodeKeyId(id: string): string | undefined {
	const parts = id.toLowerCase().split("+");
	const key = parts.pop();
	if (!key) return undefined;
	let bits = 0;
	for (const part of parts) {
		const bit = MOD_BITS[part];
		if (bit === undefined) return undefined;
		bits |= bit;
	}
	if (bits === 0) {
		if (key.length === 1) return key;
		return SPECIAL[key]?.legacy;
	}
	const code = key.length === 1 ? key.codePointAt(0)! : SPECIAL[key]?.code;
	if (!code) return undefined;
	// CSI-u modifier is bits+1 (the encoding parseKey accepts).
	return `\x1b[${code};${bits + 1}u`;
}
